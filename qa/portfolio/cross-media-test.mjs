// P5.4 STEP 4 — cross-media showcase: film stills × paintings in ONE visual
// language space (the product's core story, validated for the portfolio).
// Read-only over the 40-asset stress pool. Schema-real tokens only.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STORE_DIR = path.join(ROOT, "work", "p5.3.2-stress", "store");
const OUT = path.join(ROOT, "work", "portfolio-validation", "cross-media-results.json");
process.env.MEMORY_STORE_DIR = STORE_DIR;

const { retrieveVisualMemory } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
);

const TESTS = [
  {
    id: "test1",
    theme: "孤独人物 + 巨大环境",
    story: "一个孤独的人站在巨大环境中",
    query: { atmosphere: ["寂静"], spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high", humanRelation: "isolated" },
    commonReasonsExpected: ["环境压过人物", "纵深很深", "留白很大", "人和环境之间距离很远"],
  },
  {
    id: "test2",
    theme: "低饱和工业空间",
    story: "工业感、低饱和、人造结构的压迫画面",
    query: { saturation: "low", environmentDominance: "high", contrast: "high", visualDensity: "dense" },
    commonReasonsExpected: ["饱和度偏低", "环境压过人物", "对比强烈"],
  },
  {
    id: "test3",
    theme: "人物与环境关系",
    story: "人和环境之间距离很远的构图",
    query: { humanRelation: "isolated", socialDistance: "high", spatialDepth: "deep", environmentDominance: "high" },
    commonReasonsExpected: ["人和环境之间距离很远", "环境压过人物", "纵深很深"],
  },
];

const out = [];
for (const t of TESTS) {
  const hits = await retrieveVisualMemory(t.query, { limit: 5 });
  const items = hits.map((r) => ({
    id: r.id,
    title: r.memory.metadata.title,
    medium: r.memory.metadata.origin === "film-still" ? "film" : "painting",
    score: Number(r.score.toFixed(1)),
    matchedFields: r.matchedFields,
    reasons: r.reasons,
  }));
  const filmN = items.filter((i) => i.medium === "film").length;
  const paintN = items.filter((i) => i.medium === "painting").length;
  const shared = t.commonReasonsExpected.filter((cr) => items.some((i) => i.reasons.some((r) => r.includes(cr))));
  out.push({
    ...t,
    results: items,
    crossMedia: { film: filmN, painting: paintN, mixed: filmN > 0 && paintN > 0 },
    sharedEvidence: shared,
    showcaseReady: null, // reviewer verdict below
  });
  console.log(`[${t.id}] ${t.theme} → film ${filmN} / painting ${paintN} · shared: ${shared.join(" · ")}`);
  for (const i of items) console.log(`   ${i.medium.padEnd(8)} ${i.title} ${i.score} · ${i.reasons.join(" / ")}`);
}

// reviewer verdict
for (const t of out) {
  t.showcaseReady = t.crossMedia.mixed && t.sharedEvidence.length >= 2
    ? "READY — 跨媒介混排且共享 ≥2 条视觉语言证据"
    : (t.crossMedia.mixed ? "PARTIAL — 混排但共享证据不足" : "SINGLE-MEDIUM — 未跨媒介（池构成限制，如实展示）");
}
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
const ready = out.filter((t) => t.showcaseReady.startsWith("READY")).length;
console.log(`\nshowcase READY: ${ready}/3 → ${OUT}`);
