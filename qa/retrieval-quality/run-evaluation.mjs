// P3 Retrieval Quality Evaluation runner.
// For each case in cases.json, runs the SAME retrieval core twice:
//   Baseline: retrieveByText(textQuery)  — rule-based text → VisualIntent → retrieval
//   Vision:   retrieveByIntent(visionIntent) — frozen REAL provider VisualIntent → retrieval
// No provider calls. No core modifications. Read-only wrt src/.
// Writes evaluation-results.json next to this file.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

// Import the production retrieval core (exact same code path as the app).
const { retrieveByText, retrieveByIntent } = await import(
  pathToFileURL(path.join(root, "src", "services", "retrieval", "retrievalService.js")).href
);

const TOP_K = 8;

function nonEmptyFields(intent) {
  return Object.entries(intent || {})
    .filter(([key, value]) => !["source", "raw"].includes(key))
    .filter(([, value]) => value && !(Array.isArray(value) && !value.length))
    .map(([key]) => key);
}

function topK(results, k = TOP_K) {
  return results.slice(0, k).map((item, index) => ({
    rank: index + 1,
    artworkId: item.artwork.id,
    artworkKey: item.artwork.key,
    title: item.artwork.title,
    artist: item.artwork.artist || "",
    retrievalScore: item.retrievalScore,
    reasons: item.reasons,
  }));
}

function overlap(a, b) {
  const setB = new Set(b);
  return a.filter((id) => setB.has(id));
}

const casesFile = JSON.parse(await readFile(path.join(__dirname, "cases.json"), "utf8"));
const cases = casesFile.cases;

const report = {
  meta: {
    phase: "P3 Retrieval Quality Validation",
    ranAt: new Date().toISOString(),
    topK: TOP_K,
    visionPipeline: "FROZEN — no provider calls in this evaluation",
    intentProvenance: casesFile.meta.visionIntentProvenance,
    coreFiles: "src/services/retrieval/* imported verbatim (unmodified)",
  },
  cases: [],
  aggregate: null,
};

let sumBaselineFields = 0;
let sumVisionFields = 0;
let sumBaselineTopK = 0;
let sumVisionTopK = 0;
let selfRetrievalHits = 0;
let overlapCounts = [];

for (const c of cases) {
  // --- Baseline: text query through the rule-based parser ---
  const baseline = retrieveByText(c.textQuery, { limit: TOP_K });
  const baselineIntentFields = nonEmptyFields(baseline.intent);

  // --- Vision: the frozen real VisualIntent ---
  const visionResults = retrieveByIntent(c.visionIntent, { limit: TOP_K });
  const visionIntentFields = nonEmptyFields(c.visionIntent);

  const baselineIds = baseline.results.map((r) => r.artwork.id);
  const visionIds = visionResults.map((r) => r.artwork.id);
  const selfRank = visionIds.indexOf(c.visionIntentSource) + 1;
  if (selfRank > 0) selfRetrievalHits += 1;

  const shared = overlap(baselineIds, visionIds);
  overlapCounts.push(shared.length);

  sumBaselineFields += baselineIntentFields.length;
  sumVisionFields += visionIntentFields.length;
  sumBaselineTopK += baseline.results.length;
  sumVisionTopK += visionResults.length;

  report.cases.push({
    id: c.id,
    category: c.category,
    dimension: c.dimension,
    description: c.description,
    textQuery: c.textQuery,
    visionIntentSource: c.visionIntentSource,
    baseline: {
      parsedIntentFields: baselineIntentFields,
      parsedIntent: baseline.intent,
      resultCount: baseline.results.length,
      topK: topK(baseline.results),
    },
    vision: {
      intentFields: visionIntentFields,
      intent: c.visionIntent,
      resultCount: visionResults.length,
      topK: topK(visionResults),
      sourceArtworkRank: selfRank > 0 ? selfRank : null,
    },
    comparison: {
      topKOverlapIds: shared,
      topKOverlapCount: shared.length,
      fieldCountBaseline: baselineIntentFields.length,
      fieldCountVision: visionIntentFields.length,
    },
  });

  console.log(
    `${c.id} [${c.category}] overlap=${shared.length}/${TOP_K} baselineFields=${baselineIntentFields.length} visionFields=${visionIntentFields.length} baselineHits=${baseline.results.length} visionHits=${visionResults.length}${selfRank ? " selfRank=" + selfRank : ""}`
  );
}

const n = cases.length;
report.aggregate = {
  caseCount: n,
  avgBaselineIntentFields: +(sumBaselineFields / n).toFixed(1),
  avgVisionIntentFields: +(sumVisionFields / n).toFixed(1),
  avgBaselineResultCount: +(sumBaselineTopK / n).toFixed(1),
  avgVisionResultCount: +(sumVisionTopK / n).toFixed(1),
  avgTopKOverlap: +(overlapCounts.reduce((a, b) => a + b, 0) / n).toFixed(1),
  visionSelfRetrievalHits: `${selfRetrievalHits}/${n}`,
};

console.log("\nAGGREGATE", JSON.stringify(report.aggregate));

const outPath = path.join(__dirname, "evaluation-results.json");
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log("Wrote", outPath);
