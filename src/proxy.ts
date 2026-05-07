import type { ApiPath, Bindings, GalleryEntry, GenerateRequestBody, RuntimeSettings } from "./types";
import { addToGallery, appendProducedId, generateImageId, saveImage } from "./storage";
import { loadRuntimeLimits } from "./settings";

interface FormatInfo {
  extension: string;
  mediaType: string;
}

const FORMAT_INFO: Record<string, FormatInfo> = {
  png: { extension: "png", mediaType: "image/png" },
  jpeg: { extension: "jpg", mediaType: "image/jpeg" },
  webp: { extension: "webp", mediaType: "image/webp" },
};

function formatInfo(fmt: string): FormatInfo {
  return FORMAT_INFO[fmt] ?? FORMAT_INFO.png!;
}

function readU32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function readU16BE(view: DataView, offset: number): number {
  return view.getUint16(offset, false);
}

function readU16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function getImageDimensions(buffer: ArrayBuffer): { width: number; height: number } | null {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length >= 24 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { width: readU32BE(view, 16), height: readU32BE(view, 20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      let marker = bytes[offset + 1]!;
      offset += 2;
      while (marker === 0xff && offset < bytes.length) {
        marker = bytes[offset]!;
        offset += 1;
      }
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > bytes.length) return null;
      const segmentLength = readU16BE(view, offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
      const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      if (sofMarkers.has(marker)) {
        const height = readU16BE(view, offset + 3);
        const width = readU16BE(view, offset + 5);
        return { width, height };
      }
      offset += segmentLength;
    }
    return null;
  }
  if (bytes.length >= 30 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const chunk0 = bytes[12], chunk1 = bytes[13], chunk2 = bytes[14], chunk3 = bytes[15];
    const isVP8X = chunk0 === 0x56 && chunk1 === 0x50 && chunk2 === 0x38 && chunk3 === 0x58;
    const isVP8 = chunk0 === 0x56 && chunk1 === 0x50 && chunk2 === 0x38 && chunk3 === 0x20;
    const isVP8L = chunk0 === 0x56 && chunk1 === 0x50 && chunk2 === 0x38 && chunk3 === 0x4c;
    if (isVP8X) {
      return { width: readU24LE(bytes, 24) + 1, height: readU24LE(bytes, 27) + 1 };
    }
    if (isVP8 && bytes.length >= 30) {
      return { width: readU16LE(view, 26) & 0x3fff, height: readU16LE(view, 28) & 0x3fff };
    }
    if (isVP8L && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface UpstreamImageRecord {
  b64_json?: string;
  url?: string;
}

function extractResponseImageResult(value: unknown): UpstreamImageRecord | null {
  if (typeof value === "string" && value) {
    if (value.startsWith("http://") || value.startsWith("https://")) return { url: value };
    if (value.startsWith("data:")) {
      const parsed = /^data:[^;,]*(?:;[^,]*)?;base64,(.+)$/i.exec(value);
      if (parsed) return { b64_json: parsed[1]! };
    }
    return { b64_json: value };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const got = extractResponseImageResult(item);
      if (got) return got;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of ["url", "b64_json", "base64", "data", "result"]) {
      const got = extractResponseImageResult((value as Record<string, unknown>)[key]);
      if (got) return got;
    }
  }
  return null;
}

function extractResponseImageResults(result: Record<string, unknown>): UpstreamImageRecord[] {
  const out: UpstreamImageRecord[] = [];
  const items = Array.isArray(result.output) ? result.output : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if ((item as Record<string, unknown>).type !== "image_generation_call") continue;
    const rec = extractResponseImageResult((item as Record<string, unknown>).result);
    if (rec) out.push(rec);
  }
  return out;
}

function resolveImageUrl(rawUrl: string, apiUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (rawUrl.startsWith("//")) return "https:" + rawUrl;
  if (rawUrl.startsWith("/")) return apiUrl.replace(/\/+$/, "") + rawUrl;
  return apiUrl.replace(/\/+$/, "") + "/" + rawUrl;
}

async function fetchImageBytes(
  image: UpstreamImageRecord,
  responsePreview: string,
  apiUrl: string,
  apiKey: string,
): Promise<ArrayBuffer> {
  if (image.b64_json) return decodeBase64(image.b64_json);
  if (image.url) {
    if (image.url.startsWith("data:")) {
      const parsed = /^data:[^;,]*(?:;[^,]*)?;base64,(.+)$/i.exec(image.url);
      if (!parsed) throw new Error("Upstream returned malformed data URL");
      return decodeBase64(parsed[1]!);
    }
    const target = resolveImageUrl(image.url, apiUrl);
    const sameOrigin = (() => {
      try { return new URL(target).host === new URL(apiUrl).host; } catch { return false; }
    })();
    const headers: Record<string, string> = { "User-Agent": "gpt-image-worker" };
    if (sameOrigin) headers["Authorization"] = `Bearer ${apiKey}`;

    let resp: Response;
    try {
      resp = await fetch(target, { headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("download fetch failed", { url: target, error: msg });
      throw new Error(`Network error downloading image from ${target}: ${msg}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error("download non-2xx", { url: target, status: resp.status, body: body.slice(0, 300) });
      throw new Error(`Failed to download image from ${target}: HTTP ${resp.status} ${body.slice(0, 200)}`);
    }
    return await resp.arrayBuffer();
  }
  throw new Error(`No image data (b64_json or url) in upstream response: ${responsePreview.slice(0, 200)}`);
}

interface DataUrl {
  mediaType: string;
  base64: string;
  bytes: ArrayBuffer;
}

function parseDataUrl(dataUrl: string): DataUrl {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("reference_images must be data URLs (data:<mime>;base64,<...>)");
  const mediaType = m[1]!;
  const base64 = m[2]!;
  return { mediaType, base64, bytes: decodeBase64(base64) };
}

function buildImagesGenerationPayload(payload: GenerateRequestBody): Record<string, unknown> {
  const data: Record<string, unknown> = {
    model: payload.model,
    prompt: payload.prompt,
    size: payload.size,
    n: payload.n,
    quality: payload.quality,
    output_format: payload.output_format,
  };
  if (payload.response_format && payload.response_format !== "none") {
    data.response_format = payload.response_format;
  }
  if (payload.output_format !== "png" && payload.output_compression !== null && payload.output_compression !== undefined) {
    data.output_compression = payload.output_compression;
  }
  return data;
}

function buildResponsesPayload(payload: GenerateRequestBody): Record<string, unknown> {
  return { prompt: payload.prompt, model: payload.model };
}

const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

async function postJson(url: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "gpt-image-worker",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("upstream fetch failed", { url, error: msg });
    if (signal?.aborted) {
      throw new Error(`Upstream API timed out after ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s at ${url}`);
    }
    throw new Error(`Failed to reach upstream API at ${url}: ${msg}`);
  }
}

async function callImagesEdits(
  apiUrl: string,
  apiKey: string,
  payload: GenerateRequestBody,
  signal?: AbortSignal,
): Promise<Response> {
  const form = new FormData();
  form.append("model", payload.model);
  form.append("prompt", payload.prompt);
  form.append("size", payload.size);
  form.append("n", String(payload.n));
  form.append("quality", payload.quality);
  form.append("output_format", payload.output_format);
  if (payload.response_format && payload.response_format !== "none") {
    form.append("response_format", payload.response_format);
  }
  if (payload.output_format !== "png" && payload.output_compression !== null && payload.output_compression !== undefined) {
    form.append("output_compression", String(payload.output_compression));
  }
  const refs = payload.reference_images ?? [];
  for (let i = 0; i < refs.length; i++) {
    const parsed = parseDataUrl(refs[i]!);
    const blob = new Blob([parsed.bytes], { type: parsed.mediaType });
    const ext = (parsed.mediaType.split("/")[1] ?? "png").toLowerCase();
    form.append("image[]", blob, `reference-${i}.${ext}`);
  }
  if (payload.mask) {
    const maskParsed = parseDataUrl(payload.mask);
    const maskBlob = new Blob([maskParsed.bytes], { type: maskParsed.mediaType });
    const maskExt = (maskParsed.mediaType.split("/")[1] ?? "png").toLowerCase();
    form.append("mask", maskBlob, `mask.${maskExt}`);
  }
  const editsUrl = `${apiUrl}/v1/images/edits`;
  try {
    return await fetch(editsUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": "gpt-image-worker",
      },
      body: form,
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("upstream fetch failed", { url: editsUrl, error: msg });
    if (signal?.aborted) {
      throw new Error(`Upstream API timed out after ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s at ${editsUrl}`);
    }
    throw new Error(`Failed to reach upstream API at ${editsUrl}: ${msg}`);
  }
}

async function readUpstreamJson(resp: Response): Promise<{ status: number; json?: Record<string, unknown>; text: string }> {
  const text = await resp.text();
  const ct = resp.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return { status: resp.status, text };
  }
  try {
    return { status: resp.status, json: JSON.parse(text) as Record<string, unknown>, text };
  } catch {
    return { status: resp.status, text };
  }
}

function upstreamErrorMessage(parsed: { status: number; json?: Record<string, unknown>; text: string }): string {
  if (parsed.json) {
    const err = parsed.json.error;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
      return `Upstream API error (${parsed.status}): ${(err as Record<string, unknown>).message}`;
    }
  }
  return `Upstream API error (${parsed.status}): ${parsed.text.slice(0, 200)}`;
}

export interface CallImageGenerationOptions {
  jobId?: string;
  existingEntries?: GalleryEntry[];
  maxFileSizeMb?: number;
  apiPresetName?: string;
  responsesConcurrency?: number;
}

export async function callImageGeneration(
  env: Bindings,
  settings: RuntimeSettings,
  payload: GenerateRequestBody,
  ownerId: string | undefined,
  signal?: AbortSignal,
  options: CallImageGenerationOptions = {},
): Promise<GalleryEntry[]> {
  const apiPath: ApiPath = settings.api_path;
  const hasReferences = !!payload.reference_images && payload.reference_images.length > 0;
  const fmt = formatInfo(payload.output_format);
  const maxBytes = (options.maxFileSizeMb ?? (await loadRuntimeLimits(env)).max_file_size_mb) * 1024 * 1024;

  const targetCount = Math.max(1, payload.n);
  const entries: GalleryEntry[] = [...(options.existingEntries ?? [])];
  if (entries.length >= targetCount) return entries.slice(0, targetCount);

  console.log("generation start", {
    api_url: settings.api_url,
    api_path: apiPath,
    job_id: options.jobId,
    has_references: hasReferences,
    reference_count: payload.reference_images?.length ?? 0,
    n: payload.n,
    already_produced: entries.length,
    size: payload.size,
    quality: payload.quality,
    output_format: payload.output_format,
    response_format: payload.response_format,
  });

  const persistEntry = async (rec: UpstreamImageRecord, sourceText: string): Promise<GalleryEntry> => {
    if (!rec.b64_json && rec.url) {
      console.log("upstream returned image url", { url: rec.url });
    }
    const bytes = await fetchImageBytes(rec, sourceText, settings.api_url, settings.api_key);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Image too large: ${bytes.byteLength} bytes (max ${maxBytes})`);
    }
    const id = generateImageId();
    const filename = `${id}.${fmt.extension}`;
    await saveImage(env, filename, bytes, fmt.mediaType);
    const dims = getImageDimensions(bytes);
    const entry: GalleryEntry = {
      id,
      prompt: payload.prompt,
      size: payload.size,
      filename,
      created_at: new Date().toISOString(),
      model: payload.model,
      quality: payload.quality,
      output_format: payload.output_format,
      output_compression: payload.output_compression ?? null,
      response_format: payload.response_format,
      n: payload.n,
      api_path: apiPath,
      api_preset_name: options.apiPresetName,
      image_width: dims?.width ?? null,
      image_height: dims?.height ?? null,
      is_public: payload.is_public ?? true,
      has_reference: hasReferences,
      owner_id: ownerId,
    };
    await addToGallery(env, entry);
    if (options.jobId && targetCount > 1) {
      await appendProducedId(env, options.jobId, id).catch((err) =>
        console.error("appendProducedId failed", { jobId: options.jobId, id, err: err instanceof Error ? err.message : String(err) }),
      );
    }
    return entry;
  };

  const runOneCall = async (perCall: number, attempt: number): Promise<GalleryEntry[]> => {
    const callPayload: GenerateRequestBody = { ...payload, n: perCall };
    let resp: Response;
    if (apiPath === "/v1/images/generations") {
      if (hasReferences) {
        resp = await callImagesEdits(settings.api_url, settings.api_key, callPayload, signal);
      } else {
        resp = await postJson(
          `${settings.api_url}/v1/images/generations`,
          settings.api_key,
          buildImagesGenerationPayload(callPayload),
          signal,
        );
      }
    } else {
      resp = await postJson(
        `${settings.api_url}/v1/responses`,
        settings.api_key,
        buildResponsesPayload(callPayload),
        signal,
      );
    }

    const parsed = await readUpstreamJson(resp);
    if (parsed.status >= 400) throw new Error(upstreamErrorMessage(parsed));
    if (!parsed.json) throw new Error(`Upstream returned non-JSON (${parsed.status}): ${parsed.text.slice(0, 200)}`);

    const records: UpstreamImageRecord[] = apiPath === "/v1/responses"
      ? extractResponseImageResults(parsed.json)
      : Array.isArray(parsed.json.data)
        ? (parsed.json.data as UpstreamImageRecord[])
        : [];
    console.log("upstream parsed", {
      api_path: apiPath,
      attempt,
      requested: perCall,
      record_count: records.length,
      first_record_kind: records[0] ? (records[0].b64_json ? "b64" : records[0].url ? "url" : "empty") : "none",
    });
    if (records.length === 0) {
      throw new Error(`No image data in upstream response: ${parsed.text.slice(0, 200)}`);
    }
    const usable = records.slice(0, perCall);
    return Promise.all(usable.map((rec) => persistEntry(rec, parsed.text)));
  };

  if (apiPath === "/v1/responses") {
    const remaining = targetCount - entries.length;
    const cap = Math.max(1, Math.min(10, Math.floor(options.responsesConcurrency ?? 3)));
    const concurrency = Math.min(remaining, cap);
    const queue = Array.from({ length: remaining }, (_, i) => i);
    let attempt = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        queue.shift();
        attempt += 1;
        const produced = await runOneCall(1, attempt);
        for (const e of produced) {
          if (entries.length < targetCount) entries.push(e);
        }
      }
    });
    await Promise.all(workers);
  } else {
    let attempt = 0;
    const maxAttempts = targetCount + 2;
    while (entries.length < targetCount && attempt < maxAttempts) {
      attempt += 1;
      const remaining = targetCount - entries.length;
      const produced = await runOneCall(remaining, attempt);
      for (const e of produced) {
        if (entries.length < targetCount) entries.push(e);
      }
    }
  }

  if (entries.length === 0) throw new Error("Upstream produced no images");
  return entries.slice(0, targetCount);
}
