// P5.3.2 STEP 3 — cross-media retrieval validation (film × painting × shan-shui).
// 5 creative tasks. Two instruction pseudotokens do NOT exist in the frozen
// schema and are honestly mapped (noted per case):
//   environmentDominance:true → "high" (enum)
//   humanRelation:"distant"  → isolated + socialDistance:"high" (no "distant")
//   Case 4 梦境/超现实 has NO schema token → honest mappable subset + note.
// Output is RELATION + EVIDENCE per case — not an accuracy number.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STORE_DIR = path.join(ROOT, "work", "p5.3.2-stress", "store");
const OUT = path.join(ROOT, "work", "p5.3.2-stress", "cross-media-results.json");
process.env.MEMORY_STORE_DIR = STORE_DIR;

const { retrieveVisualMemory } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
);

const CASES = [
  {
    id: "case1",
    task: "一个孤独的人站在巨大环境中",
    instructionQuery: { atmosphere: ["寂静"], spatialDepth: "deep", environmentDominance: true },
    mappingNote: "environmentDominance:true 不存在于 schema（枚举 high/low）→ 映射为 high",
    query: { atmosphere: ["寂静"], spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high", humanRelation: "isolated" },
  },
  {
    id: "case2",
    task: "老工业城市夜晚",
    instructionQuery: { colorTemperature: "cool", saturation: "low", atmosphere: ["夜晚"] },
    mappingNote: "全部为 schema 真实 token，直接使用",
    query: { colorTemperature: "cool", saturation: "low", atmosphere: ["夜晚", "阴郁"] },
  },
  {
    id: "case3",
    task: "人物被空间压迫",
    instructionQuery: { humanRelation: "distant", environmentDominance: true },
    mappingNote: "humanRelation 无 distant 枚举（isolated/together/crowd）→ 映射为 isolated + socialDistance high；environmentDominance:true → high",
    query: { humanRelation: "isolated", socialDistance: "high", environmentDominance: "high", spatialDepth: "deep" },
  },
  {
    id: "case4",
    task: "梦境/超现实空间",
    instructionQuery: "(未给出 query)",
    mappingNote: "schema 无 梦境/超现实 token（ATMOSPHERE_TOKENS 只有 空旷/寂静/夜晚/雾/热闹/阴郁）→ 诚实用可映射子集（雾+空旷+低饱和+大留白），并记录部分语义不可表达",
    query: { atmosphere: ["雾", "空旷"], saturation: "low", negativeSpace: "high", motion: "still" },
  },
  {
    id: "case5",
    task: "温暖日常空间",
    instructionQuery: "(未给出 query)",
    mappingNote: "无直接枚举「日常」→ 可映射子集：暖色+漫射光+相伴人物",
    query: { colorTemperature: "warm", lightQuality: "diffuse", humanRelation: "together", arousal: "low" },
  },
];

const out = [];
for (const c of CASES) {
  const { query, ...rest } = c;
  const results = await retrieveVisualMemory(query, { limit: 5 });
  const cats = results.map((r) => {
    const m = r.memory;
    return { id: r.id, title: m.metadata.title, category: (m.userData && m.userData.note || "").includes("film-still") ? "film" : (m.metadata.origin === "film-still" ? "film" : "art"), score: Number(r.score.toFixed(1)), reasons: r.reasons };
  });
  const filmN = cats.filter((c2) => c2.category === "film").length;
  const artN = cats.filter((c2) => c2.category === "art").length;
  out.push({
    ...rest,
    topResults: cats,
    crossMedia: { film: filmN, art: artN },
    relation: "", // reviewer fills: does film × painting share the visual space?
    evidence: [], // reviewer fills e.g. ["deep space", "environment dominance"]
  });
  console.log(`[${c.id}] ${c.task} → ${results.length} 条 (film ${filmN} / art ${artN})`);
  for (const r of cats) console.log(`   ${r.id} [${r.category}] ${r.title} ${r.score} · ${r.reasons.join(" / ")}`);
}

await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`\nraw → ${OUT}（relation/evidence 由评审填充）`);
