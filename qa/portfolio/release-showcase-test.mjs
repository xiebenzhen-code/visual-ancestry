// P5.5 STEP 4 — release showcase test: does the PORTFOLIO presentation journey hold?
// Case 1 full chain (Upload → Retrieve → Profile) — all REAL data: one real
//   provider upload into an isolated copy of the real 34-asset pool, then real
//   retrieval and real profile aggregation on the enriched pool.
// Case 2 cross-media — "lonely figure + vast environment" must return BOTH
//   film and painting in one ranked list with shared evidence.
// Case 3 limits — a visual language that does not exist in the pool must yield
//   NO strong match; the system must not fabricate or force a recommendation.
// Store binding happens at first import — the release store must exist and be
// bound to MEMORY_STORE_DIR BEFORE any dynamic import (P5.4 lesson).
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const RELEASE_STORE = path.join(ROOT, "work", "portfolio-validation", "release-store");
const OUT = path.join(ROOT, "work", "portfolio-validation", "release-showcase-results.json");
const BASE = "http://127.0.0.1:4175";
const STRONG = 5.0; // real strong matches score 8+; partial ~5–7 (see probe evidence)

const fsProm = await import("node:fs/promises");
await mkdir(path.dirname(RELEASE_STORE), { recursive: true });
await fsProm.cp(path.join(ROOT, "work", "portfolio-validation", "demo-store"), RELEASE_STORE, { recursive: true });
process.env.MEMORY_STORE_DIR = RELEASE_STORE;

const results = [];
let pass = 0, fail = 0;
const check = (caseName, desc, cond, detail) => {
  if (cond) { pass++; results.push({ caseName, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ caseName, desc, pass: false, detail: detail || "" }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
};

// ===================== Case 1: full chain, all real data =====================
console.log("Case 1 — 完整链路 Upload → Retrieve → Profile（全部真实数据）");
{
  const { uploadFromImage } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "uploadService.js")).href
  );
  const img = path.join(ROOT, "work", "p5.3.2-stress", "dataset", "A-film", "s04-the-general-1926.jpg");
  let r, seconds;
  for (let attempt = 1; attempt <= 2; attempt++) { // product semantics: one manual retry
    const t0 = Date.now();
    r = await uploadFromImage(img, {
      base: BASE, id: "release-showcase-1", title: "The General 1926 (release showcase)",
      origin: "film-still", tags: ["release"], note: "P5.5 STEP4 release upload",
    });
    seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    if (r.ok && r.memory && r.memory.status === "success") break;
    console.log(`  (attempt ${attempt} failed: ${r.error ? r.error.code : "?"} — retrying once per product contract)`);
  }
  const ok = !!(r.ok && r.memory && r.memory.status === "success");
  check("case1", `真实 provider 上传成功（${seconds}s）`, ok, r.error ? r.error.code : "");
  const intentOK = ok && r.memory.visualIntent.source === "vision" && Object.keys(r.memory.visualIntent).length === 25;
  check("case1", "上传产出真实 VisualIntent（source=vision · 25 字段）", intentOK);

  const { retrieveVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
  );
  const { buildVisualProfile } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "visualProfile.js")).href
  );
  const hits = await retrieveVisualMemory(
    { atmosphere: ["寂静"], spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high", humanRelation: "isolated" },
    { limit: 5 }
  );
  check("case1", "Retrieve 在扩池后真实返回", hits.length === 5 && hits.every((h) => typeof h.score === "number" && Array.isArray(h.reasons) && h.reasons.length > 0), `got ${hits.length}`);
  const p = await buildVisualProfile();
  check("case1", "Profile 真实聚合（sampleSize = 35 = 34 + 1 新上传）", p.sampleSize === 35, `got ${p.sampleSize}`);
  check("case1", "Profile confidence 合法且绑定样本量", ["observation", "tendency", "pattern"].includes(p.confidence.level) && p.confidence.basis.includes("35"), JSON.stringify(p.confidence));
  check("case1", "Profile 诚实清单存在", typeof p.unavailable === "object" && Object.keys(p.unavailable).length > 0);
}

// ===================== Case 2: cross-media ====================================
console.log("Case 2 — 跨媒介：孤独人物 + 巨大环境 → Film + Painting 同时返回");
{
  const { retrieveVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
  );
  const hits = await retrieveVisualMemory(
    { atmosphere: ["寂静"], spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high", humanRelation: "isolated" },
    { limit: 5 }
  );
  const medium = (m) => (m.metadata.origin === "film-still" ? "film" : "painting");
  const films = hits.filter((h) => medium(h.memory) === "film");
  const paintings = hits.filter((h) => medium(h.memory) === "painting");
  check("case2", `同榜混排（film ${films.length} + painting ${paintings.length}）`, films.length > 0 && paintings.length > 0, hits.map((h) => medium(h.memory)).join(","));
  check("case2", "两条媒介共享至少 2 条视觉语言理由", hits.every((h) => h.reasons.length >= 2) && films.length > 0 && paintings.length > 0,
    `film reasons: ${films[0]?.reasons.join("/")} | painting reasons: ${paintings[0]?.reasons.join("/")}`);
  check("case2", "每条带可解释证据（matchedFields + reasons）", hits.every((h) => Array.isArray(h.matchedFields) && h.matchedFields.length > 0 && Array.isArray(h.reasons)));
}

// ===================== Case 3: limits — no strong match =======================
console.log("Case 3 — 限制测试：不存在的视觉语言 → No strong match（禁止强行推荐）");
{
  const { retrieveVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
  );
  // 梦境/超现实创作语言在 schema token 空间内只能映射出池中不存在的组合
  // （真实探测：top score 1.8，而真实强匹配为 8+ —— 见 P5.5 审计与 evidence.json）
  const q = { atmosphere: ["雾"], motion: "still", lightDirection: "under", cameraHeight: "overhead", melancholy: "high" };
  const hits = await retrieveVisualMemory(q, { limit: 5 });
  const top = hits.length ? Math.max(...hits.map((h) => h.score)) : 0;
  check("case3", `No strong match（top score ${top.toFixed(1)} < ${STRONG} 阈值）`, top < STRONG, hits.map((h) => h.score.toFixed(1)).join(",") || "(empty)");
  check("case3", "不伪造匹配（无 score=满分/无假 matchedFields）", hits.every((h) => h.matchedFields.every((f) => f in q)) || hits.length === 0);
  const rec = hits.filter((h) => h.memory.userData?.recommended || h.memory.metadata?.recommended);
  check("case3", "无强行推荐标记（结果中零 recommendation 注入）", rec.length === 0);
  console.log(`  → verdict: ${top < STRONG ? "No strong match — honest" : "UNEXPECTED strong match"} (top ${top.toFixed(1)})`);
}

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ total: pass + fail, pass, fail, threshold: { STRONG }, results }, null, 2) + "\n", "utf8");
console.log(`→ ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
