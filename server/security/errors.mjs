// server/security/errors.mjs
//
// R5 STEP 4 — one place that decides what a client is allowed to see.
//
// RULE
//   A response body may contain: a machine code, a fixed Chinese sentence, and
//   nothing else. It may never contain the provider's raw text, the upstream
//   URL, the API key, a stack trace, a file path, or anything derived from the
//   user's image. The provider reason is mapped to a code here and dropped.
//
//   The detail that WOULD be useful for debugging goes to stdout via
//   `logServerEvent`, which emits structural facts only (codes, counts,
//   durations) — never content.

export const CLIENT_ERRORS = {
  unauthorized: { status: 401, message: "识图服务未授权：请先在本页输入访问码。" },
  forbidden: { status: 403, message: "访问码无效或已失效。" },
  "session-expired": { status: 403, message: "访问会话已过期，请重新输入访问码。" },
  "rate-limited": { status: 429, message: "识图请求过于频繁，请稍后再试。" },
  "budget-exhausted-daily": { status: 429, message: "今日识图调用额度已用尽，请明日再试。" },
  "budget-exhausted-total": { status: 429, message: "识图调用总额度已用尽。" },
  // P3.1：已配置付费 Provider 却拿不到可用账本时拒绝调用。用 503 而不是 429 是
  // 有意的——额度并没有用尽，缺的是安全机制本身，报 429 会把人引向错误方向。
  "budget-unavailable": { status: 503, message: "预算账本未配置或不可用，已拒绝调用。" },
  // P3.1：本轮自己的调用次数上限（按**尝试次数**计，不是按不同图片数）。
  "round-call-limit": { status: 429, message: "本次实验的识图调用次数已达上限。" },
  "too-many-in-flight": { status: 429, message: "当前识图请求过多，请稍后再试。" },
  "payload-too-large": { status: 413, message: "请求体超过 6MB 上限。" },
  "invalid-json": { status: 400, message: "请求体不是合法 JSON。" },
  "missing-field": { status: 400, message: "缺少 imageBase64 或 mimeType。" },
  "unsupported-format": { status: 400, message: "仅支持 JPG / PNG / WEBP / GIF。" },
  "invalid-base64": { status: 400, message: "imageBase64 无法解码。" },
  "provider-not-configured": { status: 503, message: "服务端未配置真实识图模型。" },
  "access-not-configured": { status: 503, message: "服务端访问控制配置不完整。" },
  "upstream-auth": { status: 502, message: "上游识图服务拒绝了本次调用。" },
  "upstream-quota": { status: 502, message: "上游识图服务额度受限。" },
  "upstream-server": { status: 502, message: "上游识图服务暂时不可用。" },
  "upstream-request": { status: 502, message: "上游识图服务拒绝了本次请求。" },
  "upstream-invalid-json": { status: 502, message: "上游识图服务返回了无法解析的内容。" },
  "upstream-empty": { status: 502, message: "上游识图服务没有返回可用内容。" },
  "upstream-timeout": { status: 504, message: "上游识图服务响应超时。" },
  "upstream-network": { status: 502, message: "无法连接上游识图服务。" },
  "intent-rejected": { status: 502, message: "上游返回的视觉意图未通过校验。" },
  "provider-missing": { status: 500, message: "服务端识图适配器缺失。" },
  "vision-service-error": { status: 500, message: "识图服务内部错误。" },
  "not-found": { status: 404, message: "资源不存在。" },
  "method-not-allowed": { status: 405, message: "请求方法不被允许。" },
  "server-error": { status: 500, message: "服务内部错误。" },
};

// Provider outcome reason -> client code. Anything not listed becomes the
// generic 502, so a future provider reason can never accidentally pass through.
const REASON_TO_CODE = {
  auth: "upstream-auth",
  quota: "upstream-quota",
  server: "upstream-server",
  request: "upstream-request",
  "invalid-json": "upstream-invalid-json",
  "empty-response": "upstream-empty",
  timeout: "upstream-timeout",
  network: "upstream-network",
};

export function clientError(code, fallback = "vision-service-error") {
  return CLIENT_ERRORS[code] || CLIENT_ERRORS[fallback];
}

/**
 * Build the ONLY body shape a client may see.
 * `meta` is restricted to numbers and short machine strings on purpose.
 */
export function errorBody(code, { meta = null } = {}) {
  const spec = clientError(code);
  const error = { code: CLIENT_ERRORS[code] ? code : "vision-service-error", message: spec.message };
  if (meta && typeof meta === "object") {
    const safe = {};
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v === "number" && Number.isFinite(v)) safe[k] = v;
      else if (typeof v === "boolean") safe[k] = v;
    }
    if (Object.keys(safe).length > 0) error.meta = safe;
  }
  return { status: spec.status, body: { ok: false, error } };
}

export function providerReasonToCode(reason) {
  return REASON_TO_CODE[reason] || "vision-service-error";
}

/**
 * Server-side log. Structural facts only.
 * Allowed: machine codes, counts, durations, booleans, model name.
 * Never called with a provider body, an image, a key, or a stack.
 */
export function logServerEvent(kind, fields = {}) {
  if (typeof console !== "undefined" && typeof console.log === "function") {
    const safe = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "number" && Number.isFinite(v)) safe[k] = v;
      else if (typeof v === "boolean") safe[k] = v;
      else if (typeof v === "string" && /^[A-Za-z0-9_.\-]{1,64}$/.test(v)) safe[k] = v;
    }
    console.log(`[fa-bridge] ${kind} ${JSON.stringify(safe)}`);
  }
}

export const ERROR_CODES = Object.keys(CLIENT_ERRORS);