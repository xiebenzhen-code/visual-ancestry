// Unified artwork schema builder.
// Every artwork record must go through defineArtwork() so pages never hard-code analysis.
// Phase 2A: local works are tagged as source:"local" with analysisLevel 2 and,
// when the image pipeline ran, point at local webp tiers via imageManifest.

import imageManifest from "../imageManifest.generated.js";

const WIKIMEDIA_FILE_PATH = "https://commons.wikimedia.org/wiki/Special:FilePath/";

export function wikimediaImage(fileName, width = 1800) {
  return `${WIKIMEDIA_FILE_PATH}${encodeURIComponent(fileName)}?width=${width}`;
}

const REQUIRED_FIELDS = [
  "id",
  "titleEn",
  "titleZh",
  "artist",
  "artistZh",
  "year",
  "origin",
  "traditions",
  "emotions",
  "atmospheres",
  "composition",
  "lighting",
  "color",
  "spatialStructure",
  "visualDNA",
  "narrativeFunction",
  "cinematic",
  "aigc",
  "shoot",
];

export function defineArtwork(seed) {
  for (const field of REQUIRED_FIELDS) {
    if (seed[field] === undefined || seed[field] === null) {
      throw new Error(`Artwork "${seed.id || "?"}" is missing required field: ${field}`);
    }
  }

  const hasImage = Boolean(seed.imageFile || seed.imageUrl);
  const rightsStatus =
    seed.rightsStatus ||
    (hasImage
      ? "Public domain / institutional public-domain record"
      : "Artist copyright — image not bundled, analysis only");

  // Phase 2A: local tiered webp images (from scripts/process-images.mjs) win;
  // otherwise fall back to the Wikimedia remote URL.
  const localTiers = imageManifest[seed.id]?.tiers || null;
  const remoteUrl = seed.imageUrl || wikimediaImage(seed.imageFile, seed.imageWidth || 1800);
  const image = hasImage
    ? {
        type: localTiers ? "local-tiered" : seed.imageUrl ? "external-url" : "wikimedia",
        fileName: seed.imageFile || null,
        url: localTiers ? localTiers.detail : remoteUrl,
        width: seed.imageWidth || 1800,
        tiers: localTiers,
        ratio: imageManifest[seed.id]?.ratio ?? null,
        fallbackUrl: remoteUrl,
      }
    : null;

  const artwork = {
    key: `local:${seed.id}`,
    source: "local",
    sourceId: seed.id,
    analysisLevel: 2,
    hasAnalysis: true,
    culture: seed.culture || (seed.origin && seed.origin !== "China" ? seed.origin : seed.origin || ""),

    id: seed.id,
    title: seed.titleEn,
    titleEn: seed.titleEn,
    titleZh: seed.titleZh,
    artist: seed.artist,
    artistZh: seed.artistZh,
    year: seed.year,
    origin: seed.origin,
    museum: seed.museum || seed.sourceName || "",
    visualTraditions: seed.traditions,
    traditions: seed.traditions,

    emotion: seed.emotions,
    emotions: seed.emotions,
    atmosphere: seed.atmospheres,
    atmospheres: seed.atmospheres,

    visualDNA: seed.visualDNA,
    narrativeFunction: Array.isArray(seed.narrativeFunction)
      ? seed.narrativeFunction
      : [seed.narrativeFunction],

    composition: seed.composition,
    lighting: seed.lighting,
    color: seed.color,
    spatialStructure: seed.spatialStructure,

    image,
    imageSource: {
      name: seed.sourceName || "Wikimedia Commons",
      url: seed.sourceUrl || null,
    },
    source: {
      name: seed.sourceName || "Wikimedia Commons",
      url: seed.sourceUrl || null,
      rightsStatus,
      evidenceLevel: seed.evidenceLevel || "A / 公共馆藏或 Wikimedia 公共领域来源",
    },
    rightsStatus,
    publicDomain: hasImage ? seed.publicDomain !== false : false,
    imageUnavailable: !hasImage,

    orientation: seed.orientation || "landscape",
    oneLine: seed.oneLine || "",

    creatorTranslation: {
      cinematic: {
        shotSize: seed.cinematic.shotSize,
        lens: seed.cinematic.lens,
        cameraHeight: seed.cinematic.cameraHeight,
        cameraMovement: seed.cinematic.cameraMovement,
        subjectPlacement: seed.cinematic.subjectPlacement,
        depthLayers: seed.cinematic.depthLayers,
        lightDirection: seed.cinematic.lightDirection,
      },
      aigc: {
        scenePrompt: seed.aigc.scene,
        cameraPrompt: seed.aigc.camera,
        lightingPrompt: seed.aigc.lighting,
        compositionPrompt: seed.aigc.composition,
        movementPrompt: seed.aigc.movement,
        negativePrompt: seed.aigc.negative,
      },
      shotDesign: seed.shotDesign || "",
    },

    shootTranslation: {
      subjectType: seed.shoot.subjectType, // PERSON | PLACE | PERSON_PLACE
      personGuide: seed.shoot.person || null,
      placeGuide: seed.shoot.place || null,
      overlay: seed.shoot.overlay || null,
      proNotes: seed.shoot.proNotes || null,
    },

    location: seed.location || null,
    locationPattern: seed.locationPattern || null,

    evidenceLevel: seed.evidenceLevel || "A / 公共馆藏或 Wikimedia 公共领域来源",
  };

  return artwork;
}

export function assembleFullPrompt(artwork) {
  const a = artwork.creatorTranslation.aigc;
  return [
    a.scenePrompt,
    a.compositionPrompt,
    a.cameraPrompt,
    a.lightingPrompt,
    a.movementPrompt,
    `Avoid: ${a.negativePrompt.replace(/^no |^avoid /i, "")}`,
  ]
    .filter(Boolean)
    .join(", ");
}
