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
  // P4.13 — 第三条证据：通道相关上限。
  //
  // 为什么需要它：色相分散度在「偏冷色调的着色黑白片」上会失效。
  // 实测反例：Way Down East (1920) 三张同片剧照，02/03 是棕褐着色（hueSpread 6°/5.3°，
  // 判对），04 是青绿着色（hueSpread 27.9°，超过 25° → 被误判成彩色）。
  // 它不是彩色片，只是色调偏冷、色相铺得开。
  //
  // 着色黑白片本质是「同一张亮度图 × 一条色调映射」，所以 R/G/B 三通道高度线性相关。
  // 真彩色画面的三通道彼此独立得多。这个差别比色相分散度稳。
  //
  // 实测 61 个样本（46 件绘画 + 15 部电影）：
  //   已知黑白/着色 14 部：最小通道相关 0.9810 – 1.0000
  //   真彩色：0.3505（the-kiss）到 0.912（american-gothic），最低 -0.539（wheatfield-crows）
  // 两侧无重叠。取 0.95 作为上限，两侧各留约 0.03 余量。
  maxChannelCorrelation: 0.95,
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

  // P4.13 — 通道相关：着色黑白片三通道高度线性相关，真彩色反之。
  // 用第二个独立扫描算，避免把上面的循环搞复杂；多一次 O(n) 但 n 只有几万像素。
  let minChannelCorr = null;
  {
    let mR = 0, mG = 0, mB = 0;
    for (let i = 0; i < n; i++) {
      const o = i * channels;
      mR += data[o]; mG += data[o + 1]; mB += data[o + 2];
    }
    mR /= n; mG /= n; mB /= n;
    let vRR = 0, vGG = 0, vBB = 0, vRG = 0, vRB = 0, vGB = 0;
    for (let i = 0; i < n; i++) {
      const o = i * channels;
      const dr = data[o] - mR, dg = data[o + 1] - mG, db = data[o + 2] - mB;
      vRR += dr * dr; vGG += dg * dg; vBB += db * db;
      vRG += dr * dg; vRB += dr * db; vGB += dg * db;
    }
    const safe = (num, den) => (den > 0 ? num / Math.sqrt(den) : 0);
    const rRG = safe(vRG, vRR * vGG);
    const rRB = safe(vRB, vRR * vBB);
    const rGB = safe(vGB, vGG * vBB);
    // 取三者最小：只要有一个通道明显独立，就不是「单色调映射」。
    minChannelCorr = Math.round(Math.min(rRG, rRB, rGB) * 10000) / 10000;
  }
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
    minChannelCorrelation: minChannelCorr,
  };
}

/**
 * 把色度指标翻译成色彩判定。
 * 注意：这个函数**只**用于「没有影片级事实」的候选（主要是远程 Commons 候选）。
 */
/**
 * 把色度指标翻译成色彩判定。
 *
 * P4.13 — 三条证据，判为彩色需**全部**满足：
 *   1) colorShare >= 0.02        有足够多像素携带色彩（排除纯黑白）
 *   2) hueSpreadDeg >= 25        色相铺得开（排除棕褐/青绿等着色）
 *   3) minChannelCorrelation < 0.95  三通道彼此独立（排除「单色调映射」）
 *
 * 第 3 条是 P4.13 新增，用来修一个真实边界缺陷：
 * Way Down East (1920) 的青绿着色剧照 hueSpread 27.9° 会撞过第 2 条，
 * 但它仍是着色黑白片。它的通道相关 0.996，第 3 条把它挡回去。
 *
 * 三条都是**必要条件**，任一不满足即判黑白。这偏保守：
 * 宁可漏掉一张真彩色，也不放行一张着色黑白——与产品规则一致（无法确认就不纳入）。
 */
export function classifyChroma(chroma) {
  if (!chroma || !chroma.ok) {
    return { verdict: "unknown", reason: `色度测量失败：${chroma?.reason || "无数据"}` };
  }
  const TH = CHROMA_THRESHOLDS;
  const hasColor = chroma.colorShare >= TH.minColorShare;
  const hueWide = chroma.hueSpreadDeg !== null && chroma.hueSpreadDeg >= TH.minHueSpread;
  // 第三条证据可能缺失（旧缓存 / 手工构造的 chroma 对象）。
  // 缺失时：判定上按「无法确认」处理（不放行），但理由上不得冒充「实测相关高」。
  const corrKnown = typeof chroma.minChannelCorrelation === "number";
  const channelsIndependent = corrKnown && chroma.minChannelCorrelation < TH.maxChannelCorrelation;

  if (hasColor && hueWide && channelsIndependent) {
    return {
      verdict: "color",
      reason: `实测彩色：${Math.round(chroma.colorShare * 100)}% 像素携带色彩，色相分散 ${chroma.hueSpreadDeg}°，通道相关仅 ${chroma.minChannelCorrelation}`,
    };
  }

  // 不满足时给出**最先失效的那条证据**作为理由，而不是笼统归到某一条。
  // 顺序很重要：旧实现在缺字段时会把原因错写成「通道相关高达 undefined」，
  // 让一张真正的棕褐着色片被描述成「单色调映射」，审计时会误导读日志的人。
  if (!hasColor) {
    return {
      verdict: "monochrome",
      reason: `实测黑白：仅 ${Math.round(chroma.colorShare * 100)}% 像素携带色彩，通道差中位数 ${chroma.medianChannelSpread}`,
    };
  }
  if (!hueWide) {
    return {
      verdict: "monochrome",
      reason: `实测单色相着色（sepia/tint）：${Math.round(chroma.colorShare * 100)}% 像素有通道差，但色相只集中在 ${chroma.hueSpreadDeg}°`,
    };
  }
  if (!corrKnown) {
    return {
      verdict: "monochrome",
      reason: `缺少通道相关证据（旧数据或未测量），无法确认是彩色，按排除处理；色相分散 ${chroma.hueSpreadDeg}°`,
    };
  }
  return {
    verdict: "monochrome",
    reason: `实测单色调映射（着色黑白）：${Math.round(chroma.colorShare * 100)}% 像素有通道差，但三通道相关高达 ${chroma.minChannelCorrelation}（色相 ${chroma.hueSpreadDeg}°）`,
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
