export interface Bindings {
  ASSETS: Fetcher;
  IMAGES: R2Bucket;
  SETTINGS: KVNamespace;
  DB: D1Database;
  DEFAULT_API_URL: string;
  DEFAULT_API_KEY?: string;
  DEFAULT_API_PATH: string;
  DEFAULT_RESPONSES_MODEL: string;
  ACCESS_KEY?: string;
  ADMIN_KEY?: string;
  ACCESS_KEY_COOKIE_NAME: string;
  ADMIN_KEY_COOKIE_NAME: string;
  OWNER_COOKIE_NAME: string;
  ACCESS_KEY_SESSION_MINUTES: string;
  ADMIN_KEY_SESSION_MINUTES: string;
  IP_ALLOWLIST: string;
  TRUST_PROXY_HEADERS: string;
  MAX_FILE_SIZE_MB: string;
  R2_PUBLIC_DOMAIN: string;
  GITHUB_REPO?: string;
}

export type ApiPath = "/v1/images/generations" | "/v1/responses";

export interface RuntimeSettings {
  api_url: string;
  api_key: string;
  api_path: ApiPath;
}

export type ResponseFormat = "b64_json" | "url" | "none";

export interface GenerateRequestBody {
  prompt: string;
  size: string;
  model: string;
  n: number;
  quality: "auto" | "low" | "medium" | "high";
  output_format: "png" | "jpeg" | "webp";
  output_compression?: number | null;
  response_format?: ResponseFormat;
  reference_images?: string[];
  is_public?: boolean;
}

export interface GalleryEntry {
  id: string;
  prompt: string;
  size: string;
  filename: string;
  image_url?: string;
  created_at: string;
  model?: string;
  quality?: string;
  output_format?: string;
  output_compression?: number | null;
  response_format?: string;
  n?: number;
  api_path?: string;
  api_preset_name?: string;
  image_width?: number | null;
  image_height?: number | null;
  duration?: string;
  is_public: boolean;
  has_reference?: boolean;
  owner_id?: string;
}

export interface GeneratedImage {
  id: string;
  filename: string;
  image_url: string;
}

export interface GenerateResponse {
  id: string;
  status: "success";
  image_url: string;
  filename?: string;
  images: GeneratedImage[];
  prompt: string;
  size: string;
  created_at: string;
  model?: string;
  quality?: string;
  output_format?: string;
  output_compression?: number | null;
  response_format?: string;
  n?: number;
  api_path?: string;
  api_preset_name?: string;
  image_width?: number | null;
  image_height?: number | null;
  duration?: string;
  is_public: boolean;
}

export type JobStatus = "queued" | "running" | "success" | "error";

export interface GenerateJob {
  id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  prompt: string;
  result?: GenerateResponse;
  detail?: string;
  owner_id?: string;
  produced_ids?: string[];
}

export interface GenerateJobSnapshot {
  api_url: string;
  api_key: string;
  api_path: string;
  api_preset_name: string;
  max_file_size_mb: number;
  r2_public_domain: string;
  responses_concurrency?: number;
}

export interface GenerateJobInput {
  payload: GenerateRequestBody;
  owner_id?: string;
  snapshot?: GenerateJobSnapshot;
}
