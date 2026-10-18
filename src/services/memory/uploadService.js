// P5.1.8 — uploadService: turn a user image into a stored VisualMemory,
// with a recoverable upload STATE (P5.1.7 showed 50% provider flake made
// uploads a black box — failures now persist, are explainable, and retryable).
//
// Thin orchestration ONLY. It does NOT re-implement the vision provider
// call, JSON recovery, prompt or schema — those stay in the frozen core:
//   - browser: reuses the frozen bridge client (visionProvider.callVisionProvider)
//   - node/QA: POSTs the same /api/vision contract directly
// then normalizeVisionIntent() (frozen pure function) → createVisualMemory()
// (types.js) → memoryRepository.addMemory() (dual-environment storage).
//
// Never fabricates an intent: if the bridge fails (503/502/…) the failure is
// classified into a stable internal code + a Chinese user message, and a
// `failed` VisualMemory (placeholder intent, error details) is PERSISTED so
// the entry stays visible and can be retried (same id → upsert).
//
// Retry contract: pass the SAME `id` (and, in the browser, the same file or
// the stored thumbnail) to overwrite a failed entry with the new outcome.
// There is deliberately NO automatic unlimited retry — one manual retry per
// failed card (product control, P5.1.8 STEP 2).
import { createVisualMemory, createReadableId } from "./types.js";
import { addMemory } from "./memoryRepository.js";
import { emptyVisualIntent } from "../retrieval/visualIntent.js";

const MEMORY_BRIDGE = "/api/vision"; // same-origin (unchanged from core)
const DEFAULT_BASE = "http://127.0.0.1:4175";
const MIME_OK = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BYTES = 6 * 1024 * 1024; // bridge cap — same as server

const isBrowser =
  typeof window !== "undefined" &&
  typeof window.crypto !== "undefined" &&
  typeof window.crypto.subtle !== "undefined";

// ---- P5.1.8 unified error classification ----------------------------------
// Internal codes are stable; user messages are Chinese and actionable.
// `retryable` marks Vision-layer flakes that a manual retry can recover.
export const UPLOAD_ERRORS = {
  UNSUPPORTED_FORMAT: { code: "UNSUPPORTED_FORMAT", message: "不支持的图片格式，请使用 JPG / PNG / WEBP / GIF。", retryable: false },
  PAYLOAD_TOO_LARGE: { code: "PAYLOAD_TOO_LARGE", message: "图片超过 6MB 上限，请压缩后重试。", retryable: false },
  VISION_TIMEOUT: { code: "VISION_TIMEOUT", message: "AI 分析超时，请重新尝试。", retryable: true },
  VISION_INVALID_RESPONSE: { code: "VISION_INVALID_RESPONSE", message: "AI 分析失败，请重新尝试。", retryable: true },
  VISION_UNAVAILABLE: { code: "VISION_UNAVAILABLE", message: "识图服务暂不可用，请稍后再试。", retryable: false },
  NETWORK_ERROR: { code: "NETWORK_ERROR", message: "网络连接失败，请检查网络后重试。", retryable: true },
  NORMALIZE_FAILED: { code: "NORMALIZE_FAILED", message: "识别结果无法理解，请重新尝试。", retryable: true },
  UNKNOWN: { code: "UNKNOWN", message: "发生未知错误，请重新尝试。", retryable: true },
};

function userError(entry) {
  return { code: entry.code, message: entry.message, retryable: entry.retryable };
}

// Node path: classify an HTTP response (data.error.code from the bridge).
function classifyHttp(status, data) {
  if (status === 401 || status === 403 || status === 429 || status === 404) {
    return userError(UPLOAD_ERRORS.VISION_UNAVAILABLE);
  }
  if (status === 503) return userError(UPLOAD_ERRORS.VISION_UNAVAILABLE);
  if (status === 502) {
    const bridgeCode = data && data.error && data.error.code;
    if (bridgeCode === "timeout" || bridgeCode === "aborted") return userError(UPLOAD_ERRORS.VISION_TIMEOUT);
    return userError(UPLOAD_ERRORS.VISION_INVALID_RESPONSE);
  }
  if (status === 400) {
    const bridgeCode = data && data.error && data.error.code;
    if (bridgeCode === "unsupported-format") return userError(UPLOAD_ERRORS.UNSUPPORTED_FORMAT);
    if (bridgeCode === "payload-too-large") return userError(UPLOAD_ERRORS.PAYLOAD_TOO_LARGE);
    return userError(UPLOAD_ERRORS.UNKNOWN);
  }
  if (status >= 500) return userError(UPLOAD_ERRORS.VISION_INVALID_RESPONSE);
  return userError(UPLOAD_ERRORS.UNKNOWN);
}

// Browser path: classify the frozen bridge client outcome ({error, reason}).
function classifyBridge(res) {
  if (res.error === "too-large") return userError(UPLOAD_ERRORS.PAYLOAD_TOO_LARGE);
  const reason = res.reason;
  if (reason === "timeout") return userError(UPLOAD_ERRORS.VISION_TIMEOUT);
  if (reason === "network") return userError(UPLOAD_ERRORS.NETWORK_ERROR);
  if (reason === "no-bridge" || reason === "auth" || reason === "quota" || reason === "server" || reason === "request") {
    return userError(UPLOAD_ERRORS.VISION_UNAVAILABLE);
  }
  if (reason === "invalid-json") return userError(UPLOAD_ERRORS.VISION_INVALID_RESPONSE);
  return userError(UPLOAD_ERRORS.UNKNOWN);
}

// ---- SHA-256 (dual environment) -------------------------------------------
async function sha256Hex(bytes) {
  if (isBrowser) {
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function buildMeta(title, origin, tags) {
  return {
    title: title ?? "",
    origin: origin ?? "",
    film: null,
    year: null,
    tags: Array.isArray(tags) ? [...tags] : [],
    createdAt: new Date().toISOString(),
  };
}

// Validation failures (user input) do NOT persist — nothing to recover.
// Vision-layer failures DO persist as a `failed` entry (recoverable).
async function persistFailed({ id, name, mime, sha256, meta, userData, err }) {
  const memory = createVisualMemory({
    id: id || createReadableId(Date.now() % 100000),
    source: "user-upload",
    status: "failed",
    error: err,
    image: { path: name || "", mime, sha256 },
    metadata: meta,
    visualIntent: emptyVisualIntent(),
    userData,
  });
  await addMemory(memory);
  return { ok: false, error: err, memory };
}

// ---- browser path: reuse the FROZEN bridge client --------------------------
// `id` supports retry: pass the same id as a failed entry to overwrite it.
export async function uploadMemory(
  file,
  { title = "", origin = "", tags = [], note = "", thumbnail = "", id = "" } = {}
) {
  const mime = file.type && file.type !== "application/octet-stream" ? file.type : "image/jpeg";
  if (!MIME_OK.has(mime)) {
    return { ok: false, error: userError(UPLOAD_ERRORS.UNSUPPORTED_FORMAT), memory: null };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    return { ok: false, error: userError(UPLOAD_ERRORS.PAYLOAD_TOO_LARGE), memory: null };
  }
  const sha256 = await sha256Hex(bytes);
  const meta = buildMeta(title, origin, tags);
  const userData = { note: note ?? "", thumbnail: thumbnail ?? "", collections: [] };

  // Frozen bridge client (same-origin /api/vision, no secrets in browser).
  const { callVisionProvider } = await import("../vision/visionProvider.js");
  const res = await callVisionProvider(file, undefined, { timeoutMs: 60_000 });
  if (!res.ok || !res.raw) {
    return persistFailed({ id, name: file.name || "", mime, sha256, meta, userData, err: classifyBridge(res) });
  }

  // Frozen normalization — a valid VisualIntent (or honest null).
  const { normalizeVisionIntent } = await import("../vision/normalizeVisionIntent.js");
  const intent = normalizeVisionIntent(res.raw);
  if (!intent) {
    return persistFailed({ id, name: file.name || "", mime, sha256, meta, userData, err: userError(UPLOAD_ERRORS.NORMALIZE_FAILED) });
  }

  const memory = createVisualMemory({
    id: id || createReadableId(Date.now() % 100000),
    source: "user-upload",
    status: "success",
    image: { path: file.name || "", mime, sha256 },
    metadata: meta,
    visualIntent: intent,
    userData,
  });
  await addMemory(memory);
  return { ok: true, memory, latencyMs: res.latencyMs ?? null };
}

// ---- node/QA path: read file, POST the same bridge contract ----------------
export async function uploadFromImage(
  imagePath,
  { base = DEFAULT_BASE, title = "", origin = "", tags = [], id = "", note = "" } = {}
) {
  const { readFile } = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const bytes = await readFile(imagePath);
  const ext = pathMod.extname(imagePath).toLowerCase();
  const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext];
  if (!mime) {
    return { ok: false, error: userError(UPLOAD_ERRORS.UNSUPPORTED_FORMAT), memory: null };
  }
  return uploadBytes(bytes, mime, {
    base, title, origin, tags, name: pathMod.basename(imagePath), id, note,
  });
}

export async function uploadBytes(
  bytes,
  mimeType,
  { base = DEFAULT_BASE, title = "", origin = "", tags = [], name = "", id = "", note = "" } = {}
) {
  if (!MIME_OK.has(mimeType)) {
    return { ok: false, error: userError(UPLOAD_ERRORS.UNSUPPORTED_FORMAT), memory: null };
  }
  if (bytes.length > MAX_BYTES) {
    return { ok: false, error: userError(UPLOAD_ERRORS.PAYLOAD_TOO_LARGE), memory: null };
  }
  const sha256 = await sha256Hex(bytes);
  const meta = buildMeta(title, origin, tags);
  const userData = { note: note ?? "", collections: [] };
  const b64 = Buffer.from(bytes).toString("base64");

  let res;
  try {
    res = await fetch(`${base}${MEMORY_BRIDGE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: b64, mimeType }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || /aborted/i.test(String(err && err.message || "")));
    const e = aborted ? userError(UPLOAD_ERRORS.VISION_TIMEOUT) : userError(UPLOAD_ERRORS.NETWORK_ERROR);
    return persistFailed({ id, name, mime: mimeType, sha256, meta, userData, err: e });
  }
  const data = await res.json().catch(() => null);
  if (res.status !== 200 || !data || data.ok !== true || !data.intent) {
    const e = classifyHttp(res.status, data);
    return persistFailed({ id, name, mime: mimeType, sha256, meta, userData, err: e });
  }

  const { normalizeVisionIntent } = await import("../vision/normalizeVisionIntent.js");
  const intent = normalizeVisionIntent(data.intent);
  if (!intent) {
    return persistFailed({ id, name, mime: mimeType, sha256, meta, userData, err: userError(UPLOAD_ERRORS.NORMALIZE_FAILED) });
  }

  const memory = createVisualMemory({
    id: id || createReadableId(Date.now() % 100000),
    source: "user-upload",
    status: "success",
    image: { path: name || "", mime: mimeType, sha256 },
    metadata: meta,
    visualIntent: intent,
    userData,
  });
  await addMemory(memory);
  return { ok: true, memory, latencyMs: data.latencyMs ?? null };
}