// http.mjs — 采集层唯一的网络出口。
//
// 为什么集中在一处：超时、并发、重试、429/Retry-After、域名白名单、响应体大小上限
// 这些东西只要有一处漏掉，就会变成"某个来源悄悄拖垮整条管线"。
// 所有 provider 都必须经过这里，不允许自己 fetch。

const ALLOWED_HOSTS = new Set([
  "api.artic.edu",
  "www.artic.edu",
  "collectionapi.metmuseum.org",
  "images.metmuseum.org",
  "openaccess-api.clevelandart.org",
  "openaccess-cdn.clevelandart.org",
  "data.rijksmuseum.nl",
  "id.rijksmuseum.nl",
  "iiif.micr.io",
  "api.openverse.org",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
  "api.tmdb.org",
  "image.tmdb.org",
  "graphql.anilist.co",
  "s4.anilist.co",
  "www.loc.gov",
  "tile.loc.gov",
]);

export const LIMITS = {
  timeoutMs: 20000,
  maxBytes: 8 * 1024 * 1024,
  concurrency: 6,
  retries: 2,
  retryDelayMs: 1500,
};

export class HttpError extends Error {
  constructor(message, { status = 0, retryAfter = null, url = "" } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.url = url;
  }
}

function assertHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(`bad-url: ${String(url).slice(0, 80)}`);
  }
  if (u.protocol !== "https:") throw new HttpError(`非 https 被拒绝: ${u.origin}`);
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new HttpError(`域名不在白名单: ${u.hostname}`);
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取 JSON 或文本。带超时、有界重试、429/Retry-After。
 */
export async function getJson(url, { headers = {}, timeoutMs = LIMITS.timeoutMs, retries = LIMITS.retries } = {}) {
  assertHost(url);
  let attempt = 0;
  let lastError = null;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        throw new HttpError(`限流 ${res.status}`, { status: res.status, retryAfter: retryAfter * 1000, url });
      }
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, { status: res.status, url });
      const text = await res.text();
      if (text.length > LIMITS.maxBytes) throw new HttpError(`响应过大 ${text.length}B`, { url });
      return { json: safeJson(text), text, status: res.status };
    } catch (e) {
      lastError = e;
      const retryable = e instanceof HttpError ? e.status === 429 || e.status === 503 || e.status === 0 : true;
      if (!retryable || attempt === retries) break;
      await sleep(e.retryAfter || LIMITS.retryDelayMs * (attempt + 1));
      attempt += 1;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new HttpError("unknown");
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 取图片字节。校验 Content-Type 与大小，返回 { bytes, contentType }。
 * 不解码（解码在 validate-image 里用真实解码器做）。
 */
export async function getImage(url, { headers = {}, timeoutMs = LIMITS.timeoutMs, attempts = 2 } = {}) {
  assertHost(url);
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after")) || 0;
        lastErr = new HttpError(`image HTTP ${res.status}`, { status: res.status, url, retryAfter: ra * 1000 });
        if (i + 1 < attempts) { await sleep(ra * 1000 || 1200); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new HttpError(`image HTTP ${res.status}`, { status: res.status, url });
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) throw new HttpError(`非图片 Content-Type: ${ct || "(空)"}`, { url });
    const len = Number(res.headers.get("content-length")) || 0;
    if (len && len > LIMITS.maxBytes) throw new HttpError(`图片过大 ${len}B`, { url });
      const ab = await res.arrayBuffer();
      if (ab.byteLength > LIMITS.maxBytes) throw new HttpError(`图片过大 ${ab.byteLength}B`, { url });
      return { bytes: Buffer.from(ab), contentType: ct };
    } catch (e) {
      lastErr = e;
      if (i + 1 >= attempts || !(e instanceof HttpError) || (e.status && e.status !== 429 && e.status !== 503 && e.status !== 0)) throw e;
      await sleep(1200);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new HttpError("image failed", { url });
}

/** 有界并发跑一批任务。 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
