// P3.1 Evaluation v2 — candidate alignment A/B against the frozen P3 (V1) results.
// All groups use the SAME frozen vision query intents (no provider calls):
//   V1  (historical, from evaluation-results.json): query vision + candidate rule + no subject weight
//   V2a (this run, isolates the scoring change):  query vision + candidate rule + subject 1.5
//   V2b (this run, full P3.1):                     query vision + candidate vision-cache-first + subject 1.5
// Writes evaluation-results-v2.json.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

const { retrieveByIntent } = await import(
  pathToFileURL(path.join(root, "src", "services", "retrieval", "retrievalService.js")).href
);

const TOP_K = 8;
const cases = JSON.parse(await readFile(path.join(__dirname, "cases.json"), "utf8")).cases;
const v1 = JSON.parse(await readFile(path.join(__dirname, "evaluation-results.json"), "utf8"));

const ids = (results) => results.map((r) => r.artwork.id);
const overlap = (a, b) => {
  const sb = new Set(b);
  return a.filter((x) => sb.has(x));
};

function summarize(results, caseItem, sourceId) {
  const resultIds = ids(results);
  const selfRank = resultIds.indexOf(sourceId) + 1;
  return {
    resultCount: results.length,
    topK: results.slice(0, TOP_K).map((item, index) => ({
      rank: index + 1,
      artworkId: item.artwork.id,
      title: item.artwork.title,
      retrievalScore: item.retrievalScore,
      reasons: item.reasons,
      candidateIntentSource: item.intent && item.intent.source === "vision" ? "vision" : "rule",
    })),
    selfRank: selfRank || null,
  };
}

const report = {
  meta: {
    phase: "P3.1 Visual Retrieval Alignment",
    ranAt: new Date().toISOString(),
    topK: TOP_K,
    groups: {
      v1: "query vision + candidate rule + no subject weight (frozen P3 results, unchanged)",
      v2a: "query vision + candidate rule + subject weight 1.5 (isolates the scoring change)",
      v2b: "query vision + candidate vision-cache-first + subject weight 1.5 (full P3.1)",
    },
    cacheCoverage: "10/49 curated artworks have a frozen REAL vision intent; the rest fall back to rules",
    providerCalls: 0,
  },
  cases: [],
  aggregate: { v1: null, v2a: null, v2b: null },
};

function aggInit() {
  return { results: 0, selfHits: 0, selfRanks: [], overlapV1: [] };
}

const aggs = { v2a: aggInit(), v2b: aggInit() };
// V1 aggregate straight from the frozen file:
const v1Self = v1.cases.filter((c) => c.vision.sourceArtworkRank).map((c) => c.vision.sourceArtworkRank);
report.aggregate.v1 = {
  avgResultCount: v1.aggregate.avgVisionResultCount,
  selfRetrievalHits: `${v1Self.length}/${v1.cases.length}`,
  selfRanks: v1Self,
  note: "frozen P3 numbers (candidate rule, no subject weight)",
};

for (const c of cases) {
  const v2aResults = retrieveByIntent(c.visionIntent, { limit: TOP_K, intentSource: "rule" });
  const v2bResults = retrieveByIntent(c.visionIntent, { limit: TOP_K, intentSource: "auto" });

  const v1Case = v1.cases.find((x) => x.id === c.id);
  const v1Ids = v1Case ? v1Case.vision.topK.map((t) => t.artworkId) : [];

  const v2aS = summarize(v2aResults, c, c.visionIntentSource);
  const v2bS = summarize(v2bResults, c, c.visionIntentSource);

  for (const [key, s] of [["v2a", v2aS], ["v2b", v2bS]]) {
    aggs[key].results += s.resultCount;
    if (s.selfRank) {
      aggs[key].selfHits += 1;
      aggs[key].selfRanks.push(s.selfRank);
    }
    aggs[key].overlapV1.push(overlap(ids(s.topK.map((t) => ({ artwork: { id: t.artworkId } }))), v1Ids).length);
  }

  report.cases.push({
    id: c.id,
    category: c.category,
    dimension: c.dimension,
    textQuery: c.textQuery,
    visionIntentSource: c.visionIntentSource,
    v1: v1Case
      ? { selfRank: v1Case.vision.sourceArtworkRank || null, resultCount: v1Case.vision.resultCount, topIds: v1Ids }
      : null,
    v2a: v2aS,
    v2b: v2bS,
    overlap: {
      v2aVsV1: overlap(v2aS.topK.map((t) => t.artworkId), v1Ids).length,
      v2bVsV1: overlap(v2bS.topK.map((t) => t.artworkId), v1Ids).length,
    },
  });

  console.log(
    `${c.id} [${c.category}] src=${c.visionIntentSource} | V1 self=${v1Case && v1Case.vision.sourceArtworkRank ? v1Case.vision.sourceArtworkRank : "MISS"} n=${v1Case ? v1Case.vision.resultCount : "-"} | V2a self=${v2aS.selfRank || "MISS"} n=${v2aS.resultCount} | V2b self=${v2bS.selfRank || "MISS"} n=${v2bS.resultCount} | V2b top1=${v2bS.topK[0] ? v2bS.topK[0].artworkId : "-"}(${v2bS.topK[0] ? v2bS.topK[0].retrievalScore : "-"})`
  );
}

const n = cases.length;
report.aggregate.v2a = {
  avgResultCount: +(aggs.v2a.results / n).toFixed(1),
  selfRetrievalHits: `${aggs.v2a.selfHits}/${n}`,
  selfRanks: aggs.v2a.selfRanks,
  avgOverlapWithV1: +(aggs.v2a.overlapV1.reduce((a, b) => a + b, 0) / n).toFixed(1),
};
report.aggregate.v2b = {
  avgResultCount: +(aggs.v2b.results / n).toFixed(1),
  selfRetrievalHits: `${aggs.v2b.selfHits}/${n}`,
  selfRanks: aggs.v2b.selfRanks,
  avgOverlapWithV1: +(aggs.v2b.overlapV1.reduce((a, b) => a + b, 0) / n).toFixed(1),
};

console.log("\nV1 (frozen):", JSON.stringify(report.aggregate.v1));
console.log("V2a:", JSON.stringify(report.aggregate.v2a));
console.log("V2b:", JSON.stringify(report.aggregate.v2b));

await writeFile(path.join(__dirname, "evaluation-results-v2.json"), JSON.stringify(report, null, 2));
console.log("Wrote evaluation-results-v2.json");
