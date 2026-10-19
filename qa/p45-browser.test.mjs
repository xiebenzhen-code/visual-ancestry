// P4.5 STEP 4 — 轻量浏览器验收
//
// 只验证本轮相关行为，不重跑历史全量 QA：
//   1. 题材查询在真实页面找到应有作品
//   2. 视觉与题材依据可区分
//   3. 色彩/材质来源明确
//   4. 创作故事不存在虚构
//   5. 不相关作品不因通用字段长期占据前列
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4493, PORT_CDP = 9333;

let pass = 0, fail = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; rows.push({ name, ok: true }); console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; rows.push({ name, ok: false, detail }); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const srvEnv = { ...process.env, HOST: "127.0.0.1", PORT: String(PORT_SRV) };
for (const k of ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL"]) delete srvEnv[k];
const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT_SRV)], { cwd: ROOT, env: srvEnv, stdio: ["ignore", "pipe", "pipe"] });
const BASE = `http://127.0.0.1:${PORT_SRV}`;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { ready = (await fetch(BASE + "/healthz")).ok; } catch {}
}
check("本地服务启动", ready);
if (!ready) { try { srv.kill(); } catch {} process.exit(1); }

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p45");
mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`)).json();
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
  } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 300));
}
check("Edge CDP 就绪", !!target);
if (!target) { try { srv.kill(); edge.kill(); } catch {} process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 });
  return r.result?.result?.value;
};

await send("Page.navigate", { url: `${BASE}/#find` });
await new Promise((r) => setTimeout(r, 2200));

// ---- 1. 题材查询在页面中找到应有作品 ----
console.log("\n=== 1. 题材查询（浏览器）===");
const mat = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures } = await import("/src/services/retrieval/colorIndex.js");
    const sigs = allSignatures();
    const cases = [["战争","third-of-may"],["肖像","whistlers-mother"],["宗教","calling"],["室内","milkmaid"]];
    const out = [];
    for (const [q, want] of cases) {
      const r = rs.retrieveByText(q, { enhanced: { signatures: sigs } });
      out.push({ q, want, ids: r.results.map(x=>x.artwork.id), basis: r.resultBasis, top: r.results[0]?.artwork?.id || null });
    }
    return out;
  })()
`);
for (const c of mat || []) {
  check(`「${c.q}」命中 ${c.want}`, c.ids.includes(c.want), `top=${c.top} n=${c.ids.length}`);
}

// ---- 2. 视觉与题材依据可区分 ----
console.log("\n=== 2. 依据可区分 ===");
const sep = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures } = await import("/src/services/retrieval/colorIndex.js");
    const sigs = allSignatures();
    const subj = rs.retrieveByText("肖像", { enhanced: { signatures: sigs } });
    const vis = rs.retrieveByText("雾 空旷", { enhanced: { signatures: sigs } });
    return {
      subjBasis: subj.resultBasis,
      subjScores: subj.results.map(h=>h.retrievalScore),
      subjFields: subj.results[0]?.matchedFields || [],
      visBasis: vis.resultBasis,
      visScores: vis.results.map(h=>h.retrievalScore),
      visFields: vis.results[0]?.matchedFields || null,
    };
  })()
`);
check("题材结果 basis=text-metadata", sep?.subjBasis === "text-metadata", sep?.subjBasis);
check("题材结果无视觉分", (sep?.subjScores || []).every((x) => x === 0));
check("题材结果带 semantics 字段标注", (sep?.subjFields || []).some((f) => /semantics:/.test(f)), JSON.stringify(sep?.subjFields));
check("视觉结果 basis=visual-intent", sep?.visBasis === "visual-intent", sep?.visBasis);
check("视觉结果有正分数", (sep?.visScores || []).some((x) => x > 0));

// ---- 3. 色彩/材质来源明确 ----
console.log("\n=== 3. 色彩与材质来源 ===");
const src = await evaluate(`
  (async () => {
    const sem = await import("/src/data/art-semantics.js");
    const { allSignatures } = await import("/src/services/retrieval/colorIndex.js");
    const sigs = allSignatures();
    const s = sem.ART_SEMANTICS["whistlers-mother"];
    return {
      material: s.material,
      materialSource: s.evidence.material.source,
      materialUrl: s.sourceUrl,
      colorBasis: sigs["whistlers-mother"].colorSignature.basis,
      hasColour: typeof sigs["whistlers-mother"].colorSignature.meanLightness === "number",
    };
  })()
`);
check("材质有真实来源标注", src?.materialSource === "wikidata", src?.materialSource);
check("材质内容为真实媒介", Array.isArray(src?.material) && src.material.includes("oil paint"), JSON.stringify(src?.material));
check("有可追溯 URL", /^https:\/\/www\.wikidata\.org/.test(src?.materialUrl || ""), src?.materialUrl);
check("色彩标注 pixel-derived", /pixel-derived/.test(src?.colorBasis || ""));

// ---- 4. 创作故事不虚构 ----
console.log("\n=== 4. 创作故事真实性 ===");
const story = await evaluate(`
  (async () => {
    const sem = await import("/src/data/art-semantics.js");
    const withNote = Object.entries(sem.ART_SEMANTICS).filter(([,s]) => s.historicalNote);
    const fabricated = withNote.filter(([,s]) => !s.evidence.historicalNote || s.evidence.historicalNote.source === "none");
    return { total: Object.keys(sem.ART_SEMANTICS).length, withNote: withNote.length, fabricated: fabricated.length };
  })()
`);
check("无虚构创作故事", story?.fabricated === 0, `样本 ${story?.total} 件，含背景 ${story?.withNote} 件，虚构 ${story?.fabricated} 件`);

// ---- 5. 不相关作品不长期占榜首 ----
console.log("\n=== 5. 通用字段占位检查 ===");
const dom = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures } = await import("/src/services/retrieval/colorIndex.js");
    const sigs = allSignatures();
    const qs = ["战争","肖像","宗教","室内","日本","中国","雾 空旷","孤独 夜晚","雪","夜晚","人群"];
    const tops = {};
    for (const q of qs) {
      const r = rs.retrieveByText(q, { enhanced: { signatures: sigs } });
      const t = r.results[0]?.artwork?.id;
      if (t) tops[t] = (tops[t] || 0) + 1;
    }
    const max = Math.max(0, ...Object.values(tops));
    return { tops, max, distinct: Object.keys(tops).length };
  })()
`);
check("无作品在 4+ 查询中霸占首位", (dom?.max || 0) < 4, `最高 ${dom?.max} 次；首位分布 ${JSON.stringify(dom?.tops)}`);
check("首位足够分散", (dom?.distinct || 0) >= 6, `${dom?.distinct} 个不同作品当过第一`);

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

console.log(`\n=== P4.5 浏览器验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter((x) => !x.ok)) console.log(`  ${r.name} — ${r.detail}`);
writeFileSync(path.join(ROOT, ".p43-evidence", "p45-browser.json"),
  JSON.stringify({ ranAt: new Date().toISOString(), paidVisionCalls: 0, pass, fail, rows }, null, 2));
console.log("-> .p43-evidence/p45-browser.json");
setTimeout(() => process.exit(fail ? 1 : 0), 500);
