// Project Context — portable snapshot of the user's current creative
// decision, exported as JSON or Markdown for use elsewhere (AIGC tools,
// shot lists, notes). Cross-platform API integrations are intentionally
// out of scope for this phase.

import { assembleFullPrompt } from "../data/artworks.js";
import { referencesForArtwork } from "../data/filmReferences.js";

export function buildProjectContext(artwork, options = {}) {
  const cinematic = artwork.creatorTranslation.cinematic;
  const aigc = artwork.creatorTranslation.aigc;
  const shoot = artwork.shootTranslation;
  const references = referencesForArtwork(artwork.id);

  return {
    project: "Visual Ancestry — Project Context",
    exportedAt: new Date().toISOString(),
    selectedArtwork: {
      id: artwork.id,
      title: artwork.titleEn,
      titleZh: artwork.titleZh,
      artist: artwork.artist,
      artistZh: artwork.artistZh,
      year: artwork.year,
    },
    emotion: artwork.emotion,
    atmosphere: artwork.atmosphere,
    visualTradition: artwork.traditions,
    visualDNA: artwork.visualDNA,
    composition: artwork.composition,
    lighting: artwork.lighting,
    color: artwork.color,
    spatialStructure: artwork.spatialStructure,
    shotDesign: artwork.creatorTranslation.shotDesign || null,
    cinematic: {
      shotSize: cinematic.shotSize,
      lens: cinematic.lens,
      cameraHeight: cinematic.cameraHeight,
      cameraMovement: cinematic.cameraMovement,
      subjectPlacement: cinematic.subjectPlacement,
      depthLayers: cinematic.depthLayers,
      lightDirection: cinematic.lightDirection,
    },
    prompt: {
      scenePrompt: aigc.scenePrompt,
      cameraPrompt: aigc.cameraPrompt,
      lightingPrompt: aigc.lightingPrompt,
      compositionPrompt: aigc.compositionPrompt,
      movementPrompt: aigc.movementPrompt,
      negativePrompt: aigc.negativePrompt,
      combinedPrompt: options.includeCombined === false ? null : assembleFullPrompt(artwork),
    },
    shootGuide: {
      subjectType: shoot.subjectType,
      person: shoot.personGuide,
      place: shoot.placeGuide,
    },
    location: artwork.location,
    locationPattern: artwork.locationPattern,
    selectedFilmFrames: references.map((reference) => ({
      filmTitle: reference.filmTitle,
      filmTitleZh: reference.filmTitleZh,
      director: reference.director,
      year: reference.year,
      relationType: reference.relationType,
      evidenceLevel: reference.evidenceLevel,
      location: reference.location,
    })),
  };
}

export function projectContextToMarkdown(context) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  push(`# Project Context — ${context.selectedArtwork.titleZh} / ${context.selectedArtwork.title}`);
  push(`> ${context.project} · exported ${context.exportedAt}`);
  push();
  push(`## Artwork`);
  push(`- ${context.selectedArtwork.titleZh} (${context.selectedArtwork.title})`);
  push(`- ${context.selectedArtwork.artistZh} / ${context.selectedArtwork.artist}, ${context.selectedArtwork.year}`);
  push(`- 情绪: ${context.emotion.join(" / ")}`);
  push(`- 氛围: ${context.atmosphere.join(" / ")}`);
  push(`- 视觉传统: ${context.visualTradition.join(" / ")}`);
  push(`- Visual DNA: ${context.visualDNA.join(" / ")}`);
  push();
  push(`## Visual Analysis`);
  push(`- Composition: ${context.composition}`);
  push(`- Lighting: ${context.lighting}`);
  push(`- Color: ${context.color}`);
  push(`- Spatial Structure: ${context.spatialStructure}`);
  push();
  push(`## Shot Design`);
  for (const [key, value] of Object.entries(context.cinematic)) push(`- ${key}: ${value}`);
  if (context.shotDesign) push(`- note: ${context.shotDesign}`);
  push();
  push(`## AIGC Prompt`);
  for (const [key, value] of Object.entries(context.prompt)) {
    if (!value) continue;
    push(`- ${key}: ${value}`);
  }
  push();
  push(`## Shoot Guide (${context.shootGuide.subjectType})`);
  if (context.shootGuide.person) {
    push(`### 拍人`);
    for (const [key, value] of Object.entries(context.shootGuide.person)) push(`- ${key}: ${value}`);
  }
  if (context.shootGuide.place) {
    push(`### 拍景`);
    for (const [key, value] of Object.entries(context.shootGuide.place)) push(`- ${key}: ${value}`);
  }
  push();
  push(`## Location`);
  if (context.location) {
    for (const [key, value] of Object.entries(context.location)) {
      push(`- ${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : value}`);
    }
  } else {
    push(`- 未确认具体拍摄点`);
  }
  if (context.locationPattern) push(`- 类似地点特征: ${context.locationPattern.join(" / ")}`);
  push();
  if (context.selectedFilmFrames.length) {
    push(`## Film References`);
    for (const frame of context.selectedFilmFrames) {
      push(`- ${frame.filmTitleZh} / ${frame.filmTitle} (${frame.director}, ${frame.year}) — ${frame.relationType}, ${frame.evidenceLevel}`);
    }
  }
  return lines.join("\n");
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    textarea.remove();
    return ok;
  }
}
