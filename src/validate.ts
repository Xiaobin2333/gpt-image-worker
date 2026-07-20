import type { GenerateRequestBody } from "./types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface ParseLimits {
  promptMaxChars: number;
  referenceMaxCount: number;
  referenceMaxBytes: number;
  generationMaxN: number;
}

export function validateImageSize(size: string): string {
  if (size === "auto") return size;
  const m = /^(\d+)x(\d+)$/i.exec(size);
  if (!m) throw new ValidationError("size must be 'auto' or formatted as WIDTHxHEIGHT");
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width <= 0 || height <= 0) throw new ValidationError("size width and height must be positive");
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new ValidationError("size width and height must be multiples of 16");
  }
  if (Math.max(width, height) > 3840) {
    throw new ValidationError("size width and height must have max side <= 3840");
  }
  const aspect = Math.max(width / height, height / width);
  if (aspect > 3) throw new ValidationError("size aspect ratio must not exceed 3:1");
  const pixels = width * height;
  if (pixels < 655360 || pixels > 8294400) {
    throw new ValidationError("size total pixels must be between 655360 and 8294400");
  }
  return `${width}x${height}`;
}

const QUALITIES = new Set(["auto", "low", "medium", "high"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);
const RESPONSE_FORMATS = new Set(["b64_json", "url", "none"]);

interface PngInfo {
  width: number;
  height: number;
  colorType: number;
}

const PNG_BIT_DEPTHS: Record<number, Set<number>> = {
  0: new Set([1, 2, 4, 8, 16]),
  2: new Set([8, 16]),
  3: new Set([1, 2, 4, 8]),
  4: new Set([8, 16]),
  6: new Set([8, 16]),
};

function parsePngDataUrl(value: string, label: string): PngInfo {
  const match = /^data:image\/png;base64,(.+)$/i.exec(value);
  if (!match?.[1]) throw new ValidationError(`${label} must be a PNG data URL`);
  let binary: string;
  try {
    binary = atob(match[1]);
  } catch {
    throw new ValidationError(`${label} contains invalid base64 data`);
  }
  if (binary.length < 33) throw new ValidationError(`${label} is not a valid PNG image`);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => bytes[index] === byte)) {
    throw new ValidationError(`${label} is not a valid PNG image`);
  }
  const chunkType = String.fromCharCode(...bytes.subarray(12, 16));
  const ihdrLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
  if (chunkType !== "IHDR" || ihdrLength !== 13) {
    throw new ValidationError(`${label} has an invalid PNG header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) throw new ValidationError(`${label} has invalid dimensions`);
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const compression = bytes[26]!;
  const filter = bytes[27]!;
  const interlace = bytes[28]!;
  if (!PNG_BIT_DEPTHS[colorType]?.has(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) {
    throw new ValidationError(`${label} has an invalid PNG header`);
  }
  return { width, height, colorType };
}

export function parseGenerateBody(input: unknown, limits: ParseLimits): GenerateRequestBody {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Request body must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
  if (!prompt) throw new ValidationError("prompt is required");
  if (prompt.length > limits.promptMaxChars) {
    throw new ValidationError(`prompt exceeds ${limits.promptMaxChars} characters`);
  }

  const size = validateImageSize(typeof raw.size === "string" ? raw.size : "1024x1024");
  const model = typeof raw.model === "string" && raw.model ? raw.model : "gpt-image-2";

  const nValue = typeof raw.n === "number" ? raw.n : 1;
  if (!Number.isInteger(nValue) || nValue < 1 || nValue > limits.generationMaxN) {
    throw new ValidationError(`n must be an integer between 1 and ${limits.generationMaxN}`);
  }

  const quality = typeof raw.quality === "string" && QUALITIES.has(raw.quality) ? raw.quality : "auto";
  const output_format = typeof raw.output_format === "string" && FORMATS.has(raw.output_format)
    ? raw.output_format
    : "png";

  let output_compression: number | null = null;
  if (output_format !== "png") {
    if (typeof raw.output_compression === "number") {
      const c = raw.output_compression;
      if (!Number.isInteger(c) || c < 0 || c > 100) {
        throw new ValidationError("output_compression must be 0-100");
      }
      output_compression = c;
    } else {
      output_compression = 100;
    }
  }

  const response_format = typeof raw.response_format === "string" && RESPONSE_FORMATS.has(raw.response_format)
    ? (raw.response_format as GenerateRequestBody["response_format"])
    : "b64_json";

  let reference_images: string[] | undefined;
  if (Array.isArray(raw.reference_images)) {
    if (limits.referenceMaxCount === 0) {
      throw new ValidationError("reference images are disabled");
    }
    const candidates = raw.reference_images
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .slice(0, limits.referenceMaxCount);
    const perImageMaxChars = Math.ceil(limits.referenceMaxBytes * 4 / 3) + 64;
    const totalMaxBytes = limits.referenceMaxBytes * Math.max(1, limits.referenceMaxCount);
    const totalMaxChars = Math.ceil(totalMaxBytes * 4 / 3) + 256;
    let totalChars = 0;
    for (const ref of candidates) {
      if (ref.length > perImageMaxChars) {
        throw new ValidationError(`reference image exceeds ${Math.round(limits.referenceMaxBytes / (1024 * 1024))}MB`);
      }
      totalChars += ref.length;
    }
    if (totalChars > totalMaxChars) {
      throw new ValidationError(`reference images exceed total size limit`);
    }
    reference_images = candidates.length === 0 ? undefined : candidates;
  }

  let mask: string | undefined;
  if (typeof raw.mask === "string" && raw.mask.length > 0) {
    if (!reference_images || reference_images.length === 0) {
      throw new ValidationError("mask requires at least one reference image");
    }
    const perImageMaxChars = Math.ceil(limits.referenceMaxBytes * 4 / 3) + 64;
    if (raw.mask.length > perImageMaxChars) {
      throw new ValidationError(`mask exceeds ${Math.round(limits.referenceMaxBytes / (1024 * 1024))}MB`);
    }
    const maskInfo = parsePngDataUrl(raw.mask, "mask");
    if (maskInfo.colorType !== 4 && maskInfo.colorType !== 6) {
      throw new ValidationError("mask PNG must contain an alpha channel");
    }
    const referenceInfo = parsePngDataUrl(reference_images[0]!, "the first reference image");
    if (referenceInfo.width !== maskInfo.width || referenceInfo.height !== maskInfo.height) {
      throw new ValidationError("mask and first reference image must have the same dimensions");
    }
    mask = raw.mask;
  }

  const is_public = raw.is_public === undefined ? true : Boolean(raw.is_public);

  return {
    prompt,
    size,
    model,
    n: nValue,
    quality: quality as GenerateRequestBody["quality"],
    output_format: output_format as GenerateRequestBody["output_format"],
    output_compression,
    response_format,
    reference_images,
    mask,
    is_public,
  };
}
