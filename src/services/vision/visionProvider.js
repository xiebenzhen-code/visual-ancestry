// visionProvider — browser-side vision bridge CLIENT (same-origin only).
//
// Security posture (locked by V5.1 P2): the browser NEVER talks to a
// third-party vision provider directly. This bundle carries no credentials,
// no provider URL and no auth headers of any kind. The only outbound vision
// call the browser may make is a same-origin POST /api/vision, where a
// server-side adapter (server/vision/openaiProvider.mjs — NOT shipped) owns
// the real provider and its server-held secrets.
//
// Before that bridge exists, /api/vision fails honestly and the FIND UI falls
// back to 改用文字描述. Nothing is invented.

export const VISION_ERRORS = {
  UNSUPPORTED: "unsupported-format",
  TOO_LARGE: "too-large",
  FAILED: "vision-failed",
  INCOMPLETE: "incomplete",
  EMPTY: "empty-intent",
};

// Same-origin vision endpoint. The server route must only accept resized
// images and MUST itself own all provider secrets.
const VISION_BRIDGE = "/api/vision";

// Browser-side contract mirror (the same shape /api/vision is expected to
// return): { ok: true, raw: <object>, latencyMs } | { ok: false, error, reason }
export async function callVisionProvider(file, _config, { timeoutMs = 45000, inputW = 0, inputH = 0 } = {}) {
  const b64 = await fileToBase64(file);
  const mime = file && file.type && file.type !== "application/octet-stream" ? file.type : "image/jpeg";
  const started = Date.now();
  try {
    const res = await fetch(VISION_BRIDGE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mimeType: mime, imageBase64: b64 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = res.status;
    // R5 STEP 5 — keep the bridge's own machine code so the UI can say WHICH
    // problem occurred. Without this, "server has no provider configured" and
    // "provider is broken" both became `server` and rendered one sentence.
    let bridgeCode = null;
    if (status !== 200 && status !== 404) {
      const peeked = await res.clone().json().catch(() => null);
      if (peeked && peeked.error && typeof peeked.error.code === "string") bridgeCode = peeked.error.code;
    }
    if (status === 401) return outcome(false, "auth", { status, bridgeCode });
    if (status === 403) return outcome(false, "auth", { status, bridgeCode });
    if (status === 429) return outcome(false, "rate-limited", { status, bridgeCode });
    if (status === 503) return outcome(false, "not-configured", { status, bridgeCode });
    if (status >= 500) return outcome(false, "server", { status, bridgeCode });
    if (status === 404) return outcome(false, "no-bridge", { status, bridgeCode });
    if (status !== 200) return outcome(false, "request", { status, bridgeCode });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return outcome(false, "invalid-json", { status });
    }
    if (!data || data.ok !== true || !data.intent) return outcome(false, "invalid-json", { status });
    return { ok: true, raw: data.intent, latencyMs: Date.now() - started };
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "timeout" : "network";
    return outcome(false, reason, {});
  }
}

function outcome(ok, reason, extra) {
  return { ok, error: ok ? undefined : VISION_ERRORS.FAILED, reason, ...extra };
}

async function fileToBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}