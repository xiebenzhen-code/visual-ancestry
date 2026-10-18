// 部分失败说明的"最后一米" —— 用 FIND 页面自己的渲染函数验证。
//
// 前面 qa/find/partial-failure-check.mjs 证明的是链路产出 note；
// 这里证明 note 真的变成用户看得见的那句说明。
//
// 为什么不用复刻：复刻的文案会与产品分叉，然后"验收通过但界面没显示"。
// 所以从 src/pages/find.js **原文切出** renderRemoteSection 函数体，
// 用产品自己的依赖（escapeHtml / creditLine / renderRemoteFilmCard）在
// 受控作用域里执行。渲染的是同一份代码，不是另写一份。
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  },
};

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}${detail ? ` — ${String(detail).slice(0, 150)}` : ""}`);
  } else {
    fail++;
    failures.push({ name, detail: String(detail).slice(0, 220) });
    console.log(`  FAIL ${name} — ${String(detail).slice(0, 220)}`);
  }
};

// ---- 从源码切出 renderRemoteSection（原文，不修改） -----------------------
const findSrc = await readFile(path.join(ROOT, "src", "pages", "find.js"), "utf8");
const startMarker = "function renderRemoteSection(remote) {";
const startIdx = findSrc.indexOf(startMarker);
if (startIdx < 0) {
  console.error("FATAL: renderRemoteSection not found in src/pages/find.js");
  process.exit(1);
}
// 函数体按大括号配平切出（渲染函数内部不含模板字符串中的裸大括号问题）
let depth = 0;
let endIdx = -1;
for (let i = startIdx + startMarker.length - 1; i < findSrc.length; i++) {
  const ch = findSrc[i];
  if (ch === "{") depth++;
  else if (ch === "}") {
    depth--;
    if (depth === 0) {
      endIdx = i + 1;
      break;
    }
  }
}
const fnSource = findSrc.slice(startIdx, endIdx);
console.log(`切出 renderRemoteSection：${fnSource.length} 字符（源码原文）\n`);

// ---- 产品自己的依赖 -------------------------------------------------------
const { renderRemoteFilmCard } = await imp("src/components/remoteFilmCard.js");
const { renderImg, aspectRatioCss } = await imp("src/utils/image.js");

// find.js 里的 creditLine 也按原文切出，保证与页面一致
const clStart = findSrc.indexOf("function creditLine(item) {");
let clEnd = -1;
if (clStart >= 0) {
  let d = 0;
  for (let i = clStart + "function creditLine(item) {".length - 1; i < findSrc.length; i++) {
    const ch = findSrc[i];
    if (ch === "{") d++;
    else if (ch === "}") {
      d--;
      if (d === 0) {
        clEnd = i + 1;
        break;
      }
    }
  }
}
const clSource = clEnd > clStart && clStart >= 0 ? findSrc.slice(clStart, clEnd) : "function creditLine(){return '';}";

// creditLine() 依赖页面内私有的 isFilm()；一并按原文切出，不重写。
const isFilmStart = findSrc.indexOf("function isFilm(");
let isFilmEnd = -1;
if (isFilmStart >= 0) {
  let d = 0;
  for (let i = isFilmStart + "function isFilm(".length - 1; i < findSrc.length; i++) {
    const ch = findSrc[i];
    if (ch === "{") d++;
    else if (ch === "}") {
      d--;
      if (d === 0) {
        isFilmEnd = i + 1;
        break;
      }
    }
  }
}
const isFilmSource = isFilmEnd > isFilmStart && isFilmStart >= 0 ? findSrc.slice(isFilmStart, isFilmEnd) : "function isFilm(){return false;}";

// escapeHtml：与页面同一实现（find.js 第 19 行 import 自 ../utils/html.js）
const { escapeHtml } = await imp("src/utils/html.js");

// 在受控作用域里构造渲染函数（依赖全部是产品真实模块）
const factory = new Function(
  "escapeHtml",
  "creditLine",
  "renderRemoteFilmCard",
  "renderImg",
  "aspectRatioCss",
  `${isFilmSource}\n${clSource}\n${fnSource}\nreturn renderRemoteSection;`
);
const renderRemoteSection = factory(escapeHtml, undefined, renderRemoteFilmCard, renderImg, aspectRatioCss);
// creditLine 在 factory 内部由 clSource 定义，外部实参传 undefined 即可

// ---- 构造"三馆成功、met 失败"的真实链路结果 -------------------------------
const { aicAdapter } = await imp("src/services/adapters/aicAdapter.js");
const { metAdapter } = await imp("src/services/adapters/metAdapter.js");
const { clevelandAdapter } = await imp("src/services/adapters/clevelandAdapter.js");
const { rijksAdapter } = await imp("src/services/adapters/rijksAdapter.js");
const P = { aic: aicAdapter, met: metAdapter, cleveland: clevelandAdapter, rijks: rijksAdapter };
const originals = Object.fromEntries(Object.entries(P).map(([k, a]) => [k, a.search]));

const FAKE_WORK = (source, id) => ({
  source,
  sourceId: `${id}`,
  title: `Landscape study ${id}`,
  artist: "Test",
  year: "1900",
  museum: `Fake ${source} Museum`,
  culture: "landscape",
  image: { url: `https://example.invalid/${source}-${id}.jpg`, tiers: {} },
  publicDomain: true,
});

let r;
try {
  mem.clear();
  for (const [name, adapter] of Object.entries(P)) {
    adapter.search = async (q, opts) => {
      if (name === "met") throw new Error("INJECTED channel failure");
      return [FAKE_WORK(name, 1), FAKE_WORK(name, 2)].slice(0, opts?.limit ?? 2);
    };
  }
  const { findRemoteReferences } = await imp("src/services/retrieval/remoteReferences.js");
  r = await findRemoteReferences("landscape", { media: "artwork" });
} finally {
  for (const [k, a] of Object.entries(P)) a.search = originals[k];
}

console.log("=== 1. 链路状态 ===");
check("note 点名 met", /met/.test(r.note || ""), `note="${r.note}"`);
check("note 是「部分来源」句式（与 partial 分支同源）", /部分来源本次未响应/.test(r.note || ""), `note="${r.note}"`);
check("有真实结果", r.results.length > 0, `results=${r.results.length}`);

console.log("\n=== 2. FIND 自己的渲染函数输出（源码原文执行）===");
const html = renderRemoteSection(r);
check("渲染函数返回非空 HTML", typeof html === "string" && html.length > 0, `len=${html.length}`);
check("HTML 中出现「部分来源本次未响应」", /部分来源本次未响应/.test(html), "用户可见说明已渲染");
check("HTML 中点名 met", /met/.test(html));
check("HTML 中给出可读原因（其余来源）", /其余来源/.test(html));
check("HTML 仍包含结果区段", /<section class="find-remote">/.test(html));
check("HTML 包含结果卡（find-hit-remote）", /find-hit-remote/.test(html));
check("说明句位于 <p class=\"quiet-note\"> 中（与页面同样式）", /<p class="quiet-note">[^<]*部分来源本次未响应/.test(html));

const resultCards = (html.match(/find-hit-remote/g) || []).length;
check("结果卡数量与三馆结果一致（6）", resultCards === r.results.length && resultCards === 6, `cards=${resultCards} results=${r.results.length}`);

console.log("\n=== 3. 对照：四馆全部成功时不得出现该说明 ===");
{
  const okRemote = { results: r.results, degraded: false, note: "", partial: false, metadataOnlyCount: 0, unsupported: false, unrelatedCount: 0, film: {} };
  const okHtml = renderRemoteSection(okRemote);
  check("全成功时无「部分来源」字样", !/部分来源本次未响应/.test(okHtml));
  check("全成功时仍渲染结果区段", /<section class="find-remote">/.test(okHtml));
}

console.log("\n=== 4. 对照：全部失败时渲染降级说明 ===");
{
  const downRemote = {
    results: [],
    degraded: true,
    note: "博物馆渠道均未响应（aic、met、cleveland、rijks）；本地检索不受影响。",
    partial: false,
    metadataOnlyCount: 0,
    unsupported: false,
    unrelatedCount: 0,
    film: {},
  };
  const downHtml = renderRemoteSection(downRemote);
  check("全部失败时渲染「均未响应」", /均未响应/.test(downHtml));
  check("全部失败时声明本地不受影响", /本地检索结果不受影响/.test(downHtml));
  check("全部失败时不渲染结果卡", !/find-hit-remote/.test(downHtml));
}

console.log("\n=== 5. 交错并发：不同查询、不同来源故障，failedSources / note 不得串扰 ===");
{
  const { findRemoteReferences } = await imp("src/services/retrieval/remoteReferences.js");
  const { searchRemoteWithStatus } = await imp("src/services/artService.js");

  const slowWork = (name) => async (q, opts) => {
    await new Promise((r) => setTimeout(r, 140)); // 保证两次检索真正重叠
    return [FAKE_WORK(name, 1), FAKE_WORK(name, 2)].slice(0, opts?.limit ?? 2);
  };
  const applySpec = (failing) => {
    for (const [name, adapter] of Object.entries(P)) {
      adapter.search = name === failing ? async () => { throw new Error("INJECTED channel failure"); } : slowWork(name);
    }
  };

  try {
    // 第一组：artService 层（failedSources 的源头，用模块级 remoteUnavailable 的历史缺陷做对比）
    mem.clear();
    applySpec("met");
    const pX = searchRemoteWithStatus("query-X", { limit: 8 });
    applySpec("rijks");
    const pY = searchRemoteWithStatus("query-Y", { limit: 8 });
    const [x, y] = await Promise.all([pX, pY]);

    check("X.failed 只含 met", JSON.stringify(x.failed) === JSON.stringify(["met"]), `X.failed=[${x.failed}]`);
    check("Y.failed 只含 rijks", JSON.stringify(y.failed) === JSON.stringify(["rijks"]), `Y.failed=[${y.failed}]`);
    check("X/Y failed 互不相同", JSON.stringify(x.failed) !== JSON.stringify(y.failed), `X=[${x.failed}] Y=[${y.failed}]`);
    check("X complete=false", x.complete === false, `X.complete=${x.complete}`);
    check("Y complete=false", y.complete === false, `Y.complete=${y.complete}`);
    check("X 仍有结果", x.works.length > 0, `X.works=${x.works.length}`);
    check("Y 仍有结果", y.works.length > 0, `Y.works=${y.works.length}`);

    // 第二组：note 层（用户可见文案）同样不得串扰。
    // 查询词必须能被假数据的 title/classification 命中，否则 references 为空，
    // “有结果”的场景就退化成完全失败场景，测不到我们要验的部分。
    mem.clear();
    applySpec("met");
    const rX = findRemoteReferences("landscape X", { media: "artwork" });
    applySpec("rijks");
    const rY = findRemoteReferences("landscape Y", { media: "artwork" });
    const [nx, ny] = await Promise.all([rX, rY]);

    check("X.note 点名 met 且不提 rijks", /met/.test(nx.note || "") && !/rijks/.test(nx.note || ""), `X.note="${nx.note}"`);
    check("Y.note 点名 rijks 且不提 met", /rijks/.test(ny.note || "") && !/met/.test(ny.note || ""), `Y.note="${ny.note}"`);
    check("X/Y note 互不相同", nx.note !== ny.note, `X="${nx.note}" Y="${ny.note}"`);

    // 两个 note 各自渲染到自己的 HTML，不能在**说明句**里出现对方的失败来源。
    // 注意：结果卡会展示 `Fake rijks Museum` 这类渠道名（来自 artwork.remote.channelName），
    // 那是正常展示，不是串扰。所以只把 note 渲染出的那句 <p class="quiet-note"> 取出来比。
    const noteParagraph = (html) => {
      const m = html.match(/<p class="quiet-note">\s*((?:部分来源|均未响应)[^<]*?)\s*<\/p>/);
      return m ? m[1].trim() : "";
    };
    const hx = renderRemoteSection(nx);
    const hy = renderRemoteSection(ny);
    const px = noteParagraph(hx);
    const py = noteParagraph(hy);
    check("X.note 对应场景确实有结果（否则测的是降级分支）", nx.results.length > 0, `X.results=${nx.results.length}`);
    check("Y.note 对应场景确实有结果", ny.results.length > 0, `Y.results=${ny.results.length}`);
    check("X 的说明句只提 met，不提 rijks", /met/.test(px) && !/rijks/.test(px), `X 说明句="${px}"`);
    check("Y 的说明句只提 rijks，不提 met", /rijks/.test(py) && !/met/.test(py), `Y 说明句="${py}"`);
    check("两个说明句不相同（确为各自那次查询）", px !== py, `X="${px}" Y="${py}"`);
  } finally {
    for (const [k, a] of Object.entries(P)) a.search = originals[k];
  }
}

console.log(`\n=== 说明到达 UI + 并发隔离: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (failures.length) console.log("失败项:", JSON.stringify(failures, null, 1));
process.exit(fail ? 1 : 0);
