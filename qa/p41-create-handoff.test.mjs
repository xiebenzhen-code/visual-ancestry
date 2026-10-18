// P4.1 — 图片分析结果能否继续进入 CREATE（STEP 3 约束 5）。
//
// 只验证「引用传递」这一条链路：FIND 图片结果 → recordReference →
// CREATE 读到的参考集合包含它。不测 UI 布局、不重跑历史 UI 验收。
//
// [MOCK] 纯模块；无网络、无 DOM。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let pass = 0, fail = 0;
const out = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; out.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// taskContext 可能依赖 window/localStorage
const mem = new Map();
if (typeof globalThis.window === "undefined") {
  globalThis.window = {
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => void mem.set(k, String(v)),
      removeItem: (k) => void mem.delete(k),
    },
    sessionStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => void mem.set(k, String(v)),
      removeItem: (k) => void mem.delete(k),
    },
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
}

const { retrieveByIntent } = await imp("src/services/retrieval/retrievalService.js");
const { normalizeVisionIntent } = await imp("src/services/vision/normalizeVisionIntent.js");

const INTENT = normalizeVisionIntent({
  subject: "figure", subjectScale: "small", spatialPosition: "low",
  subjectPosition: "low", spatialDepth: "deep", negativeSpace: "high",
  environmentDominance: "high", lightDirection: "back", lightQuality: "diffuse",
  colorTemperature: "cool", saturation: "low", contrast: "low",
  humanRelation: "isolated", cameraDistance: "far", cameraHeight: "eye",
  cameraRelation: "observational", motion: "still", visualDensity: "sparse",
  arousal: "low", socialDistance: "high", melancholy: "medium",
  emotion: ["孤独"], atmosphere: ["雾", "空旷"],
});

console.log("=== 1. 图片检索结果带可被引用的 key ===");
const hits = retrieveByIntent(INTENT, { limit: 6 });
check("检索返回结果", hits.length > 0, `hits=${hits.length}`);
check("每条结果都有 artwork.key", hits.every((h) => h.artwork && typeof h.artwork.key === "string" && h.artwork.key.length > 0));
check("key 不含空白（可安全作为 DOM dataset）", hits.every((h) => !/\s/.test(h.artwork.key)));

console.log("\n=== 2. recordReference → CREATE 读取 ===");
const taskCtx = await imp("src/utils/taskContext.js");
const api = Object.keys(taskCtx);
console.log(`  taskContext exports: ${api.join(", ")}`);

const recKey = hits[0].artwork.key;

// Real product order: a FIND search calls beginTask(intent) FIRST, then a
// result click calls recordReference(key). recordReference() is a no-op
// unless the task is "fresh" (has a taskId and was updated recently), so
// calling it first legitimately returns an empty list. Reproduce the real
// order instead of asserting against an artificial one.
let keys = null;
try {
  taskCtx.beginTask(INTENT);
  taskCtx.recordReference(recKey);
  const snap = taskCtx.getSnapshot();
  keys = Array.isArray(snap.referenceKeys) ? snap.referenceKeys : null;
} catch (e) {
  console.log(`  beginTask/recordReference threw: ${String(e.message).slice(0, 80)}`);
}

check("快照可读", !!keys);
check("当前任务记录了该引用", !!keys && keys.includes(recKey), `keys=[${(keys || []).slice(0, 4).join(", ")}]`);
check("引用列表非空", !!keys && keys.length > 0);
check("重复记录不产生重复项", (() => {
  taskCtx.recordReference(recKey);
  const k2 = taskCtx.getSnapshot().referenceKeys;
  return k2.filter((x) => x === recKey).length === 1;
})());
check("检索结果可映射为引用 key（闭环最后一环）",
  hits.every((h) => typeof h.artwork.key === "string") && keys.includes(hits[0].artwork.key));

console.log("\n=== 3. CREATE 侧读取契约存在 ===");
let createSrc = null;
try {
  const fs = await import("node:fs/promises");
  createSrc = await fs.readFile(path.join(ROOT, "src", "pages", "create.js"), "utf8");
} catch { /* ignore */ }
check("create.js 可读", !!createSrc);
if (createSrc) {
  check("CREATE 从 taskContext 取参考（非自建一套）",
    /taskContext|useTask|currentTask|referenceKeys/.test(createSrc));
  // CREATE may REUSE the frozen scoreIntent() to order references — that is
  // sharing one scorer, not building a second one. What must not exist is a
  // locally defined weight table or a parallel scoring implementation.
  check("CREATE 复用冻结 scoreIntent（而非自建）",
    /import \{ scoreIntent \} from "\.\.\/services\/retrieval\/scoring\.js"/.test(createSrc));
  check("CREATE 未定义自己的权重表", !/const\s+WEIGHTS|WEIGHTS\s*=\s*\{/.test(createSrc));
  check("CREATE 未定义第二个评分函数", !/function\s+scoreIntent/.test(createSrc));
}

console.log(`\n=== CREATE 引用传递: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (out.length) for (const o of out) console.log("  " + o);
process.exit(fail ? 1 : 0);
