// Single retrieval entry. Pages must not invent their own similarity rules.
import { artworks } from "../../data/artworks.js";
import visualIntentsData from "../../data/visual-intents/artworks.json" with { type: "json" };
import { parseVisualIntent } from "./visualIntentParser.js";
import { intentFromArtwork, sharedReasons } from "./artworkIntent.js";
import { scoreIntent } from "./scoring.js";
import { cinemaRelations } from "./relationBuilder.js";
import { filmStills, FILM_STILL_RIGHTS } from "../../data/filmStills.js";
import { emptyVisualIntent } from "./visualIntent.js";
// P4.12 — 黑白电影影像硬性排除。产品规则，不是评分偏好：
// 判定放在候选进入推荐池之前，评分无法绕过（池子里根本没有它）。
import { filterFilmCandidates, FILM_COLOR_FACTS } from "./monochromePolicy.js";
import { analyzeImage as runVision } from "../vision/visionService.js";
// P4.4 — 缺失值感知排序 + 色彩证据 + 艺术语境（全部为可选增强，不替换 baseline）
import { rankWithMissingAwareness } from "./missingAwareRanking.js";
import { rerank as rerankWithColorAndDiversity, explain as explainRerank } from "./rerank.js";
import { buildArtContext, matchableObservations } from "./artContext.js";
import { colorDistance as colorDistanceForOriginal } from "./rerank.js";
import { allSignatures, signatureIndexMeta, assertUploadSignatureOrigin } from "./colorIndex.js";
import { applyVisualLexicon, searchByLexicon, analyzeQuery } from "./queryLexicon.js";

// P3.1 alignment: artworks with a validated REAL vision intent (frozen P2.8
// calibration) are retrieved in the same VisualIntent space as vision
// queries. Artworks absent from the cache keep the rule-based derivation.
const VISUAL_INTENT_CACHE = (visualIntentsData && visualIntentsData.intents) || {};

// R5 STEP 3 — intent provenance. Three origins must never be conflated, and
// `intent.source` alone cannot express them: the live query intent and the
// frozen calibration intents BOTH carry source === "vision". The retrieval
// boundary therefore names the origin explicitly:
//   · live-vision        this run's real provider call (FIND image / SHOOT photo)
//   · calibration-cache  the frozen P2.8 real-provider intents stored per artwork
//   · rule-derivation    intentFromArtwork() reading curated text
//   · text-parse         a text query read by the rule parser
// Display copy lives in the pages; this module only states the fact.
export const INTENT_PROVENANCE = {
  LIVE: "live-vision",
  CACHE: "calibration-cache",
  RULE: "rule-derivation",
  TEXT: "text-parse",
};

// Display copy for the vocabulary above. It lives beside the vocabulary so the
// label can never drift from the value it names.
export const INTENT_PROVENANCE_LABELS = {
  [INTENT_PROVENANCE.LIVE]: "本次实时识别",
  [INTENT_PROVENANCE.CACHE]: "历史校准数据",
  [INTENT_PROVENANCE.RULE]: "规则推导",
  [INTENT_PROVENANCE.TEXT]: "文字解析",
  "film-still-record": "电影画面档案",
};

export function provenanceLabel(provenance) {
  return INTENT_PROVENANCE_LABELS[provenance] || "来源未标注";
}

// Which of the two artwork-side sources actually supplied this artwork's
// intent. It must follow the SAME branch as intentOf() or the label would lie.
function provenanceOf(artwork, intentSource = "auto") {
  if (intentSource !== "auto") return INTENT_PROVENANCE.RULE; // forced rule probe
  return cachedVisionIntent(artwork) ? INTENT_PROVENANCE.CACHE : INTENT_PROVENANCE.RULE;
}

function cachedVisionIntent(artwork) {
  const entry = VISUAL_INTENT_CACHE[artwork.id];
  return entry && entry.source === "vision" && entry.intent ? entry.intent : null;
}

const intentCache = new Map();

// R5 STEP 3 — film stills are real retrieval candidates, not decoration on a
// static card. They enter the SAME pool and the SAME deterministic scorer: a
// film still carries a 22-field VisualIntent exactly like a painting does, so
// scoreIntent() and sharedReasons() apply unchanged.
//
// The film still is deliberately shaped to look like an artwork from the
// retrieval layer's point of view — key/id/medium/artist/image all exist —
// while keeping its own metadata intact so a director is never rendered as a
// painter and a frame is never rendered as a single painting. `medium` is what
// the pages branch on; it is never collapsed into the artwork vocabulary.
//
// Note the scorer is NOT modified to favour films. With 3 film stills against
// 46 paintings, a pure score sort can legitimately leave every film out of the
// top N — that is the deterministic ranking working, not a bug. What the page
// needs is a MEDIUM FILTER (media: "all" | "artwork" | "film"); "film" then
// returns exactly the films, ranked by the same unmodified score. So the
// requirement "a legal film frame is reachable from FIND" is satisfied by the
// filter, not by bending the ranking.
export const MEDIA = { ARTWORK: "artwork", FILM: "film" };

function filmStillCandidates() {
  return filmStills
    .filter((still) => still.image && still.visualIntent)
    .map((still) => ({
      key: still.id,
      id: still.id,
      medium: MEDIA.FILM,
      title: still.title,
      titleZh: still.titleZh,
      // For a film still the creator is the director. The field name stays
      // `artist` because the shared renderer reads it; the pages print
      // "导演" for medium === film. Nobody is ever called a painter by mistake.
      artist: still.director,
      artistZh: still.directorZh,
      year: String(still.year),
      image: still.image,
      imageUnavailable: false,
      orientation: still.image.ratio >= 1 ? "landscape" : "portrait",
      // Carried so SHOOT can render a film-frame reference through the same
      // path a painting uses. The advice inside names the frame it came from.
      shootTranslation: still.shootTranslation || null,
      // buildProjectContext() and aiService() read these on ANY reference. A
      // film frame missing them crashed the SHOOT page (found in STEP 4).
      creatorTranslation: still.creatorTranslation || null,
      emotion: still.emotion || still.visualIntent.emotion,
      emotions: still.emotions || still.visualIntent.emotion,
      atmosphere: still.atmosphere || still.visualIntent.atmosphere,
      atmospheres: still.atmospheres || still.visualIntent.atmosphere,
      traditions: still.traditions || ["电影"],
      visualDNA: still.visualDNA || [],
      composition: still.composition || "",
      lighting: still.lighting || "",
      color: still.color || "",
      spatialStructure: still.spatialStructure || "",
      location: still.location || null,
      locationPattern: still.locationPattern || null,
      evidenceLevel: still.evidenceLevel || "",
      source: still.source,
      film: {
        title: still.title,
        titleZh: still.titleZh,
        director: still.director,
        directorZh: still.directorZh,
        year: still.year,
        frameIdentifier: still.frameIdentifier,
        timestamp: still.timestamp,
        timestampNote: still.timestampNote || null,
        visualNote: still.visualNote || null,
        rights: {
          license: still.source.license,
          licenseShortName: still.source.licenseShortName,
          rightsCategory: still.source.rightsCategory,
          copyrighted: still.source.copyrighted,
          attributionRequired: still.source.attributionRequired,
          credit: still.source.credit || null,
          verifiedBy: FILM_STILL_RIGHTS.verificationMethod,
          verifiedAt: FILM_STILL_RIGHTS.verifiedAt,
        },
      },
    }));
}

// P4.12 — 黑白电影影像在进入池子之前就被剔除。
// 只在这里过滤：curatedPool / filmStillPool / filmStillAsArtwork 全部经过同一个池，
// 因此 FIND、CREATE、SHOOT 与文字检索不会各自漏一条路径。
const FILM_POOL_AUDIT = filterFilmCandidates(filmStillCandidates());
const FILM_POOL = FILM_POOL_AUDIT.kept;

/** 被黑白规则排除的电影影像（供页面与测试如实上报，不可用于补足数量）。 */
export function excludedFilmCandidates() {
  return FILM_POOL_AUDIT.excluded.slice();
}

// The same artwork-shaped view, for pages that resolve a reference by id
// (SHOOT). One shape, one code path — only the labels differ per medium.
export function filmStillAsArtwork(still) {
  // P4.12 — 必须查过滤后的 FILM_POOL，不能查 filmStillCandidates()。
  // MEASURED 缺陷：原先查原始候选，于是 #shoot/film-the-general 这类直连链接
  // 仍能把已排除的黑白片解析成有效 artwork，绕过 pool 过滤。
  return FILM_POOL.find((c) => c.id === still?.id) || null;
}

export function filmStillPool() {
  return FILM_POOL.slice();
}

// media: "all" (default) | "artwork" | "film" — the FIND medium filter.
//
// P4.9 STEP 2 — 未知值（例如 "animation"）以前会静默回落到「全部」。
// 那会让「选了动画却返回绘画」这种错误无声通过。本地档案里动画 0 件，
// 所以未知/未支持的媒介应当返回**空池**，由调用方如实说明，
// 而不是拿全池充数。
function curatedPool(media = "all") {
  const paintings = artworks.filter((artwork) => artwork.image && !artwork.imageUnavailable);
  if (media === MEDIA.ARTWORK) return paintings;
  if (media === MEDIA.FILM) return FILM_POOL;
  if (media === "all" || media === undefined || media === null || media === "") {
    return paintings.concat(FILM_POOL);
  }
  return [];
}

// intentSource "auto": vision-intent cache first, rule fallback (default).
// intentSource "rule": force the pre-P3.1 rule derivation (evaluation probe).
function intentOf(artwork, intentSource = "auto") {
  const cacheKey = `${artwork.key}|${intentSource}`;
  if (!intentCache.has(cacheKey)) {
    // Film stills ship a hand-authored, license-verified 22-field intent. There
    // is no calibration cache entry and no rule derivation for them — inventing
    // one from a film's metadata would be a different claim than the painting path.
    if (artwork.medium === MEDIA.FILM) {
      intentCache.set(cacheKey, filmStillIntent(artwork));
      return intentCache.get(cacheKey);
    }
    const cached = intentSource === "auto" ? cachedVisionIntent(artwork) : null;
    intentCache.set(cacheKey, cached || intentFromArtwork(artwork));
  }
  return intentCache.get(cacheKey);
}

function filmStillIntent(candidate) {
  const still = filmStills.find((f) => f.id === candidate.id);
  return still ? { ...still.visualIntent } : emptyVisualIntent();
}

// A film still's intent is authored, not derived and not a live provider call.
// It gets its OWN provenance value — calling it "rule-derivation" or
// "calibration-cache" would be a false claim about where it came from.
export const INTENT_PROVENANCE_FILM = "film-still-record";

// P4.4 — `enhanced` 为可选参数。不传时行为与 P4.3 及之前逐字节一致（baseline 排序）。
// 传 enhanced 时：缺失值感知排序 → 色彩/多样性二阶段重排；baseline 分数仍保留在返回值里。
export function retrieveByIntent(intent, { limit = 8, excludeKey = "", intentSource = "auto", media = "all", enhanced = null } = {}) {
  const items = curatedPool(media)
    .filter((artwork) => artwork.key !== excludeKey)
    .map((artwork) => {
      const candidateIntent = intentOf(artwork, intentSource);
      const scored = scoreIntent(intent, candidateIntent);
      return {
        artwork,
        medium: artwork.medium || MEDIA.ARTWORK,
        retrievalScore: scored.score,
        reasons: sharedReasons(intent, candidateIntent, 4),
        intent: candidateIntent,
        intentProvenance:
          artwork.medium === MEDIA.FILM ? INTENT_PROVENANCE_FILM : provenanceOf(artwork, intentSource),
      };
    })
    .filter((item) => item.retrievalScore > 0 && item.reasons.length);

  if (!enhanced) {
    // 原始路径，一字未改
    return items.sort((a, b) => b.retrievalScore - a.retrievalScore).slice(0, limit);
  }

  // ---- 增强路径 ----
  const sigs = enhanced.signatures || {};
  const querySig = enhanced.querySig || null;

  // 阶段 1：缺失值感知排序
  const aware = rankWithMissingAwareness(intent, items);

  // 阶段 2：色彩 + 多样性重排（颜色只在结构达标时参与）
  const reranked = rerankWithColorAndDiversity(
    intent,
    aware.map((x) => ({
      artwork: x.artwork,
      intent: x.intent,
      medium: x.medium,
      baseScore: x.comparison.baselineScore,
      qualityScore: x.qualityScore,
      comparison: x.comparison,
      // P4.6 修复：baseline 路径有 intentProvenance，enhanced 路径曾丢失它，
      // 导致 isOriginalMatch 判定拿不到 provenance 而永远为 false。
      intentProvenance: x.intentProvenance,
    })),
    sigs,
    { querySig, limit }
  );

  // 映射回页面既有契约（artwork / retrievalScore / reasons / intent / intentProvenance）
  return reranked.map((r) => {
    const explanation = explainRerank(r, intent);
    const ctx = buildArtContext({ artwork: r.artwork, signature: sigs[r.artwork?.id] });
    // P4.6 — 「是否可称为原作识别」必须同时满足三个条件，缺一不可：
    //   1. 该作品自身有真实 Vision intent（calibration-cache 或 live）
    //   2. 查询图与它的色彩签名距离极小（同一张图应≈0）
    //   3. 核心结构字段几乎全中
    // 任一不满足就只是「参考」，不得宣称识别成功。
    const candSig = sigs[r.artwork?.id];
    const selfDistance = querySig && candSig && querySig.ok && candSig.ok
      ? colorDistanceForOriginal(querySig, candSig)
      : null;
    // 实测：同一张图两次独立识别会有字段分歧（本轮实测 9 个核心字段中 6 个一致，
    // 3 个不同：spatialDepth / cameraDistance / cameraRelation）。Vision 本身有不确定性，
    // 要求 ratio === 1 会让「原作识别」永远无法出现。改为分级，并把依据全部暴露：
    //   certain  核心全中 + 色彩距离极小  → 可以称「这张图就是」
    //   likely   核心 ≥2/3 一致 + 色彩距离很小 → 只能说「很可能是同一构图」
    //   none     其余 → 只作为参考，不宣称识别
    // intentProvenance 在 rerank 返回对象顶层（由 P4.6 透传），不在 r.item 上。
    const prov = r.intentProvenance ?? r.item?.intentProvenance;
    const hasRealIntent = prov === INTENT_PROVENANCE.CACHE || prov === INTENT_PROVENANCE.LIVE;
    // colorDistance() 返回 { distance, components }，不是数字 —— 之前直接比较对象
    // 导致 colourClose 恒为 false（实测发现）。这里显式取 .distance。
    const selfDistValue = selfDistance && typeof selfDistance === "object" ? selfDistance.distance : selfDistance;
    const colourClose = typeof selfDistValue === "number" && selfDistValue < 0.02;
    let originalMatch = "none";
    if (hasRealIntent && colourClose) {
      if (r.core.defined >= 3 && r.core.ratio === 1) originalMatch = "certain";
      else if (r.core.defined >= 3 && r.core.ratio >= 0.66) originalMatch = "likely";
    }
    const isOriginalMatch = originalMatch === "certain";
    return {
      artwork: r.artwork,
      medium: r.medium,
      retrievalScore: r.finalScore,
      baselineScore: r.baseScore,
      reasons: (r.reasons && r.reasons.length) ? r.reasons : (r.item?.reasons?.length ? r.item.reasons : explanation.evidence.map((e) => e.text)),
      intent: r.item?.intent ?? r.intent,
      intentProvenance: r.intentProvenance ?? r.item?.intentProvenance,
      // P4.4 新增可追溯信息
      comparison: r.item.comparison || null,
      colorEvidence: r.colorDelta ? { distance: r.colorDelta.distance, components: r.colorDelta.components, bonus: r.colorBonus } : null,
      diversityPenalty: r.diversityPenalty,
      nearDuplicateOf: r.nearDuplicateOf || null,
      crossTradition: r.crossTradition,
      explanation,
      artContext: ctx,
      artContextMatchable: matchableObservations(ctx).map((c) => c.text),
      isOriginalMatch,
      originalMatch,
      originalMatchEvidence: originalMatch === "none" ? null : {
        selfColourDistance: selfDistValue,
        coreRatio: Math.round(r.core.ratio * 100) / 100,
        coreAgree: r.core.agree,
        coreDefined: r.core.defined,
        intentProvenance: r.intentProvenance ?? r.item?.intentProvenance,
        disagreements: r.core.differFields.map((x) => `${x.field}: 本次=${x.query} / 存档=${x.candidate}`),
      },
    };
  });
}

// P4.4 — 文本检索增加两件事，且都不伪造视觉判断：
//   1. 视觉词补充：queryLexicon 里 kind==="visual" 的条目补进 intent（合法枚举内）
//   2. 文本回退：题材/文化词（战争/日本/宗教…）不产生视觉字段，
//      改走 searchByLexicon 的元数据匹配，并明确标注 basis="text-metadata"
// 两者都没有命中时，诚实返回空结果 + 原因。
export function retrieveByText(text, options = {}) {
  const parsed = parseVisualIntent(text);
  const { intent, visualHits } = applyVisualLexicon(parsed, text);
  const queryAnalysis = analyzeQuery(text);

  const opts = options || {};
  const enhanced = opts.enhanced
    ? { ...opts.enhanced, signatures: opts.enhanced.signatures || allSignatures() }
    : null;

  const visualResults = retrieveByIntent(intent, { ...opts, enhanced });

  // 文本回退：只有当视觉通道确实没有可用结果时才启用，
  // 避免把文本匹配混进视觉相似结果里冒充。
  let textFallback = null;
  if (!visualResults.length && queryAnalysis.canProduceTextMatch) {
    const pool = curatedPool(opts.media || "all");
    textFallback = searchByLexicon(pool, text);
  }

  // 文本回退结果必须映射成与视觉结果**同形的对象**，否则页面渲染会拿到 undefined。
  // 同时明确标注：这是元数据文本匹配，不是视觉相似 —— 不给它伪造的分数。
  const fallbackMapped = textFallback
    ? textFallback.results.map((r) => ({
        artwork: r.artwork,
        medium: r.artwork.medium || "artwork",
        retrievalScore: 0, // 文本匹配不产生视觉相似度；0 表示「不适用」
        reasons: [`${r.lexiconKind === "culture" ? "文化/地区" : "题材"}匹配「${r.lexeme}」（字段：${r.matchedFields.join("、")}）`],
        intent: null,
        intentProvenance: "text-metadata",
        basis: "text-metadata",
        matchedFields: r.matchedFields,
        lexeme: r.lexeme,
        note: r.note,
      }))
    : [];

  const results = visualResults.length ? visualResults : fallbackMapped;

  return {
    intent,
    results,
    queryProvenance: INTENT_PROVENANCE.TEXT,
    // P4.4 可追溯信息
    queryAnalysis,
    visualHits,
    resultBasis: visualResults.length ? "visual-intent" : textFallback ? "text-metadata" : "empty",
    emptyReason: results.length
      ? null
      : queryAnalysis.canProduceTextMatch
        ? "查询被识别为题材/文化词，但档案中没有匹配的作品"
        : "查询未能识别为视觉描述、题材或文化词，因此不返回结果",
    textFallback: textFallback ? { matchedTerms: textFallback.matchedTerms, perEntry: textFallback.perEntry } : null,
  };
}

// Image FIND funnels through the exact same pipeline: file → vision → intent
// → retrieval. Returns { ok, error, title, summary, intent, results }.
// ok:false carries a VISION_ERRORS error so the page can offer the text path.
export async function retrieveByImage(file, options = {}) {
  const vision = await runVision(file);
  if (!vision.ok) {
return {
    ok: false,
    error: vision.error,
    // R5 STEP 5 — the failure CLASS travels with the error. "No provider
    // configured" and "you were rate limited" are different problems; the page
    // must be able to say so instead of printing one sentence for both.
    reason: vision.reason || "failed",
    intent: null,
    results: [],
    title: "",
    summary: [],
    queryProvenance: null,
  };
  }
  return {
    ok: true,
    intent: vision.intent,
    // P4.4 — 上传图必须从**它自己的像素**算颜色，不得查本地资产索引。
    // querySig 由调用方（find.js）在浏览器里用 colorSignatureBrowser 算好后传入；
    // 这里只做透传与来源断言，绝不回退到 signatureFor(artworkId)。
    results: retrieveByIntent(vision.intent, {
      ...options,
      enhanced: options && options.enhanced ? { ...options.enhanced, signatures: options.enhanced.signatures || allSignatures() } : null,
    }),
    title: shortTitle(vision.intent),
    summary: shortSummary(vision.intent),
    // A successful image outcome means THIS run really called the provider.
    // No calibration cache and no rule fallback can reach this line.
    queryProvenance: INTENT_PROVENANCE.LIVE,
    // P4.4 — 回传本次上传图的签名（由调用方从上传像素算得），
    // 并断言它不是本地资产索引的查询结果。没有就是 null，不伪造。
    querySignature: (options && options.enhanced && options.enhanced.querySig) || null,
    querySignatureOrigin: (options && options.enhanced && options.enhanced.querySig)
      ? assertUploadSignatureOrigin(options.enhanced.querySig).reason
      : "unavailable",
  };
}

export function retrieveByArtwork(artwork, options = {}) {
  return retrieveByIntent(intentOf(artwork, options.intentSource), { ...options, excludeKey: artwork.key });
}

// Single source of truth for "which intent does this artwork carry" and "where
// did it come from". Pages must not re-implement the cache lookup: a second
// copy could label a result with a provenance the scorer never used.
export function intentForArtwork(artwork, intentSource = "auto") {
  return intentOf(artwork, intentSource);
}

export function provenanceForArtwork(artwork, intentSource = "auto") {
  return provenanceOf(artwork, intentSource);
}

export function relationsFor(artwork) {
  return cinemaRelations(artwork);
}

// One-line reading of the vision result for the FIND UI ("小人物 / 大空间 / …").
// Only fields the model actually returned appear; nothing is padded.
const SHORT_LABELS = [
  ["subjectScale", { small: "小人物", medium: "中等人物", large: "大人物" }],
  ["environmentDominance", { high: "大空间", low: "空间次要" }],
  ["spatialDepth", { deep: "深景", shallow: "浅景" }],
  ["negativeSpace", { high: "高留白" }],
  ["socialDistance", { high: "疏离", low: "贴近" }],
  ["cameraRelation", { observational: "冷静观察", immersive: "沉浸", confrontational: "直面" }],
  ["melancholy", { high: "偏忧郁", low: "不忧郁" }],
  ["arousal", { low: "静态", high: "高张力" }],
];

export function shortTitle(intent) {
  const parts = [];
  for (const [field, labels] of SHORT_LABELS) {
    const v = intent && intent[field];
    if (v && labels[v]) parts.push(labels[v]);
  }
  return parts.length ? parts.slice(0, 6).join(" / ") : "";
}

function shortSummary(intent) {
  return shortTitle(intent);
}

export { parseVisualIntent } from "./visualIntentParser.js";
export { intentSummary } from "./visualIntentParser.js";
