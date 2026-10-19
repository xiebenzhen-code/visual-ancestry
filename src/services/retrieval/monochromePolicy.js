// monochromePolicy.js — 黑白电影影像的硬性排除规则
//
// 产品决定（不是评分偏好）：AIGC 创作参考不再使用黑白电影影像。
//
// 这一层刻意放在「候选进入推荐列表之前」，而不是放在评分里。
// 原因：评分可以被加权绕过，过滤不能。一条候选如果被判为黑白，
// 它就不存在于候选池中——提高相关性分数没有东西可提。
//
// 判定依据的优先顺序（任务书第 3 条）：
//   1. 影片级已核实事实（filmRecord.colorVerdict）——最可靠，优先
//   2. 实际图像像素测量（measureChroma）——用于没有影片级事实的情况
//   3. 两者都拿不到 → 标 unknown，不纳入正式推荐（任务书第 4 条）
//
// 明确禁止的判定方式：
//   · 只看平均饱和度。sepia 棕褐调老片饱和度不低（Broken Blossoms 实测 meanSat=0.57），
//     真彩色片也可能低饱和。用饱和度当判据两个方向都会错。
//   · 只看 visualIntent.saturation 字段。那是「视觉意图」标注，不是色彩事实。

// ---- 影片级色彩判定 ----
//
// "monochrome"  = 影片原始发行即为黑白（含被 sepia/tinted 着色的黑白片）
// "color"       = 影片原始发行即为彩色（Technicolor 等工艺）
// "unknown"     = 未核实
//
// 这张表只登记**已核实**的影片。未登记的影片一律 unknown，不得默认放行。
export const FILM_COLOR_FACTS = {
  "film-nibelungen-siegfried": { verdict: "monochrome", basis: "1924 德国默片，黑白发行", confidence: "high" },
  "film-broken-blossoms": { verdict: "monochrome", basis: "1919 美国默片，黑白发行（本地图为 sepia 着色）", confidence: "high" },
  "film-orphans-storm": { verdict: "monochrome", basis: "1921 美国默片，黑白发行", confidence: "high" },
  "film-ten-commandments": { verdict: "monochrome", basis: "1923 默片，主体黑白（本地图为黑白剧照）", confidence: "high" },
  "film-sherlock-jr": { verdict: "monochrome", basis: "1924 美国默片，黑白发行", confidence: "high" },
  "film-the-general": { verdict: "monochrome", basis: "1926 美国默片，黑白发行（本地图为 sepia 着色）", confidence: "high" },
  // 唯一确认的彩色片：1922 年 Two-Color Technicolor
  "film-toll-of-the-sea": { verdict: "color", basis: "1922 年 Technicolor 双色工艺彩色片", confidence: "high" },
  "film-man-movie-camera": { verdict: "monochrome", basis: "1929 苏联默片，黑白发行", confidence: "high" },
  "film-pandoras-box": { verdict: "monochrome", basis: "1929 德国默片，黑白发行", confidence: "high" },
  "film-diary-lost-girl": { verdict: "monochrome", basis: "1929 德国默片，黑白发行", confidence: "high" },
  "film-gold-rush": { verdict: "monochrome", basis: "1925 卓别林默片，黑白发行（本地图为 sepia 着色）", confidence: "high" },
  "film-city-lights": { verdict: "monochrome", basis: "1931 卓别林默片，黑白发行", confidence: "high" },
  "film-modern-times": { verdict: "monochrome", basis: "1936 卓别林影片，黑白发行", confidence: "high" },
  "film-s13-intolerance": { verdict: "monochrome", basis: "1916 格里菲斯默片，黑白发行（本地图为着色）", confidence: "high" },
  "film-s02-the-kid": { verdict: "monochrome", basis: "1921 卓别林默片，黑白发行", confidence: "high" },
};

// ---- 像素色度测量 ----
//
// 两把尺子，都必要：
//   colorShare : 有明显通道差（max-min > 12）的像素占比。黑白扫描/压缩会有轻微色偏，
//                所以设 0.02 下限，避免把 JPEG 色度噪声当成彩色。
//   hueSpread  : 色相的循环标准差（度）。真彩色画面多色相，sepia 是单一色相。
//                实测：真彩色 toll-of-the-sea = 36.3°，sepia 片全部 < 10°。
//
// 判定：
//   彩色   colorShare >= 0.02 且 hueSpread >= 25°
//   单色   其余（colorShare 低，或色相集中）—— 视为着色黑白，仍需排除
export const CHROMA_THRESHOLDS = {
  minChannelSpread: 12,   // 单像素 max-min 超过此值才算携带色彩
  minColorShare: 0.02,    // 携带色彩的像素占比下限
  minHueSpread: 25,       // 色相循环标准差下限（度）
  sampleWidth: 200,
};

/**
 * 从已解码的像素算色度指标。纯函数，确定性。
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number, channels: number}} img
 */
export function measureChroma(img) {
  const { data, width, height } = img;
  const channels = img.channels || Math.round(data.length / (width * height));
  if (channels !== 3 && channels !== 4) {
    return { ok: false, reason: `unsupported-channels: ${channels}` };
  }
  const n = width * height;
  if (n === 0) return { ok: false, reason: "empty-raster" };

  const TH = CHROMA_THRESHOLDS;
  let colored = 0;
  let cosSum = 0;
  let sinSum = 0;
  let satSum = 0;
  const spreads = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sp = mx - mn;
    spreads[i] = sp;
    satSum += mx === 0 ? 0 : sp / mx;
    if (sp > TH.minChannelSpread) {
      colored++;
      // 色相（度），只用圆统计的两个分量，避免逐点开方
      let hDeg;
      if (mx === r) hDeg = ((g - b) / sp) * 60;
      else if (mx === g) hDeg = ((b - r) / sp + 2) * 60;
      else hDeg = ((r - g) / sp + 4) * 60;
      const rad = (hDeg * Math.PI) / 180;
      cosSum += Math.cos(rad);
      sinSum += Math.sin(rad);
    }
  }

  spreads.sort();
  const medianSpread = spreads[Math.floor(n / 2)];
  const p90Spread = spreads[Math.floor(n * 0.9)];
  const colorShare = colored / n;
  let hueSpread = null;
  if (colored > 50) {
    const R = Math.hypot(cosSum / colored, sinSum / colored);
    // 圆标准差 → 度。R 越小越分散。
    hueSpread = (Math.sqrt(-2 * Math.log(Math.max(R, 1e-9))) * 180) / Math.PI;
  }

  return {
    ok: true,
    colorShare: Math.round(colorShare * 10000) / 10000,
    hueSpreadDeg: hueSpread === null ? null : Math.round(hueSpread * 10) / 10,
    meanSaturation: Math.round((satSum / n) * 10000) / 10000,
    medianChannelSpread: medianSpread,
    p90ChannelSpread: p90Spread,
  };
}

/**
 * 把色度指标翻译成色彩判定。
 * 注意：这个函数**只**用于「没有影片级事实」的候选（主要是远程 Commons 候选）。
 */
export function classifyChroma(chroma) {
  if (!chroma || !chroma.ok) {
    return { verdict: "unknown", reason: `色度测量失败：${chroma?.reason || "无数据"}` };
  }
  const TH = CHROMA_THRESHOLDS;
  const isColour = chroma.colorShare >= TH.minColorShare
    && chroma.hueSpreadDeg !== null
    && chroma.hueSpreadDeg >= TH.minHueSpread;
  if (isColour) {
    return {
      verdict: "color",
      reason: `实测彩色：${Math.round(chroma.colorShare * 100)}% 像素携带色彩，色相分散 ${chroma.hueSpreadDeg}°`,
    };
  }
  // 区分「纯黑白」与「单色相着色」，两者都要排除，但理由不同，便于审计
  const tinted = chroma.colorShare >= TH.minColorShare;
  return {
    verdict: "monochrome",
    reason: tinted
      ? `实测单色相着色（sepia/tint）：${Math.round(chroma.colorShare * 100)}% 像素有通道差，但色相只集中在 ${chroma.hueSpreadDeg}°`
      : `实测黑白：仅 ${Math.round(chroma.colorShare * 100)}% 像素携带色彩，通道差中位数 ${chroma.medianChannelSpread}`,
  };
}

/**
 * 综合判定一条候选能不能进入 AIGC 推荐。
 *
 * @param {object} candidate  候选（需要 id / film /
 * @param {object} [measured]  可选的像素测量结果（measureChroma 的返回值）
 * @returns {{allowed: boolean, verdict: string, reason: string, evidence: string}}
 */
export function judgeFilmCandidate(candidate, measured = null) {
  const id = candidate?.id || candidate?.artwork?.id || "";
  const filmTitle = candidate?.film?.title || candidate?.artwork?.film?.title || candidate?.title || "";

  // 非电影候选一律放行——这条规则只针对电影影像
  const isFilm = candidate?.medium === "film"
    || candidate?.artwork?.medium === "film"
    || Boolean(candidate?.film)
    || Boolean(candidate?.artwork?.film)
    || String(id).startsWith("film-");
  if (!isFilm) {
    return { allowed: true, verdict: "not-film", reason: "非电影候选，不适用本规则", evidence: "medium" };
  }

  // 1) 影片级事实优先
  const fact = FILM_COLOR_FACTS[id];
  if (fact && fact.verdict === "color") {
    return {
      allowed: true, verdict: "color", reason: `已核实为彩色影片（${fact.basis}）`,
      evidence: `film-fact:${fact.confidence}`,
    };
  }
  if (fact && fact.verdict === "monochrome") {
    return {
      allowed: false, verdict: "monochrome",
      reason: `已核实为黑白影片（${fact.basis}）`,
      evidence: `film-fact:${fact.confidence}`, filmTitle,
    };
  }

  // 2) 没有影片级事实 → 用像素实测
  if (measured) {
    const cls = classifyChroma(measured);
    return {
      allowed: cls.verdict === "color",
      verdict: cls.verdict,
      reason: cls.reason,
      evidence: "pixel-measured",
      filmTitle,
    };
  }

  // 3) 两样都没有 → 不纳入正式推荐（任务书第 4 条）
  return {
    allowed: false, verdict: "unknown",
    reason: "无法确认是否为黑白影像，按规则不纳入正式推荐",
    evidence: "insufficient-evidence", filmTitle,
  };
}

/**
 * 批量过滤。返回 { kept, excluded }，excluded 里带原因，供如实上报。
 *
 * 关键：返回的 kept 是**已经排除**的池，调用方拿不到被排除的东西。
 * 这样「提高相关性评分」没有对象可提。
 */
export function filterFilmCandidates(candidates, measureById = null) {
  const kept = [];
  const excluded = [];
  for (const c of candidates) {
    const id = c?.id || c?.artwork?.id || "";
    const measured = typeof measureById === "function" ? measureById(id) : null;
    const j = judgeFilmCandidate(c, measured);
    if (j.allowed) kept.push(c);
    else excluded.push({ id, filmTitle: j.filmTitle || "", verdict: j.verdict, reason: j.reason, evidence: j.evidence });
  }
  return { kept, excluded };
}

export const MONOCHROME_POLICY = {
  rule: "AIGC 创作参考不使用黑白电影影像",
  status: "hard-filter",
  appliesTo: ["local-film-pool", "commons-remote-film", "find", "create", "shoot"],
  bypssableByScore: false,
  unknownHandling: "exclude-and-record",
  allowShortfall: true,
  thresholds: CHROMA_THRESHOLDS,
  note: "sepia/tinted 黑白片按黑白处理；判定不得只依据饱和度。",
};
