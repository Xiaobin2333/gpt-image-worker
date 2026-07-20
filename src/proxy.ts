import type { ApiPath, Bindings, GalleryEntry, GenerateRequestBody, RuntimeSettings } from "./types";
import { addGalleryEntriesForJob, addToGallery, addToGalleryForJob, deleteImage, deleteImages, generateImageId, getEntry, saveImage } from "./storage";
import { loadRuntimeLimits } from "./settings";
import { runSettledBatchWithRetries } from "./batch";

interface FormatInfo {
  outputFormat: "png" | "jpeg" | "webp";
  extension: string;
  mediaType: string;
}

const FORMAT_INFO: Record<string, FormatInfo> = {
  png: { outputFormat: "png", extension: "png", mediaType: "image/png" },
  jpeg: { outputFormat: "jpeg", extension: "jpg", mediaType: "image/jpeg" },
  webp: { outputFormat: "webp", extension: "webp", mediaType: "image/webp" },
};

function formatInfo(fmt: string): FormatInfo {
  return FORMAT_INFO[fmt] ?? FORMAT_INFO.png!;
}

function detectFormatInfo(buffer: ArrayBuffer): FormatInfo | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return FORMAT_INFO.png!;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return FORMAT_INFO.jpeg!;
  }
  if (bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return FORMAT_INFO.webp!;
  }
  return null;
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

class UpstreamRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamRequestError";
  }
}

class IncompleteGenerationError extends Error {
  constructor(
    message: string,
    readonly completedEntries: GalleryEntry[],
    readonly rootCause?: unknown,
  ) {
    super(message);
    this.name = "IncompleteGenerationError";
  }
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
  signal?: AbortSignal,
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
      resp = await fetch(target, { headers, signal });
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

interface PreparedEditAsset {
  blob: Blob;
  filename: string;
}

interface PreparedEditAssets {
  references: PreparedEditAsset[];
  mask?: PreparedEditAsset;
}

function parseDataUrl(dataUrl: string): DataUrl {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("reference_images must be data URLs (data:<mime>;base64,<...>)");
  const mediaType = m[1]!;
  const base64 = m[2]!;
  return { mediaType, base64, bytes: decodeBase64(base64) };
}

function prepareEditAssets(payload: GenerateRequestBody): PreparedEditAssets {
  const references = (payload.reference_images ?? []).map((dataUrl, index) => {
    const parsed = parseDataUrl(dataUrl);
    const ext = (parsed.mediaType.split("/")[1] ?? "png").toLowerCase();
    return {
      blob: new Blob([parsed.bytes], { type: parsed.mediaType }),
      filename: `reference-${index}.${ext}`,
    };
  });
  const mask = payload.mask
    ? (() => {
        const parsed = parseDataUrl(payload.mask!);
        const ext = (parsed.mediaType.split("/")[1] ?? "png").toLowerCase();
        return { blob: new Blob([parsed.bytes], { type: parsed.mediaType }), filename: `mask.${ext}` };
      })()
    : undefined;
  return { references, mask };
}

export function buildImagesGenerationPayload(payload: GenerateRequestBody): Record<string, unknown> {
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

export function buildResponsesPayload(
  payload: GenerateRequestBody,
  responsesModel: string,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "image_generation",
    size: payload.size,
    quality: payload.quality,
    output_format: payload.output_format,
  };
  if (payload.output_format !== "png" && payload.output_compression !== null && payload.output_compression !== undefined) {
    tool.output_compression = payload.output_compression;
  }
  if (payload.mask) {
    tool.input_image_mask = { image_url: payload.mask };
  }
  const references = payload.reference_images ?? [];
  const input = references.length > 0
    ? [{
        role: "user",
        content: [
          { type: "input_text", text: payload.prompt },
          ...references.map((imageUrl) => ({ type: "input_image", image_url: imageUrl })),
        ],
      }]
    : payload.prompt;
  return {
    model: responsesModel.trim() || payload.model,
    input,
    tools: [tool],
  };
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
  assets: PreparedEditAssets,
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
  for (const reference of assets.references) {
    form.append("image[]", reference.blob, reference.filename);
  }
  if (assets.mask) {
    form.append("mask", assets.mask.blob, assets.mask.filename);
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

function rejectsImageCountParameter(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Upstream API error \(400\):\s*Unknown parameter:\s*['"]tools\[0\]\.n['"]/i.test(message);
}

function requiresSingleImageCalls(payload: GenerateRequestBody): boolean {
  return !!payload.mask || /^gpt-image-2(?:$|[-.:/_])/i.test(payload.model.trim());
}

function isRetryableParallelError(error: unknown): boolean {
  return error instanceof UpstreamRequestError
    && (error.status === 425 || error.status === 429);
}

export interface CallImageGenerationOptions {
  jobId?: string;
  existingEntries?: GalleryEntry[];
  maxFileSizeMb?: number;
  apiPresetName?: string;
  responsesModel?: string;
  claimToken?: string;
  onImage?: (entry: GalleryEntry, completed: number, total: number) => void | Promise<void>;
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
  const editAssets = apiPath === "/v1/images/generations" && hasReferences
    ? prepareEditAssets(payload)
    : null;
  const maxBytes = (options.maxFileSizeMb ?? (await loadRuntimeLimits(env)).max_file_size_mb) * 1024 * 1024;

  const targetCount = Math.max(1, payload.n);
  const entries: GalleryEntry[] = [...(options.existingEntries ?? [])];
  const existingIds = new Set(entries.map((entry) => entry.id));
  const publishedIds = new Set(existingIds);
  if (entries.length >= targetCount) return entries.slice(0, targetCount);

  const ensureNotAborted = () => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Generation job cancelled");
    }
  };
  const isFatalJobError = (error: unknown): boolean => {
    if (error instanceof IncompleteGenerationError && error.rootCause) {
      return isFatalJobError(error.rootCause);
    }
    if (signal?.aborted) return true;
    const message = error instanceof Error ? error.message : String(error);
    return (error instanceof DOMException && error.name === "AbortError")
      || /Generation job (?:lease lost|cancelled)/i.test(message);
  };

  const isRetryablePersistenceError = (error: unknown): boolean => {
    if (isFatalJobError(error)) return false;
    if (error instanceof DOMException && error.name === "InvalidCharacterError") return false;
    const message = error instanceof Error ? error.message : String(error);
    return !/Image too large|malformed data URL|No image data \(b64_json or url\)|HTTP (?:400|401|403|404)\b/i.test(message);
  };

  const deletePendingImages = async (pending: GalleryEntry[]) => {
    await deleteImages(env, pending.map((entry) => entry.filename)).catch(() => {});
  };

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

  interface PersistenceState {
    id: string;
    createdAt: string;
    bytes?: ArrayBuffer;
    entry?: GalleryEntry;
  }

  const persistEntry = async (
    rec: UpstreamImageRecord,
    sourceText: string,
    state: PersistenceState,
  ): Promise<GalleryEntry> => {
    if (!rec.b64_json && rec.url) {
      console.log("upstream returned image url", { url: rec.url });
    }
    ensureNotAborted();
    if (!state.bytes || !state.entry) {
      const bytes = await fetchImageBytes(rec, sourceText, settings.api_url, settings.api_key, signal);
      ensureNotAborted();
      if (bytes.byteLength > maxBytes) {
        throw new Error(`Image too large: ${bytes.byteLength} bytes (max ${maxBytes})`);
      }
      const actualFormat = detectFormatInfo(bytes) ?? fmt;
      const filename = `${state.id}.${actualFormat.extension}`;
      const dims = getImageDimensions(bytes);
      state.bytes = bytes;
      state.entry = {
        id: state.id,
        prompt: payload.prompt,
        size: payload.size,
        filename,
        created_at: state.createdAt,
        model: payload.model,
        quality: payload.quality,
        output_format: actualFormat.outputFormat,
        output_compression: actualFormat.outputFormat === "png" ? null : payload.output_compression ?? null,
        response_format: payload.response_format,
        n: payload.n,
        api_path: apiPath,
        api_preset_name: options.apiPresetName,
        image_width: dims?.width ?? null,
        image_height: dims?.height ?? null,
        byte_size: bytes.byteLength,
        favorite: false,
        is_public: payload.is_public ?? true,
        has_reference: hasReferences,
        owner_id: ownerId,
      };
    }

    const bytes = state.bytes;
    const entry = state.entry;
    const actualFormat = formatInfo(entry.output_format ?? payload.output_format);
    await saveImage(env, entry.filename, bytes, actualFormat.mediaType);
    try {
      ensureNotAborted();
    } catch (err) {
      await deleteImage(env, entry.filename).catch(() => {});
      throw err;
    }

    let committedEntry = entry;
    try {
      if (!options.jobId) {
        await addToGallery(env, entry);
      } else {
        if (!options.claimToken) throw new Error("Generation claim token missing");
        const committed = await addToGalleryForJob(env, entry, options.jobId, options.claimToken);
        if (!committed) throw new Error("Generation job lease lost");
      }
    } catch (error) {
      if (isFatalJobError(error)) {
        await deleteImage(env, entry.filename).catch(() => {});
        throw error;
      }
      let existing: GalleryEntry | null;
      try {
        existing = await getEntry(env, entry.id);
      } catch (lookupError) {
        console.error("gallery commit verification failed", {
          imageId: entry.id,
          error: lookupError instanceof Error ? lookupError.message : String(lookupError),
        });
        throw error;
      }
      if (!existing) {
        await deleteImage(env, entry.filename).catch(() => {});
        throw error;
      }
      committedEntry = existing;
    }

    const firstPublish = !publishedIds.has(committedEntry.id);
    publishedIds.add(committedEntry.id);
    if (options.jobId && firstPublish && options.onImage) {
      try {
        await options.onImage(committedEntry, publishedIds.size, targetCount);
      } catch (error) {
        console.error("generation image progress callback failed", {
          jobId: options.jobId,
          imageId: committedEntry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return committedEntry;
  };

  const appendEntries = (produced: GalleryEntry[]) => {
    for (const entry of produced) {
      if (entries.length >= targetCount || existingIds.has(entry.id)) continue;
      entries.push(entry);
      existingIds.add(entry.id);
    }
  };

  const completedEntriesFromError = (error: unknown): GalleryEntry[] =>
    error instanceof IncompleteGenerationError ? error.completedEntries : [];

  const runOneCall = async (perCall: number, attempt: number): Promise<GalleryEntry[]> => {
    ensureNotAborted();
    const callPayload: GenerateRequestBody = { ...payload, n: perCall };
    let resp: Response;
    if (apiPath === "/v1/images/generations") {
      if (hasReferences) {
        resp = await callImagesEdits(settings.api_url, settings.api_key, callPayload, editAssets!, signal);
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
        buildResponsesPayload(callPayload, options.responsesModel ?? ""),
        signal,
      );
    }

    const parsed = await readUpstreamJson(resp);
    ensureNotAborted();
    if (parsed.status >= 400) {
      throw new UpstreamRequestError(parsed.status, upstreamErrorMessage(parsed));
    }
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
    const persistenceStates: PersistenceState[] = usable.map(() => ({
      id: generateImageId(),
      createdAt: new Date().toISOString(),
    }));
    const persisted = await runSettledBatchWithRetries(
      usable.length,
      usable.length,
      (index) => persistEntry(usable[index]!, parsed.text, persistenceStates[index]!),
      {
        maxRetries: 2,
        shouldRetry: isRetryablePersistenceError,
        beforeRetry: (errors, nextAttempt) => {
          console.warn("retrying image persistence without regenerating", {
            next_attempt: nextAttempt,
            retry_count: errors.length,
            errors: errors.slice(0, 3).map(({ index, error }) => ({
              index,
              message: error instanceof Error ? error.message : String(error),
            })),
          });
        },
      },
    );
    if (persisted.errors.length > 0 || persisted.results.length < perCall) {
      console.warn("upstream records partially failed to persist", {
        requested: perCall,
        returned: usable.length,
        succeeded: persisted.results.length,
        failed: persisted.errors.length,
      });
      const fatal = persisted.errors.find(({ error }) => isFatalJobError(error));
      const details = persisted.errors.slice(0, 3)
        .map(({ error }) => error instanceof Error ? error.message : String(error));
      if (usable.length < perCall) details.unshift(`upstream returned ${usable.length} records`);
      throw new IncompleteGenerationError(
        `Generated ${persisted.results.length} of ${perCall} images${details.length > 0 ? `: ${details.join("; ")}` : ""}`,
        persisted.results,
        fatal?.error,
      );
    }
    return persisted.results;
  };

  const runParallelSingleCalls = async (remaining: number, concurrency: number, label: string) => {
    let fatalError: unknown;
    const batch = await runSettledBatchWithRetries(
      remaining,
      concurrency,
      async (index, attempt) => {
        if (fatalError) throw fatalError;
        try {
          return await runOneCall(1, index + 1 + ((attempt - 1) * remaining));
        } catch (error) {
          if (isFatalJobError(error)) fatalError = error;
          throw error;
        }
      },
      {
        maxRetries: 2,
        shouldRetry: (error) => !fatalError && isRetryableParallelError(error),
        beforeRetry: async (errors, nextAttempt) => {
          console.warn(`${label} retrying failed image calls`, {
            next_attempt: nextAttempt,
            retry_count: errors.length,
            errors: errors.slice(0, 3).map(({ index, error }) => ({
              index,
              message: error instanceof Error ? error.message : String(error),
            })),
          });
          await new Promise((resolve) => setTimeout(resolve, nextAttempt === 2 ? 800 : 1600));
          ensureNotAborted();
        },
      },
    );
    for (const produced of batch.results) {
      appendEntries(produced);
    }
    for (const { error } of batch.errors) appendEntries(completedEntriesFromError(error));
    if (batch.errors.length === 0) return;
    console.warn(`${label} parallel batch partially failed`, {
      requested: remaining,
      succeeded: batch.results.length,
      failed: batch.errors.length,
      errors: batch.errors.slice(0, 3).map(({ index, error }) => ({
        attempt: index + 1,
        message: error instanceof Error ? error.message : String(error),
      })),
    });
    const fatal = batch.errors.find(({ error }) => isFatalJobError(error));
    if (fatal) {
      await deletePendingImages(entries.filter((entry) => !publishedIds.has(entry.id)));
      throw fatal.error;
    }
    if (entries.length === 0) throw batch.errors[0]!.error;
    const messages = batch.errors.slice(0, 3).map(({ error }) => error instanceof Error ? error.message : String(error));
    throw new Error(`Generated ${entries.length} of ${targetCount} images; ${batch.errors.length} calls failed: ${messages.join("; ")}`);
  };

  const parallelImages = apiPath === "/v1/images/generations"
    && requiresSingleImageCalls(payload);
  if (apiPath === "/v1/responses" || parallelImages) {
    const remaining = targetCount - entries.length;
    await runParallelSingleCalls(remaining, remaining, apiPath === "/v1/responses" ? "responses" : "images");
  } else {
    let attempt = 0;
    const maxSafeRetries = 2;
    const safeRetryBackoffMs = [800, 1600];
    let safeRetries = 0;
    let terminalError: unknown;
    while (entries.length < targetCount && attempt <= maxSafeRetries) {
      attempt += 1;
      const remaining = targetCount - entries.length;
      const perCall = remaining;
      try {
        const produced = await runOneCall(perCall, attempt);
        appendEntries(produced);
      } catch (e) {
        appendEntries(completedEntriesFromError(e));
        const msg = e instanceof Error ? e.message : String(e);
        if (isFatalJobError(e)) {
          await deletePendingImages(entries.filter((entry) => !publishedIds.has(entry.id)));
          throw e;
        }
        if (perCall > 1 && rejectsImageCountParameter(e)) {
          console.warn("upstream rejected batch image count, retrying as single-image calls", {
            requested: targetCount,
            failed_attempt: attempt,
            message: msg,
          });
          await runParallelSingleCalls(remaining, remaining, "images fallback");
          break;
        }
        if (isRetryableParallelError(e) && safeRetries < maxSafeRetries) {
          const backoffMs = safeRetryBackoffMs[safeRetries] ?? 1600;
          safeRetries += 1;
          console.warn("upstream rejected request before generation, retrying", { attempt, safeRetries, backoffMs, msg });
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          ensureNotAborted();
          continue;
        }
        terminalError = e;
        console.warn("generation call failed without regeneration retry", {
          requested: targetCount,
          succeeded: entries.length,
          failed_attempt: attempt,
          message: msg,
        });
        break;
      }
    }
    if (entries.length === 0 && terminalError) throw terminalError;
  }

  if (entries.length === 0) throw new Error("Upstream produced no images");
  if (entries.length < targetCount) {
    throw new Error(`Generated ${entries.length} of ${targetCount} images; generation was not retried to avoid duplicate upstream images`);
  }
  const pendingEntries = entries.filter((entry) => !publishedIds.has(entry.id));
  if (options.jobId && pendingEntries.length > 0) {
    if (!options.claimToken) {
      await deletePendingImages(pendingEntries);
      throw new Error("Generation claim token missing");
    }
    try {
      ensureNotAborted();
    } catch (error) {
      await deletePendingImages(pendingEntries);
      throw error;
    }
    const committed = await addGalleryEntriesForJob(
      env,
      pendingEntries,
      options.jobId,
      options.claimToken,
    );
    if (!committed) {
      await deletePendingImages(pendingEntries);
      throw new Error("Generation job lease lost");
    }
  }
  return entries.slice(0, targetCount);
}
