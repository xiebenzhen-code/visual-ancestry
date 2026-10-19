// filmPixelCompare.js — P4.10 STEP 3/4：给远程电影候选做**真实像素比较**。
//
// 定位：这是「元数据召回之后」的第二阶段。它不改变谁被召回，只回答
// 「这些已经通过来源/许可/性质核验的候选，画面结构和查询图有多接近」。
//
// 三条硬约束（来自任务书，写进代码防止越界）：
//   1. 不与本地 VisualIntent 22 字段分数相加 —— 两者量纲不同。
//      本模块只重排**远程电影候选之间**，不参与本地作品排序。
//   2. 不产生 semantic-verified。没有真实语义视觉分析时，
//      最高只能到 pixel-compared。
//   3. 读不到像素就标 unavailable，不猜特征。
//
// 缓存：以 Commons 的 sha1（imageinfo 已提供）+ 采样宽度为键。
// sha1 变则缓存失效 —— 不需要自建版本号。
// 只存特征，不存图像本身。

import { spatialFromImageData, spatialDistance, similarityLevel } from "./spatialSignature.js";

const CACHE_PREFIX = "va-spatial-sig-v1";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_SCHEMA = 1;
// 采样宽度 160 是实测定下的：再小（80）九格统计噪声明显，再大（320）计算时间翻倍而结果差异 < 0.005。
const SAMPLE_WIDTH = 160;
// 单次比较的候选上限。任务书要求严格限制数量与耗时。
const MAX_CANDIDATES = 8;
// 单张图的读取超时。实测 Commons 缩略图 11ms–2.6s，给 12s 足够且不至于卡死整页。
const IMAGE_TIMEOUT_MS = 12000;

function cacheKey(sha1, width) {
  return `${CACHE_PREFIX}:${sha1 || "nohash"}:${width}`;
}

function cacheRead(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const e = JSON.parse(raw);
    if (!e || Date.now() - e.ts > CACHE_TTL) return null;
    if (e.schema !== CACHE_SCHEMA) {
      window.localStorage.removeItem(key);
      return null;
    }
    return e.value;
  } catch {
    return null;
  }
}

function cacheWrite(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ts: Date.now(), schema: CACHE_SCHEMA, value }));
  } catch {
    /* 配额满/隐私模式：静默降级为不缓存，不影响功能 */
  }
}

/**
 * 从本地 File（用户上传图）计算空间签名。
 * 与 URL 版分开：File 不走 CORS，也不存在画布污染，直接用 createImageBitmap。
 */
export async function spatialFromFile(file, { width = SAMPLE_WIDTH } = {}) {
  if (typeof document === "undefined") return { ok: false, reason: "no-dom", spatial: null };
  if (!file) return { ok: false, reason: "no-file", spatial: null };
  let bitmap = null;
  try {
    bitmap = typeof createImageBitmap === "function"
      ? await createImageBitmap(file)
      : await new Promise((res, rej) => {
          const im = new Image();
          const u = URL.createObjectURL(file);
          im.onload = () => { URL.revokeObjectURL(u); res(im); };
          im.onerror = (e) => { URL.revokeObjectURL(u); rej(e); };
          im.src = u;
        });
    const w = Math.min(width, bitmap.width || bitmap.naturalWidth);
    const ratio = (bitmap.height || bitmap.naturalHeight) / (bitmap.width || bitmap.naturalWidth);
    const h = Math.max(1, Math.round(ratio * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: false, reason: "no-2d-context", spatial: null };
    ctx.drawImage(bitmap, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const sig = spatialFromImageData({ data: imageData.data, width: w, height: h, channels: 4 });
    return sig.ok ? { ok: true, spatial: sig.spatial, sampledWidth: w, sampledHeight: h }
                  : { ok: false, reason: sig.reason || "signature-failed", spatial: null };
  } catch (e) {
    return { ok: false, reason: `file-raster-failed: ${String(e?.message || e).slice(0, 60)}`, spatial: null };
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}
/**
 * 从 URL 读像素并算空间签名。
 *
 * 关键：必须设 crossOrigin="anonymous"。实测（qa 里记录）：
 *   · 不设 crossOrigin：4/4 图片 getImageData 抛 SecurityError（画布被污染）
 *   · 设了 crossOrigin：4/4 可读，因为 upload/thumb.wikimedia.org 返回
 *     access-control-allow-origin: *
 * 所以不需要服务端代理，也就不引入 SSRF 面。
 */
export async function spatialSignatureFromUrl(url, { timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return { ok: false, reason: "no-dom", spatial: null };
  }
  if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(String(url || ""))) {
    // 只接受 Commons 图像域名。这是白名单，不是「任意 URL 都行」。
    return { ok: false, reason: "untrusted-host", spatial: null };
  }

  const img = new Image();
  img.crossOrigin = "anonymous";

  const loaded = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      done({ ok: true });
    };
    img.onerror = () => {
      clearTimeout(timer);
      done({ ok: false, reason: "load-error" });
    };
    img.src = url;
  });

  if (!loaded.ok) return { ok: false, reason: loaded.reason, spatial: null };
  if (!img.naturalWidth || !img.naturalHeight) {
    return { ok: false, reason: "zero-natural-size", spatial: null };
  }

  try {
    const w = Math.min(SAMPLE_WIDTH, img.naturalWidth);
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: false, reason: "no-2d-context", spatial: null };
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const sig = spatialFromImageData({
      data: imageData.data,
      width: w,
      height: h,
      channels: 4, // ImageData 一定是 RGBA
    });
    if (!sig.ok) return { ok: false, reason: sig.reason || "signature-failed", spatial: null };
    return { ok: true, spatial: sig.spatial, sampledWidth: w, sampledHeight: h };
  } catch (e) {
    // SecurityError 会走到这里：说明画布被污染。如实报告，不伪造特征。
    return { ok: false, reason: `raster-blocked: ${String(e?.name || e?.message || e).slice(0, 60)}`, spatial: null };
  }
}

/**
 * 主入口：把查询图与一组远程电影候选做像素比较。
 *
 * @param {object|null} querySig  查询图的空间签名（来自 spatialFromImageData）
 * @param {Array} items           远程电影候选（findRemoteFilm 的 results）
 * @returns {Promise<{
 *   compared: Array,       // 成功比较的（含 components / level / explanation）
 *   unreadable: Array,     // 读不到像素的（含原因）
 *   stats: object
 * }>}
 */
export async function compareFilmCandidatesWithQuery(querySig, items = []) {
  const out = { compared: [], unreadable: [], stats: { attempted: 0, succeeded: 0, cached: 0 } };
  if (!querySig || !querySig.ok) {
    return { ...out, skipped: "no-query-signature" };
  }

  const targets = items
    .filter((it) => it && it.artwork && it.artwork.image && !it.artwork.imageUnavailable)
    .slice(0, MAX_CANDIDATES);

  for (const it of targets) {
    out.stats.attempted++;
    const art = it.artwork;
    const image = art.image || {};
    // 优先用缩略图（更小更快），退回原图。
    const url = image.thumbnailUrl || image.url || (image.tiers && image.tiers.preview) || null;
    const sha1 = art.remote?.sha1 || image.sha1 || null;
    const key = cacheKey(sha1, SAMPLE_WIDTH);

    let sig = cacheRead(key);
    if (sig) {
      out.stats.cached++;
    } else {
      const fetched = await spatialSignatureFromUrl(url);
      if (!fetched.ok) {
        out.unreadable.push({
          sourceId: art.remote?.sourceId || art.id,
          title: art.film?.title || art.title,
          reason: fetched.reason,
        });
        continue;
      }
      sig = fetched;
      cacheWrite(key, { spatial: sig.spatial, sampledWidth: sig.sampledWidth, sampledHeight: sig.sampledHeight });
    }

    const dist = spatialDistance(querySig, sig);
    if (!dist.comparable) {
      out.unreadable.push({
        sourceId: art.remote?.sourceId || art.id,
        title: art.film?.title || art.title,
        reason: "not-comparable",
      });
      continue;
    }
    out.stats.succeeded++;
    const level = similarityLevel(dist.distance);
    out.compared.push({
      sourceId: art.remote?.sourceId || art.id,
      title: art.film?.title || art.title,
      distance: dist.distance,
      level: level.level,
      levelLabel: level.label,
      components: dist.components,
      colourComparable: dist.colourComparable,
      incomparable: dist.incomparable,
      explanation: explainComparison(dist),
      status: "pixel-compared",
    });
  }

  return out;
}

/**
 * 把分量翻译成人能读的说明。
 * **只描述像素分布，不推断语义。** 这是任务书的硬线：
 * 可以说「明暗分布接近」，不可以说「两个人物形成相同的对峙关系」。
 */
export function explainComparison(dist) {
  const similar = [];
  const different = [];
  const c = dist.components || {};
  const pct = (v) => `${Math.round((1 - v) * 100)}%`;

  if (typeof c.luminanceLayout === "number") {
    if (c.luminanceLayout <= 0.08) similar.push(`明暗分区接近（九宫格亮度吻合 ${pct(c.luminanceLayout)}）`);
    else if (c.luminanceLayout >= 0.18) different.push("明暗分区差异明显");
  }
  if (typeof c.edgeLayout === "number") {
    if (c.edgeLayout <= 0.05) similar.push("细节密度分布接近");
    else if (c.edgeLayout >= 0.12) different.push("细节密度分布不同");
  }
  if (typeof c.colourLayout === "number") {
    if (c.colourLayout <= 0.10) similar.push("色彩分布接近");
    else if (c.colourLayout >= 0.25) different.push("色彩分布不同");
  }
  if (typeof c.brightness === "number" && c.brightness <= 0.05) {
    similar.push("整体明暗接近");
  }
  if (typeof c.brightness === "number" && c.brightness >= 0.25) {
    different.push("整体明暗差异大");
  }

  return {
    similar,
    different,
    // 不可比较的因素必须显式列出，不能静默省略。
    incomparable: dist.incomparable || [],
    basis: "逐像素统计（九宫格亮度/细节/色彩分布），不含语义分析",
    disclaimer: "没有做任何对象、人物或场景识别。",
  };
}

/**
 * 按像素距离整理候选。**P4.10 实测后降级：不再用它提升任何候选的排名。**
 *
 * 为什么降级（这是本轮最重要的结论，证据见 .rc1-audit/P4.10-REPORT.md）：
 *   效度检验显示同一张图裁掉 10% 的距离是 0.1477，
 *   而它与一幅完全不同的画（Whistler 的母亲）距离只有 0.1054。
 *   重叠区 0.0423 —— 该描述子无法区分「同图轻微重构图」与「换了一幅画」。
 *   在这种分辨力下让它提权，等于用随机扰动改变推荐顺序。
 *
 * 现在的语义：只产出证据与等级，供人阅读；排序完全保留元数据顺序。
 * 保留 pixelRank 字段仅作「如果按结构距离会怎样」的旁证，不参与渲染顺序。
 */
export function reorderByPixels(items, compared) {
  const byId = new Map((compared || []).map((c) => [c.sourceId, c]));
  const decorated = items.map((it, i) => {
    const id = it.artwork?.remote?.sourceId || it.artwork?.id;
    const c = byId.get(id) || null;
    return {
      item: it,
      metadataRank: i + 1,
      pixel: c,
      pixelDistance: c ? c.distance : null,
      status: c ? "pixel-compared" : "metadata-only",
    };
  });
  // 旁证排名：只计算「若仅按结构距离会怎么排」，不用于渲染。
  const sortedByPixel = decorated
    .filter((d) => d.pixelDistance !== null)
    .sort((a, b) => a.pixelDistance - b.pixelDistance);
  const pixelRankOf = new Map(sortedByPixel.map((d, i) => [d.item, i + 1]));
  // 返回顺序 = 原元数据顺序。像素只挂一个旁证名次。
  return decorated.map((d) => ({
    ...d,
    pixelRank: pixelRankOf.get(d.item) || null,
    // 明确标注：这个名次不参与排序，只作为证据。
    rankApplied: false,
  }));
}

export const FILM_PIXEL_CONTRACT = {
  sampleWidth: SAMPLE_WIDTH,
  maxCandidates: MAX_CANDIDATES,
  imageTimeoutMs: IMAGE_TIMEOUT_MS,
  allowedHosts: ["upload.wikimedia.org", "thumb.wikimedia.org"],
  maxStatus: "pixel-compared",
  neverProduce: ["semantic-verified"],
  cache: { prefix: CACHE_PREFIX, key: "sha1+sampleWidth", ttlMs: CACHE_TTL },
};
