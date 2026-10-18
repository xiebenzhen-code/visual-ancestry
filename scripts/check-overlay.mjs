// Overlay + shoot guide coverage check.
import { artworks } from "../src/data/artworks.js";

let withOverlay = 0;
let withSubject = 0;
let withEye = 0;
let personWithOverlay = [];
let missingGuide = [];

for (const a of artworks) {
  const s = a.shootTranslation;
  const ov = s.overlay;
  if (ov) {
    withOverlay++;
    if (ov.subjectArea) withSubject++;
    if (ov.eyeDirection) withEye++;
  }
  const t = s.subjectType;
  if ((t === "PERSON" || t === "PERSON_PLACE") && !s.personGuide) missingGuide.push(a.id + ":person");
  if ((t === "PLACE" || t === "PERSON_PLACE") && !s.placeGuide) missingGuide.push(a.id + ":place");
  if (t === "PERSON" && ov && ov.subjectArea) personWithOverlay.push(a.id);
}

console.log("total:", artworks.length);
console.log("withOverlay:", withOverlay, "withSubjectArea:", withSubject, "withEyeDirection:", withEye);
console.log("PERSON with subjectArea:", personWithOverlay.join(", "));
console.log("missing guides:", missingGuide.join(", ") || "none");
// Sample one overlay config for schema reference
const sample = artworks.find((a) => a.shootTranslation.overlay && a.shootTranslation.overlay.subjectArea);
console.log("sample overlay:", JSON.stringify(sample.shootTranslation.overlay));
const quiet = artworks.filter((a) => a.emotion.includes("平静") && a.shootTranslation.subjectType !== "PLACE").map((a) => a.id);
console.log("quiet person works:", quiet.join(", "));
