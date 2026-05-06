import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "./types";
import { loadAccessLock } from "./settings";

const encoder = new TextEncoder();

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const norm = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function signatureSecret(env: Bindings, kind: "access" | "admin"): string {
  if (kind === "admin") return env.ADMIN_KEY || "gpt-image-panel-admin-dev-secret";
  return env.ADMIN_KEY || env.ACCESS_KEY || env.DEFAULT_API_KEY || "gpt-image-panel-dev-secret";
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  let entry = hmacKeyCache.get(secret);
  if (!entry) {
    entry = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeyCache.set(secret, entry);
  }
  return entry;
}

export interface AccessToken {
  token: string;
  expiresAt: Date;
}

export async function createAccessToken(
  env: Bindings,
  kind: "access" | "admin" = "access",
  minutesOverride?: number,
): Promise<AccessToken> {
  const fallback = kind === "admin"
    ? Number(env.ADMIN_KEY_SESSION_MINUTES) || 180
    : Number(env.ACCESS_KEY_SESSION_MINUTES) || 180;
  const minutes = Number.isFinite(minutesOverride) && (minutesOverride as number) > 0
    ? Math.floor(minutesOverride as number)
    : fallback;
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
  const payloadJson = JSON.stringify({ exp: Math.floor(expiresAt.getTime() / 1000), k: kind });
  const payloadPart = b64urlEncode(encoder.encode(payloadJson));
  const key = await importHmacKey(signatureSecret(env, kind));
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart));
  return { token: `${payloadPart}.${b64urlEncode(sig)}`, expiresAt };
}

export async function verifyAccessToken(
  env: Bindings,
  token: string | undefined,
  kind: "access" | "admin" = "access",
): Promise<Date | null> {
  if (!token || !token.includes(".")) return null;
  const [payloadPart, sigPart] = token.split(".", 2) as [string, string];

  let actualSig: Uint8Array;
  try {
    actualSig = b64urlDecode(sigPart);
  } catch {
    return null;
  }

  const key = await importHmacKey(signatureSecret(env, kind));
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    actualSig,
    encoder.encode(payloadPart),
  );
  if (!ok) return null;

  let payload: { exp?: number; k?: string };
  try {
    const raw = b64urlDecode(payloadPart);
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number") return null;
  if (payload.k && payload.k !== kind) return null;
  const expiresAt = new Date(payload.exp * 1000);
  if (expiresAt.getTime() <= Date.now()) return null;
  return expiresAt;
}

export function getClientIp(c: Context<any>): string {
  const trustProxy = c.env.TRUST_PROXY_HEADERS.toLowerCase() === "true"
    || c.env.TRUST_PROXY_HEADERS === "1";

  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return cfIp;

  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",", 1)[0]!.trim();
    const xri = c.req.header("x-real-ip");
    if (xri) return xri.trim();
  }
  return "";
}

function ipToBigInt(ip: string): { value: bigint; family: 4 | 6 } | null {
  if (ip.includes(":")) {
    const expanded = expandIPv6(ip);
    if (!expanded) return null;
    let v = 0n;
    for (const part of expanded) v = (v << 16n) | BigInt(part);
    return { value: v, family: 6 };
  }
  const segs = ip.split(".");
  if (segs.length !== 4) return null;
  let v = 0n;
  for (const seg of segs) {
    const n = Number(seg);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return { value: v, family: 4 };
}

function expandIPv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const filled = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (filled.length !== 8) return null;
  return filled.map((h) => {
    const n = parseInt(h || "0", 16);
    return Number.isInteger(n) && n >= 0 && n <= 0xffff ? n : NaN;
  }).every((n) => !Number.isNaN(n))
    ? filled.map((h) => parseInt(h || "0", 16))
    : null;
}

export function isIpAllowed(env: Bindings, ip: string): boolean {
  const allowlist = (env.IP_ALLOWLIST || "")
    .replace(/;/g, ",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) return true;

  const client = ipToBigInt(ip);
  if (!client) return false;

  for (const entry of allowlist) {
    const [addr, bitsStr] = entry.includes("/") ? entry.split("/") : [entry, undefined];
    const candidate = ipToBigInt(addr!);
    if (!candidate || candidate.family !== client.family) continue;

    if (bitsStr === undefined) {
      if (candidate.value === client.value) return true;
      continue;
    }

    const bits = Number(bitsStr);
    const total = client.family === 4 ? 32 : 128;
    if (!Number.isInteger(bits) || bits < 0 || bits > total) continue;
    const mask = bits === 0 ? 0n : (~0n << BigInt(total - bits)) & ((1n << BigInt(total)) - 1n);
    if ((candidate.value & mask) === (client.value & mask)) return true;
  }
  return false;
}

export async function isAdminRequest(c: Context<any>): Promise<boolean> {
  if (!c.env.ADMIN_KEY) return false;
  const cookie = getCookie(c, c.env.ADMIN_KEY_COOKIE_NAME);
  return (await verifyAccessToken(c.env, cookie, "admin")) !== null;
}

export async function isUnlocked(c: Context<any>): Promise<boolean> {
  let lockPromise = c.get("cache_access") as Promise<Awaited<ReturnType<typeof loadAccessLock>>> | undefined;
  if (!lockPromise) {
    lockPromise = loadAccessLock(c.env);
    c.set("cache_access", lockPromise);
  }
  const lock = await lockPromise;
  if (!lock.enabled || !lock.key) return true;
  const cookie = getCookie(c, c.env.ACCESS_KEY_COOKIE_NAME);
  if ((await verifyAccessToken(c.env, cookie, "access")) !== null) return true;
  return await isAdminRequest(c);
}

const OWNER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getOwnerId(c: Context<any>): string | undefined {
  const cookie = getCookie(c, c.env.OWNER_COOKIE_NAME);
  if (cookie && OWNER_ID_RE.test(cookie)) return cookie;
  const header = c.req.header("x-owner-id");
  if (header && OWNER_ID_RE.test(header)) return header;
  return undefined;
}

export function generateOwnerId(): string {
  return crypto.randomUUID();
}
