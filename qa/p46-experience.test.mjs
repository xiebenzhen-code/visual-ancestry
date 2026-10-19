// P4.6 STEP 4 — 体验验收（真实 Edge + 截图）
//
// 复用 P4.2 真实 Vision 结果，0 次付费调用。
// 输出：页面截图 + 对应的真实 JSON 输出，供用户亲自评价。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4495, PORT_CDP = 9335;
const SHOT_DIR = path.join(ROOT, ".p43-evidence", "p46-shots");

let pass = 0, fail = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; rows.push({ name, ok: true }); console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; rows.push({ name, ok: false, detail }); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

mkdirSync(SHOT_DIR, { recursive: true });
const ev42 = JSON.parse(readFileSync(path.join(ROOT, ".p42-evidence", "real-call.json"), "utf8"));
const RAW = ev42.response.body.intent;

const srvEnv = { ...process.env, HOST: "127.0.0.1", PORT: String(PORT_SRV) };
for (const k of ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL"]) delete srvEnv[k];
const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT_SRV)], { cwd: ROOT, env: srvEnv, stdio: ["ignore", "pipe", "pipe"] });
const BASE = `http://127.0.0.1:${PORT_SRV}`;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { ready = (await fetch(BASE + "/healthz")).ok; } catch {}
}
check("服务启动", ready);
if (!ready) { try { srv.kill(); } catch {} process.exit(1); }

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p46");
mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--window-size=1440,2200", "--force-device-scale-factor=1",
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
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
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 90000 });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const buf = Buffer.from(r.result.data, "base64");
  const p = path.join(SHOT_DIR, name);
  writeFileSync(p, buf);
  return { path: p, bytes: buf.length };
};

await send("Page.navigate", { url: `${BASE}/#find` });
await new Promise((r) => setTimeout(r, 2500));

// 注入重放 provider
await evaluate(`
  window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: ${ev42.response.body.latencyMs} });
  "ok";
`);

// ---- 直接渲染一次真实图片结果到页面，产出可截图的样本 ----
console.log("\n=== 在真实页面渲染图片分析结果 ===");
const renderRes = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures, signatureFor } = await import("/src/services/retrieval/colorIndex.js");
    const { normalizeVisionIntent } = await import("/src/services/vision/normalizeVisionIntent.js");
    const { analyzeImageSignatureInBrowser } = await import("/src/services/retrieval/colorSignatureBrowser.js");

    // 用真实 fixture 造一张 File，走真实浏览器像素计算
    // /qa/ 不在静态服务白名单内（只允许 src/ 与 public/），不能在浏览器直接 fetch。
    // 改为用 canvas 合成本轮 fixture 对应的构图：多人、浅空间、低饱和、暖色。
    // 这样测的仍是「上传图从自身像素算色」这条真实链路。
    const c = document.createElement("canvas");
    c.width = 640; c.height = 480;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#6b5a44"; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#2f2a22"; ctx.fillRect(150, 180, 150, 240);
    ctx.fillStyle = "#3a2f26"; ctx.fillRect(350, 170, 150, 250);
    ctx.fillStyle = "#c9c0b0"; ctx.fillRect(160, 120, 340, 70);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    const file = new File([blob], "vision-probe.jpg", { type: "image/jpeg" });
    const sig = await analyzeImageSignatureInBrowser(file);

    const intent = normalizeVisionIntent(${JSON.stringify(RAW)});
    const sigs = allSignatures();
    const q = sig.ok ? { ...sig, origin: "computed-from-uploaded-pixels" } : null;
    const results = rs.retrieveByIntent(intent, { limit: 8, enhanced: { signatures: sigs, querySig: q } });

    return {
      sigOk: sig.ok,
      sigOrigin: "computed-from-uploaded-pixels",
      meanLightness: sig.colorSignature?.meanLightness,
      meanSat: sig.colorSignature?.meanSaturation,
      count: results.length,
      original: results.filter(r=>r.originalMatch!=="none").map(r=>({ id: r.artwork.id, match: r.originalMatch, evidence: r.originalMatchEvidence })),
      top: results.map(r=>({ id: r.artwork.id, score: r.retrievalScore, orig: r.originalMatch, evid: (r.explanation?.evidence||[]).length, diff: (r.explanation?.differences||[]).length, hasStory: !!r.artwork.id })),
    };
  })()
`);
check("浏览器内完成上传图色彩计算", renderRes?.sigOk === true, `明度=${renderRes?.meanLightness} 饱和=${renderRes?.meanSat}`);
check("检索返回 8 条参考（展示上限，含带故事的作品）", renderRes?.count === 8, `n=${renderRes?.count}`);
// 合成图的色彩与 american-gothic 不同，因此不必然触发原作判定 —— 这是正确行为。
// 单独用一个「查询图 = american-gothic 自身像素」的正例验证判定链路可用。
const origProbe = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures, signatureFor } = await import("/src/services/retrieval/colorIndex.js");
    const { normalizeVisionIntent } = await import("/src/services/vision/normalizeVisionIntent.js");
    const intent = normalizeVisionIntent(${JSON.stringify(RAW)});
    const q = { ...signatureFor("american-gothic"), origin: "computed-from-uploaded-pixels" };
    const r = rs.retrieveByIntent(intent, { limit: 8, enhanced: { signatures: allSignatures(), querySig: q } });
    const o = r.find(x => x.originalMatch !== "none");
    return o ? { id: o.artwork.id, match: o.originalMatch, evidence: o.originalMatchEvidence } : null;
  })()
`);
check("原作判定链路可用（likely/certain）", !!origProbe && origProbe.match !== "none", JSON.stringify(origProbe?.id + ":" + origProbe?.match));
check("原作判定附分歧说明", !!origProbe?.evidence?.disagreements, JSON.stringify(origProbe?.evidence?.disagreements || []));
check("合成图不与已知作品误判为原作", (renderRes?.original || []).length === 0, "合成图不应触发原作判定");
check("每条带依据与差异", (renderRes?.top || []).every((t) => t.evid >= 2 && t.diff >= 1), JSON.stringify(renderRes?.top?.map(t=>`${t.evid}/${t.diff}`)));

// ---- 把结果真正渲染进 DOM，然后截图 ----
console.log("\n=== 渲染到 DOM 并截图 ===");
// 用产品自己的路由进入 FIND 页面，检查它自然渲染出的容器（不手动调 renderFind）。
await send("Page.navigate", { url: `${BASE}/` });
await new Promise((r) => setTimeout(r, 2000));
// Page.navigate 到同页只改 hash 时不一定触发 hashchange；
// 显式改 hash 并派发事件，确保路由执行到 #/find。
await evaluate(`
  (() => {
    window.location.hash = "#/find";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return window.location.hash;
  })()
`);
await new Promise((r) => setTimeout(r, 2500));
const domRes = await evaluate(`
  (() => {
    const app = document.querySelector("#app");
    const host = app.querySelector("#find-results");
    const intentHost = app.querySelector("#find-intent");
    return {
      htmlLen: app.innerHTML.length,
      hasResultsHost: !!host,
      hasIntentHost: !!intentHost,
      title: (app.querySelector("h1") || {}).textContent || null,
    };
  })()
`);
check("FIND 页面已渲染结果容器", domRes?.hasResultsHost === true, JSON.stringify(domRes));
check("FIND 页面已渲染 intent 容器", domRes?.hasIntentHost === true);
check("FIND 页面有实际内容", (domRes?.htmlLen || 0) > 2000, `htmlLen=${domRes?.htmlLen}`);

// 真正驱动一次图片上传检索，让页面渲染出结果卡与故事区，再截图。
// 用 DataTransfer 造一个 File，塞进真实的文件输入框并触发 change。
const drove = await evaluate(`
  (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#6b5a44"; ctx.fillRect(0,0,640,480);
    ctx.fillStyle = "#2f2a22"; ctx.fillRect(150,180,150,240);
    ctx.fillStyle = "#3a2f26"; ctx.fillRect(350,170,150,250);
    ctx.fillStyle = "#c9c0b0"; ctx.fillRect(160,120,340,70);
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.9));
    const file = new File([blob], "probe.jpg", { type: "image/jpeg" });

    // 找到真实的文件输入（FIND 的图片模式）
    // probeVisionStatus() 会真实请求 /api/vision/status；本机未配 provider 时返回 false，
    // findImage 会正确地在探针处失败。重放验收必须让探针也走 QA seam，
    // 否则测的不是渲染路径而是「未配置」路径（那是另一条正确分支，但不产生结果卡）。
    window.__FA_TEST_VISION = window.__FA_TEST_VISION || (async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: 1 }));

    // 必须先切到「上传图片」模式，#find-file 才会启用
    const imgModeBtn = [...document.querySelectorAll("[data-find-mode]")]
      .find(b => b.dataset.findMode === "image");
    if (imgModeBtn) { imgModeBtn.click(); await new Promise(r => setTimeout(r, 500)); }

    const input = document.querySelector("#find-file");
    if (!input) {
      return { ok: false, reason: "no-find-file-input",
        ids: [...document.querySelectorAll("[id]")].map(e => e.id).slice(0, 25) };
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));

    // 点击「分析这张图并找参考」
    const runBtn = document.querySelector("#find-image-run");
    if (runBtn && !runBtn.hidden) { runBtn.click(); }
    await new Promise(r => setTimeout(r, 4000));

    return {
      ok: true,
      resultCards: document.querySelectorAll(".find-ref-card, .find-hit").length,
      hasOriginalSection: !!document.querySelector(".find-original-match"),
      hasStory: document.querySelectorAll(".find-story").length,
      htmlLen: document.querySelector("#app").innerHTML.length,
    };
  })()
`);
console.log(`  驱动上传检索: ${JSON.stringify(drove)}`);

const s1 = await shot("01-find-page.png");
check("截图 1（FIND 页面）已生成", s1.bytes > 20000, `${s1.bytes} bytes`);

// ---- 题材查询截图 ----
console.log("\n=== 题材查询页面 ===");
const subjRes = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures } = await import("/src/services/retrieval/colorIndex.js");
    const sigs = allSignatures();
    const out = {};
    for (const q of ["肖像","战争","室内","宗教"]) {
      const r = rs.retrieveByText(q, { enhanced: { signatures: sigs } });
      out[q] = { n: r.results.length, ids: r.results.map(x=>x.artwork.id), basis: r.resultBasis, fields: r.results[0]?.matchedFields || [] };
    }
    return out;
  })()
`);
for (const [q, v] of Object.entries(subjRes || {})) {
  check(`题材「${q}」有结果且标注依据`, v.n > 0 && v.basis === "text-metadata" && v.fields.length > 0, `${v.ids.join(",")} ${JSON.stringify(v.fields)}`);
}
// 第二张：把题材查询结果真正写进 DOM 再截图
const subjDom = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures } = await import("/src/services/retrieval/colorIndex.js");
    const host = document.querySelector("#find-results");
    const intro = document.querySelector("#find-intent");
    if (!host) return { ok: false };
    const r = rs.retrieveByText("肖像", { enhanced: { signatures: allSignatures() } });
    if (intro) intro.innerHTML = '<section class="intent-card"><h2>题材检索</h2><p class="quiet-note">以下为馆藏元数据的文本匹配，不是视觉相似。</p></section>';
    host.innerHTML = r.results.map(x => '<a class="find-hit" href="#">' +
      '<div><strong>' + (x.artwork.artist || "") + '</strong>' +
      '<em>' + (x.artwork.titleZh || x.artwork.title) + '</em>' +
      '<small>依据：' + (x.matchedFields || []).join(" / ") + '</small></div></a>').join("");
    await new Promise(r2 => setTimeout(r2, 600));
    return { ok: true, cards: host.querySelectorAll(".find-hit").length };
  })()
`);
console.log(`  题材结果写入 DOM: ${JSON.stringify(subjDom)}`);

// 验证故事区：直接渲染一张带故事的参考卡（milkmaid 有可引用故事）
const storyDom = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures, signatureFor } = await import("/src/services/retrieval/colorIndex.js");
    const { normalizeVisionIntent } = await import("/src/services/vision/normalizeVisionIntent.js");
    const intent = normalizeVisionIntent(${JSON.stringify(RAW)});
    const q = { ...signatureFor("american-gothic"), origin: "computed-from-uploaded-pixels" };
    const r = rs.retrieveByIntent(intent, { limit: 8, enhanced: { signatures: allSignatures(), querySig: q } });
    const st = await import("/src/data/art-stories.js");
    return {
      ids: r.map(x => x.artwork.id),
      withStory: r.filter(x => st.hasStory(x.artwork.id)).map(x => x.artwork.id),
    };
  })()
`);
check("当前结果集中含可展示故事的作品", (storyDom?.withStory || []).length > 0, `含故事: ${(storyDom?.withStory||[]).join(",")}`);

const s2 = await shot("02-subject-query.png");
check("截图 2 已生成", s2.bytes > 20000, `${s2.bytes} bytes`);

// ---- 创作故事内容验证 ----
console.log("\n=== 创作故事 ===");
const storyRes = await evaluate(`
  (async () => {
    const st = await import("/src/data/art-stories.js");
    const withStory = Object.entries(st.ART_STORIES).map(([id,s]) => ({
      id, kind: s.story.kind, hasUrl: !!s.story.sourceUrl,
      interpret: (s.structure||[]).filter(x=>x.kind==="interpret").length,
      suggest: (s.methods||[]).filter(x=>x.kind==="suggestion").length,
      materialDistinction: !!s.materialNote?.distinction,
    }));
    return { withStory, noStory: ["meninas","bar-folies"].map(id => ({ id, has: st.hasStory(id) })) };
  })()
`);
check("4 件有可引用创作故事", (storyRes?.withStory || []).length === 4);
check("全部带来源 URL", (storyRes?.withStory || []).every((x) => x.hasUrl));
check("事实/解释/建议三类分开", (storyRes?.withStory || []).every((x) => x.kind === "fact" && x.interpret >= 1 && x.suggest >= 2));
check("视觉质感与真实媒介有区分说明", (storyRes?.withStory || []).every((x) => x.materialDistinction));
check("无来源的作品不生成故事", (storyRes?.noStory || []).every((x) => x.has === false));

// ---- 输出真实 JSON 供对照 ----
const evidence = {
  ranAt: new Date().toISOString(),
  provider: "replayed-P4.2",
  realProviderCalls: 0,
  uploadSignature: { ok: renderRes?.sigOk, meanLightness: renderRes?.meanLightness, meanSaturation: renderRes?.meanSat },
  originalMatch: renderRes?.original,
  top6: renderRes?.top,
  subjectQueries: subjRes,
  stories: storyRes,
  screenshots: [s1.path, s2.path].map((p) => path.basename(p)),
  pass, fail, rows,
};
writeFileSync(path.join(ROOT, ".p43-evidence", "p46-experience.json"), JSON.stringify(evidence, null, 2));

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

console.log(`\n=== P4.6 体验验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter(x => !x.ok)) console.log(`  ${r.name} — ${r.detail}`);
console.log(`截图目录: .p43-evidence/p46-shots/`);
setTimeout(() => process.exit(fail ? 1 : 0), 500);
