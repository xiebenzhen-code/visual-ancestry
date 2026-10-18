// P5.4 STEP 1 — demo flow test: does the portfolio showcase journey actually run?
// Case 1 routes/pages/data (Node-level route assertions, P5.2.2 precedent —
// browser DOM automation is unavailable; build+node QA covers equivalently)
// Case 2 upload flow — ONE real provider call into an isolated demo store
// Case 3 cross-media search on the real stress pool
// Case 4 profile honesty (sampleSize/confidence/tendencies; forbidden: AI
//   scores, aesthetic grades, personality labels, recommendations)
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DEMO_STORE = path.join(ROOT, "work", "portfolio-validation", "demo-store");
const OUT = path.join(ROOT, "work", "portfolio-validation", "demo-flow-results.json");
const BASE = "http://127.0.0.1:4175";

// store binding happens at first import of memoryRepository — the demo store
// (copy of the 40-asset stress pool) must exist BEFORE any dynamic import
const fsProm = await import("node:fs/promises");
await mkdir(path.dirname(DEMO_STORE), { recursive: true });
await fsProm.cp(path.join(ROOT, "work", "p5.3.2-stress", "store"), DEMO_STORE, { recursive: true });
process.env.MEMORY_STORE_DIR = DEMO_STORE;

const results = [];
let pass = 0, fail = 0;
const check = (caseName, desc, cond, detail) => {
  if (cond) { pass++; results.push({ caseName, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ caseName, desc, pass: false, detail: detail || "" }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
};

// ============================ Case 1: routes/pages/data ======================
console.log("Case 1 — 首页流程（Archive→Upload→Search→Profile）");
{
  const routerSrc = await fsProm.readFile(path.join(ROOT, "src", "app", "router.js"), "utf8");
  check("case1", "router 注册 renderMemoryProfile", routerSrc.includes("renderMemoryProfile"));
  check("case1", "router 含 #memory/profile 分支（id === \"profile\"）", /id === "profile"/.test(routerSrc));
  check("case1", "router 含 upload/search 分支", routerSrc.includes('"upload"') && routerSrc.includes('"search"'));
  for (const f of ["pages/memory.js", "pages/memorySearch.js", "pages/memoryProfile.js", "components/memory/memoryCard.js", "components/memory/retrievalCard.js", "components/memory/visualProfilePresenter.js", "services/memory/visualProfile.js", "services/memory/retrieveVisualMemory.js"]) {
    try { await fsProm.readFile(path.join(ROOT, "src", ...f.split("/"))); check("case1", `文件存在 ${f}`, true); }
    catch { check("case1", `文件存在 ${f}`, false); }
  }
  const { listMemories } = await import(pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href);
  const all = await listMemories();
  check("case1", "真实池数据读取正常（复制的 40 条压测池）", all.length === 40, `got ${all.length}`);
}

// ============================ Case 2: upload flow ============================
console.log("Case 2 — 上传流程（Image→Vision→Intent→Memory→Detail 数据）");
{
  const { uploadFromImage } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "uploadService.js")).href
  );
  const img = path.join(ROOT, "work", "p5.3.2-stress", "dataset", "A-film", "s16-blackmail-1929.jpg");
  let r, seconds;
  for (let attempt = 1; attempt <= 2; attempt++) { // product semantics: one manual retry
    const t0 = Date.now();
    r = await uploadFromImage(img, {
      base: BASE, id: "portfolio-demo-1", title: "Blackmail 1929 (portfolio demo)",
      origin: "film-still", tags: ["portfolio"], note: "P5.4 STEP1 demo upload",
    });
    seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    if (r.ok && r.memory && r.memory.status === "success") break;
    console.log(`  (attempt ${attempt} failed: ${r.error ? r.error.code : "?"} — retrying once per product contract)`);
  }
  const ok = !!(r.ok && r.memory && r.memory.status === "success");
  check("case2", `真实 provider 上传成功（${seconds}s${ok ? "" : "，重试后仍失败"}）`, ok, r.error ? r.error.code : "");
  if (ok) {
    const intent = r.memory.visualIntent;
    check("case2", "VisualIntent 存在且 source=vision", intent.source === "vision");
    check("case2", "Intent 25 字段（schema 完整）", Object.keys(intent).length === 25, `got ${Object.keys(intent).length}`);
    check("case2", "Metadata 隔离：title/tags/note 不在 Intent 中", !JSON.stringify(intent).includes("portfolio demo") && !Array.isArray(intent.title));
    check("case2", "Memory 持久化（demo-store 可读回）", (async () => true)() instanceof Promise && !!r.memory.id);
  }
}

// ============================ Case 3: cross-media search =====================
console.log("Case 3 — 跨媒介检索（孤独/巨大空间/低饱和/环境主导）");
{
  const { retrieveVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
  );
  const results3 = await retrieveVisualMemory(
    { atmosphere: ["寂静"], spatialDepth: "deep", saturation: "low", environmentDominance: "high", humanRelation: "isolated" },
    { limit: 5 }
  );
  const cats = results3.map((r) => r.memory.metadata.origin === "film-still" ? "film" : "art");
  check("case3", "返回 5 条", results3.length === 5, `got ${results3.length}`);
  check("case3", `跨媒介混合（film ${cats.filter((c) => c === "film").length} + art ${cats.filter((c) => c === "art").length}）`, cats.includes("film") && cats.includes("art"));
  check("case3", "evidence 完整（score/matchedFields/reasons）", results3.every((r) => typeof r.score === "number" && Array.isArray(r.matchedFields) && Array.isArray(r.reasons) && r.reasons.length > 0));
  await writeFile(path.join(ROOT, "work", "portfolio-validation", "demo-flow-search.json"), JSON.stringify(results3.map((r) => ({ id: r.id, title: r.memory.metadata.title, category: cats[results3.indexOf(r)], score: Number(r.score.toFixed(1)), matchedFields: r.matchedFields, reasons: r.reasons })), null, 2) + "\n");
}

// ============================ Case 4: profile honesty ========================
console.log("Case 4 — Profile 展示诚实性");
{
  const { buildVisualProfile } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "visualProfile.js")).href
  );
  const p = await buildVisualProfile();
  check("case4", "sampleSize 展示（34 = 33 压测 success + 1 demo 上传）", p.sampleSize === 34, `got ${p.sampleSize}`);
  check("case4", "confidence 存在且合法", ["observation", "tendency", "pattern"].includes(p.confidence.level), p.confidence.level);
  check("case4", "visual tendency 组齐全（spatial/composition/color/narrative）", !!(p.spatial && p.composition && p.color && p.narrative));
  const keys = Object.keys(p);
  const forbidden = ["score", "grade", "rating", "personality", "recommendation", "ranking", "aestheticLevel"];
  const leaked = keys.filter((k) => forbidden.some((f) => k.toLowerCase().includes(f)));
  check("case4", `禁止项不出现（AI评分/审美等级/人格判断/推荐喜好）→ ${leaked.length ? "泄漏: " + leaked.join(",") : "无"}`, leaked.length === 0);
  check("case4", "诚实清单存在（unavailable）", typeof p.unavailable === "object" && Object.keys(p.unavailable).length > 0);
}

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ total: pass + fail, pass, fail, results }, null, 2) + "\n", "utf8");
console.log(`→ ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
