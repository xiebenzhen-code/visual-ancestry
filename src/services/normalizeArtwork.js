// normalizeArtwork.js — canonical unified Artwork schema for Phase 2A.
//
// STRICT SEPARATION:
//   - API facts: title / artist / year / origin / culture / museum / image /
//     rights / publicDomain / source / sourceId — ground truth from museums.
//   - Analysis: emotion / atmosphere / visualDNA / composition / lighting /
//     color / spatialStructure / narrativeFunction / creatorTranslation /
//     shootTranslation / location — OUR interpretation, only present for
//     curated featured works (analysisLevel > 0).
//
// API works always get analysisLevel = 0 and EMPTY analysis arrays. We never
// fabricate emotions. UI shows "Visual analysis unavailable" for those.

export const ANALYSIS_NONE = 0;
export const ANALYSIS_FULL = 2;

export function emptyAnalysis() {
  return {
    emotion: [],
    atmosphere: [],
    visualDNA: [],
    narrativeFunction: [],
    composition: "",
    lighting: "",
    color: "",
    spatialStructure: "",
    oneLine: "",
    creatorTranslation: null,
    shootTranslation: null,
    overlay: null,
    location: null,
    locationPattern: null,
  };
}

/**
 * @param {object} facts — API ground truth
 * @param {string} facts.source        e.g. "aic" | "met" | "rijks" | "cleveland"
 * @param {string|number} facts.sourceId
 * @param {string} facts.title
 * @param {string} [facts.titleZh]
 * @param {string} [facts.artist]
 * @param {string} [facts.artistZh]
 * @param {string} [facts.year]
 * @param {string} [facts.origin]
 * @param {string} [facts.culture]
 * @param {string} [facts.museum]
 * @param {object|null} facts.image    { url, tiers?, ratio?, fallbackUrl? }
 * @param {string} [facts.rights]
 * @param {boolean} [facts.publicDomain]
 * @param {string} [facts.sourceUrl]
 * @param {number} [facts.analysisLevel=0]
 * @param {object|null} [facts.analysis] — our curated analysis for featured works
 */
export function normalizeArtwork(facts) {
  const {
    source,
    sourceId,
    title,
    titleZh = "",
    artist = "Unknown",
    artistZh = "",
    year = "",
    origin = "",
    culture = "",
    museum = "",
    image = null,
    rights = "",
    publicDomain = false,
    sourceUrl = "",
    analysisLevel = ANALYSIS_NONE,
    analysis = null,
  } = facts;

  const a = analysis || emptyAnalysis();

  return {
    key: `${source}:${sourceId}`,
    source,
    sourceId: String(sourceId),

    // API facts
    title,
    titleEn: title,
    titleZh,
    artist,
    artistZh,
    year,
    origin,
    culture,
    museum,
    image,
    imageUnavailable: !image,
    rightsStatus: rights || "Rights retained by rights holder / institution",
    publicDomain: Boolean(publicDomain),
    source: {
      name: facts.sourceName || museum || source,
      url: sourceUrl || null,
      rightsStatus: rights || "",
    },
    sourceUrl,

    // Analysis (curated only)
    analysisLevel,
    hasAnalysis: analysisLevel > 0,

    emotion: a.emotion,
    emotions: a.emotion,
    atmosphere: a.atmosphere,
    atmospheres: a.atmosphere,
    visualDNA: a.visualDNA,
    narrativeFunction: a.narrativeFunction,
    composition: a.composition,
    lighting: a.lighting,
    color: a.color,
    spatialStructure: a.spatialStructure,
    oneLine: a.oneLine,
    creatorTranslation: a.creatorTranslation,
    shootTranslation: a.shootTranslation,
    overlay: a.overlay,
    location: a.location,
    locationPattern: a.locationPattern,

    // taxonomy compatibility (analyzed works only; remote works fall back to facts)
    traditions: a.traditions || [],
    visualTraditions: a.traditions || [],
    orientation: a.orientation || "landscape",
  };
}
