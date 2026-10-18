// P5.3.2 STEP 4 — profile stability across pool growth (20 / 50 / 100 slices).
// Read-only: aggregates the FIRST-N success memories (upload order) into
// profiles and compares the shares. Stability = continuous trend (small
// step-to-step deltas), NOT accuracy. With C unavailable the honest top
// slice is 70 (20/50/70), labelled as such.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STORE_DIR = path.join(ROOT, "work", "p5.3.2-stress", "store");
const OUT = path.join(ROOT, "work", "p5.3.2-stress", "profile-stability.json");
process.env.MEMORY_STORE_DIR = STORE_DIR;

const { aggregateVisualProfile } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "visualProfile.js")).href
);
const { listMemories } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
);

const METRICS = [
  ["spatial.deepSpace", (p) => p.spatial.deepSpace],
  ["spatial.environmentDominant", (p) => p.spatial.environmentDominant],
  ["spatial.negativeSpaceHigh", (p) => p.spatial.negativeSpaceHigh],
  ["composition.farCamera", (p) => p.composition.farCamera],
  ["composition.staticFrame", (p) => p.composition.staticFrame],
  ["color.lowSaturation", (p) => p.color.lowSaturation],
  ["color.highContrast", (p) => p.color.highContrast],
  ["narrative.isolation", (p) => p.narrative.isolation],
  ["narrative.socialDistanceHigh", (p) => p.narrative.socialDistanceHigh],
  ["narrative.melancholyMedium", (p) => p.narrative.melancholyMedium],
];

const all = (await listMemories()).filter(
  (m) => m.status === "success" && m.visualIntent && m.visualIntent.source !== "empty" && m.visualIntent.source !== "example"
);
all.sort((a, b) => String(a.metadata.createdAt).localeCompare(String(b.metadata.createdAt)));
console.log(`success pool: ${all.length}`);

// requested slices 20/50/100 — capped honestly at pool size
const sliceTargets = [20, 50, 100].map((n) => Math.min(n, all.length));
const uniq = [...new Set(sliceTargets)];

const slices = uniq.map((n) => ({ n, profile: aggregateVisualProfile(all.slice(0, n)) }));

// stability verdict per metric: |Δ| between consecutive slices ≤ 0.15 = stable
const series = {};
const verdicts = {};
for (const [name, get] of METRICS) {
  series[name] = {};
  for (const { n, profile } of slices) {
    const s = get(profile);
    series[name][n] = { count: s.count, ratio: s.ratio };
  }
  const ratios = slices.map(({ n }) => series[name][n].ratio);
  let maxDelta = 0;
  for (let i = 1; i < ratios.length; i++) maxDelta = Math.max(maxDelta, Math.abs(ratios[i] - ratios[i - 1]));
  verdicts[name] = {
    series: ratios.join(" → "),
    maxStepDelta: Number(maxDelta.toFixed(2)),
    verdict: maxDelta <= 0.15 ? "stable" : (maxDelta <= 0.3 ? "shifting" : "unstable"),
  };
}

const out = {
  note: "P5.3.2 STEP 4 profile stability — slices by upload order; stability = continuous trend",
  poolSize: all.length,
  slices: uniq,
  sliceCapNote: uniq[uniq.length - 1] < 100 ? `C 类不可得 → 池上限 ${all.length}，100 张切片诚实降级为 ${all.length}` : null,
  confidencePerSlice: Object.fromEntries(slices.map(({ n, profile }) => [n, profile.confidence.level])),
  series,
  verdicts,
};
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`slices: ${uniq.join("/")} · confidence: ${Object.values(out.confidencePerSlice).join("/")}`);
for (const [name, v] of Object.entries(verdicts)) {
  console.log(`  ${name.padEnd(30)} ${v.series}  ${v.verdict} (maxΔ ${v.maxStepDelta})`);
}
console.log(`→ ${OUT}`);
