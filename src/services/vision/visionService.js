// visionService — orchestration of the single vision path.
//
//   image → client resize (≤1280px JPEG) → POST /api/vision → normalize → VisualIntent
//
// Pages call analyzeImage() only; they never touch a provider. The browser
// bundle contains no provider credentials: the only outbound vision call is a
// same-origin POST /api/vision, where a server-side adapter owns the real
// multimodal provider and its server-held secrets (never placed in any static
// or browser-persistent location). Until that bridge exists, /api/vision
// fails honestly and the FIND UI falls back to 改用文字描述 — nothing is
// invented.
//
// Vision scope is narrow: observable visual structure only. Identity, story,
// psychology, intent, symbolism, genre and artist-style are out of scope.
import { normalizeVisionIntent } from "./normalizeVisionIntent.js";
import { prepareVisionImage } from "./prepareVisionImage.js";
import { callVisionProvider, VISION_ERRORS } from "./visionProvider.js";

export { VISION_ERRORS };

const SUPPORTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;

// QA seam: automated acceptance injects a test-only provider function on
// window before any module loads. Production builds strip the seam branches
// below (see scripts/build.mjs); applyProvider then simply calls the real
// same-origin bridge, so the shipped bundle never references test fixtures.
async function applyProvider(file) {
  /*__QA_SEAM_START__*/
  if (typeof window !== "undefined" && typeof window.__FA_TEST_VISION === "function") {
    return window.__FA_TEST_VISION(file);
  }
  /*__QA_SEAM_END__*/
  return realProviderFor(file);
}
async function realProviderFor(file) {
  return callVisionProvider(file, undefined, { timeoutMs: REQUEST_TIMEOUT_MS });
}

// No server-side bridge is configured in this build, so vision is honestly
// unavailable: the browser calls same-origin /api/vision, which does not exist
// yet, fails cleanly, and FIND falls back to 改用文字描述.
// QA builds (--qa) keep the test-only provider seam; when injected on window,
// the FIND image flow treats vision as available so acceptance flows work.
//
// R1.0 — the production gate is now a REAL same-origin probe: GET
// /api/vision/status returns { provider: "configured" } only when the
// server-side bridge owns a working provider (VISION_API_BASE + KEY). The
// browser enables the image mode only when that probe succeeds — no fake
// availability, no credentials in the bundle. The probe result is cached for
// STATUS_TTL_MS so the UI does not hammer the endpoint per interaction.
const STATUS_ENDPOINT = "/api/vision/status";
const STATUS_TTL_MS = 30_000;
let statusCache = null; // { at, configured }

export function visionAvailable() {
  /*__QA_SEAM_START__*/
  if (typeof window !== "undefined" && typeof window.__FA_TEST_VISION === "function") {
    return true;
  }
  /*__QA_SEAM_END__*/
  return statusCache !== null && statusCache.configured === true && Date.now() - statusCache.at < STATUS_TTL_MS;
}

export async function probeVisionStatus() {
  /*__QA_SEAM_START__*/
  if (typeof window !== "undefined" && typeof window.__FA_TEST_VISION === "function") {
    statusCache = { at: Date.now(), configured: true };
    return true;
  }
  /*__QA_SEAM_END__*/
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.configured === true;
  }
  try {
    const res = await fetch(STATUS_ENDPOINT, { method: "GET", signal: AbortSignal.timeout(4000) });
    if (res.status !== 200) {
      statusCache = { at: Date.now(), configured: false };
      return false;
    }
    const data = await res.json().catch(() => null);
    const configured = !!(data && data.provider === "configured");
    statusCache = { at: Date.now(), configured };
    return configured;
  } catch {
    statusCache = { at: Date.now(), configured: false };
    return false;
  }
}

export async function analyzeImage(file) {
  if (!file) return fail(VISION_ERRORS.FAILED);
  if (file.type && !SUPPORTED_TYPES.includes(file.type)) return fail(VISION_ERRORS.UNSUPPORTED);
  if (typeof file.size === "number" && file.size > MAX_BYTES) return fail(VISION_ERRORS.TOO_LARGE);

  // Client-side resize/compress: the provider receives a smaller JPEG while
  // the UI keeps the original for local preview. Nothing is persisted.
  const prepared = await prepareVisionImage(file);

  let response;
  try {
    response = await applyProvider(prepared.file);
  } catch {
    return fail(VISION_ERRORS.FAILED, "network");
  }
  // R5 STEP 5 — the CALLER REASON must survive. visionProvider already
  // classifies the bridge answer (auth / quota / rate-limited / not-configured
  // / server / no-bridge / invalid-json / timeout / network). Collapsing all of
  // them into one "vision-failed" made the UI show an identical sentence for
  // "no provider configured" and "you were rate limited", which are different
  // problems with different remedies. The reason is a machine code only.
  if (!response || !response.ok) return fail((response && response.error) || VISION_ERRORS.FAILED, (response && response.reason) || "failed");

  const intent = normalizeVisionIntent(response.raw);
  if (!intent) return fail(VISION_ERRORS.INCOMPLETE, "invalid-intent");
  if (isEmptyIntent(intent)) return fail(VISION_ERRORS.EMPTY, "empty-intent");
  return { ok: true, intent, demo: false };
}

function fail(error, reason) {
  return { ok: false, error, intent: null, reason: reason || "failed" };
}

function isEmptyIntent(intent) {
  return Object.entries(intent).every(([key, value]) => {
    if (key === "source") return true;
    if (Array.isArray(value)) return value.length === 0;
    return !value;
  });
}
