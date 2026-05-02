import type { Bindings } from "./types";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  env: Bindings,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const newReset = now + windowMs;

  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END`,
  )
    .bind(key, newReset, now, now, newReset)
    .run();

  const row = await env.DB.prepare(`SELECT count, reset_at FROM rate_limits WHERE key = ?`)
    .bind(key)
    .first();
  const count = Number((row as { count: number } | null)?.count ?? 0);
  const resetAt = Number((row as { reset_at: number } | null)?.reset_at ?? newReset);
  if (count > limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function pruneRateLimits(env: Bindings): Promise<void> {
  await env.DB.prepare(`DELETE FROM rate_limits WHERE reset_at < ?`).bind(Date.now()).run();
}
