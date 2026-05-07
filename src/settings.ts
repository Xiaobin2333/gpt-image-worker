import type { ApiPath, Bindings, RuntimeSettings } from "./types";

const SETTINGS_KEY = "runtime:api";
const ACCESS_LOCK_KEY = "runtime:access";
const TURNSTILE_KEY = "runtime:turnstile";
const RATE_LIMIT_KEY = "runtime:ratelimit";
const LIMITS_KEY = "runtime:limits";

export interface ApiPreset {
  id: string;
  name: string;
  api_url: string;
  api_key: string;
  api_path: ApiPath;
}

export interface ApiSettingsState {
  active_preset_id: string;
  presets: ApiPreset[];
}

export interface AccessLock {
  enabled: boolean;
  key: string;
}

export interface TurnstileConfig {
  enabled: boolean;
  site_key: string;
  secret_key: string;
}

export interface RateLimitConfig {
  enabled: boolean;
  limit: number;
  window_seconds: number;
}

export interface RuntimeLimits {
  r2_public_domain: string;
  prompt_max_chars: number;
  reference_max_count: number;
  reference_max_mb: number;
  generation_max_n: number;
  max_file_size_mb: number;
  responses_model: string;
  responses_concurrency: number;
  access_session_minutes: number;
  admin_session_minutes: number;
  prompt_helper_model: string;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = { enabled: false, limit: 10, window_seconds: 60 };

export const LIMITS_BOUNDS = {
  prompt_max_chars: { min: 100, max: 20_000, default: 4_000 },
  reference_max_count: { min: 0, max: 16, default: 4 },
  reference_max_mb: { min: 1, max: 50, default: 4 },
  generation_max_n: { min: 1, max: 20, default: 10 },
  max_file_size_mb: { min: 1, max: 100, default: 50 },
  responses_concurrency: { min: 1, max: 10, default: 3 },
  access_session_minutes: { min: 5, max: 10_080, default: 180 },
  admin_session_minutes: { min: 5, max: 10_080, default: 180 },
} as const;

export function normalizeApiPath(path: string | undefined | null): ApiPath {
  return path === "/v1/responses" ? "/v1/responses" : "/v1/images/generations";
}

const KV_CACHE_TTL_SECONDS = 300;

function sanitizePreset(raw: unknown, fallbackId: string, fallbackName: string): ApiPreset {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : fallbackId;
  const rawName = typeof r.name === "string" ? r.name.trim() : "";
  const name = rawName || fallbackName;
  const apiUrl = typeof r.api_url === "string" ? r.api_url.replace(/\/+$/, "") : "";
  const apiKey = typeof r.api_key === "string" ? r.api_key : "";
  const apiPath = normalizeApiPath(typeof r.api_path === "string" ? r.api_path : undefined);
  return { id, name, api_url: apiUrl, api_key: apiKey, api_path: apiPath };
}

function defaultPresetFromEnv(env: Bindings): ApiPreset {
  return {
    id: "default",
    name: "Default",
    api_url: (env.DEFAULT_API_URL ?? "").replace(/\/+$/, ""),
    api_key: env.DEFAULT_API_KEY ?? "",
    api_path: normalizeApiPath(env.DEFAULT_API_PATH),
  };
}

export async function loadApiSettingsState(env: Bindings): Promise<ApiSettingsState> {
  const stored = await env.SETTINGS.get<Record<string, unknown>>(SETTINGS_KEY, {
    type: "json",
    cacheTtl: KV_CACHE_TTL_SECONDS,
  });
  if (stored && Array.isArray(stored.presets)) {
    const seen = new Set<string>();
    const presets: ApiPreset[] = [];
    (stored.presets as unknown[]).forEach((p, i) => {
      const cand = sanitizePreset(p, `preset-${i + 1}`, `Preset ${i + 1}`);
      if (seen.has(cand.id)) return;
      seen.add(cand.id);
      presets.push(cand);
    });
    if (presets.length === 0) presets.push(defaultPresetFromEnv(env));
    const requested = typeof stored.active_preset_id === "string" ? stored.active_preset_id : "";
    const active_preset_id = presets.some((p) => p.id === requested) ? requested : presets[0]!.id;
    return { active_preset_id, presets };
  }
  const legacy = (stored ?? {}) as Partial<RuntimeSettings>;
  const seed = defaultPresetFromEnv(env);
  const preset: ApiPreset = {
    id: "default",
    name: "Default",
    api_url: typeof legacy.api_url === "string" ? legacy.api_url.replace(/\/+$/, "") : seed.api_url,
    api_key: typeof legacy.api_key === "string" ? legacy.api_key : seed.api_key,
    api_path: normalizeApiPath(typeof legacy.api_path === "string" ? legacy.api_path : seed.api_path),
  };
  return { active_preset_id: preset.id, presets: [preset] };
}

export async function saveApiSettingsState(
  env: Bindings,
  state: ApiSettingsState,
): Promise<ApiSettingsState> {
  await env.SETTINGS.put(SETTINGS_KEY, JSON.stringify(state));
  return state;
}

function getActivePreset(state: ApiSettingsState): ApiPreset {
  return state.presets.find((p) => p.id === state.active_preset_id) ?? state.presets[0]!;
}

export async function loadSettings(env: Bindings): Promise<RuntimeSettings> {
  const state = await loadApiSettingsState(env);
  const active = getActivePreset(state);
  return {
    api_url: active.api_url,
    api_key: active.api_key,
    api_path: active.api_path,
  };
}

export async function saveSettings(
  env: Bindings,
  patch: { active_preset_id?: string | null; preset_name?: string | null; api_url: string; api_key?: string | null; api_path: string },
): Promise<RuntimeSettings> {
  const state = await loadApiSettingsState(env);
  const targetId = patch.active_preset_id && state.presets.some((p) => p.id === patch.active_preset_id)
    ? patch.active_preset_id
    : state.active_preset_id;
  const target = state.presets.find((p) => p.id === targetId) ?? state.presets[0]!;
  const renamed = typeof patch.preset_name === "string" && patch.preset_name.trim()
    ? patch.preset_name.trim()
    : target.name;
  const next: ApiPreset = {
    id: target.id,
    name: renamed,
    api_url: patch.api_url.replace(/\/+$/, ""),
    api_key: patch.api_key === undefined || patch.api_key === null ? target.api_key : patch.api_key,
    api_path: normalizeApiPath(patch.api_path),
  };
  const presets = state.presets.map((p) => (p.id === target.id ? next : p));
  await saveApiSettingsState(env, { active_preset_id: target.id, presets });
  return { api_url: next.api_url, api_key: next.api_key, api_path: next.api_path };
}

export async function createApiPreset(
  env: Bindings,
  patch: { name?: string | null; api_url?: string | null; api_key?: string | null; api_path?: string | null; source_preset_id?: string | null },
): Promise<{ state: ApiSettingsState; created: ApiPreset }> {
  const state = await loadApiSettingsState(env);
  const source = patch.source_preset_id
    ? state.presets.find((p) => p.id === patch.source_preset_id) ?? getActivePreset(state)
    : getActivePreset(state);
  const id = crypto.randomUUID();
  const nextNumber = state.presets.length + 1;
  const candidateName = (patch.name ?? "").trim();
  const created: ApiPreset = {
    id,
    name: candidateName || `Preset ${nextNumber}`,
    api_url: (patch.api_url ?? source.api_url).replace(/\/+$/, ""),
    api_key: patch.api_key ?? source.api_key,
    api_path: normalizeApiPath(patch.api_path ?? source.api_path),
  };
  const presets = [...state.presets, created];
  const nextState: ApiSettingsState = { active_preset_id: id, presets };
  await saveApiSettingsState(env, nextState);
  return { state: nextState, created };
}

export async function activateApiPreset(env: Bindings, presetId: string): Promise<ApiSettingsState | null> {
  const state = await loadApiSettingsState(env);
  if (!state.presets.some((p) => p.id === presetId)) return null;
  const next: ApiSettingsState = { ...state, active_preset_id: presetId };
  await saveApiSettingsState(env, next);
  return next;
}

export async function deleteApiPreset(env: Bindings, presetId: string): Promise<{ state: ApiSettingsState | null; error?: string }> {
  const state = await loadApiSettingsState(env);
  if (state.presets.length <= 1) return { state: null, error: "At least one preset is required" };
  const idx = state.presets.findIndex((p) => p.id === presetId);
  if (idx < 0) return { state: null, error: "Preset not found" };
  const presets = state.presets.filter((p) => p.id !== presetId);
  let active_preset_id = state.active_preset_id;
  if (state.active_preset_id === presetId) {
    const fallback = presets[Math.min(idx, presets.length - 1)]!;
    active_preset_id = fallback.id;
  }
  const next: ApiSettingsState = { active_preset_id, presets };
  await saveApiSettingsState(env, next);
  return { state: next };
}

export function getActivePresetFromState(state: ApiSettingsState): ApiPreset {
  return getActivePreset(state);
}

export async function loadAccessLock(env: Bindings): Promise<AccessLock> {
  const stored = await env.SETTINGS.get<Partial<AccessLock>>(ACCESS_LOCK_KEY, {
    type: "json",
    cacheTtl: KV_CACHE_TTL_SECONDS,
  });
  if (stored && typeof stored.enabled === "boolean") {
    return { enabled: stored.enabled, key: stored.key ?? "" };
  }
  const seedKey = env.ACCESS_KEY ?? "";
  return { enabled: !!seedKey, key: seedKey };
}

export async function saveAccessLock(
  env: Bindings,
  patch: { enabled: boolean; key?: string | null },
): Promise<AccessLock> {
  const current = await loadAccessLock(env);
  const nextKey = patch.key === undefined || patch.key === null ? current.key : patch.key;
  const next: AccessLock = {
    enabled: patch.enabled,
    key: nextKey,
  };
  await env.SETTINGS.put(ACCESS_LOCK_KEY, JSON.stringify(next));
  return next;
}

export async function loadTurnstileConfig(env: Bindings): Promise<TurnstileConfig> {
  const stored = await env.SETTINGS.get<Partial<TurnstileConfig>>(TURNSTILE_KEY, {
    type: "json",
    cacheTtl: KV_CACHE_TTL_SECONDS,
  });
  return {
    enabled: !!stored?.enabled,
    site_key: stored?.site_key ?? "",
    secret_key: stored?.secret_key ?? "",
  };
}

export async function saveTurnstileConfig(
  env: Bindings,
  patch: { enabled: boolean; site_key?: string | null; secret_key?: string | null },
): Promise<TurnstileConfig> {
  const current = await loadTurnstileConfig(env);
  const next: TurnstileConfig = {
    enabled: patch.enabled,
    site_key: patch.site_key === undefined || patch.site_key === null ? current.site_key : patch.site_key,
    secret_key: patch.secret_key === undefined || patch.secret_key === null ? current.secret_key : patch.secret_key,
  };
  await env.SETTINGS.put(TURNSTILE_KEY, JSON.stringify(next));
  return next;
}

export async function loadRateLimitConfig(env: Bindings): Promise<RateLimitConfig> {
  const stored = await env.SETTINGS.get<Partial<RateLimitConfig>>(RATE_LIMIT_KEY, {
    type: "json",
    cacheTtl: KV_CACHE_TTL_SECONDS,
  });
  if (!stored) return { ...DEFAULT_RATE_LIMIT };
  const limit = Number.isFinite(stored.limit) && (stored.limit as number) > 0
    ? Math.min(1000, Math.floor(stored.limit as number))
    : DEFAULT_RATE_LIMIT.limit;
  const windowSeconds = Number.isFinite(stored.window_seconds) && (stored.window_seconds as number) > 0
    ? Math.min(86400, Math.floor(stored.window_seconds as number))
    : DEFAULT_RATE_LIMIT.window_seconds;
  return { enabled: !!stored.enabled, limit, window_seconds: windowSeconds };
}

export async function saveRateLimitConfig(
  env: Bindings,
  patch: { enabled: boolean; limit?: number | null; window_seconds?: number | null },
): Promise<RateLimitConfig> {
  const current = await loadRateLimitConfig(env);
  const limit = patch.limit === undefined || patch.limit === null
    ? current.limit
    : Math.max(1, Math.min(1000, Math.floor(Number(patch.limit) || current.limit)));
  const windowSeconds = patch.window_seconds === undefined || patch.window_seconds === null
    ? current.window_seconds
    : Math.max(1, Math.min(86400, Math.floor(Number(patch.window_seconds) || current.window_seconds)));
  const next: RateLimitConfig = { enabled: patch.enabled, limit, window_seconds: windowSeconds };
  await env.SETTINGS.put(RATE_LIMIT_KEY, JSON.stringify(next));
  return next;
}

export function maskKey(key: string): string {
  if (!key || key.length <= 8) return "***";
  return key.slice(0, 4) + "***" + key.slice(-4);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sanitizeDomain(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export async function loadRuntimeLimits(env: Bindings): Promise<RuntimeLimits> {
  const stored = await env.SETTINGS.get<Partial<RuntimeLimits>>(LIMITS_KEY, {
    type: "json",
    cacheTtl: KV_CACHE_TTL_SECONDS,
  });
  const seedDomain = sanitizeDomain(env.R2_PUBLIC_DOMAIN ?? "");
  const seedMaxFile = Number(env.MAX_FILE_SIZE_MB);
  const seedResponses = (env.DEFAULT_RESPONSES_MODEL ?? "").trim();
  const seedAccessMin = Number(env.ACCESS_KEY_SESSION_MINUTES);
  const seedAdminMin = Number(env.ADMIN_KEY_SESSION_MINUTES);
  return {
    r2_public_domain: typeof stored?.r2_public_domain === "string"
      ? sanitizeDomain(stored.r2_public_domain)
      : seedDomain,
    prompt_max_chars: clampInt(
      stored?.prompt_max_chars,
      LIMITS_BOUNDS.prompt_max_chars.default,
      LIMITS_BOUNDS.prompt_max_chars.min,
      LIMITS_BOUNDS.prompt_max_chars.max,
    ),
    reference_max_count: clampInt(
      stored?.reference_max_count,
      LIMITS_BOUNDS.reference_max_count.default,
      LIMITS_BOUNDS.reference_max_count.min,
      LIMITS_BOUNDS.reference_max_count.max,
    ),
    reference_max_mb: clampInt(
      stored?.reference_max_mb,
      LIMITS_BOUNDS.reference_max_mb.default,
      LIMITS_BOUNDS.reference_max_mb.min,
      LIMITS_BOUNDS.reference_max_mb.max,
    ),
    generation_max_n: clampInt(
      stored?.generation_max_n,
      LIMITS_BOUNDS.generation_max_n.default,
      LIMITS_BOUNDS.generation_max_n.min,
      LIMITS_BOUNDS.generation_max_n.max,
    ),
    max_file_size_mb: clampInt(
      stored?.max_file_size_mb,
      Number.isFinite(seedMaxFile) && seedMaxFile > 0 ? seedMaxFile : LIMITS_BOUNDS.max_file_size_mb.default,
      LIMITS_BOUNDS.max_file_size_mb.min,
      LIMITS_BOUNDS.max_file_size_mb.max,
    ),
    responses_model: typeof stored?.responses_model === "string" && stored.responses_model.trim()
      ? stored.responses_model.trim()
      : seedResponses,
    responses_concurrency: clampInt(
      stored?.responses_concurrency,
      LIMITS_BOUNDS.responses_concurrency.default,
      LIMITS_BOUNDS.responses_concurrency.min,
      LIMITS_BOUNDS.responses_concurrency.max,
    ),
    access_session_minutes: clampInt(
      stored?.access_session_minutes,
      Number.isFinite(seedAccessMin) && seedAccessMin > 0 ? seedAccessMin : LIMITS_BOUNDS.access_session_minutes.default,
      LIMITS_BOUNDS.access_session_minutes.min,
      LIMITS_BOUNDS.access_session_minutes.max,
    ),
    admin_session_minutes: clampInt(
      stored?.admin_session_minutes,
      Number.isFinite(seedAdminMin) && seedAdminMin > 0 ? seedAdminMin : LIMITS_BOUNDS.admin_session_minutes.default,
      LIMITS_BOUNDS.admin_session_minutes.min,
      LIMITS_BOUNDS.admin_session_minutes.max,
    ),
    prompt_helper_model: typeof stored?.prompt_helper_model === "string" && stored.prompt_helper_model.trim()
      ? stored.prompt_helper_model.trim()
      : "gpt-4o-mini",
  };
}

export async function saveRuntimeLimits(
  env: Bindings,
  patch: Partial<RuntimeLimits>,
): Promise<RuntimeLimits> {
  const current = await loadRuntimeLimits(env);
  const next: RuntimeLimits = {
    r2_public_domain: typeof patch.r2_public_domain === "string"
      ? sanitizeDomain(patch.r2_public_domain)
      : current.r2_public_domain,
    prompt_max_chars: patch.prompt_max_chars === undefined
      ? current.prompt_max_chars
      : clampInt(
          patch.prompt_max_chars,
          current.prompt_max_chars,
          LIMITS_BOUNDS.prompt_max_chars.min,
          LIMITS_BOUNDS.prompt_max_chars.max,
        ),
    reference_max_count: patch.reference_max_count === undefined
      ? current.reference_max_count
      : clampInt(
          patch.reference_max_count,
          current.reference_max_count,
          LIMITS_BOUNDS.reference_max_count.min,
          LIMITS_BOUNDS.reference_max_count.max,
        ),
    reference_max_mb: patch.reference_max_mb === undefined
      ? current.reference_max_mb
      : clampInt(
          patch.reference_max_mb,
          current.reference_max_mb,
          LIMITS_BOUNDS.reference_max_mb.min,
          LIMITS_BOUNDS.reference_max_mb.max,
        ),
    generation_max_n: patch.generation_max_n === undefined
      ? current.generation_max_n
      : clampInt(
          patch.generation_max_n,
          current.generation_max_n,
          LIMITS_BOUNDS.generation_max_n.min,
          LIMITS_BOUNDS.generation_max_n.max,
        ),
    max_file_size_mb: patch.max_file_size_mb === undefined
      ? current.max_file_size_mb
      : clampInt(
          patch.max_file_size_mb,
          current.max_file_size_mb,
          LIMITS_BOUNDS.max_file_size_mb.min,
          LIMITS_BOUNDS.max_file_size_mb.max,
        ),
    responses_model: typeof patch.responses_model === "string"
      ? patch.responses_model.trim() || current.responses_model
      : current.responses_model,
    responses_concurrency: patch.responses_concurrency === undefined
      ? current.responses_concurrency
      : clampInt(
          patch.responses_concurrency,
          current.responses_concurrency,
          LIMITS_BOUNDS.responses_concurrency.min,
          LIMITS_BOUNDS.responses_concurrency.max,
        ),
    access_session_minutes: patch.access_session_minutes === undefined
      ? current.access_session_minutes
      : clampInt(
          patch.access_session_minutes,
          current.access_session_minutes,
          LIMITS_BOUNDS.access_session_minutes.min,
          LIMITS_BOUNDS.access_session_minutes.max,
        ),
    admin_session_minutes: patch.admin_session_minutes === undefined
      ? current.admin_session_minutes
      : clampInt(
          patch.admin_session_minutes,
          current.admin_session_minutes,
          LIMITS_BOUNDS.admin_session_minutes.min,
          LIMITS_BOUNDS.admin_session_minutes.max,
        ),
    prompt_helper_model: typeof patch.prompt_helper_model === "string"
      ? patch.prompt_helper_model.trim() || current.prompt_helper_model
      : current.prompt_helper_model,
  };
  await env.SETTINGS.put(LIMITS_KEY, JSON.stringify(next));
  return next;
}
