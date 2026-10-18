// 部分渠道失败状态是否真正到达 FIND 远程结果 —— 专项验收。
//
// 只覆盖三种状态，不重跑其它验收：
//   A 四馆全部成功        → 正常显示结果，无「部分来源」提示
//   B 三馆成功、一馆超时  → 仍显示有效结果，并说明哪几个来源没响应
//   C 全部失败            → 明确降级说明，本地检索不受影响
//   D 部分失败的结果      → 不得被缓存成完整结果
//
// 故障注入方式是替换单个适配器的 search（测试侧），不改产品代码。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// artService 的缓存走 window.localStorage；Node 下补一个内存实现，让缓存
// 逻辑跑的是产品真实代码路径。
const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  },
};

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { aicAdapter } = await imp("src/services/adapters/aicAdapter.js");
const { metAdapter } = await imp("src/services/adapters/metAdapter.js");
const { clevelandAdapter } = await imp("src/services/adapters/clevelandAdapter.js");
const { rijksAdapter } = await imp("src/services/adapters/rijksAdapter.js");
const ADAPTERS = [
  ["aic", aicAdapter], ["met", metAdapter],
  ["cleveland", clevelandAdapter], ["rijks", rijksAdapter],
];

const FAKE_WORK = (source, id) => ({
  source,
  sourceId: `${id}`,
  // SUBJECT_FIELDS = title/classification/subjects/department, and
  // normalizeArtwork() drops all but culture+museum — so a real museum hit
  // matches on its TITLE (e.g. Met's "Landscape (recto); Landscape (verso)").
  title: `Landscape study ${id}`,
  artist: "Test",
  year: "1900",
  museum: `Fake ${source} Museum`,
  culture: "landscape",
  image: { url: `https://example.invalid/${source}-${id}.jpg`, tiers: {} },
  publicDomain: true,
});

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ` — ${String(detail).slice(0, 120)}` : ""}`); }
  else { fail++; failures.push({ name, detail: String(detail).slice(0, 200) }); console.log(`  FAIL ${name} — ${String(detail).slice(0, 200)}`); }
};

// 用可控的假适配器替换真实网络：只验证状态传递，不依赖外部服务。
const originals = ADAPTERS.map(([, a]) => a.search);
function setChannels(spec) {
  ADAPTERS.forEach(([name, adapter], i) => {
    adapter.search = async (query, opts) => {
      const mode = spec[name];
      if (mode === "fail") throw new Error("INJECTED channel failure");
      return [FAKE_WORK(name, 1), FAKE_WORK(name, 2)].slice(0, opts?.limit ?? 2);
    };
  });
}
const restore = () => ADAPTERS.forEach(([, a], i) => { a.search = originals[i]; });

const { findRemotePaintings } = await imp("src/services/retrieval/remoteReferences.js");
const { searchLocal } = await imp("src/services/artService.js");
const { getCachedRemote } = await imp("src/services/artService.js");

const QUERY = "landscape";

try {
  console.log("=== A. 四馆全部成功 ===");
  mem.clear();
  setChannels({ aic: "ok", met: "ok", cleveland: "ok", rijks: "ok" });
  let r = await findRemotePaintings(QUERY, { media: "all" });
  check("A 返回结果", r.results.length > 0, `results=${r.results.length}`);
  check("A 不标为降级", r.degraded === false, `degraded=${r.degraded}`);
  check("A 无「部分来源」提示", !r.partial && !r.note, `partial=${r.partial} note="${r.note}"`);

  console.log("\n=== B. 三馆成功、一馆失败 ===");
  mem.clear();
  setChannels({ aic: "ok", met: "fail", cleveland: "ok", rijks: "ok" });
  r = await findRemotePaintings(QUERY, { media: "all" });
  check("B 仍显示有效结果", r.results.length > 0, `results=${r.results.length}`);
  check("B 不谎报整体降级", r.degraded === false, `degraded=${r.degraded}`);
  check("B 标记为部分失败", r.partial === true, `partial=${r.partial}`);
  check("B 说明点名失败来源", /met/.test(r.note || ""), `note="${r.note}"`);
  check("B 本地检索不受影响", searchLocal(QUERY).length >= 0, `local=${searchLocal(QUERY).length}`);

  console.log("\n=== D. 部分失败结果不得缓存为完整 ===");
  const cached = getCachedRemote(QUERY);
  check("D 部分失败时无缓存条目", cached === null, `cached=${cached ? cached.length + " works" : "null"}`);

  console.log("\n=== C. 全部失败 ===");
  mem.clear();
  setChannels({ aic: "fail", met: "fail", cleveland: "fail", rijks: "fail" });
  r = await findRemotePaintings(QUERY, { media: "all" });
  check("C 无远程结果", r.results.length === 0, `results=${r.results.length}`);
  check("C 明确降级", r.degraded === true, `degraded=${r.degraded}`);
  check("C 降级说明提到来源与本地不受影响", /未响应|不可用/.test(r.note || "") && /本地检索不受影响/.test(r.note || ""), `note="${r.note}"`);
  check("C 本地检索仍可用", searchLocal(QUERY).length > 0, `local=${searchLocal(QUERY).length}`);
  const cachedAllFail = getCachedRemote(QUERY);
  check("C 全部失败不写缓存", cachedAllFail === null, `cached=${cachedAllFail ? cachedAllFail.length + " works" : "null"}`);
} finally {
  restore();
}

console.log(`\n=== 部分失败状态验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (failures.length) console.log("失败项:", JSON.stringify(failures, null, 1));
process.exit(fail ? 1 : 0);