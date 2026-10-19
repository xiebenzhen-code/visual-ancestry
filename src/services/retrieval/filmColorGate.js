// filmColorGate.js — 远程电影候选的黑白硬性排除（浏览器侧）
//
// 为什么单独一个文件：
//   本地池可以靠影片级事实（FILM_COLOR_FACTS）在同步路径上过滤；
//   远程 Commons 候选没有影片级事实，也没有颜色元数据（实测 extmetadata
//   的 15 个字段里没有任何 color/colour/black-and-white 键，Categories
//   也不含 "Black and white films"），所以只能实测像素。
//   实测需要 canvas + 异步读图，不能塞进同步的 curatedPool。
//
// 边界：
//   · 只接受 wikimedia 图像域名（与 P4.10 同一个白名单）
//   · 读不到像素 → 判 unknown → 排除并记录（任务书第 4 条）
//   · 绝不用「饱和度低」当判据（sepia 片饱和度很高，见 monochromePolicy 注释）

import { measureChroma, classifyChroma } from "./monochromePolicy.js";

const CACHE_PREFIX = "va-film-color-v1";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 12000;
const SAMPLE_WIDTH = 200;

function cacheKey(url) {
  return `${CACHE_PREFIX}:${url}`;
}

function readCache(url) {
  try {
    const raw = window.localStorage.getItem(cacheKey(url));
    if (!raw) return null;
    const e = JSON.parse(raw);
    if (!e || Date.now() - e.ts > CACHE_TTL) return null;
    return e.value;
  } catch {
    return null;
  }
}

function writeCache(url, value) {
  try {
    window.localStorage.setItem(cacheKey(url), JSON.stringify({ ts: Date.now(), value }));
  } catch {
    /* 隐私模式/配额满：静默降级为不缓存，不影响判定 */
  }
}

/**
 * 从 URL 读像素并测色度。返回 { ok:true, chroma } 或 { ok:false, reason }。
 */
export async function measureUrlChroma(url, { timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return { ok: false, reason: "no-dom" };
  }
  if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(String(url || ""))) {
    return { ok: false, reason: "untrusted-host" };
  }
  const cached = readCache(url);
  if (cached) return { ok: true, chroma: cached, cached: true };

  const img = new Image();
  img.crossOrigin = "anonymous";
  const loaded = await new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), timeoutMs);
    img.onload = () => { clearTimeout(timer); settle({ ok: true }); };
    img.onerror = () => { clearTimeout(timer); settle({ ok: false, reason: "load-error" }); };
    img.src = url;
  });
  if (!loaded.ok) return loaded;
  if (!img.naturalWidth || !img.naturalHeight) return { ok: false, reason: "zero-natural-size" };

  try {
    const w = Math.min(SAMPLE_WIDTH, img.naturalWidth);
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: false, reason: "no-2d-context" };
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h);
    const chroma = measureChroma({ data: pixels.data, width: w, height: h, channels: 4 });
    if (!chroma.ok) return { ok: false, reason: chroma.reason || "chroma-failed" };
    writeCache(url, chroma);
    return { ok: true, chroma };
  } catch (e) {
    return { ok: false, reason: `raster-blocked: ${String(e?.name || e?.message || e).slice(0, 60)}` };
  }
}

/**
 * 过滤远程电影候选。
 *
 * 返回 { results, excluded }。results 已经剔除了黑白与无法确认的候选。
 * 允许返回 1 条或 0 条 —— 不用无关素材补足数量（任务书第 5 条）。
 *
 * @param {Array} results  远程候选（每条带 artwork.image.thumbnailUrl）
 * @param {object} [opts]
 * @param {number} [opts.concurrency=2]  与 filmPixelCompare 同一上限
 * @param {Function} [opts.measure]  测试注入点
 */
export async function gateRemoteFilmByColor(results, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const concurrency = Math.max(1, Math.min(3, opts.concurrency ?? 2));
  const measure = typeof opts.measure === "function" ? opts.measure : measureUrlChroma;

  const kept = [];
  const excluded = [];
  const reasons = new Map(); // id -> {verdict, reason}

  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      const item = list[idx];
      const art = item?.artwork || item || {};
      const img = art.image || {};
      const url = img.thumbnailUrl || img.url || null;
      const id = art.id || art.sourceId || art.remote?.sourceId || `idx-${idx}`;
      const filmTitle = art.film?.title || art.title || "";

      if (!url) {
        reasons.set(idx, {
          id, filmTitle,
          verdict: "unknown",
          reason: "候选没有可读取的图像地址，无法确认是否黑白",
        });
        continue;
      }

      const m = await measure(url);
      if (!m.ok) {
        reasons.set(idx, {
          id, filmTitle,
          verdict: "unknown",
          reason: `无法读取像素（${m.reason}），不能确认是否黑白`,
        });
        continue;
      }
      const cls = classifyChroma(m.chroma);
      if (cls.verdict === "color") {
        kept.push({ idx, item });
      } else {
        reasons.set(idx, { id, filmTitle, verdict: cls.verdict, reason: cls.reason });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));

  // 保持原有相对顺序，不让异步完成次序改变推荐顺序
  kept.sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < list.length; i++) {
    const r = reasons.get(i);
    if (r) excluded.push(r);
  }

  return { results: kept.map((k) => k.item), excluded };
}

export const FILM_COLOR_GATE = {
  rule: "黑白电影影像不进推荐列表",
  mode: "hard-filter",
  unknownHandling: "exclude-and-record",
  allowEmpty: true,
  refillWithUnrelated: false,
  cache: { prefix: CACHE_PREFIX, ttlMs: CACHE_TTL },
  allowedHosts: ["upload.wikimedia.org", "thumb.wikimedia.org"],
};
