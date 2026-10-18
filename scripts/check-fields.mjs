// Quick field inspection: which artworks lack images, and key atmosphere fields.
import { artworks } from "../src/data/artworks.js";

const noImage = artworks.filter((a) => a.imageUnavailable);
console.log("NO IMAGE:", noImage.map((a) => `${a.id} (${a.artist})`).join(" | ") || "none");

const fuchun = artworks.find((a) => a.id === "fuchun-mountains");
console.log("fuchun atmospheres:", JSON.stringify(fuchun.atmosphere));
console.log("fuchun location:", JSON.stringify(fuchun.location));

const withLoc = artworks.filter((a) => a.location);
console.log("with location:", withLoc.map((a) => a.id).join(", "));

const subjectTypes = {};
for (const a of artworks) {
  const t = a.shootTranslation.subjectType;
  subjectTypes[t] = (subjectTypes[t] || 0) + 1;
}
console.log("subjectTypes:", JSON.stringify(subjectTypes));
