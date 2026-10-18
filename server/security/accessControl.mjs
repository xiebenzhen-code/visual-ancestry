// server/security/accessControl.mjs
//
// R5 STEP 4 — REAL access control for the vision bridge.
//
// WHY NOT A FIXED SHARED TICKET
//   The R1.0 design used `X-Vision-Ticket: <fixed token>` compared
//   constant-time. That is a bearer secret: whoever holds it holds unlimited
//   paid provider calls, and a browser-reachable secret must eventually live in
//   the bundle or in localStorage. R5 forbids both.
//
// WHAT THIS DOES INSTEAD
//   Two-step, no static secret ever reaches the bundle:
//
//     1. The operator reads a short ACCESS CODE from the server console (or an
//        operator handover). The code is NOT in the build, NOT in any source
//        file, NOT in dist. The tester types it into the UI.
//     2. POST /api/vision/session  { code }
//        -> server verifies the code (constant-time), then issues a signed
//           short-lived token:  v1.<b64url(payload)>.<b64url(hmac-sha256)>
//        -> the browser keeps it in sessionStorage only.
//
//   The HMAC key (VISION_ACCESS_SECRET) never leaves the server process, and
//   the token cannot be forged offline. A stolen token is bounded by its TTL.
//
// FAIL-CLOSED
//   If VISION_ACCESS_CODE is set but VISION_ACCESS_SECRET is missing, the
//   server REFUSES TO START. A half-configured gate must never degrade into an
//   open gate.
//
// LOCAL-OPEN MODE
//   With no code configured the bridge is open, and that is only acceptable for
//   a developer machine. server.mjs therefore additionally refuses to bind a
//   non-loopback address while in local-open mode, so an accidental deploy
//   cannot expose an unauthenticated paid endpoint.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TTL_MS = 4 * 60 * 60 * 1000; // hard ceiling: 4 hours
const MIN_CODE_LENGTH = 8;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length is the only observable difference and
    // the fast path is not a timing oracle for the prefix.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function accessConfig(env = process.env) {
  const code = typeof env.VISION_ACCESS_CODE === "string" ? env.VISION_ACCESS_CODE.trim() : "";
  const secret = typeof env.VISION_ACCESS_SECRET === "string" ? env.VISION_ACCESS_SECRET.trim() : "";
  const ttlRaw = Number(env.VISION_ACCESS_TTL_MS);
  const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, MAX_TTL_MS) : DEFAULT_TTL_MS;
  return { code, secret, ttlMs };
}

/**
 * Decide the gate mode.
 * Returns { mode, usable, problem } where mode is:
 *   "local-open" — no code configured (developer machine only)
 *   "code"       — code required; session tokens are signed
 *   "broken"     — code set without a secret → the caller MUST refuse to serve
 */
export function accessMode(config) {
  if (!config.code && !config.secret) return { mode: "local-open", usable: true, problem: null };
  if (config.code && !config.secret) {
    return { mode: "broken", usable: false, problem: "VISION_ACCESS_CODE 已设置但缺少 VISION_ACCESS_SECRET，拒绝启动。" };
  }
  if (!config.code && config.secret) {
    return { mode: "broken", usable: false, problem: "VISION_ACCESS_SECRET 已设置但缺少 VISION_ACCESS_CODE，拒绝启动。" };
  }
  if (config.code.length < MIN_CODE_LENGTH) {
    return { mode: "broken", usable: false, problem: `VISION_ACCESS_CODE 至少需要 ${MIN_CODE_LENGTH} 个字符，拒绝启动。` };
  }
  if (config.secret.length < 32) {
    return { mode: "broken", usable: false, problem: "VISION_ACCESS_SECRET 至少需要 32 个字符，拒绝启动。" };
  }
  return { mode: "code", usable: true, problem: null };
}

function sign(payloadB64, secret) {
  return b64url(createHmac("sha256", secret).update(payloadB64).digest());
}

export function issueToken(config, now = Date.now()) {
  const payload = { sid: randomBytes(9).toString("base64url"), iat: now, exp: now + config.ttlMs };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return { token: `${TOKEN_VERSION}.${payloadB64}.${sign(payloadB64, config.secret)}`, expiresAt: payload.exp };
}

export function verifyAccessCode(given, config) {
  return constantTimeEquals(typeof given === "string" ? given.trim() : "", config.code);
}

/**
 * Validate a bearer token. Returns { ok, reason }.
 * reason is a machine code only — never an explanation of what was wrong in
 * terms that would help an attacker (no field names, no lengths, no hints).
 */
export function verifyToken(given, config, now = Date.now()) {
  if (typeof given !== "string" || given.length === 0) return { ok: false, reason: "missing" };
  const parts = given.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: "malformed" };
  const [, payloadB64, sig] = parts;
  const expected = sign(payloadB64, config.secret);
  if (!constantTimeEquals(sig, expected)) return { ok: false, reason: "bad-signature" };
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload.exp !== "number") return { ok: false, reason: "malformed" };
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, reason: null, sid: payload.sid, expiresAt: payload.exp };
}

/**
 * Single entry point used by the bridge.
 * mode "local-open" → allowed, and the caller is expected to have already
 * refused a non-loopback bind.
 */
export function authorizeVisionRequest(headers, config, mode, now = Date.now()) {
  if (mode === "local-open") return { ok: true, reason: null, sid: null };
  const header = headers["x-vision-session"];
  const bearer =
    typeof header === "string" && header.length > 0
      ? header
      : (() => {
          const auth = headers.authorization;
          if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
          return "";
        })();
  return verifyToken(bearer, config, now);
}

export const ACCESS_CONSTANTS = { DEFAULT_TTL_MS, MAX_TTL_MS, MIN_CODE_LENGTH, TOKEN_VERSION };