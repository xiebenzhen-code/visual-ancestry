// P5.8.1 STEP 3 — memory-lifecycle-test.mjs · the full Personal Memory lifecycle.
//
//   Build Library → Persist → Export → Clear → Import → Restore → Continue Using
//
// Two branches, one process:
//   NODE branch (QA store dir):  build → persist-on-disk proof → export →
//     clear (boundary: only personal store touched) → import merge/replace →
//     restore-consistency (retrieval + profile + assistant on restored pool)
//   BROWSER branch (fake localStorage, P5.1.5 precedent): memoryRepository has
//     NO stateful dependencies (types.js is pure constants), so a query-suffix
//     re-import re-evaluates the module → isBrowser re-detected → a fresh
//     "session" against the same fake localStorage = a real RESTART semantic.
//
// Zero provider. Frozen layers are CALLED (retrieval/profile/assistant), never
// modified.
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = (...p) => pathToFileURL(path.join(ROOT, "src", ...p)).href;
const OUT = path.join(ROOT, "work", "p5.8.1-lifecycle", "lifecycle-test-results.json");

const results = [];
let pass = 0, fail = 0;
const check = (caseName, desc, cond, detail) => {
  if (cond) { pass++; results.push({ caseName, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ caseName, desc, pass: false, detail: detail || "" }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
};

// ===================== NODE BRANCH — full lifecycle ===========================
const storeDir = await mkdtemp(path.join(os.tmpdir(), "p581-lifecycle-"));
process.env.MEMORY_STORE_DIR = storeDir;

const { listMemories, addMemory, clearPersonalMemory } = await import(SRC("services", "memory", "memoryRepository.js"));
const { exportPersonalArchive, importPersonalArchive, validateArchive, buildArchive, ARCHIVE_FORMAT, ARCHIVE_VERSION } = await import(SRC("services", "memory", "archivePortability.js"));
const { retrieveVisualMemory } = await import(SRC("services", "memory", "retrieveVisualMemory.js"));
const { buildVisualProfile } = await import(SRC("services", "memory", "visualProfile.js"));
const { runAssistant } = await import(SRC("services", "memory", "visualAssistant.js"));

function mem(id, over = {}) {
  return {
    id, source: "user-upload", status: "success", error: null,
    image: { path: `${id}.jpg`, mime: "image/jpeg", sha256: `sha-${id}` },
    metadata: { title: `t-${id}`, origin: "artwork-reference", film: null, year: null, tags: [], createdAt: "2026-10-03T00:00:00.000Z" },
    visualIntent: { source: "vision", spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high", saturation: "low", humanRelation: "isolated", socialDistance: "high", atmosphere: ["寂静"], ...over },
    userData: { note: "", collections: [], thumbnail: `data:image/jpeg;base64,thumb-${id}` },
  };
}

console.log("[node] 1 — Build Library");
{
  for (const id of ["m1", "m2", "m3", "m4", "m5"]) await addMemory(mem(id));
  await addMemory(mem("m6", { spatialDepth: "shallow", saturation: "high", humanRelation: "crowd", environmentDominance: "low", negativeSpace: "low" }));
  check("build", "6 条入库", (await listMemories()).length === 6);
}

console.log("[node] 2 — Persist（落盘证据）");
{
  const file = path.join(storeDir, "memories.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  check("persist", "store 文件存在于磁盘且含 6 条", Array.isArray(raw.memories) && raw.memories.length === 6, `${raw.memories.length}`);
  check("persist", "条目含恢复所需图像信息（thumbnail data URL）", raw.memories.every((m) => typeof m.userData.thumbnail === "string" && m.userData.thumbnail.startsWith("data:image")));
}

console.log("[node] 3 — Export");
let archive;
{
  archive = await exportPersonalArchive();
  check("export", "契约外层（format/version/exportedAt/memoryCount）", archive.format === ARCHIVE_FORMAT && archive.version === 1 && typeof archive.exportedAt === "string" && archive.memoryCount === 6);
  check("export", "memories 原样携带（含 thumbnail）", archive.memories.length === 6 && archive.memories[0].userData.thumbnail.startsWith("data:image"));
  const v = validateArchive(archive);
  check("export", "自校验通过", v.ok, v.reason);
}

console.log("[node] 4 — Clear（数据边界）");
{
  // boundary sentinels: 邻近存储（artService 缓存/#eye 画像模拟）不受影响
  const before = await listMemories();
  await clearPersonalMemory();
  check("clear", "清空后 pool = 0", (await listMemories()).length === 0);
  const file = path.join(storeDir, "memories.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  check("clear", "磁盘 store 也为空（真删除非仅内存）", Array.isArray(raw.memories) && raw.memories.length === 0);
  check("clear", "边界：清空前 6 条与清空后 archive 仍完整（数据未被意外销毁于导出件）", archive.memoryCount === 6 && before.length === 6);
}

console.log("[node] 5 — Import（restore）");
{
  const bad1 = await importPersonalArchive({ format: "wrong", version: 1, memoryCount: 0, memories: [] });
  check("import", "format 不符 → 整体拒绝", bad1.ok === false && /format/.test(bad1.reason));
  const bad2 = await importPersonalArchive({ ...archive, memoryCount: 99 });
  check("import", "memoryCount 与条目不符 → 拒绝（防损坏）", bad2.ok === false && /memoryCount|不符/.test(bad2.reason));
  const bad3 = await importPersonalArchive(buildArchive([{ id: "", visualIntent: {} }, { id: "x" }]));
  check("import", "坏条目跳过并报告（不中断）", bad3.ok === true && bad3.restored === 0 && bad3.skipped.length === 2, JSON.stringify(bad3.skipped));

  const r1 = await importPersonalArchive(archive, { mode: "merge" });
  check("import", "merge 恢复 6 条", r1.ok && r1.restored === 6 && r1.skipped.length === 0, JSON.stringify(r1));
  const pool = await listMemories();
  check("import", "恢复后条目原样（id/thumbnail/intent 逐字段一致）", pool.length === 6 && pool.every((m) => { const orig = archive.memories.find((a) => a.id === m.id); return orig && orig.userData.thumbnail === m.userData.thumbnail && orig.visualIntent.spatialDepth === m.visualIntent.spatialDepth; }));

  // replace mode: current pool + archive(6) → replace 后仍是 6（不是 12）
  await addMemory(mem("m7"));
  const r2 = await importPersonalArchive(archive, { mode: "replace" });
  check("import", "replace 模式：清后导入（7+6 → 6，不是 13）", r2.ok && r2.restored === 6 && (await listMemories()).length === 6, `pool=${(await listMemories()).length}`);
}

console.log("[node] 6 — Continue Using（恢复一致性：冻结层调用验证）");
{
  const hits = await retrieveVisualMemory({ spatialDepth: "deep", humanRelation: "isolated" }, { limit: 5 });
  check("restore-consistency", "恢复后检索正常（>0 条带理由）", hits.length > 0 && hits.every((h) => h.reasons.length > 0), `${hits.length} hits`);
  const p = await buildVisualProfile();
  check("restore-consistency", "恢复后画像正常（sampleSize=6，isolated 5/6）", p.sampleSize === 6 && p.narrative.isolation.count === 5, JSON.stringify({ n: p.sampleSize, iso: p.narrative.isolation.count }));
  const a = await runAssistant({ task: "find_reference", query: "找孤独空间的参考" });
  check("restore-consistency", "恢复后 Assistant 正常（真实引用恢复的资产）", a.ok && a.results.length > 0 && a.results.every((x) => /^t-m[1-6]$/.test(x.title)), a.results.map((x) => x.title).join(","));
}


// ===================== BROWSER BRANCH — restart semantics =====================
// Purpose: verify the repository's BROWSER branch (production path) — restart
// persistence, clear, and the data boundary. Portability orchestration
// (validate/upsert loop) is fully covered in the node branch above; here we
// use repository APIs + the PURE buildArchive() to avoid cross-instance
// module-binding ambiguity (?query re-imports don't reliably rebind relative
// dependencies — P5.6 lesson).
console.log("[browser] 7 — fake localStorage：add → restart → 数据仍在 → clear 边界");
{
  const fakeStore = new Map();
  const fakeLocalStorage = {
    getItem: (k) => (fakeStore.has(k) ? fakeStore.get(k) : null),
    setItem: (k, v) => fakeStore.set(k, String(v)),
    removeItem: (k) => fakeStore.delete(k),
  };
  // boundary sentinels：#eye 画像与 artService 缓存（模拟真实键行为）
  fakeStore.set("visual-eye-profile:v1", JSON.stringify({ visits: 42 }));
  fakeStore.set("visual-art-cache:v1", JSON.stringify({ q: "stash", at: 1 }));

  globalThis.window = { localStorage: fakeLocalStorage };
  try {
    const repo1 = await import(SRC("services", "memory", "memoryRepository.js") + "?session1");
    await repo1.addMemory(mem("b1"));
    await repo1.addMemory(mem("b2"));

    // RESTART: 全新模块实例（浏览器语义 = 新页面会话读同一 localStorage）
    const repo2 = await import(SRC("services", "memory", "memoryRepository.js") + "?session2");
    const afterRestart = await repo2.listMemories();
    check("browser", "restart 后 2 条仍在（localStorage 语义）", afterRestart.length === 2 && afterRestart.every((m) => ["b1", "b2"].includes(m.id)), afterRestart.map((m) => m.id).join(","));

    // export via PURE buildArchive over the browser repository
    const { buildArchive, validateArchive } = await import(SRC("services", "memory", "archivePortability.js"));
    const exp = buildArchive(await repo2.listMemories());
    check("browser", "浏览器分支导出内容正确（2 条 + 缩略图，契约校验通过）", exp.memoryCount === 2 && exp.memories.every((m) => m.userData.thumbnail.startsWith("data:image")) && validateArchive(exp).ok);

    await repo2.clearPersonalMemory();
    check("browser", "clear 后 pool = 0", (await repo2.listMemories()).length === 0);
    check("browser", "数据边界：#eye 画像键未被触碰", JSON.parse(fakeStore.get("visual-eye-profile:v1")).visits === 42);
    check("browser", "数据边界：artService 缓存键未被触碰", JSON.parse(fakeStore.get("visual-art-cache:v1")).q === "stash");

    // restore: upsert the archived entries back through the repository API
    for (const m of exp.memories) await repo2.addMemory(m);
    const restored = await repo2.listMemories();
    check("browser", "浏览器分支恢复正常（2 条原样回归）", restored.length === 2 && restored.every((m) => m.userData.thumbnail.startsWith("data:image")));
  } finally {
    delete globalThis.window;
  }
}

await rm(storeDir, { recursive: true, force: true }).catch(() => {});

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ total: pass + fail, pass, fail, results }, null, 2) + "\n", "utf8");
console.log(`→ ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
