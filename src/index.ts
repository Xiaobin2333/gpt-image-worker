import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import {
  createAccessToken,
  generateOwnerId,
  getClientIp,
  getOwnerId,
  isAdminRequest,
  isIpAllowed,
  isUnlocked,
  verifyAccessToken,
} from "./auth";
import { callImageGeneration } from "./proxy";
import {
  cancelGenerateJob,
  deleteAllGallery,
  deleteGalleryEntry,
  getEntry,
  getEntryByFilename,
  getGalleryPage,
  getImage,
  getJob,
  getPendingJobInput,
  finishClaimedJob,
  offloadLargePayloadAssets,
  inflateJobInput,
  deleteJobTmpAssets,
  pruneOrphanTmpAssets,
  listActiveJobs,
  listPendingJobIds,
  listProducedEntries,
  pruneOldJobs,
  pruneOrphanImages,
  renewJobLease,
  saveJob,
  setGalleryFavorite,
  tryClaimJob,
  updateGalleryEntry,
} from "./storage";
import { LIMITS_BOUNDS, activateApiPreset, createApiPreset, deleteApiPreset, getActivePresetFromState, loadAccessLock, loadApiSettingsState, loadRateLimitConfig, loadRuntimeLimits, loadSettings, loadTurnstileConfig, maskKey, normalizeApiPath, parseModelIds, saveAccessLock, saveRateLimitConfig, saveRuntimeLimits, saveSettings, saveTurnstileConfig, type ApiPreset, type ApiSettingsState } from "./settings";
import { verifyTurnstileToken } from "./turnstile";
import { checkRateLimit, pruneRateLimits } from "./ratelimit";
import type { ApiPath, Bindings, GalleryEntry, GenerateJob, GenerateJobInput, GenerateJobSnapshot, GenerateResponse } from "./types";
import { parseGenerateBody, ValidationError } from "./validate";
import { getCookie } from "hono/cookie";
import { APP_VERSION } from "./version.generated";

type RequestVars = {
  cache_access?: Promise<Awaited<ReturnType<typeof loadAccessLock>>>;
  cache_turnstile?: Promise<Awaited<ReturnType<typeof loadTurnstileConfig>>>;
  cache_ratelimit?: Promise<Awaited<ReturnType<typeof loadRateLimitConfig>>>;
  cache_limits?: Promise<Awaited<ReturnType<typeof loadRuntimeLimits>>>;
  cache_api_state?: Promise<Awaited<ReturnType<typeof loadApiSettingsState>>>;
};

const app = new Hono<{ Bindings: Bindings; Variables: RequestVars }>();
type AppContext = Context<{ Bindings: Bindings; Variables: RequestVars }>;

function cachedAccessLock(c: AppContext) {
  let p = c.get("cache_access");
  if (!p) { p = loadAccessLock(c.env); c.set("cache_access", p); }
  return p;
}
function cachedTurnstile(c: AppContext) {
  let p = c.get("cache_turnstile");
  if (!p) { p = loadTurnstileConfig(c.env); c.set("cache_turnstile", p); }
  return p;
}
function cachedRateLimit(c: AppContext) {
  let p = c.get("cache_ratelimit");
  if (!p) { p = loadRateLimitConfig(c.env); c.set("cache_ratelimit", p); }
  return p;
}
function cachedLimits(c: AppContext) {
  let p = c.get("cache_limits");
  if (!p) { p = loadRuntimeLimits(c.env); c.set("cache_limits", p); }
  return p;
}
function cachedApiState(c: AppContext) {
  let p = c.get("cache_api_state");
  if (!p) { p = loadApiSettingsState(c.env); c.set("cache_api_state", p); }
  return p;
}

function jsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ status: "error", detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const ip = getClientIp(c);
  if (!isIpAllowed(c.env, ip)) {
    return jsonError(403, "IP address is not allowed");
  }
  return next();
});

function isPublicPath(path: string): boolean {
  if (path === "/health") return true;
  if (path === "/api/session" || path === "/api/access") return true;
  if (path === "/api/version") return true;
  if (path === "/api/admin/login" || path === "/api/admin/logout") return true;
  return !path.startsWith("/api/");
}

app.use("*", async (c, next) => {
  if (!isPublicPath(c.req.path)) {
    if (!(await isUnlocked(c))) return jsonError(401, "Site access required");
  }
  return next();
});

const OWNER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

function publicImageUrl(domain: string, filename: string): string | null {
  if (!domain) return null;
  return `https://${domain}/${encodeURIComponent(filename)}`;
}

function imageUrlFor(domain: string, entry: Pick<GalleryEntry, "filename" | "is_public">): string {
  if (entry.is_public) {
    const direct = publicImageUrl(domain, entry.filename);
    if (direct) return direct;
  }
  return `/api/image/${entry.filename}`;
}

function buildGenerateResponse(domain: string, entries: GalleryEntry[]): GenerateResponse {
  const primary = entries[0]!;
  const images = entries.map((entry) => ({
    id: entry.id,
    filename: entry.filename,
    image_url: imageUrlFor(domain, entry),
  }));
  return {
    id: primary.id,
    status: "success",
    image_url: images[0]!.image_url,
    filename: primary.filename,
    images,
    prompt: primary.prompt,
    size: primary.size,
    created_at: primary.created_at,
    model: primary.model,
    quality: primary.quality,
    output_format: primary.output_format,
    output_compression: primary.output_compression ?? null,
    response_format: primary.response_format,
    n: primary.n,
    api_path: primary.api_path,
    api_preset_name: primary.api_preset_name,
    image_width: primary.image_width ?? null,
    image_height: primary.image_height ?? null,
    duration: primary.duration,
    byte_size: primary.byte_size ?? null,
    is_public: primary.is_public,
  };
}

async function ensureOwnerCookie(c: AppContext): Promise<string> {
  let owner = getOwnerId(c);
  if (!owner) owner = generateOwnerId();
  const url = new URL(c.req.url);
  const secure = url.protocol === "https:";
  setCookie(c, c.env.OWNER_COOKIE_NAME, owner, {
    maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: secure ? "None" : "Lax",
    secure,
    path: "/",
  });
  return owner;
}

app.onError((err, c) => {
  if (err instanceof ValidationError) return jsonError(400, err.message);
  const message = err instanceof Error ? err.message : String(err);
  console.error("unhandled error", { path: c.req.path, error: message, stack: err instanceof Error ? err.stack : undefined });
  return jsonError(500, message || "Internal Server Error");
});

app.get("/health", (c) =>
  c.json({ status: "ok", time: new Date().toISOString() }),
);

app.get("/api/version", (c) => {
  const repo = (c.env.GITHUB_REPO ?? "").trim();
  const releaseUrl = repo ? `https://github.com/${repo}/releases/latest` : null;
  const etag = `W/"${APP_VERSION}"`;
  if (c.req.header("If-None-Match") === etag) {
    c.header("Cache-Control", "public, max-age=300");
    c.header("ETag", etag);
    return c.body(null, 304);
  }
  c.header("Cache-Control", "public, max-age=300");
  c.header("ETag", etag);
  return c.json({ version: APP_VERSION, github_repo: repo, release_url: releaseUrl });
});

function constantTimeEq(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ea.byteLength; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

app.get("/api/session", async (c) => {
  const [lock, turnstile, limits, apiState] = await Promise.all([
    cachedAccessLock(c),
    cachedTurnstile(c),
    cachedLimits(c),
    cachedApiState(c),
  ]);
  const activePreset = getActivePresetFromState(apiState);
  const accessRequired = !!lock.enabled && !!lock.key;
  let accessAuthed = !accessRequired;
  let accessExpires: Date | null = null;
  if (accessRequired) {
    const cookie = getCookie(c, c.env.ACCESS_KEY_COOKIE_NAME);
    accessExpires = await verifyAccessToken(c.env, cookie, "access");
    accessAuthed = accessExpires !== null;
  }
  const adminAvailable = !!c.env.ADMIN_KEY;
  let adminExpires: Date | null = null;
  let isAdmin = false;
  if (adminAvailable) {
    const cookie = getCookie(c, c.env.ADMIN_KEY_COOKIE_NAME);
    adminExpires = await verifyAccessToken(c.env, cookie, "admin");
    isAdmin = adminExpires !== null;
  }
  if (isAdmin) accessAuthed = true;
  c.header("Cache-Control", "no-store");
  return c.json({
    access_required: accessRequired,
    authenticated: accessAuthed,
    access_expires_at: accessExpires ? accessExpires.toISOString() : null,
    admin_available: adminAvailable,
    is_admin: isAdmin,
    admin_expires_at: adminExpires ? adminExpires.toISOString() : null,
    models: activePreset.models,
    turnstile: turnstile.enabled && turnstile.site_key
      ? { enabled: true, site_key: turnstile.site_key }
      : { enabled: false, site_key: "" },
    limits: {
      prompt_max_chars: limits.prompt_max_chars,
      reference_max_count: limits.reference_max_count,
      reference_max_mb: limits.reference_max_mb,
      generation_max_n: limits.generation_max_n,
    },
  });
});

app.post("/api/access", async (c) => {
  const lock = await cachedAccessLock(c);
  if (!lock.enabled || !lock.key) {
    return c.json({ access_required: false, authenticated: true, expires_at: null });
  }
  let body: { access_key?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const provided = typeof body.access_key === "string" ? body.access_key : "";
  if (!provided || !constantTimeEq(provided, lock.key)) {
    return jsonError(401, "Invalid access key");
  }

  const limits = await cachedLimits(c);
  const minutes = limits.access_session_minutes;
  const { token, expiresAt } = await createAccessToken(c.env, "access", minutes);
  const url = new URL(c.req.url);
  setCookie(c, c.env.ACCESS_KEY_COOKIE_NAME, token, {
    maxAge: minutes * 60,
    httpOnly: true,
    sameSite: "Lax",
    secure: url.protocol === "https:",
    path: "/",
  });
  return c.json({
    access_required: true,
    authenticated: true,
    expires_at: expiresAt.toISOString(),
  });
});

app.get("/api/admin/access-lock", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const lock = await loadAccessLock(c.env);
  c.header("Cache-Control", "private, max-age=10");
  return c.json({
    enabled: lock.enabled,
    key_set: !!lock.key,
    key_masked: maskKey(lock.key),
  });
});

app.post("/api/admin/access-lock", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let body: { enabled?: unknown; key?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const enabled = body.enabled === true;
  const key = body.key === undefined ? null
    : body.key === null ? null
    : typeof body.key === "string" ? body.key.trim()
    : null;
  if (enabled) {
    const current = await loadAccessLock(c.env);
    const finalKey = key === null ? current.key : key;
    if (!finalKey) return jsonError(400, "Access key is required when enabling site access protection");
  }
  const next = await saveAccessLock(c.env, { enabled, key });
  return c.json({ enabled: next.enabled, key_set: !!next.key, key_masked: maskKey(next.key) });
});

app.get("/api/admin/turnstile", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const cfg = await loadTurnstileConfig(c.env);
  c.header("Cache-Control", "private, max-age=10");
  return c.json({
    enabled: cfg.enabled,
    site_key: cfg.site_key,
    secret_key_set: !!cfg.secret_key,
    secret_key_masked: maskKey(cfg.secret_key),
  });
});

app.post("/api/admin/turnstile", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let body: { enabled?: unknown; site_key?: unknown; secret_key?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const enabled = body.enabled === true;
  const siteKey = body.site_key === undefined ? null
    : body.site_key === null ? null
    : typeof body.site_key === "string" ? body.site_key.trim()
    : null;
  const secretKey = body.secret_key === undefined ? null
    : body.secret_key === null ? null
    : typeof body.secret_key === "string" ? body.secret_key.trim()
    : null;
  if (enabled) {
    const current = await loadTurnstileConfig(c.env);
    const finalSite = siteKey === null ? current.site_key : siteKey;
    const finalSecret = secretKey === null ? current.secret_key : secretKey;
    if (!finalSite || !finalSecret) {
      return jsonError(400, "Site key and secret key are required when enabling Turnstile");
    }
  }
  const next = await saveTurnstileConfig(c.env, { enabled, site_key: siteKey, secret_key: secretKey });
  return c.json({
    enabled: next.enabled,
    site_key: next.site_key,
    secret_key_set: !!next.secret_key,
    secret_key_masked: maskKey(next.secret_key),
  });
});

app.get("/api/admin/rate-limit", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const cfg = await loadRateLimitConfig(c.env);
  c.header("Cache-Control", "private, max-age=10");
  return c.json(cfg);
});

app.post("/api/admin/rate-limit", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let body: { enabled?: unknown; limit?: unknown; window_seconds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const enabled = body.enabled === true;
  const limit = typeof body.limit === "number" ? body.limit : null;
  const windowSeconds = typeof body.window_seconds === "number" ? body.window_seconds : null;
  const next = await saveRateLimitConfig(c.env, { enabled, limit, window_seconds: windowSeconds });
  return c.json(next);
});

app.post("/api/admin/cleanup-orphans", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const result = await pruneOrphanImages(c.env);
  return c.json({ status: "ok", ...result });
});

app.get("/api/admin/limits", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const limits = await loadRuntimeLimits(c.env);
  c.header("Cache-Control", "private, max-age=10");
  return c.json({ ...limits, bounds: LIMITS_BOUNDS });
});

app.post("/api/admin/limits", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let body: Partial<{
    r2_public_domain: unknown;
    prompt_max_chars: unknown;
    reference_max_count: unknown;
    reference_max_mb: unknown;
    generation_max_n: unknown;
    max_file_size_mb: unknown;
    responses_model: unknown;
    responses_concurrency: unknown;
    access_session_minutes: unknown;
    admin_session_minutes: unknown;
    prompt_helper_model: unknown;
  }>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.r2_public_domain === "string") patch.r2_public_domain = body.r2_public_domain;
  if (typeof body.prompt_max_chars === "number") patch.prompt_max_chars = body.prompt_max_chars;
  if (typeof body.reference_max_count === "number") patch.reference_max_count = body.reference_max_count;
  if (typeof body.reference_max_mb === "number") patch.reference_max_mb = body.reference_max_mb;
  if (typeof body.generation_max_n === "number") patch.generation_max_n = body.generation_max_n;
  if (typeof body.max_file_size_mb === "number") patch.max_file_size_mb = body.max_file_size_mb;
  if (typeof body.responses_model === "string") patch.responses_model = body.responses_model;
  if (typeof body.responses_concurrency === "number") patch.responses_concurrency = body.responses_concurrency;
  if (typeof body.access_session_minutes === "number") patch.access_session_minutes = body.access_session_minutes;
  if (typeof body.admin_session_minutes === "number") patch.admin_session_minutes = body.admin_session_minutes;
  if (typeof body.prompt_helper_model === "string") patch.prompt_helper_model = body.prompt_helper_model;
  const next = await saveRuntimeLimits(c.env, patch);
  return c.json({ ...next, bounds: LIMITS_BOUNDS });
});

app.post("/api/admin/login", async (c) => {
  if (!c.env.ADMIN_KEY) {
    return jsonError(503, "ADMIN_KEY is not configured");
  }
  let body: { admin_key?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const provided = typeof body.admin_key === "string" ? body.admin_key : "";
  if (!provided || !constantTimeEq(provided, c.env.ADMIN_KEY)) {
    return jsonError(401, "Invalid admin key");
  }

  const limits = await cachedLimits(c);
  const minutes = limits.admin_session_minutes;
  const { token, expiresAt } = await createAccessToken(c.env, "admin", minutes);
  const url = new URL(c.req.url);
  setCookie(c, c.env.ADMIN_KEY_COOKIE_NAME, token, {
    maxAge: minutes * 60,
    httpOnly: true,
    sameSite: "Lax",
    secure: url.protocol === "https:",
    path: "/",
  });
  return c.json({ admin_available: true, is_admin: true, expires_at: expiresAt.toISOString() });
});

app.post("/api/admin/logout", (c) => {
  const url = new URL(c.req.url);
  setCookie(c, c.env.ADMIN_KEY_COOKIE_NAME, "", {
    maxAge: 0,
    httpOnly: true,
    sameSite: "Lax",
    secure: url.protocol === "https:",
    path: "/",
  });
  return c.json({ admin_available: !!c.env.ADMIN_KEY, is_admin: false, expires_at: null });
});

async function requireAdmin(c: AppContext): Promise<Response | null> {
  if (!c.env.ADMIN_KEY) return jsonError(503, "ADMIN_KEY is not configured; admin features disabled");
  const ok = await isAdminRequest(c);
  if (!ok) return jsonError(401, "Admin authentication required");
  return null;
}

function serializePreset(preset: ApiPreset) {
  return {
    id: preset.id,
    name: preset.name,
    api_url: preset.api_url,
    api_path: preset.api_path,
    models: preset.models,
    api_key_masked: maskKey(preset.api_key),
    has_api_key: !!preset.api_key,
  };
}

function buildSettingsResponse(state: ApiSettingsState) {
  const active = getActivePresetFromState(state);
  return {
    active_preset_id: active.id,
    api_url: active.api_url,
    api_key_masked: maskKey(active.api_key),
    has_api_key: !!active.api_key,
    api_path: active.api_path,
    models: active.models,
    presets: state.presets.map(serializePreset),
  };
}

app.get("/api/settings", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const state = await loadApiSettingsState(c.env);
  c.header("Cache-Control", "private, max-age=10");
  return c.json(buildSettingsResponse(state));
});

app.post("/api/settings", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let raw: Record<string, unknown>;
  try {
    raw = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const apiUrl = typeof raw.api_url === "string" ? raw.api_url : "";
  if (!apiUrl) return jsonError(400, "api_url is required");
  const apiKey = raw.api_key === undefined ? null
    : raw.api_key === null ? null
    : typeof raw.api_key === "string" ? raw.api_key
    : null;
  const apiPath = normalizeApiPath(typeof raw.api_path === "string" ? raw.api_path : undefined);
  const activePresetId = typeof raw.active_preset_id === "string" ? raw.active_preset_id : null;
  const presetName = typeof raw.preset_name === "string" ? raw.preset_name : null;
  let models: string[] | null = null;
  if (raw.models !== undefined) {
    try {
      models = parseModelIds(raw.models);
    } catch (error) {
      return jsonError(400, error instanceof Error ? error.message : "Invalid models");
    }
  }
  await saveSettings(c.env, {
    active_preset_id: activePresetId,
    preset_name: presetName,
    api_url: apiUrl,
    api_key: apiKey,
    api_path: apiPath,
    models,
  });
  const state = await loadApiSettingsState(c.env);
  return c.json(buildSettingsResponse(state));
});

app.post("/api/settings/presets", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let raw: Record<string, unknown>;
  try {
    raw = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const name = typeof raw.name === "string" ? raw.name : null;
  const apiUrl = typeof raw.api_url === "string" ? raw.api_url : null;
  const apiKey = typeof raw.api_key === "string" ? raw.api_key : null;
  const apiPath = typeof raw.api_path === "string" ? raw.api_path : null;
  const sourcePresetId = typeof raw.source_preset_id === "string" ? raw.source_preset_id : null;
  const { state } = await createApiPreset(c.env, {
    name,
    api_url: apiUrl,
    api_key: apiKey,
    api_path: apiPath,
    source_preset_id: sourcePresetId,
  });
  return c.json(buildSettingsResponse(state));
});

app.post("/api/settings/presets/:id/activate", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const state = await activateApiPreset(c.env, id);
  if (!state) return jsonError(404, "Preset not found");
  return c.json(buildSettingsResponse(state));
});

app.delete("/api/settings/presets/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const { state, error } = await deleteApiPreset(c.env, id);
  if (!state) {
    const status = error === "Preset not found" ? 404 : 400;
    return jsonError(status, error ?? "Failed to delete preset");
  }
  return c.json(buildSettingsResponse(state));
});

type JobRunContext = {
  api_url: string;
  api_key: string;
  api_path: string;
  api_preset_name: string;
  max_file_size_mb: number;
  r2_public_domain: string;
  responses_concurrency: number;
};

const JOB_LEASE_RENEW_MS = 45_000;

function startJobExecutionMonitor(
  env: Bindings,
  jobId: string,
  claimToken: string,
  controller: AbortController,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const active = await renewJobLease(env, jobId, claimToken);
        if (!active) {
          stopped = true;
          controller.abort(new Error("Generation job cancelled"));
          return;
        }
      } catch (err) {
        console.error("job lease renewal failed", {
          jobId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (!stopped) schedule();
    }, JOB_LEASE_RENEW_MS);
  };

  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

async function resolveJobContext(env: Bindings, input: GenerateJobInput | null): Promise<JobRunContext> {
  if (input?.snapshot) {
    const responsesConcurrency = input.snapshot.responses_concurrency
      ?? (await loadRuntimeLimits(env)).responses_concurrency;
    return {
      ...input.snapshot,
      responses_concurrency: responsesConcurrency,
    };
  }
  const [apiState, limits] = await Promise.all([loadApiSettingsState(env), loadRuntimeLimits(env)]);
  const active = getActivePresetFromState(apiState);
  return {
    api_url: active.api_url,
    api_key: active.api_key,
    api_path: active.api_path,
    api_preset_name: active.name || "",
    max_file_size_mb: limits.max_file_size_mb,
    r2_public_domain: limits.r2_public_domain,
    responses_concurrency: limits.responses_concurrency,
  };
}

type ClaimedJobOutcome =
  | { status: "success"; result: GenerateResponse }
  | { status: "error"; detail: string }
  | { status: "lost" };

async function executeClaimedJob(
  env: Bindings,
  claimed: GenerateJob,
  claimToken: string,
  source: "stream" | "cron",
): Promise<ClaimedJobOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  const stopExecutionMonitor = startJobExecutionMonitor(env, claimed.id, claimToken, controller);
  let finalized = false;
  let input: GenerateJobInput | null = null;
  let runContext: JobRunContext | null = null;

  const finish = async (status: "success" | "error", values: { result?: GenerateResponse; detail?: string }) => {
    const committed = await finishClaimedJob(env, {
      ...claimed,
      status,
      updated_at: new Date().toISOString(),
      result: values.result,
      detail: values.detail,
    }, claimToken);
    if (committed) finalized = true;
    return committed;
  };

  try {
    const rawInput = await getPendingJobInput(env, claimed.id);
    input = rawInput ? await inflateJobInput(env, rawInput) : null;
    runContext = await resolveJobContext(env, input);

    const producedIds = claimed.produced_ids ?? [];
    const existingEntries = producedIds.length > 0 ? await listProducedEntries(env, producedIds) : [];
    const targetN = input?.payload.n ?? Math.max(1, existingEntries.length);
    if (existingEntries.length >= targetN && targetN > 0) {
      const result = buildGenerateResponse(runContext.r2_public_domain, existingEntries.slice(0, targetN));
      return await finish("success", { result }) ? { status: "success", result } : { status: "lost" };
    }

    if (!input) {
      if (existingEntries.length > 0) {
        const result = buildGenerateResponse(runContext.r2_public_domain, existingEntries);
        return await finish("success", { result }) ? { status: "success", result } : { status: "lost" };
      }
      const detail = "Pending input missing";
      return await finish("error", { detail }) ? { status: "error", detail } : { status: "lost" };
    }

    if (!runContext.api_url || !runContext.api_key) {
      const detail = "API not configured";
      return await finish("error", { detail }) ? { status: "error", detail } : { status: "lost" };
    }

    const startedAt = Date.now();
    const entries = await callImageGeneration(
      env,
      { api_url: runContext.api_url, api_key: runContext.api_key, api_path: runContext.api_path as ApiPath },
      input.payload,
      input.owner_id,
      controller.signal,
      {
        jobId: claimed.id,
        existingEntries,
        maxFileSizeMb: runContext.max_file_size_mb,
        apiPresetName: runContext.api_preset_name || undefined,
        responsesConcurrency: runContext.responses_concurrency,
        claimToken,
      },
    );
    if (entries.length === 0) throw new Error("No images returned by upstream");
    const duration = `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
    const firstNew = entries.find((entry) => !existingEntries.some((existing) => existing.id === entry.id));
    if (firstNew) {
      await updateGalleryEntry(env, firstNew.id, { duration }).catch((error: unknown) =>
        console.error("updateGalleryEntry failed", {
          jobId: claimed.id,
          id: firstNew.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      firstNew.duration = duration;
    }
    const result = buildGenerateResponse(runContext.r2_public_domain, entries);
    return await finish("success", { result }) ? { status: "success", result } : { status: "lost" };
  } catch (error) {
    const current = await getJob(env, claimed.id);
    if (current?.claim_token === claimToken && (current.status === "success" || current.status === "error")) {
      finalized = true;
      if (current.status === "success" && current.result) return { status: "success", result: current.result };
      return { status: "error", detail: current.detail ?? "unknown" };
    }
    const ownsClaim = current?.status === "running" && current.claim_token === claimToken;
    if (!ownsClaim) return { status: "lost" };

    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${source} job failed`, {
      jobId: claimed.id,
      detail,
      error_type: error instanceof Error ? error.name : typeof error,
      api_url: runContext?.api_url,
      api_path: runContext?.api_path,
      model: input?.payload.model,
      size: input?.payload.size,
      quality: input?.payload.quality,
      output_format: input?.payload.output_format,
      response_format: input?.payload.response_format,
      n: input?.payload.n,
    });
    return await finish("error", { detail }) ? { status: "error", detail } : { status: "lost" };
  } finally {
    clearTimeout(timer);
    stopExecutionMonitor();
    if (finalized) await deleteJobTmpAssets(env, claimed.id).catch(() => {});
  }
}

app.post("/api/generate", async (c) => {
  const [bodyTextOrErr, apiState, rlConfig, turnstile, limits] = await Promise.all([
    c.req.text().catch((e) => e instanceof Error ? e : new Error(String(e))),
    cachedApiState(c),
    cachedRateLimit(c),
    cachedTurnstile(c),
    cachedLimits(c),
  ]);
  const activePreset = getActivePresetFromState(apiState);
  const settings = { api_url: activePreset.api_url, api_key: activePreset.api_key, api_path: activePreset.api_path };
  if (bodyTextOrErr instanceof Error) return jsonError(400, "Request body must be readable");
  if (!settings.api_url) return jsonError(400, "API URL not configured. Please set it in Settings.");
  if (!settings.api_key) return jsonError(400, "API Key not configured. Please set it in Settings.");

  let raw: unknown;
  try {
    raw = JSON.parse(bodyTextOrErr);
  } catch {
    return jsonError(400, "Request body must be JSON");
  }

  const adminBypass = await isAdminRequest(c);

  if (!adminBypass && rlConfig.enabled) {
    const ip = getClientIp(c) || "unknown";
    const rl = await checkRateLimit(c.env, "gen:" + ip, rlConfig.limit, rlConfig.window_seconds);
    if (!rl.allowed) {
      const headers: Record<string, string> = { "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSeconds) };
      return new Response(JSON.stringify({ status: "error", detail: `Rate limit exceeded. Try again in ${rl.retryAfterSeconds}s.` }), { status: 429, headers });
    }
  }

  const adminMaxN = LIMITS_BOUNDS.generation_max_n.max;
  const generationMaxN = adminBypass ? adminMaxN : limits.generation_max_n;
  const payload = parseGenerateBody(raw, {
    promptMaxChars: limits.prompt_max_chars,
    referenceMaxCount: limits.reference_max_count,
    referenceMaxBytes: limits.reference_max_mb * 1024 * 1024,
    generationMaxN,
  });
  if (settings.api_path === "/v1/responses" && (payload.reference_images?.length || payload.mask)) {
    return jsonError(400, "Reference images and masks require the Images API path");
  }
  const turnstileToken = typeof (raw as { turnstile_token?: unknown })?.turnstile_token === "string"
    ? ((raw as { turnstile_token?: string }).turnstile_token as string).trim()
    : "";

  if (turnstile.enabled && turnstile.secret_key && !adminBypass) {
    if (!turnstileToken) return jsonError(400, "Captcha required");
    const ip = getClientIp(c);
    const result = await verifyTurnstileToken(turnstile.secret_key, turnstileToken, ip);
    if (!result.success) {
      console.warn("turnstile verify failed", { codes: result.errorCodes });
      return jsonError(403, "Captcha verification failed");
    }
  }

  const owner = await ensureOwnerCookie(c);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const initial: GenerateJob = {
    id: jobId,
    status: "queued",
    created_at: now,
    updated_at: now,
    prompt: payload.prompt,
    owner_id: owner,
  };
  const snapshot: GenerateJobSnapshot = {
    api_url: settings.api_url,
    api_key: settings.api_key,
    api_path: settings.api_path,
    api_preset_name: activePreset.name || "",
    max_file_size_mb: limits.max_file_size_mb,
    r2_public_domain: limits.r2_public_domain,
    responses_concurrency: limits.responses_concurrency,
  };
  const persistedInput = await offloadLargePayloadAssets(c.env, jobId, { payload, owner_id: owner, snapshot });
  await saveJob(c.env, initial, persistedInput);

  return c.json({ job_id: jobId, status: "queued" }, 202);
});

app.get("/api/generate/jobs", async (c) => {
  const admin = await isAdminRequest(c);
  const owner = getOwnerId(c);
  if (!admin && !owner) {
    c.header("Cache-Control", "no-store");
    return c.json([]);
  }
  const jobs = await listActiveJobs(c.env, admin ? undefined : owner);
  const items = jobs.map((job) => {
    const payload = job.payload?.payload;
    return {
      job_id: job.id,
      status: job.status,
      stage: job.status,
      message: job.status === "queued" ? "Queued" : "Running",
      operation: "generation",
      prompt: job.prompt,
      size: payload?.size,
      model: payload?.model,
      quality: payload?.quality,
      output_format: payload?.output_format,
      output_compression: payload?.output_compression ?? null,
      response_format: payload?.response_format,
      n: payload?.n,
      api_path: job.payload?.snapshot?.api_path,
      api_preset_name: job.payload?.snapshot?.api_preset_name || undefined,
      created_at: job.created_at,
      updated_at: job.updated_at,
    };
  });
  c.header("Cache-Control", "no-store");
  return c.json(items);
});

app.delete("/api/generate/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const admin = await isAdminRequest(c);
  const owner = getOwnerId(c);
  const result = await cancelGenerateJob(c.env, jobId, admin ? undefined : owner);
  if (result.status === "not_found") return jsonError(404, "Generation job not found");
  if (result.status === "forbidden") return jsonError(404, "Generation job not found");
  if (result.status === "already_finished") return jsonError(409, "Generation job already finished");
  await deleteJobTmpAssets(c.env, jobId).catch(() => {});
  return c.json({ status: "success", message: "Generation job cancelled" });
});

app.get("/api/generate/:jobId/stream", async (c) => {
  const jobId = c.req.param("jobId");
  const job = await getJob(c.env, jobId);
  if (!job) return jsonError(404, "Job not found or expired");
  const owner = getOwnerId(c);
  const admin = await isAdminRequest(c);
  if (job.owner_id && job.owner_id !== owner && !admin) {
    return jsonError(404, "Job not found or expired");
  }

  const env = c.env;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };
      const send = (line: string) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(line)); } catch { close(); }
      };
      const sendEvent = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { send(`: heartbeat\n\n`); } catch { close(); }
      }, 45_000);

      try {
        if (job.status === "success" && job.result) {
          sendEvent("done", { result: job.result });
          return;
        }
        if (job.status === "error") {
          sendEvent("error", { detail: job.detail ?? "unknown" });
          return;
        }

        const claimed = await tryClaimJob(env, jobId);
        if (!claimed) {
          sendEvent("waiting", { reason: "another-worker-running" });
          return;
        }
        const claimToken = claimed.claim_token;
        if (!claimToken) {
          sendEvent("error", { detail: "Generation claim token missing" });
          return;
        }

        sendEvent("running", { updated_at: claimed.updated_at });
        const outcome = await executeClaimedJob(env, claimed, claimToken, "stream");
        if (outcome.status === "success") sendEvent("done", { result: outcome.result });
        else if (outcome.status === "error") sendEvent("error", { detail: outcome.detail });
        else sendEvent("waiting", { reason: "job-lease-lost" });
      } finally {
        clearInterval(heartbeat);
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "Connection": "keep-alive",
    },
  });
});

app.get("/api/generate/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = await getJob(c.env, jobId);
  if (!job) return jsonError(404, "Job not found or expired");
  const owner = getOwnerId(c);
  const admin = await isAdminRequest(c);
  if (job.owner_id && job.owner_id !== owner && !admin) {
    return jsonError(404, "Job not found or expired");
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    job_id: job.id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    prompt: job.prompt,
    result: job.result ?? null,
    detail: job.detail ?? null,
  });
});

app.get("/api/gallery", async (c) => {
  const url = new URL(c.req.url);
  const page = Math.max(Number(url.searchParams.get("page") ?? "1") || 1, 1);
  const pageSize = Math.min(Math.max(Number(url.searchParams.get("page_size") ?? "9") || 9, 1), 100);
  const scope = url.searchParams.get("scope") ?? "default";
  const prompt = (url.searchParams.get("prompt") ?? "").trim().slice(0, 500);
  const model = (url.searchParams.get("model") ?? "").trim().slice(0, 200);
  const preset = (url.searchParams.get("preset") ?? "").trim().slice(0, 200);
  const size = (url.searchParams.get("size") ?? "").trim().slice(0, 100);
  const dateFrom = parseGalleryDate(url.searchParams.get("date_from"));
  const dateTo = parseGalleryDate(url.searchParams.get("date_to"));
  const admin = await isAdminRequest(c);
  const owner = getOwnerId(c);
  const includeAllPrivate = admin && scope === "all";

  const [result, limits] = await Promise.all([
    getGalleryPage(c.env, {
      page,
      pageSize,
      includeAllPrivate,
      ownerId: owner,
      prompt: prompt || undefined,
      model: model || undefined,
      preset: preset || undefined,
      size: size || undefined,
      dateFrom: dateFrom ?? undefined,
      dateToExclusive: dateTo ? nextGalleryDate(dateTo) : undefined,
      favorite: url.searchParams.get("favorite") === "true",
    }),
    cachedLimits(c),
  ]);
  const images = result.images.map((entry) => ({
    ...entry,
    image_url: imageUrlFor(limits.r2_public_domain, entry),
  }));
  c.header("Cache-Control", "private, max-age=5");
  c.header("Vary", "Cookie");
  return c.json({ ...result, images });
});

function parseGalleryDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function nextGalleryDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

app.patch("/api/gallery/:id/favorite", async (c) => {
  let body: { favorite?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  if (typeof body.favorite !== "boolean") return jsonError(400, "favorite must be a boolean");

  const id = c.req.param("id");
  const entry = await getEntry(c.env, id);
  if (!entry) return jsonError(404, "Gallery entry not found");
  const owner = getOwnerId(c);
  const admin = await isAdminRequest(c);
  if (!entry.is_public && entry.owner_id !== owner && !admin) {
    return jsonError(404, "Gallery entry not found");
  }

  const updated = await setGalleryFavorite(c.env, id, body.favorite);
  if (!updated) return jsonError(404, "Gallery entry not found");
  const limits = await cachedLimits(c);
  return c.json({
    ...updated,
    image_url: imageUrlFor(limits.r2_public_domain, updated),
  });
});

app.delete("/api/gallery", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const result = await deleteAllGallery(c.env);
  return c.json({
    status: "ok",
    message: `Deleted ${result.deleted_images} image file(s) and ${result.deleted_entries} gallery entries`,
    ...result,
  });
});

app.delete("/api/gallery/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const removed = await deleteGalleryEntry(c.env, id);
  if (!removed) return jsonError(404, "Gallery entry not found");
  return c.json({ status: "ok", message: "Gallery entry deleted" });
});

app.post("/api/admin/gallery/delete", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let body: { ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  if (!Array.isArray(body.ids)) return jsonError(400, "ids must be an array");
  const ids = body.ids
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim())
    .slice(0, 100);
  if (ids.length === 0) return jsonError(400, "ids must not be empty");
  let deleted = 0;
  const missing: string[] = [];
  for (const id of ids) {
    const removed = await deleteGalleryEntry(c.env, id);
    if (removed) deleted++;
    else missing.push(id);
  }
  return c.json({ status: "ok", deleted, missing });
});

const SAFE_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp)$/i;

async function serveImageObject(
  c: AppContext,
  filename: string,
  attachment: boolean,
): Promise<Response> {
  if (!SAFE_FILENAME_RE.test(filename)) return jsonError(404, "Image not found");
  const entry = await getEntryByFilename(c.env, filename);
  if (entry && !entry.is_public) {
    const admin = await isAdminRequest(c);
    const owner = getOwnerId(c);
    const isOwner = !!owner && entry.owner_id === owner;
    if (!admin && !isOwner) return jsonError(404, "Image not found");
  }

  let obj = await getImage(c.env, filename);
  if (!obj) {
    await new Promise((r) => setTimeout(r, 250));
    obj = await getImage(c.env, filename);
  }
  if (!obj) return jsonError(404, "Image not found");

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  if (attachment) {
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
    const ext = filename.split(".").pop() || "png";
    headers.set("Content-Disposition", `attachment; filename="gpt-image-${ts}.${ext}"`);
    headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  } else if (entry && !entry.is_public) {
    headers.set("Cache-Control", "private, max-age=86400");
  } else {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return new Response(obj.body, { headers });
}

app.get("/api/image/:filename", (c) => serveImageObject(c, c.req.param("filename"), false));
app.get("/api/download/:filename", (c) => serveImageObject(c, c.req.param("filename"), true));

app.get("/api/gallery/:id/raw", async (c) => {
  const entry = await getEntry(c.env, c.req.param("id"));
  if (!entry) return jsonError(404, "Gallery entry not found");
  if (!entry.is_public) {
    const admin = await isAdminRequest(c);
    const owner = getOwnerId(c);
    const isOwner = !!owner && entry.owner_id === owner;
    if (!admin && !isOwner) return jsonError(404, "Gallery entry not found");
  }
  return c.json(entry);
});

app.post("/api/prompt/refine", async (c) => {
  const [apiState, rlConfig, turnstile, limits] = await Promise.all([
    cachedApiState(c),
    cachedRateLimit(c),
    cachedTurnstile(c),
    cachedLimits(c),
  ]);
  const active = getActivePresetFromState(apiState);
  if (!active.api_url) return jsonError(400, "API URL not configured");
  if (!active.api_key) return jsonError(400, "API Key not configured");

  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Request body must be JSON");
  }
  const userText = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!userText) return jsonError(400, "text is required");
  if (userText.length > limits.prompt_max_chars) {
    return jsonError(400, `text exceeds ${limits.prompt_max_chars} characters`);
  }
  const ctx = (raw.context && typeof raw.context === "object" ? raw.context : {}) as Record<string, unknown>;
  const targetLang = raw.lang === "en" ? "en" : "zh";
  const model = typeof raw.model === "string" && raw.model.trim()
    ? raw.model.trim()
    : limits.prompt_helper_model;

  const adminBypass = await isAdminRequest(c);
  if (!adminBypass && rlConfig.enabled) {
    const ip = getClientIp(c) || "unknown";
    const rl = await checkRateLimit(c.env, "refine:" + ip, rlConfig.limit, rlConfig.window_seconds);
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({ status: "error", detail: `Rate limit exceeded. Try again in ${rl.retryAfterSeconds}s.` }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }
  }
  if (turnstile.enabled && turnstile.secret_key && !adminBypass) {
    const token = typeof raw.turnstile_token === "string" ? raw.turnstile_token.trim() : "";
    if (!token) return jsonError(400, "Captcha required");
    const result = await verifyTurnstileToken(turnstile.secret_key, token, getClientIp(c));
    if (!result.success) return jsonError(403, "Captcha verification failed");
  }

  const sysLines = targetLang === "en"
    ? [
        "You are a senior text-to-image prompt engineer.",
        "Rewrite the user's idea into ONE concise English image prompt suitable for diffusion-style image APIs.",
        "Keep all subjects/actions/styles the user mentioned. Add useful visual details (lighting, lens, composition, mood) only if they help.",
        "No prefaces, no explanations, no quotes. Output a single paragraph under 1500 characters.",
      ]
    : [
        "你是资深的文生图提示词工程师。",
        "把用户的想法改写成一段简洁的中文图像提示词，适合直接喂给扩散类图像 API。",
        "保留用户提到的全部主体/动作/风格。仅在必要时补充光照、镜头、构图、氛围等可视细节。",
        "不要前言、不要解释、不要引号，输出单段，控制在 1500 字以内。",
      ];
  const ctxLines: string[] = [];
  if (typeof ctx.size === "string" && ctx.size) ctxLines.push(`size=${ctx.size}`);
  if (typeof ctx.quality === "string" && ctx.quality) ctxLines.push(`quality=${ctx.quality}`);
  if (typeof ctx.output_format === "string" && ctx.output_format) ctxLines.push(`format=${ctx.output_format}`);
  if (typeof ctx.api_path === "string" && ctx.api_path) ctxLines.push(`api_path=${ctx.api_path}`);
  if (ctx.has_reference) ctxLines.push("mode=image-to-image");
  if (ctx.has_mask) ctxLines.push("mode=inpaint");
  if (typeof ctx.template === "string" && ctx.template) ctxLines.push(`template=${ctx.template}`);
  const sysContent = [...sysLines, ctxLines.length ? `Context: ${ctxLines.join(", ")}` : ""].filter(Boolean).join("\n");

  const apiUrl = `${active.api_url.replace(/\/+$/, "")}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${active.api_key}`,
        "Content-Type": "application/json",
        "User-Agent": "gpt-image-worker",
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        messages: [
          { role: "system", content: sysContent },
          { role: "user", content: userText },
        ],
      }),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text.slice(0, 400);
      try {
        const j = JSON.parse(text);
        const msg = j?.error?.message;
        if (typeof msg === "string") detail = msg;
      } catch {}
      return jsonError(resp.status >= 500 ? 502 : resp.status, `Upstream chat error: ${detail}`);
    }
    let parsed: { choices?: Array<{ message?: { content?: string } }> };
    try { parsed = JSON.parse(text); } catch { return jsonError(502, "Upstream returned non-JSON"); }
    const refined = parsed?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!refined) return jsonError(502, "Upstream returned empty content");
    return c.json({ status: "ok", prompt: refined, model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (controller.signal.aborted) return jsonError(504, "Chat completion timed out");
    return jsonError(502, `Failed to reach chat endpoint: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
});

app.post("/api/admin/test-api", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let raw: Record<string, unknown> = {};
  try { raw = (await c.req.json()) as Record<string, unknown>; } catch {}
  const apiState = await loadApiSettingsState(c.env);
  const active = getActivePresetFromState(apiState);
  const apiUrl = (typeof raw.api_url === "string" && raw.api_url.trim() ? raw.api_url.trim() : active.api_url).replace(/\/+$/, "");
  const apiKey = typeof raw.api_key === "string" && raw.api_key.trim() ? raw.api_key.trim() : active.api_key;
  const mode = raw.mode === "image" ? "image" : "models";
  if (!apiUrl) return jsonError(400, "API URL not configured");
  if (!apiKey) return jsonError(400, "API Key not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const startedAt = Date.now();
  try {
    if (mode === "models") {
      const resp = await fetch(`${apiUrl}/v1/models`, {
        headers: { "Authorization": `Bearer ${apiKey}`, "User-Agent": "gpt-image-worker" },
        signal: controller.signal,
      });
      const text = await resp.text();
      const elapsed = Date.now() - startedAt;
      if (!resp.ok) {
        return c.json({ status: "error", elapsed_ms: elapsed, http_status: resp.status, detail: text.slice(0, 300) });
      }
      let modelCount = 0;
      let sample: string[] = [];
      try {
        const j = JSON.parse(text);
        const list = Array.isArray(j?.data) ? j.data : [];
        modelCount = list.length;
        sample = list.slice(0, 8).map((m: unknown) => (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : ""))
          .filter(Boolean);
      } catch {}
      return c.json({ status: "ok", mode, elapsed_ms: elapsed, http_status: resp.status, model_count: modelCount, sample });
    }
    const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "gpt-image-2";
    const resp = await fetch(`${apiUrl}/v1/images/generations`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "gpt-image-worker" },
      body: JSON.stringify({ model, prompt: "a single small red dot on white background", size: "1024x1024", n: 1, quality: "low" }),
      signal: controller.signal,
    });
    const text = await resp.text();
    const elapsed = Date.now() - startedAt;
    if (!resp.ok) {
      let detail = text.slice(0, 300);
      try { const j = JSON.parse(text); if (typeof j?.error?.message === "string") detail = j.error.message; } catch {}
      return c.json({ status: "error", mode, elapsed_ms: elapsed, http_status: resp.status, detail });
    }
    let hasImage = false;
    try {
      const j = JSON.parse(text);
      const data = Array.isArray(j?.data) ? j.data : [];
      hasImage = data.some((d: unknown) => d && typeof d === "object" && (typeof (d as { b64_json?: unknown }).b64_json === "string" || typeof (d as { url?: unknown }).url === "string"));
    } catch {}
    return c.json({ status: hasImage ? "ok" : "warn", mode, elapsed_ms: elapsed, http_status: resp.status, has_image: hasImage });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = controller.signal.aborted;
    return c.json({ status: "error", mode, elapsed_ms: Date.now() - startedAt, detail: aborted ? "timeout" : msg });
  } finally {
    clearTimeout(timer);
  }
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

async function processPendingJob(env: Bindings, jobId: string): Promise<void> {
  const claimed = await tryClaimJob(env, jobId);
  if (!claimed) {
    console.log("skip already-claimed job", { jobId });
    return;
  }
  const claimToken = claimed.claim_token;
  if (!claimToken) throw new Error(`Generation claim token missing for ${jobId}`);
  await executeClaimedJob(env, claimed, claimToken, "cron");
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    const ids = await listPendingJobIds(env, 1);

    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (ids.length === 0 && minute % 30 === 0) {
      ctx.waitUntil(Promise.all([
        pruneOldJobs(env).catch((err) => console.error("pruneOldJobs failed", { err: err instanceof Error ? err.message : String(err) })),
        pruneRateLimits(env).catch((err) => console.error("pruneRateLimits failed", { err: err instanceof Error ? err.message : String(err) })),
        pruneOrphanTmpAssets(env).catch((err: unknown) => console.error("pruneOrphanTmpAssets failed", { err: err instanceof Error ? err.message : String(err) })),
      ]));
    }

    if (ids.length === 0) return;
    console.log("cron tick", { pending: ids.length });
    ctx.waitUntil(Promise.all(ids.map((id) => processPendingJob(env, id).catch((err) => {
      console.error("processPendingJob failed", { id, err: err instanceof Error ? err.message : String(err) });
    }))));
  },
};
