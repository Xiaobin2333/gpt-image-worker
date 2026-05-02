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
  deleteGalleryEntry,
  getEntry,
  getEntryByFilename,
  getGalleryPage,
  getImage,
  getJob,
  getPendingJobInput,
  listPendingJobIds,
  listProducedEntries,
  pruneOldJobs,
  pruneOrphanImages,
  saveJob,
  tryClaimJob,
} from "./storage";
import { LIMITS_BOUNDS, loadAccessLock, loadRateLimitConfig, loadRuntimeLimits, loadSettings, loadTurnstileConfig, maskKey, normalizeApiPath, saveAccessLock, saveRateLimitConfig, saveRuntimeLimits, saveSettings, saveTurnstileConfig } from "./settings";
import { verifyTurnstileToken } from "./turnstile";
import { checkRateLimit, pruneRateLimits } from "./ratelimit";
import type { Bindings, GalleryEntry, GenerateJob, GenerateResponse } from "./types";
import { parseGenerateBody, ValidationError } from "./validate";
import { getCookie } from "hono/cookie";

const app = new Hono<{ Bindings: Bindings }>();
type AppContext = Context<{ Bindings: Bindings }>;

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
    n: primary.n,
    api_path: primary.api_path,
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

function constantTimeEq(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ea.byteLength; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

app.get("/api/session", async (c) => {
  const lock = await loadAccessLock(c.env);
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
  const [turnstile, limits] = await Promise.all([
    loadTurnstileConfig(c.env),
    loadRuntimeLimits(c.env),
  ]);
  c.header("Cache-Control", "private, max-age=10");
  return c.json({
    access_required: accessRequired,
    authenticated: accessAuthed,
    access_expires_at: accessExpires ? accessExpires.toISOString() : null,
    admin_available: adminAvailable,
    is_admin: isAdmin,
    admin_expires_at: adminExpires ? adminExpires.toISOString() : null,
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
  const lock = await loadAccessLock(c.env);
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

  const limits = await loadRuntimeLimits(c.env);
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
    access_session_minutes: unknown;
    admin_session_minutes: unknown;
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
  if (typeof body.access_session_minutes === "number") patch.access_session_minutes = body.access_session_minutes;
  if (typeof body.admin_session_minutes === "number") patch.admin_session_minutes = body.admin_session_minutes;
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

  const limits = await loadRuntimeLimits(c.env);
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

app.get("/api/settings", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const s = await loadSettings(c.env);
  return c.json({
    api_url: s.api_url,
    api_key_masked: maskKey(s.api_key),
    api_path: s.api_path,
  });
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
  await saveSettings(c.env, { api_url: apiUrl, api_key: apiKey, api_path: apiPath });
  return c.json({ status: "ok", message: "Settings updated" });
});

app.post("/api/generate", async (c) => {
  const [bodyTextOrErr, settings, rlConfig, turnstile, limits] = await Promise.all([
    c.req.text().catch((e) => e instanceof Error ? e : new Error(String(e))),
    loadSettings(c.env),
    loadRateLimitConfig(c.env),
    loadTurnstileConfig(c.env),
    loadRuntimeLimits(c.env),
  ]);
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
  await saveJob(c.env, initial, { payload, owner_id: owner });

  return c.json({ job_id: jobId, status: "queued" }, 202);
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
      const send = (line: string) => controller.enqueue(enc.encode(line));
      const sendEvent = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };
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
          for (let i = 0; i < 60 && !closed; i++) {
            await new Promise((r) => setTimeout(r, 5_000));
            const j = await getJob(env, jobId);
            if (!j) { sendEvent("error", { detail: "Job vanished" }); return; }
            if (j.status === "success" && j.result) { sendEvent("done", { result: j.result }); return; }
            if (j.status === "error") { sendEvent("error", { detail: j.detail ?? "unknown" }); return; }
          }
          sendEvent("error", { detail: "Timed out waiting for worker" });
          return;
        }

        sendEvent("running", { updated_at: claimed.updated_at });

        const input = await getPendingJobInput(env, jobId);
        const limits = await loadRuntimeLimits(env);

        const producedIds = claimed.produced_ids ?? [];
        const existingEntries = producedIds.length > 0 ? await listProducedEntries(env, producedIds) : [];
        const targetN = input?.payload.n ?? Math.max(1, existingEntries.length);
        if (existingEntries.length >= targetN && targetN > 0) {
          const result = buildGenerateResponse(limits.r2_public_domain, existingEntries.slice(0, targetN));
          await saveJob(env, { ...claimed, status: "success", updated_at: new Date().toISOString(), result });
          sendEvent("done", { result });
          return;
        }

        if (!input) {
          if (existingEntries.length > 0) {
            const result = buildGenerateResponse(limits.r2_public_domain, existingEntries);
            await saveJob(env, { ...claimed, status: "success", updated_at: new Date().toISOString(), result });
            sendEvent("done", { result });
            return;
          }
          await saveJob(env, { ...claimed, status: "error", updated_at: new Date().toISOString(), detail: "Pending input missing" });
          sendEvent("error", { detail: "Pending input missing" });
          return;
        }

        const settings = await loadSettings(env);
        if (!settings.api_url || !settings.api_key) {
          const detail = "API not configured";
          await saveJob(env, { ...claimed, status: "error", updated_at: new Date().toISOString(), detail });
          sendEvent("error", { detail });
          return;
        }

        const controller2 = new AbortController();
        const timer = setTimeout(() => controller2.abort(), 5 * 60 * 1000);
        try {
          const entries = await callImageGeneration(
            env,
            settings,
            input.payload,
            input.owner_id,
            controller2.signal,
            {
              jobId,
              existingEntries,
              maxFileSizeMb: limits.max_file_size_mb,
              responsesModel: limits.responses_model,
            },
          );
          if (entries.length === 0) throw new Error("No images returned by upstream");
          const result = buildGenerateResponse(limits.r2_public_domain, entries);
          await saveJob(env, { ...claimed, status: "success", updated_at: new Date().toISOString(), result });
          sendEvent("done", { result });
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          console.error("stream job failed", { jobId, detail });
          await saveJob(env, { ...claimed, status: "error", updated_at: new Date().toISOString(), detail });
          sendEvent("error", { detail });
        } finally {
          clearTimeout(timer);
        }
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
  const admin = await isAdminRequest(c);
  const owner = getOwnerId(c);
  const includeAllPrivate = admin && scope === "all";

  const [result, limits] = await Promise.all([
    getGalleryPage(c.env, { page, pageSize, includeAllPrivate, ownerId: owner }),
    loadRuntimeLimits(c.env),
  ]);
  const images = result.images.map((entry) => ({
    ...entry,
    image_url: imageUrlFor(limits.r2_public_domain, entry),
  }));
  c.header("Cache-Control", "private, max-age=5");
  c.header("Vary", "Cookie");
  return c.json({ ...result, images });
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

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

async function processPendingJob(env: Bindings, jobId: string): Promise<void> {
  const claimed = await tryClaimJob(env, jobId);
  if (!claimed) {
    console.log("skip already-claimed job", { jobId });
    return;
  }

  const input = await getPendingJobInput(env, jobId);
  const limits = await loadRuntimeLimits(env);

  const producedIds = claimed.produced_ids ?? [];
  const existingEntries = producedIds.length > 0 ? await listProducedEntries(env, producedIds) : [];
  const targetN = input?.payload.n ?? Math.max(1, existingEntries.length);
  if (existingEntries.length >= targetN && targetN > 0) {
    const result = buildGenerateResponse(limits.r2_public_domain, existingEntries.slice(0, targetN));
    await saveJob(env, { ...claimed, status: "success", updated_at: new Date().toISOString(), result });
    return;
  }
  if (!input) {
    if (existingEntries.length > 0) {
      const result = buildGenerateResponse(limits.r2_public_domain, existingEntries);
      await saveJob(env, { ...claimed, status: "success", updated_at: new Date().toISOString(), result });
      return;
    }
    await saveJob(env, { ...claimed, status: "error", updated_at: new Date().toISOString(), detail: "Pending input missing" });
    return;
  }

  const settings = await loadSettings(env);
  if (!settings.api_url || !settings.api_key) {
    await saveJob(env, { ...claimed, status: "error", updated_at: new Date().toISOString(), detail: "API not configured" });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const entries = await callImageGeneration(
      env,
      settings,
      input.payload,
      input.owner_id,
      controller.signal,
      {
        jobId,
        existingEntries,
        maxFileSizeMb: limits.max_file_size_mb,
        responsesModel: limits.responses_model,
      },
    );
    if (entries.length === 0) throw new Error("No images returned by upstream");
    const result = buildGenerateResponse(limits.r2_public_domain, entries);
    await saveJob(env, { ...claimed, status: "success", updated_at: new Date().toISOString(), result });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("cron job failed", { jobId, detail });
    await saveJob(env, { ...claimed, status: "error", updated_at: new Date().toISOString(), detail });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    const ids = await listPendingJobIds(env, 5);

    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute % 30 === 0 || ids.length === 0) {
      ctx.waitUntil(Promise.all([
        pruneOldJobs(env).catch((err) => console.error("pruneOldJobs failed", { err: err instanceof Error ? err.message : String(err) })),
        pruneRateLimits(env).catch((err) => console.error("pruneRateLimits failed", { err: err instanceof Error ? err.message : String(err) })),
      ]));
    }

    if (ids.length === 0) return;
    console.log("cron tick", { pending: ids.length });
    ctx.waitUntil(Promise.all(ids.map((id) => processPendingJob(env, id).catch((err) => {
      console.error("processPendingJob failed", { id, err: err instanceof Error ? err.message : String(err) });
    }))));
  },
};
