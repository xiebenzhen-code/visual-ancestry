// Smoke: import the full Frame Atlas module graph and exercise the retrieval
// chain exactly like the FIND page does. Writes a report file (stdout here is
// unreliable in this environment, so callers capture this file).
import { retrieveByText, retrieveByArtwork, parseVisualIntent, intentSummary, relationsFor } from "../src/services/retrieval/retrievalService.js";
import { curateHomepage } from "../src/services/homepageCurator.js";
import { suggestForQueryWithFallback } from "../src/services/suggestionService.js";
import { artworks, findArtwork } from "../src/data/artworks.js";
import { getStructuredPrompt } from "../src/services/aiService.js";
import { findLocalById } from "../src/services/artService.js";

const out = [];
const sample = "一个人站在很大的空间里，感觉很远，但不是悲伤。";

try {
  const { intent, results } = retrieveByText(sample, { limit: 6 });
  out.push("== SAMPLE QUERY ==");
  out.push(sample);
  out.push("== INTENT FIELDS ==");
  out.push(intentSummary(intent).join("\n"));
  out.push("emotion=" + JSON.stringify(intent.emotion));
  out.push("atmosphere=" + JSON.stringify(intent.atmosphere));
  out.push("melancholy=" + intent.melancholy);
  out.push("subjectScale=" + intent.subjectScale + " environmentDominance=" + intent.environmentDominance +
    " spatialDepth=" + intent.spatialDepth + " negativeSpace=" + intent.negativeSpace +
    " arousal=" + intent.arousal + " socialDistance=" + intent.socialDistance +
    " cameraRelation=" + intent.cameraRelation);
  out.push("== TOP RESULTS ==");
  for (const r of results) {
    out.push(`- ${r.artwork.id} | score ${r.retrievalScore} | ${r.reasons.join("; ")}`);
  }
  out.push(`results=${results.length}`);
} catch (e) {
  out.push("SAMPLE FAILED: " + e.message + "\n" + (e.stack || ""));
}

try {
  const wanderer = findLocalById("wanderer");
  out.push("== WANDERER RELATIONS ==");
  out.push("relations=" + relationsFor(wanderer).map((r) => `${r.filmTitle} (${r.relationClass}/${r.relationType})`).join(" | "));
  out.push("== WANDERER SIMILAR (retrieveByArtwork) ==");
  const sim = retrieveByArtwork(wanderer, { limit: 3 });
  for (const r of sim) out.push(`- ${r.artwork.id} | score ${r.retrievalScore} | ${r.reasons.join("; ")}`);
} catch (e) {
  out.push("WANDERER FAILED: " + e.message);
}

try {
  out.push("== HOMEPAGE ==");
  const works = curateHomepage(4);
  out.push("count=" + works.length + " ids=" + works.map((w) => w.id).join(","));
} catch (e) {
  out.push("HOMEPAGE FAILED: " + e.message);
}

try {
  out.push("== SUGGESTIONS (no-match fallback) ==");
  out.push("孤独 -> " + suggestForQueryWithFallback("孤独").join(","));
  out.push("zzz-none -> " + suggestForQueryWithFallback("zzz-none").join(","));
} catch (e) {
  out.push("SUGGEST FAILED: " + e.message);
}

try {
  out.push("== CREATE PROMPT COVERAGE ==");
  const analyzed = artworks.filter((a) => a.hasAnalysis && a.image && !a.imageUnavailable);
  let missing = 0;
  for (const a of analyzed) {
    const p = getStructuredPrompt(a);
    const empty = Object.values(p).every((v) => !v);
    if (empty) { missing++; out.push(`- NO PROMPT FIELDS: ${a.id}`); }
  }
  out.push(`analyzed=${analyzed.length} missing=${missing}`);
} catch (e) {
  out.push("CREATE FAILED: " + e.message);
}

out.push("OK");
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./smoke-import-result.txt", import.meta.url), out.join("\n"), "utf8");
