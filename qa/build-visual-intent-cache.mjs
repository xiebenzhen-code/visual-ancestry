// Build the artwork VisualIntent cache (P3.1 / P3.2).
// Reuses the existing vision pipeline's REAL outputs — zero provider calls,
// zero new provider logic. Idempotent: safe to re-run after calibration grows.
// Output: src/data/visual-intents/artworks.json
//
// P3.2: emits a per-artwork generation status for the FULL curated pool
// (cached / pending / rejected + reason), so cache coverage is explicit.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const CALIBRATION = path.join(root, "qa", "vision-calibration-results.json");
const OUT_DIR = path.join(root, "src", "data", "visual-intents");
const OUT = path.join(OUT_DIR, "artworks.json");

const { artworks } = await import(pathToFileURL(path.join(root, "src", "data", "artworks.js")).href);
const pool = artworks.filter((a) => a.image && !a.imageUnavailable);

const calibration = JSON.parse(await readFile(CALIBRATION, "utf8"));
const records = calibration.results || [];

// Per-image latest (one intent per image).
const latest = new Map();
for (const rec of records) {
  const id = String(rec.image || "").split("/")[0];
  if (!id) continue;
  if (!latest.has(id) || rec.timestamp > latest.get(id).timestamp) latest.set(id, rec);
}

// Admission gate: HTTP 200 + schemaValid + 0 unknown enums.
const intents = {};
const status = {};
let cached = 0;
let rejected = 0;
let pending = 0;

for (const artwork of pool) {
  const rec = latest.get(artwork.id);
  if (!rec) {
    status[artwork.id] = { state: "pending", reason: "not-yet-calibrated", fallback: "rule" };
    pending += 1;
    continue;
  }
  const ok = rec.httpStatus === 200 && rec.schemaValid === true && (rec.unknownEnums || 0) === 0 && rec.visualIntent;
  if (!ok) {
    status[artwork.id] = {
      state: "rejected",
      reason: `http=${rec.httpStatus} schemaValid=${rec.schemaValid} unknownEnums=${rec.unknownEnums}`,
      fallback: "rule",
    };
    rejected += 1;
    continue;
  }
  intents[artwork.id] = {
    source: "vision",
    model: rec.model || calibration.model || "unknown",
    calibratedAt: rec.timestamp || null,
    intent: rec.visualIntent,
  };
  status[artwork.id] = { state: "cached", calibratedAt: rec.timestamp || null, latencyMs: rec.latencyMs ?? null };
  cached += 1;
}

const out = {
  meta: {
    phase: "P3.2 Artwork VisualIntent Expansion",
    generatedAt: new Date().toISOString(),
    provenance:
      "Frozen vision calibration runs (qa/vision-calibration-results.json) — REAL provider outputs " +
      "(HTTP 200, schemaValid, unknownEnums=0). Intents embedded verbatim.",
    pipeline: "existing vision pipeline reused; no provider calls made by this builder",
    admission: "httpStatus==200 && schemaValid==true && unknownEnums==0 && intent present",
    coverage: { pool: pool.length, cached, pending, rejected, complete: cached === pool.length },
    fallback: "artworks without a cached intent keep the rule-based intentFromArtwork() derivation",
  },
  status,
  intents,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log(`visual-intent cache: pool=${pool.length} cached=${cached} pending=${pending} rejected=${rejected} -> ${path.relative(root, OUT)}`);
if (pending) console.log("pending ids:", Object.entries(status).filter(([, s]) => s.state === "pending").map(([id]) => id).join(", "));
if (rejected) console.log("rejected ids:", Object.entries(status).filter(([, s]) => s.state === "rejected").map(([id]) => id).join(", "));
console.log(cached === pool.length ? "COVERAGE COMPLETE (49/49)" : `COVERAGE INCOMPLETE (${cached}/${pool.length})`);
