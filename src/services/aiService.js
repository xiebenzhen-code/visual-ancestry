// aiService — reserved access point for AI capabilities.
// No external AI calls in this phase. The AIGC prompt fields are curated
// per artwork in the dataset; this service only assembles them.
// Future provider: a multimodal model endpoint (image analysis, prompt
// expansion). Pages must keep calling this service, never a vendor API.

import { assembleFullPrompt } from "../data/artworks.js";

export function getStructuredPrompt(artwork) {
  return artwork.creatorTranslation.aigc;
}

export function getCombinedPrompt(artwork) {
  return assembleFullPrompt(artwork);
}

// Placeholder for a future multimodal analysis call. Intentionally throws
// so nobody wires a fake implementation into a page.
export async function analyzeImage() {
  throw new Error("aiService.analyzeImage is reserved for a future multimodal provider.");
}
