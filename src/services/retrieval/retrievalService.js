// Single retrieval entry. Pages must not invent their own similarity rules.
import { artworks } from "../../data/artworks.js";
import visualIntentsData from "../../data/visual-intents/artworks.json" with { type: "json" };
import { parseVisualIntent } from "./visualIntentParser.js";
import { intentFromArtwork, sharedReasons } from "./artworkIntent.js";
import { scoreIntent } from "./scoring.js";
import { cinemaRelations } from "./relationBuilder.js";
import { filmStills, FILM_STILL_RIGHTS } from "../../data/filmStills.js";
import { emptyVisualIntent } from "./visualIntent.js";
import { analyzeImage as runVision } from "../vision/visionService.js";

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

const FILM_POOL = filmStillCandidates();

// The same artwork-shaped view, for pages that resolve a reference by id
// (SHOOT). One shape, one code path — only the labels differ per medium.
export function filmStillAsArtwork(still) {
  return filmStillCandidates().find((c) => c.id === still.id) || null;
}

export function filmStillPool() {
  return FILM_POOL.slice();
}

// media: "all" (default) | "artwork" | "film" — theFIND medium filter.
function curatedPool(media = "all") {
  const paintings = artworks.filter((artwork) => artwork.image && !artwork.imageUnavailable);
  if (media === MEDIA.ARTWORK) return paintings;
  if (media === MEDIA.FILM) return FILM_POOL;
  return paintings.concat(FILM_POOL);
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

export function retrieveByIntent(intent, { limit = 8, excludeKey = "", intentSource = "auto", media = "all" } = {}) {
  return curatedPool(media)
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
    .filter((item) => item.retrievalScore > 0 && item.reasons.length)
    .sort((a, b) => b.retrievalScore - a.retrievalScore)
    .slice(0, limit);
}

export function retrieveByText(text, options) {
  const intent = parseVisualIntent(text);
  return { intent, results: retrieveByIntent(intent, options), queryProvenance: INTENT_PROVENANCE.TEXT };
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
    results: retrieveByIntent(vision.intent, options),
    title: shortTitle(vision.intent),
    summary: shortSummary(vision.intent),
    // A successful image outcome means THIS run really called the provider.
    // No calibration cache and no rule fallback can reach this line.
    queryProvenance: INTENT_PROVENANCE.LIVE,
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
