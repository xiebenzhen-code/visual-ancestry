// spatialSignature.js — P4.10 STEP 2：可复现的空间视觉特征。
//
// 为什么需要它：现有 Color Signature 是**全局直方图**，它知道「这张图偏暗、偏暖」，
// 但不知道「暗的部分在画面中间还是四周」。两张主色相近但构图完全不同的图，
// 色彩距离可能很小。这一层补的就是「颜色在哪里」。
//
// 严格边界（这几条是任务书要求，也写进代码防止后来者越界）：
//   1. 只描述**可测量的像素分布**，不推断语义。
//      「上三分之一偏暗」可以说；「人物站在窗边」不可以 —— 那需要语义分析。
//   2. 不因主色相近就断言构图相近。空间特征是独立维度，不是色彩的替代。
//   3. 确定性：固定采样网格、固定取整、无随机、无时间依赖。
//   4. 低内存：只保留 3×3 聚合结果与少量标量，不保存原始像素。
//
// 黑白与彩色的可比性：亮度/结构维度对两者同口径（都先转亮度）；
// 色彩布局维度只在双方都是彩色且饱和度足够时才可比，否则标 not-comparable。

// 3×3 网格：把画面切成九宫格，逐格统计。
// 9 格是刻意的选择：再细就会对裁切/缩放敏感，再粗就无法区分「主体居中」与「主体偏左」。
const GRID = 3;

// 采样宽度。与 colorSignature 的 TARGET_WIDTH 保持一致，便于两个签名共用一张位图。
const TARGET_WIDTH = 160;

/**
 * 从 ImageData 计算空间签名。
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @returns {{
 *   ok: boolean,
 *   spatial: {
 *     grid: { cols: number, rows: number },
 *     luminance: number[],        // 9 格平均亮度 0..1
 *     luminanceStd: number[],     // 9 格亮度标准差 0..1（局部对比）
 *     saturation: number[],       // 9 格平均饱和 0..1
 *     warmShare: number[],        // 9 格暖色占比 0..1
 *     edge: number[],             // 9 格边缘强度 0..1
 *     edgeDirection: number[],    // 9 格主边缘方向（0..3，对应 0/45/90/135 度）
 *     verticalBias: number,       // 上排/下排亮度差，正=上亮
 *     horizontalBias: number,     // 左列/右列亮度差，正=左亮
 *     centerSurround: number,     // 中心格与八格均值的亮度差，正=中心亮
 *     globalContrast: number,     // 全图亮度标准差
 *     brightness: number,         // 全图平均亮度
 *     grain: number,              // 相邻像素亮度差的均值（纹理强度粗估）
 *     colourMode: "color" | "monochrome",
 *   } | null,
 *   reason?: string
 * }}
 */
export function spatialFromImageData(img) {
  if (!img || !img.data || !img.width || !img.height) {
    return { ok: false, spatial: null, reason: "no-image-data" };
  }
  const { data, width, height } = img;
  const total = width * height;
  if (total === 0) return { ok: false, spatial: null, reason: "empty-raster" };

  // 通道数必须显式推导。MEASURED 缺陷：原实现按 *4（RGBA）算索引，
  // 但 decoders 常常给 3 通道（sharp raw() 默认 RGB；浏览器 ImageData 是 RGBA）。
  // 通道数不符时索引会越界成 undefined，一路变成 NaN，最终所有特征都是 null ——
  // 界面看起来只是「没算出特征」，不报错，属于最难发现的那类静默失败。
  let channels = img.channels;
  if (!channels) {
    const byLen = data.length / total;
    channels = Number.isInteger(byLen) ? byLen : 0;
  }
  if (channels !== 3 && channels !== 4) {
    return { ok: false, spatial: null, reason: `unsupported-channels: ${channels}` };
  }

  const cols = GRID;
  const rows = GRID;
  // 每格累加器。用普通数组而不是 Map，保证顺序确定。
  const sumLum = new Array(cols * rows).fill(0);
  const sumLumSq = new Array(cols * rows).fill(0);
  const sumSat = new Array(cols * rows).fill(0);
  const sumWarm = new Array(cols * rows).fill(0);
  const sumEdge = new Array(cols * rows).fill(0);
  // 四个方向的梯度能量累加，用于判断主方向。
  const dirEnergy = new Array(cols * rows).fill(0).map(() => [0, 0, 0, 0]);
  const cellCount = new Array(cols * rows).fill(0);

  let gSumLum = 0;
  let gSumLumSq = 0;
  let gSumSat = 0;
  let gSumWarm = 0;
  let grainSum = 0;
  let grainCount = 0;

  const lumAt = (i) => {
    // Rec.709 亮度，与 colorStats 同口径。
    return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  };

  for (let y = 0; y < height; y++) {
    // 行所属网格：用比例映射，避免 height 不整除时报越界。
    const ry = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const rx = Math.min(cols - 1, Math.floor((x * cols) / width));
      const cell = ry * cols + rx;
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];

      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      // 暖色判定：红分量显著高于蓝分量。阈值 0.08 是经验值，确保中性灰不算暖。
      const warm = r - b > 20 ? 1 : 0;

      sumLum[cell] += lum;
      sumLumSq[cell] += lum * lum;
      sumSat[cell] += sat;
      sumWarm[cell] += warm;
      cellCount[cell] += 1;

      gSumLum += lum;
      gSumLumSq += lum * lum;
      gSumSat += sat;
      gSumWarm += warm;

      // 梯度：只算右邻与下邻，边界处跳过（保证不越界且不引入填充像素）。
      let gx = 0, gy = 0;
      if (x + 1 < width) {
        const j = (y * width + x + 1) * channels;
        gx = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255 - lum;
      }
      if (y + 1 < height) {
        const k = ((y + 1) * width + x) * channels;
        gy = (0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]) / 255 - lum;
      }
      const mag = Math.sqrt(gx * gx + gy * gy);
      sumEdge[cell] += mag;

      // 方向量化到 4 个桶（0/45/90/135），用能量加权。
      if (mag > 1e-6) {
        const ang = Math.atan2(gy, gx); // -PI..PI
        const deg = ((ang * 180) / Math.PI + 180) % 180; // 0..180
        const bucket = Math.min(3, Math.floor(deg / 45));
        dirEnergy[cell][bucket] += mag;
      }

      // 纹理粗估：相邻像素亮度差（只取右邻，避免重复计数）
      if (x + 1 < width) {
        const j = (y * width + x + 1) * channels;
        const lum2 = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255;
        grainSum += Math.abs(lum2 - lum);
        grainCount += 1;
      }
    }
  }

  const round = (v, d = 4) => {
    const p = Math.pow(10, d);
    return Math.round(v * p) / p;
  };

  const luminance = [];
  const luminanceStd = [];
  const saturation = [];
  const warmShare = [];
  const edge = [];
  const edgeDirection = [];

  for (let c = 0; c < cols * rows; c++) {
    const n = cellCount[c] || 1;
    const mLum = sumLum[c] / n;
    const varLum = Math.max(0, sumLumSq[c] / n - mLum * mLum);
    luminance.push(round(mLum));
    luminanceStd.push(round(Math.sqrt(varLum)));
    saturation.push(round(sumSat[c] / n));
    warmShare.push(round(sumWarm[c] / n));
    // 边缘强度按格内像素数归一化，跨尺寸可比。
    edge.push(round(sumEdge[c] / n));

    const d = dirEnergy[c];
    const maxD = Math.max(d[0], d[1], d[2], d[3]);
    edgeDirection.push(maxD <= 0 ? -1 : d.indexOf(maxD));
  }

  const gMeanLum = gSumLum / total;
  const gVarLum = Math.max(0, gSumLumSq / total - gMeanLum * gMeanLum);
  const gMeanSat = gSumSat / total;
  const gWarmShare = gSumWarm / total;

  // 上排 vs 下排、左列 vs 右列、中心 vs 四周：三个最能描述「布局」的标量。
  const topRow = (luminance[0] + luminance[1] + luminance[2]) / 3;
  const bottomRow = (luminance[6] + luminance[7] + luminance[8]) / 3;
  const leftCol = (luminance[0] + luminance[3] + luminance[6]) / 3;
  const rightCol = (luminance[2] + luminance[5] + luminance[8]) / 3;
  const center = luminance[4];
  const surround = (luminance[0] + luminance[1] + luminance[2] + luminance[3] + luminance[5] + luminance[6] + luminance[7] + luminance[8]) / 8;

  // 单色判定：平均饱和很低且暖色占比接近 0。
  // 与 colorComparability 的阈值保持同一量级（0.06 / 0.02），避免两处判定打架。
  const colourMode = gMeanSat < 0.06 && gWarmShare < 0.02 ? "monochrome" : "color";

  return {
    ok: true,
    spatial: {
      grid: { cols, rows },
      luminance,
      luminanceStd,
      saturation,
      warmShare,
      edge,
      edgeDirection,
      verticalBias: round(topRow - bottomRow),
      horizontalBias: round(leftCol - rightCol),
      centerSurround: round(center - surround),
      globalContrast: round(Math.sqrt(gVarLum)),
      brightness: round(gMeanLum),
      grain: round(grainCount ? grainSum / grainCount : 0, 5),
      colourMode,
    },
  };
}

/**
 * 特征距离。**分段返回，不压成一个不可解释的总分。**
 *
 * 这是任务书的明确要求：必须保留「哪些维度相似、哪些不同、哪些不可比」。
 * 调用方（filmPixelCompare）负责把这些分量写成人能读的说明。
 *
 * @returns {{
 *   comparable: boolean,
 *   colourComparable: boolean,
 *   distance: number|null,
 *   components: { luminanceLayout:number, contrast:number, edgeLayout:number, colourLayout:number|null, brightness:number },
 *   incomparable: string[]
 * }}
 */
export function spatialDistance(a, b) {
  if (!a || !b || !a.ok || !b.ok) {
    return {
      comparable: false, colourComparable: false, distance: null,
      components: {}, incomparable: ["缺少可比较的空间签名"],
    };
  }
  const A = a.spatial, B = b.spatial;
  if (A.grid.cols !== B.grid.cols || A.grid.rows !== B.grid.rows) {
    return {
      comparable: false, colourComparable: false, distance: null,
      components: {}, incomparable: ["网格尺寸不一致"],
    };
  }

  const n = A.luminance.length;
  const meanAbs = (arrA, arrB) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(arrA[i] - arrB[i]);
    return s / n;
  };

  // 1) 亮度布局：九格亮度差的平均。这是「明暗分布是否接近」的直接度量。
  const luminanceLayout = meanAbs(A.luminance, B.luminance);
  // 2) 局部对比：九格标准差的平均差，反映「哪块更有质感」。
  const contrast = meanAbs(A.luminanceStd, B.luminanceStd);
  // 3) 边缘布局：边缘强度的分布差。区分「线条集中在一处」与「均匀分布」。
  const edgeLayout = meanAbs(A.edge, B.edge);

  // 4) 色彩布局：只在双方都是彩色时可比。
  const colourComparable = A.colourMode === "color" && B.colourMode === "color";
  let colourLayout = null;
  const incomparable = [];
  if (colourComparable) {
    const satDiff = meanAbs(A.saturation, B.saturation);
    const warmDiff = meanAbs(A.warmShare, B.warmShare);
    colourLayout = (satDiff + warmDiff) / 2;
  } else {
    if (A.colourMode !== B.colourMode) {
      incomparable.push(
        `色彩布局不可比：一方是${A.colourMode === "monochrome" ? "黑白" : "彩色"}，另一方是${B.colourMode === "monochrome" ? "黑白" : "彩色"}`
      );
    } else {
      incomparable.push("色彩布局不可比：双方都是低饱和画面，色彩差异不携带构图信息");
    }
  }

  // 5) 全局亮度差（标量，最容易理解的一项）
  const brightness = Math.abs(A.brightness - B.brightness);

  // 加权距离。权重按「这个维度在判断布局时的可靠性」设定，不是按「让某张图排第一」调出来的：
  //   亮度布局 0.40 —— 最稳定，跨黑白彩色都成立
  //   边缘布局 0.30 —— 结构信息，同样跨介质成立
  //   局部对比 0.15 —— 纹理感知，受扫描质量影响较大
  //   色彩布局 0.15 —— 仅彩色可比，占比刻意压低，避免色彩主导
  // 当色彩不可比时，把它的权重按比例分给其余三项，保证距离仍在 0..1 量级。
  let distance;
  if (colourComparable) {
    distance = luminanceLayout * 0.40 + edgeLayout * 0.30 + contrast * 0.15 + colourLayout * 0.15;
  } else {
    distance = luminanceLayout * 0.47 + edgeLayout * 0.35 + contrast * 0.18;
  }

  const r = (v) => (v === null ? null : Math.round(v * 10000) / 10000);

  return {
    comparable: true,
    colourComparable,
    distance: r(Math.min(1, Math.max(0, distance))),
    components: {
      luminanceLayout: r(luminanceLayout),
      contrast: r(contrast),
      edgeLayout: r(edgeLayout),
      colourLayout: r(colourLayout),
      brightness: r(brightness),
    },
    incomparable,
  };
}

/**
 * 把距离翻译成等级。**P4.10 实测后改写：原来的绝对阈值（0.06/0.12/0.22）
 * 是从「我以为的距离尺度」猜的，不是量出来的。**
 *
 * 实测分布（17 条真实 Commons 候选，见 .rc1-audit/P4.10-REPORT.md）：
 *   · 同一部片 6 张剧照两两之间：0.069 – 0.156
 *   · 不同片之间：0.054 – 0.175
 *   · 同一张图裁掉 10%：0.1477；与一幅完全不同的画：0.1054
 * 也就是说真实观测的全程跨度约 0.05 – 0.18，而「同图裁切」落在其中部。
 * 原阈值把 0.12 当「有一定相近」，等于把大部分真实候选都归进「差异明显」，
 * 标签失去信息量；同时又会把「同图裁切」判成「差异明显」——自相矛盾。
 *
 * 现在的做法：不宣称绝对相似度，只按**实测区间**给出相对位置的措辞，
 * 并明确标注该分级不能用来判断「是否相似」。
 */
export function similarityLevel(distance) {
  if (distance === null || distance === undefined) return { level: "unknown", label: "未比较" };
  if (distance <= 0.07) return { level: "close", label: "结构分布落在较接近的一端" };
  if (distance <= 0.11) return { level: "near", label: "结构分布中等" };
  return { level: "far", label: "结构分布落在较疏远的一端" };
}

/**
 * 本轮实测结论：该描述子不适合判断「画面是否相似」。
 * 单独导出，供界面直接引用，避免文案与代码判断分叉。
 */
export const SPATIAL_VALIDITY = {
  usableForRanking: false,
  usableForEvidence: true,
  overlap: 0.0423,
  reason:
    "实测：同一张图裁掉 10% 的距离（0.1477）比它与一幅完全不同的画的距离（0.1054）更大，" +
    "两者分布重叠 0.0423。因此这个比较只能作为像素分布的旁证，不能用来判断画面相似或改变排序。",
};

export const SPATIAL_CONTRACT = {
  grid: GRID,
  targetWidth: TARGET_WIDTH,
  deterministic: true,
  weights: { luminanceLayout: 0.40, edgeLayout: 0.30, contrast: 0.15, colourLayout: 0.15 },
  note: "只描述像素分布，不推断语义。不用于断言画面中有何对象。",
};
