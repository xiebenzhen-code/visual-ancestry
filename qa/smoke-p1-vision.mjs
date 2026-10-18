// V5.1 smoke — vision adapter + merge into an existing VisualIntent retrieval.
// Runs in Node (no DOM) against the real modules. Writes qa/smoke-p1-vision.txt
import { writeFileSync } from "node:fs";
import { normalizeVisionIntent } from "../src/services/vision/normalizeVisionIntent.js";
import { retrieveByIntent } from "../src/services/retrieval/retrievalService.js";

const out = [];

// 1) rich payload, only legal fields survive
const rich = normalizeVisionIntent({
  subjectScale: "small",
  environmentDominance: "high",
  spatialDepth: "deep",
  negativeSpace: "high",
  arousal: "low",
  socialDistance: "high",
  cameraRelation: "observational",
  melancholy: "low",
  inventado: "muy grande", // must be dropped
  emotion: ["平静"],
  atmosphere: ["空旷"],
});
out.push("RICH source=" + rich.source);
for (const k of ["subjectScale", "environmentDominance", "spatialDepth", "negativeSpace", "arousal", "socialDistance", "cameraRelation", "melancholy"]) {
  out.push(`  ${k}=${rich[k]}`);
}
out.push("  inventado gone=" + !("inventado" in rich));
out.push("  emotion=" + JSON.stringify(rich.emotion) + " atmosphere=" + JSON.stringify(rich.atmosphere));

// 2) partial payload — untouched fields stay empty, nothing invented
const partial = normalizeVisionIntent({ subjectScale: "small", cameraRelation: "observational" });
out.push("PARTIAL subjectScale=" + partial.subjectScale + " cameraRelation=" + partial.cameraRelation);
out.push("PARTIAL spatialDepth empty=" + (partial.spatialDepth === "") + " melancholy empty=" + (partial.melancholy === ""));

// 3) a real retrieval against the curated pool using the vision result
const results = retrieveByIntent(rich, { limit: 4 });
out.push("RETRIEVAL hits=" + results.length + " scores=" + results.map((r) => r.retrievalScore).join(","));
out.push("RETRIEVAL reasons=" + (results[0] ? results[0].reasons.join(";") : ""));

// 4) bad payloads
out.push("NULL -> " + normalizeVisionIntent(null));
out.push("[], string, number -> " + normalizeVisionIntent([]) + " / " + normalizeVisionIntent("x") + " / " + normalizeVisionIntent(3));

out.push("OK");
writeFileSync(new URL("./smoke-p1-vision.txt", import.meta.url), out.join("\n"), "utf8");