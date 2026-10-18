// P5.2.1 STEP 7 — real product validation on the P5.1.8 pool (20 success
// memories). Three visual-language queries; records top-5 with score /
// matchedFields / reasons — NOT just top-1. Zero provider calls (pure local
// personal-pool retrieval). Results → work/p5.2.1-retrieval-results.json.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STORE_DIR = path.join(ROOT, "work", "p5.1.8-store");
process.env.MEMORY_STORE_DIR = STORE_DIR;

// 查询 → VisualQuery（schema 真实 token：atmosphere/emotion 中文列表，
// 标量字段英文枚举）。映射自用户指令 STEP 7。
const QUERIES = [
  {
    name: "Q1 孤独城市空间",
    note: "孤立 / 深空间 / 低饱和 / 环境主体",
    query: { humanRelation: "isolated", socialDistance: "high", spatialDepth: "deep", saturation: "low", environmentDominance: "high" },
  },
  {
    name: "Q2 低饱和夜景",
    note: "夜晚 / 冷色 / 低饱和",
    query: { atmosphere: ["夜晚"], colorTemperature: "cool", saturation: "low" },
  },
  {
    name: "Q3 空旷自然环境",
    note: "空旷 / 自然 / 大空间",
    query: { atmosphere: ["空旷"], subject: "place", environmentDominance: "high", spatialDepth: "deep", negativeSpace: "high" },
  },
];

async function run() {
  await mkdir(STORE_DIR, { recursive: true });
  const { retrieveVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
  );

  const all = [];
  for (const { name, note, query } of QUERIES) {
    const results = await retrieveVisualMemory(query, { limit: 5 });
    all.push({
      queryName: name,
      queryNote: note,
      query,
      totalResults: results.length,
      top5: results.map((r) => ({
        id: r.id,
        title: r.memory.metadata.title || "",
        origin: r.memory.metadata.origin || "",
        score: r.score,
        possible: r.possible,
        matchedFields: r.matchedFields,
        reasons: r.reasons,
      })),
    });
    console.log(`\n== ${name}（${note}）==`);
    console.log(`结果 ${results.length} 条`);
    for (const r of results) {
      console.log(`  #${r.score.toFixed(1)} ${r.id} 「${r.memory.metadata.title}」(${r.memory.metadata.origin})`);
      console.log(`      matched: ${r.matchedFields.join(", ") || "—"}`);
      console.log(`      reasons: ${r.reasons.join(" · ")}`);
    }
  }

  await writeFile(path.join(ROOT, "work", "p5.2.1-retrieval-results.json"), JSON.stringify({ pool: "work/p5.1.8-store (20 success)", queries: all }, null, 2) + "\n", "utf8");
  console.log("\n结果已写入 work/p5.2.1-retrieval-results.json");
}

run().catch((e) => { console.error(e); process.exit(1); });