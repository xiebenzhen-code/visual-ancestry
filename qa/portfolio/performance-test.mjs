// P5.4 STEP 3 — performance validation: local-first latency at current scale.
// Read-only over the 40-asset stress pool: archive read / retrieval query /
// profile aggregation, 5 iterations each (report min/avg). Zero provider.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STORE_DIR = path.join(ROOT, "work", "p5.3.2-stress", "store");
const OUT = path.join(ROOT, "work", "portfolio-validation", "performance.json");
process.env.MEMORY_STORE_DIR = STORE_DIR;

const { listMemories } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
);
const { retrieveVisualMemory } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
);
const { buildVisualProfile } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "visualProfile.js")).href
);

const N = 5;
const stat = (xs) => ({ min: Math.min(...xs), avg: Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2)) });

// warm-up + archive read
await listMemories();
const archiveXs = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  const all = await listMemories();
  archiveXs.push(Number((performance.now() - t).toFixed(2)));
  var poolSize = all.length;
}

// retrieval query
const QUERY = { atmosphere: ["寂静"], spatialDepth: "deep", saturation: "low", environmentDominance: "high", humanRelation: "isolated" };
await retrieveVisualMemory(QUERY, { limit: 5 });
const searchXs = [];
let searchHits = 0;
for (let i = 0; i < N; i++) {
  const t = performance.now();
  const hits = await retrieveVisualMemory(QUERY, { limit: 5 });
  searchXs.push(Number((performance.now() - t).toFixed(2)));
  searchHits = hits.length;
}

// profile aggregation
await buildVisualProfile();
const profileXs = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  const p = await buildVisualProfile();
  profileXs.push(Number((performance.now() - t).toFixed(2)));
  var profSample = p.sampleSize;
}

const out = {
  note: "P5.4 STEP 3 local-first latency (node, file-backed store, 5 iterations)",
  assets: poolSize,
  archiveMs: stat(archiveXs),
  searchMs: stat(searchXs),
  profileMs: stat(profileXs),
  searchHits,
  profileSampleSize: profSample,
  verdict: null, // filled below
};
// local-first target: everything well under interactive thresholds
const allAvg = [out.archiveMs.avg, out.searchMs.avg, out.profileMs.avg];
out.verdict = allAvg.every((x) => x < 50) ? "PASS (<50ms interactive threshold)" : "REVIEW";
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`assets=${out.assets} · archive ${JSON.stringify(out.archiveMs)}ms · search ${JSON.stringify(out.searchMs)}ms · profile ${JSON.stringify(out.profileMs)}ms`);
console.log(`verdict: ${out.verdict} → ${OUT}`);
