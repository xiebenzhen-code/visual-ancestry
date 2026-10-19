// P4.4 — 浏览器端色彩签名（与 colorSignature.js 同算法、同参数）
//
// 为什么需要这份实现：
//   colorSignature.js 依赖 sharp（Node-only，devDependency），浏览器无法 import。
//   但「上传一张陌生图片，必须从它自己的像素算颜色」是硬要求，
//   不能拿本地已知作品的预计算值冒充。
//
// 一致性保证：
//   · 同一光栅策略：等比缩到 256 宽、白底拍平、sRGB
//   · 同一主色算法：5-bit 直方图 + 加权中位切分（无 k-means、无 RNG）
//   · 同一字段集与同一 basis 字符串
//   qa/p44 测试会用同一张图对比 Node 版与浏览器版数值，差值必须极小。
//
// 不依赖 sharp，只用 canvas。无法取像素时返回 ok:false，绝不伪造。

const TARGET_WIDTH = 256;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

/** 与 Node 版完全相同的加权中位切分 */
function dominantColors(pixels, total, k = 6) {
  const binCount = new Map();
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let e = binCount.get(bin);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; binCount.set(bin, e); }
    e.n++; e.r += r; e.g += g; e.b += b;
  }
  let boxes = [{ bins: [...binCount.entries()].map(([bin, e]) => ({ bin, ...e })), n: 0, r: 0, g: 0, b: 0 }];
  boxes[0].bins.forEach((x) => { boxes[0].n += x.n; boxes[0].r += x.r; boxes[0].g += x.g; boxes[0].b += x.b; });

  const rangeOf = (box) => {
    let mnR = 255, mxR = 0, mnG = 255, mxG = 0, mnB = 255, mxB = 0;
    for (const x of box.bins) {
      const r = x.r / x.n, g = x.g / x.n, b = x.b / x.n;
      if (r < mnR) mnR = r; if (r > mxR) mxR = r;
      if (g < mnG) mnG = g; if (g > mxG) mxG = g;
      if (b < mnB) mnB = b; if (b > mxB) mxB = b;
    }
    return [{ ch: "r", span: mxR - mnR }, { ch: "g", span: mxG - mnG }, { ch: "b", span: mxB - mnB }]
      .sort((p, q) => q.span - p.span)[0];
  };

  while (boxes.length < k) {
    let pick = -1, pickSpan = -1, pickCh = null;
    boxes.forEach((box, i) => {
      if (box.bins.length < 2) return;
      const r = rangeOf(box);
      const weighted = r.span * Math.sqrt(box.n);
      if (weighted > pickSpan) { pickSpan = weighted; pick = i; pickCh = r.ch; }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    box.bins.sort((p, q) => {
      const pv = pickCh === "r" ? p.r / p.n : pickCh === "g" ? p.g / p.n : p.b / p.n;
      const qv = pickCh === "r" ? q.r / q.n : pickCh === "g" ? q.g / q.n : q.b / q.n;
      return pv - qv || p.bin - q.bin;
    });
    const half = box.n / 2;
    let acc = 0, cut = 0;
    for (let i = 0; i < box.bins.length - 1; i++) {
      acc += box.bins[i].n;
      if (acc >= half) { cut = i + 1; break; }
      cut = i + 1;
    }
    const A = box.bins.slice(0, cut), B = box.bins.slice(cut);
    if (!A.length || !B.length) break;
    const mk = (bins) => {
      const o = { bins, n: 0, r: 0, g: 0, b: 0 };
      for (const x of bins) { o.n += x.n; o.r += x.r; o.g += x.g; o.b += x.b; }
      return o;
    };
    boxes.splice(pick, 1, mk(A), mk(B));
  }

  return boxes
    .map((box) => {
      const r = Math.round(box.r / box.n), g = Math.round(box.g / box.n), b = Math.round(box.b / box.n);
      const { h, s, l } = rgbToHsl(r, g, b);
      return {
        hex: "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""),
        share: Math.round((box.n / total) * 1000) / 1000,
        hsl: { h: Math.round(h), s: Math.round(s * 100) / 100, l: Math.round(l * 100) / 100 },
      };
    })
    .sort((a, b) => b.share - a.share);
}

function colorStats(pixels, width, height) {
  const total = width * height;
  let sumL = 0, sumS = 0, warm = 0, cool = 0, neutral = 0;
  const lums = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
    const { s, l } = rgbToHsl(r, g, b);
    sumL += l; sumS += s;
    lums[i] = 0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
    const diff = r - b;
    if (diff > 12) warm++;
    else if (diff < -12) cool++;
    else neutral++;
  }
  const meanL = lums.reduce((a, b) => a + b, 0) / total;
  let varL = 0;
  for (let i = 0; i < total; i++) { const d = lums[i] - meanL; varL += d * d; }
  const stdL = Math.sqrt(varL / total);

  let grad = 0, gn = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      grad += Math.abs(lums[i] - lums[i + 1]) + Math.abs(lums[i] - lums[i + width]);
      gn++;
    }
  }
  const edgeDensity = gn ? grad / gn : 0;

  const sorted = Array.from(lums).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

  return {
    meanLightness: Math.round((sumL / total) * 1000) / 1000,
    meanSaturation: Math.round((sumS / total) * 1000) / 1000,
    luminanceStd: Math.round(stdL * 1000) / 1000,
    p05: Math.round(q(0.05) * 1000) / 1000,
    p95: Math.round(q(0.95) * 1000) / 1000,
    warmShare: Math.round((warm / total) * 1000) / 1000,
    coolShare: Math.round((cool / total) * 1000) / 1000,
    neutralShare: Math.round((neutral / total) * 1000) / 1000,
    edgeDensity: Math.round(edgeDensity * 10000) / 10000,
  };
}

function subjectBackgroundRelation(pixels, width, height) {
  const cx = width / 2, cy = height / 2;
  const rx = width * 0.28, ry = height * 0.34;
  let sL = 0, sn = 0, bL = 0, bn = 0, sWarm = 0, bWarm = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
      const { l } = rgbToHsl(r, g, b);
      const inEllipse = ((x - cx) ** 2) / (rx * rx) + ((y - cy) ** 2) / (ry * ry) <= 1;
      const inCorner = (x < width * 0.18 || x > width * 0.82) && (y < height * 0.18 || y > height * 0.82);
      const isWarm = r - b > 12;
      if (inEllipse) { sL += l; sn++; if (isWarm) sWarm++; }
      else if (inCorner) { bL += l; bn++; if (isWarm) bWarm++; }
    }
  }
  if (!sn || !bn) return null;
  const delta = sL / sn - bL / bn;
  return {
    subjectLightness: Math.round((sL / sn) * 1000) / 1000,
    backgroundLightness: Math.round((bL / bn) * 1000) / 1000,
    subjectVsBackground: delta > 0.08 ? "subject-lighter" : delta < -0.08 ? "subject-darker" : "similar",
    subjectWarmShare: Math.round((sWarm / sn) * 1000) / 1000,
    backgroundWarmShare: Math.round((bWarm / bn) * 1000) / 1000,
  };
}

function surfaceTexture(stats) {
  let modulation = "low";
  if (stats.luminanceStd > 0.18 || stats.edgeDensity > 0.045) modulation = "high";
  else if (stats.luminanceStd > 0.09 || stats.edgeDensity > 0.02) modulation = "medium";
  return { surfaceModulation: modulation, basis: "pixel-derived (contrast + edge density)", notAMaterialName: true };
}

/**
 * 从浏览器 File/Blob 计算色彩签名。
 * 与 Node 版同算法、同字段、同 basis。
 */
export async function analyzeImageSignatureInBrowser(file) {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    // 环境不支持 canvas 时明确失败，不返回伪造值
    if (typeof document === "undefined") {
      return { ok: false, reason: "no-canvas-environment", colorSignature: null, surface: null };
    }
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    return { ok: false, reason: `decode-failed: ${String(e?.message || e).slice(0, 60)}`, colorSignature: null, surface: null };
  }
  try {
    const scale = Math.min(1, TARGET_WIDTH / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // 白底拍平（与 Node 版 flatten 一致）
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const pixels = img.data;
    const total = w * h;

    const stats = colorStats(pixels, w, h);
    const dominant = dominantColors(pixels, total);
    const rel = subjectBackgroundRelation(pixels, w, h);
    const surf = surfaceTexture(stats);

    return {
      ok: true,
      colorSignature: {
        dominant,
        meanLightness: stats.meanLightness,
        meanSaturation: stats.meanSaturation,
        luminanceStd: stats.luminanceStd,
        luminanceRange: [stats.p05, stats.p95],
        warmShare: stats.warmShare,
        coolShare: stats.coolShare,
        neutralShare: stats.neutralShare,
        subjectBackground: rel,
        raster: { width: w, height: h },
        basis: "pixel-derived, deterministic (5-bit histogram + weighted median cut)",
      },
      surface: { ...surf, edgeDensity: stats.edgeDensity },
    };
  } catch (e) {
    return { ok: false, reason: `raster-failed: ${String(e?.message || e).slice(0, 60)}`, colorSignature: null, surface: null };
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

/** 色彩可比性判定：黑白/极低饱和画面与彩色画面的色彩证据不可直接比 */
export function colorComparability(sig) {
  if (!sig || !sig.ok) return { comparable: false, mode: "unavailable", reason: "无色彩签名" };
  const cs = sig.colorSignature;
  // 黑白判定：饱和度极低且冷暖分布接近中性
  if (cs.meanSaturation < 0.06 && Math.abs(cs.warmShare - cs.coolShare) < 0.05) {
    return {
      comparable: false,
      mode: "monochrome",
      reason: `饱和度 ${cs.meanSaturation} 极低，判定为黑白/近黑白影像；色相与冷暖证据不可用，仅明度与对比可比`,
    };
  }
  if (cs.meanSaturation < 0.12) {
    return {
      comparable: "limited",
      mode: "low-saturation",
      reason: `饱和度 ${cs.meanSaturation} 偏低，色彩证据权重应下调，明度/对比仍可比`,
    };
  }
  return { comparable: true, mode: "color", reason: `饱和度 ${cs.meanSaturation}，色彩证据完整可比` };
}

export const BROWSER_SIGNATURE_CONTRACT = {
  targetWidth: TARGET_WIDTH,
  sameAlgorithmAs: "src/services/retrieval/colorSignature.js",
  requiresCanvas: true,
  deterministic: true,
};
