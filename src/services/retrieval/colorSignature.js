// P4.3-B 色彩与材质签名 —— 确定性本地分析
//
// 原则：
//   · 只用本地像素，不发网络、不调付费 Vision
//   · 全部确定性：无 k-means（种子相关）、无随机
//   · 统一光栅 256px 宽，保证三档可复现
//   · 无法读取真实像素时不产出任何颜色/材质值（返回 null，不伪造）
//
// 输出字段全部标注 basis，区分「从像素测得」与「未知」。

import sharp from "sharp";

/** 统一光栅：EXIF 归正 → 白底拍平 → sRGB → 等比缩到 256 宽 → 去 alpha → raw */
async function rasterize(file) {
  const { data, info } = await sharp(file)
    .rotate()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .resize({ width: 256, fit: "inside", kernel: "lanczos3", withoutEnlargement: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

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

/**
 * 主色提取：5-bit 量化直方图 + 加权中位切分（无 RNG）。
 * 返回 [{hex, share, hsl}]，share 之和 ≈ 1。
 */
function dominantColors(data, width, height, channels, k = 6) {
  const total = width * height;
  const binCount = new Map();
  for (let i = 0; i < total; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let e = binCount.get(bin);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; binCount.set(bin, e); }
    e.n++; e.r += r; e.g += g; e.b += b;
  }
  let boxes = [{
    bins: [...binCount.entries()].map(([bin, e]) => ({ bin, ...e })),
    n: 0, r: 0, g: 0, b: 0,
  }];
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
    // 按该通道计数加权中位数切分；并列取低 bin 索引
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

/** 全局色彩统计 + 冷暖 + 对比 + 细节密度 */
function colorStats(data, width, height, channels) {
  const total = width * height;
  let sumL = 0, sumS = 0, warm = 0, cool = 0, neutral = 0;
  const lums = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const { s, l } = rgbToHsl(r, g, b);
    sumL += l; sumS += s;
    lums[i] = 0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
    // 冷暖：用 R-B 差判定（色相法在低饱和图会乱跳）
    const diff = r - b;
    if (diff > 12) warm++;
    else if (diff < -12) cool++;
    else neutral++;
  }
  const meanL = lums.reduce((a, b) => a + b, 0) / total;
  let varL = 0;
  for (let i = 0; i < total; i++) { const d = lums[i] - meanL; varL += d * d; }
  const stdL = Math.sqrt(varL / total);

  // 细节密度：4 邻域梯度均值（在固定 256 宽光栅上计算，跨档可比）
  let grad = 0, gn = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = Math.abs(lums[i] - lums[i + 1]);
      const dy = Math.abs(lums[i] - lums[i + width]);
      grad += dx + dy; gn++;
    }
  }
  const edgeDensity = gn ? grad / gn : 0;

  const q = (arr, p) => { const s2 = Float32Array.from(arr).sort(); return s2[Math.min(s2.length - 1, Math.floor(s2.length * p))]; };
  return {
    meanLightness: Math.round((sumL / total) * 1000) / 1000,
    meanSaturation: Math.round((sumS / total) * 1000) / 1000,
    luminanceStd: Math.round(stdL * 1000) / 1000,
    p05: Math.round(q(lums, 0.05) * 1000) / 1000,
    p95: Math.round(q(lums, 0.95) * 1000) / 1000,
    warmShare: Math.round((warm / total) * 1000) / 1000,
    coolShare: Math.round((cool / total) * 1000) / 1000,
    neutralShare: Math.round((neutral / total) * 1000) / 1000,
    edgeDensity: Math.round(edgeDensity * 10000) / 10000,
    raster: { width, height },
  };
}

/** 主体 vs 背景色彩关系：以中心椭圆为主体区，四角为背景区 */
function subjectBackgroundRelation(data, width, height, channels) {
  const cx = width / 2, cy = height / 2;
  const rx = width * 0.28, ry = height * 0.34;
  let sL = 0, sn = 0, bL = 0, bn = 0, sWarm = 0, bWarm = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const { l } = rgbToHsl(r, g, b);
      const inEllipse = ((x - cx) * (x - cx)) / (rx * rx) + ((y - cy) * (y - cy)) / (ry * ry) <= 1;
      const inCorner = (x < width * 0.18 || x > width * 0.82) && (y < height * 0.18 || y > height * 0.82);
      const isWarm = r - b > 12;
      if (inEllipse) { sL += l; sn++; if (isWarm) sWarm++; }
      else if (inCorner) { bL += l; bn++; if (isWarm) bWarm++; }
    }
  }
  if (!sn || !bn) return null;
  const sMean = sL / sn, bMean = bL / bn;
  const delta = sMean - bMean;
  return {
    subjectLightness: Math.round(sMean * 1000) / 1000,
    backgroundLightness: Math.round(bMean * 1000) / 1000,
    subjectVsBackground: delta > 0.08 ? "subject-lighter" : delta < -0.08 ? "subject-darker" : "similar",
    subjectWarmShare: Math.round((sWarm / sn) * 1000) / 1000,
    backgroundWarmShare: Math.round((bWarm / bn) * 1000) / 1000,
  };
}

/** 表面质感（仅从像素可得的部分）—— 不声称材质名称 */
function surfaceTexture(data, width, height, channels) {
  const st = colorStats(data, width, height, channels);
  // 用对比度 + 细节密度组合成一个受限的质感描述，不给材质名
  const contrast = st.luminanceStd;
  const edge = st.edgeDensity;
  let modulation = "low";
  if (contrast > 0.18 || edge > 0.045) modulation = "high";
  else if (contrast > 0.09 || edge > 0.02) modulation = "medium";
  return {
    // 这是"表面调制程度"，不是材质名称
    surfaceModulation: modulation,
    basis: "pixel-derived (contrast + edge density)",
    notAMaterialName: true,
  };
}

/**
 * 主入口。file 不存在/解码失败 → 返回 { ok:false, reason }，绝不返回伪造值。
 */
export async function analyzeImageSignature(file) {
  let r;
  try {
    r = await rasterize(file);
  } catch (e) {
    return { ok: false, reason: `decode-failed: ${String(e?.message || e).slice(0, 80)}`, colorSignature: null, surface: null };
  }
  if (!r.width || !r.height) {
    return { ok: false, reason: "empty-raster", colorSignature: null, surface: null };
  }
  const dominant = dominantColors(r.data, r.width, r.height, r.channels);
  const stats = colorStats(r.data, r.width, r.height, r.channels);
  const rel = subjectBackgroundRelation(r.data, r.width, r.height, r.channels);
  const surf = surfaceTexture(r.data, r.width, r.height, r.channels);

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
      raster: stats.raster,
      basis: "pixel-derived, deterministic (5-bit histogram + weighted median cut)",
    },
    surface: { ...surf, edgeDensity: stats.edgeDensity },
  };
}

export const SIGNATURE_CONTRACT = {
  colorFields: ["dominant", "meanLightness", "meanSaturation", "luminanceStd", "luminanceRange",
    "warmShare", "coolShare", "neutralShare", "subjectBackground", "raster", "basis"],
  surfaceFields: ["surfaceModulation", "edgeDensity", "basis", "notAMaterialName"],
  deterministic: true,
  requiresPixels: true,
};
