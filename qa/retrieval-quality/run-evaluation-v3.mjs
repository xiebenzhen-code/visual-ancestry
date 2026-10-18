// P3.2 Evaluation v3 — three-way comparison, all on the same frozen vision queries.
//   V1 = frozen P3      : query vision + candidate rule      + no subject weight
//   V2 = frozen P3.1    : query vision + candidate cache(10) + subject weight
//   V3 = live P3.2 run  : query vision + candidate cache(current coverage) + subject weight
// V3 reads the live cache, so its numbers reflect the cache coverage at run time
// (10/49 today; 49/49 after the remaining 39 artworks are calibrated).
// Writes evaluation-results-v3.json
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
const v1File = JSON.parse(await readFile(path.join(__dirname, "evaluation-results.json"), "utf8"));
const v2File = JSON.parse(await readFile(path.join(__dirname, "evaluation-results-v2.json"), "utf8"));
const cache = JSON.parse(await readFile(path.join(root, "src", "data", "visual-intents", "artworks.json"), "utf8"));
const coverage = cache.meta.coverage;
const cachedIds = new Set(Object.keys(cache.intents));

const overlap = (a, b) => {
  const sb = new Set(b);
  return a.filter((x) => sb.has(x));
};

const report = {
  meta: {
    phase: "P3.2 Artwork VisualIntent Expansion",
    ranAt: new Date().toISOString(),
    topK: TOP_K,
    cacheCoverage: coverage,
    expansionStatus: coverage.complete ? "COMPLETE (49/49)" : `PENDING (${coverage.cached}/${coverage.pool})`,
    groups: {
      v1: "query vision + candidate rule + no subject weight (frozen P3 results)",
      v2: "query vision + candidate cache (10) + subject weight (frozen P3.1 results)",
      v3: `query vision + candidate cache (${coverage.cached}) + subject weight (live run)`,
    },
    providerCalls: 0,
  },
  cases: [],
  aggregate: {},
};

let v3SelfHits = 0;
let v3VisionCandidateEntries = 0;
let v3RuleCandidateEntries = 0;
let v2VisionCandidateEntries = 0;
const v3Scores = [];

for (const c of cases) {
  const results = retrieveByIntent(c.visionIntent, { limit: TOP_K, intentSource: "auto" });
  const topK = results.map((item, index) => ({
    rank: index + 1,
    artworkId: item.artwork.id,
    title: item.artwork.title,
    retrievalScore: item.retrievalScore,
    reasons: item.reasons,
    candidateIntentSource: item.intent && item.intent.source === "vision" ? "vision" : "rule",
  }));
  const ids = topK.map((t) => t.artworkId);
  const selfRank = ids.indexOf(c.visionIntentSource) + 1;
  if (selfRank) v3SelfHits += 1;
  for (const t of topK) {
    if (t.candidateIntentSource === "vision") v3VisionCandidateEntries += 1;
    else v3RuleCandidateEntries += 1;
    v3Scores.push(t.retrievalScore);
  }

  const v1Case = v1File.cases.find((x) => x.id === c.id);
  const v2Case = v2File.cases.find((x) => x.id === c.id);
  const v1Ids = v1Case ? v1Case.vision.topK.map((t) => t.artworkId) : [];
  const v2TopK = v2Case ? v2Case.v2b.topK : [];
  const v2Ids = v2TopK.map((t) => t.artworkId);
  for (const t of v2TopK) if (t.candidateIntentSource === "vision") v2VisionCandidateEntries += 1;

  report.cases.push({
    id: c.id,
    category: c.category,
    visionIntentSource: c.visionIntentSource,
    v1: { selfRank: v1Case ? v1Case.vision.sourceArtworkRank || null : null, topIds: v1Ids },
    v2: { selfRank: v2Case ? v2Case.v2b.selfRank : null, topIds: v2Ids },
    v3: { selfRank: selfRank || null, resultCount: results.length, topK },
    overlap: {
      v3VsV1: overlap(ids, v1Ids).length,
      v3VsV2: overlap(ids, v2Ids).length,
    },
    cachedArtworksInV3Top: ids.filter((id) => cachedIds.has(id)).length,
  });

  console.log(
    `${c.id} [${c.category}] src=${c.visionIntentSource} | V1 self=${v1Case && v1Case.vision.sourceArtworkRank ? v1Case.vision.sourceArtworkRank : "MISS"} | V2 self=${v2Case ? v2Case.v2b.selfRank || "MISS" : "-"} | V3 self=${selfRank || "MISS"} | V3 top1=${ids[0]}(${topK[0].retrievalScore}) | cached in V3 top8=${ids.filter((id) => cachedIds.has(id)).length}`
  );
}

const n = cases.length;
const v1Self = v1File.cases.filter((c) => c.vision.sourceArtworkRank).length;
const v2Self = v2File.cases.filter((c) => c.v2b && c.v2b.selfRank).length;

report.aggregate = {
  v1: { selfRetrievalHits: `${v1Self}/${n}`, note: "frozen P3 (candidate rule, no subject weight)" },
  v2: {
    selfRetrievalHits: `${v2Self}/${n}`,
    visionCandidateEntriesInTopK: `${v2VisionCandidateEntries}/${n * TOP_K}`,
    note: "frozen P3.1 (candidate cache 10)",
  },
  v3: {
    selfRetrievalHits: `${v3SelfHits}/${n}`,
    visionCandidateEntriesInTopK: `${v3VisionCandidateEntries}/${n * TOP_K}`,
    ruleCandidateEntriesInTopK: `${v3RuleCandidateEntries}/${n * TOP_K}`,
    avgScore: +(v3Scores.reduce((a, b) => a + b, 0) / v3Scores.length).toFixed(1),
    note: `live run with cache ${coverage.cached}/${coverage.pool}`,
  },
};

console.log("\nAGGREGATE", JSON.stringify(report.aggregate, null, 2));
await writeFile(path.join(__dirname, "evaluation-results-v3.json"), JSON.stringify(report, null, 2));
console.log("Wrote evaluation-results-v3.json", coverage.complete ? "(COMPLETE)" : "(PENDING EXPANSION)");
