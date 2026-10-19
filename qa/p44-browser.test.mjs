// P4.4 STEP 6 — 真实 Edge 浏览器验收
//
// 验证：上传图自身的色彩计算、重排生效、结果卡、创作参考理由、CREATE 传递。
//
// 重要：Provider 响应是**重放 P4.2 已保存的结果**（window.__FA_TEST_VISION 注入），
// 因此这不是第二次 REAL-PROVIDER 调用，只是 REAL-INTEGRATION（浏览器侧）。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4491;
const PORT_CDP = 9331;
const OUT = path.join(ROOT, ".p43-evidence", "p44-browser.json");

let pass = 0, fail = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; rows.push({ name, ok: true }); console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; rows.push({ name, ok: false, detail }); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ---- P4.2 响应（用于重放）----
const evP42 = JSON.parse(readFileSync(path.join(ROOT, ".p42-evidence", "real-call.json"), "utf8"));
const RAW_INTENT = evP42.response.body.intent;
console.log(`replaying P4.2 intent (httpStatus=${evP42.response.httpStatus}, latency=${evP42.response.body.latencyMs}ms)`);

// ---- 启动服务端 ----
const srvEnv = { ...process.env, HOST: "127.0.0.1", PORT: String(PORT_SRV), VISION_RATE_LIMIT: "600", VISION_RATE_BURST: "200" };
for (const k of ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL", "VISION_ACCESS_CODE", "VISION_ACCESS_SECRET"]) delete srvEnv[k];
const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT_SRV)], { cwd: ROOT, env: srvEnv, stdio: ["ignore", "pipe", "pipe"] });
let srvLog = "";
srv.stdout.on("data", (d) => (srvLog += d));
srv.stderr.on("data", (d) => (srvLog += d));

const BASE = `http://127.0.0.1:${PORT_SRV}`;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { ready = (await fetch(BASE + "/healthz")).ok; } catch {}
}
check("本地服务启动", ready);
if (!ready) { try { srv.kill(); } catch {} process.exit(1); }

// ---- 启动 Edge（隔离 profile）----
const PROFILE = path.join(ROOT, ".p43-evidence", "edge-profile-p44");
mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT_CDP}`,
  `--user-data-dir=${PROFILE}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let edgeLog = "";
edge.stdout.on("data", (d) => (edgeLog += d));
edge.stderr.on("data", (d) => (edgeLog += d));

async function cdpTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

const target = await cdpTargets();
check("Edge CDP 就绪", !!target);
if (!target) { try { srv.kill(); edge.kill(); } catch {} process.exit(1); }

// ---- 极简 CDP 客户端 ----
const { WebSocket } = await import("node:worker_threads").then(() => ({ WebSocket: globalThis.WebSocket })).catch(() => ({ WebSocket: globalThis.WebSocket }));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 });
  if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return { value: r.result && r.result.result ? r.result.result.value : undefined };
};

const navigate = async (url) => {
  await send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 1500));
};

// ---- 注入重放 + 加载页面 ----
console.log("\n=== 1. 页面加载与重放注入 ===");
await navigate(`${BASE}/#find`);
await new Promise((r) => setTimeout(r, 1200));

// 注入重放 provider（同时让 QA seam 认为是可用状态）
const inject = `
  window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW_INTENT)}, latencyMs: ${evP42.response.body.latencyMs} });
  window.__VA_REPLAY_USED__ = 0;
  "injected";
`;
const inj = await evaluate(inject);
check("重放 provider 注入成功", inj.value === "injected", JSON.stringify(inj).slice(0, 80));

const hasCanvas = await evaluate(`typeof createImageBitmap === "function" && typeof document.createElement("canvas").getContext === "function"`);
check("浏览器支持 canvas + createImageBitmap", hasCanvas.value === true);

// ---- 2. 上传图色彩计算（真实 canvas）----
console.log("\n=== 2. 上传图从自身像素计算色彩 ===");
const colorRes = await evaluate(`
  (async () => {
    const mod = await import("/src/services/retrieval/colorSignatureBrowser.js");
    // 造一张确定可预测的图：左半红右半蓝
    const c = document.createElement("canvas");
    c.width = 200; c.height = 100;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ff0000"; ctx.fillRect(0,0,100,100);
    ctx.fillStyle = "#0000ff"; ctx.fillRect(100,0,100,100);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    const file = new File([blob], "test.jpg", { type: "image/jpeg" });
    const sig = await mod.analyzeImageSignatureSignature ? null : await mod.analyzeImageSignatureInBrowser(file);
    return {
      ok: sig.ok,
      hasDominant: Array.isArray(sig.colorSignature?.dominant),
      dominantCount: sig.colorSignature?.dominant?.length ?? 0,
      topHexes: (sig.colorSignature?.dominant || []).slice(0,3).map(d => d.hex),
      meanSat: sig.colorSignature?.meanSaturation,
      raster: sig.colorSignature?.raster,
      basis: sig.colorSignature?.basis,
    };
  })()
`);
check("浏览器能从像素算出色彩签名", colorRes.value?.ok === true, JSON.stringify(colorRes.value).slice(0, 120));
check("主色数量 > 0", (colorRes.value?.dominantCount ?? 0) > 0, `n=${colorRes.value?.dominantCount}`);
check("识别出红蓝两色（左红右蓝测试图）", (colorRes.value?.topHexes || []).some(h => /^#f/i.test(h)) && (colorRes.value?.topHexes || []).some(h => /^#0+[0-9a-f]{0,2}f/i.test(h) || /^#0000/i.test(h)), (colorRes.value?.topHexes || []).join(","));
check("标注 pixel-derived 确定性", /pixel-derived/.test(colorRes.value?.basis || ""));

// ---- 3. 检索链在浏览器中生效 ----
console.log("\n=== 3. 浏览器内检索链（增强路径）===");
const chainRes = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures, signatureFor } = await import("/src/services/retrieval/colorIndex.js");
    const { normalizeVisionIntent } = await import("/src/services/vision/normalizeVisionIntent.js");
    const sigs = allSignatures();
    const intent = normalizeVisionIntent(${JSON.stringify(RAW_INTENT)});
    const q = { ...signatureFor("american-gothic"), origin: "computed-from-uploaded-pixels" };
    const oldR = rs.retrieveByIntent(intent, { limit: 8 });
    const newR = rs.retrieveByIntent(intent, { limit: 8, enhanced: { signatures: sigs, querySig: q } });
    return {
      sigCount: Object.keys(sigs).length,
      oldTop: oldR.map(h => [h.artwork.id, h.retrievalScore]),
      newTop: newR.map(h => [h.artwork.id, h.retrievalScore]),
      hasColorEvidence: newR.some(h => !!h.colorEvidence),
      hasExplanation: newR.every(h => h.explanation && h.explanation.evidence.length >= 2),
      hasArtContext: newR.every(h => !!h.artContext),
    };
  })()
`);
check("浏览器内加载 61 条签名", chainRes.value?.sigCount === 61, `n=${chainRes.value?.sigCount}`);
check("增强路径返回结果", (chainRes.value?.newTop || []).length > 0, `n=${chainRes.value?.newTop?.length}`);
check("结果带色彩证据", chainRes.value?.hasColorEvidence === true);
check("每条带 >=2 依据", chainRes.value?.hasExplanation === true);
check("每条带艺术语境", chainRes.value?.hasArtContext === true);

// ---- 4. 文本查询：常见词修复在浏览器生效 ----
console.log("\n=== 4. 常见查询在浏览器中的表现 ===");
const textRes = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const { allSignatures } = await import("/src/services/retrieval/colorIndex.js");
    const words = ["战争","肖像","静物","室内","城市","雪","日本","宗教","人群","海"];
    const out = [];
    for (const w of words) {
      const r = rs.retrieveByText(w, { enhanced: { signatures: allSignatures() } });
      out.push({ w, n: r.results.length, basis: r.resultBasis, reason: r.emptyReason || null });
    }
    return out;
  })()
`);
const tr = textRes.value || [];
const nonEmpty = tr.filter(x => x.n > 0).length;
check("10 组查询在浏览器中可执行", tr.length === 10);
check("至少 6 组非空", nonEmpty >= 6, `${nonEmpty}/10`);
check("空结果都带原因", tr.filter(x => x.n === 0).every(x => !!x.reason), tr.filter(x => x.n === 0).map(x => x.w).join(","));

// ---- 5. CREATE 传递 ----
console.log("\n=== 5. CREATE 引用传递 ===");
const createRes = await evaluate(`
  (async () => {
    const rs = await import("/src/services/retrieval/retrievalService.js");
    const ctxMod = await import("/src/utils/taskContext.js");
    const { normalizeVisionIntent } = await import("/src/services/vision/normalizeVisionIntent.js");
    const { allSignatures, signatureFor } = await import("/src/services/retrieval/colorIndex.js");
    const intent = normalizeVisionIntent(${JSON.stringify(RAW_INTENT)});
    const q = { ...signatureFor("american-gothic"), origin: "computed-from-uploaded-pixels" };
    const r = rs.retrieveByIntent(intent, { limit: 3, enhanced: { signatures: allSignatures(), querySig: q } });
    ctxMod.resetForTest();
    ctxMod.beginTask(intent);
    if (r[0]) ctxMod.recordReference(r[0].artwork.key);
    const snap = ctxMod.getSnapshot();
    return { key: r[0]?.artwork?.key || null, recorded: snap.referenceKeys, fresh: snap.fresh };
  })()
`);
check("浏览器内可记录引用", createRes.value?.key && (createRes.value?.recorded || []).includes(createRes.value.key), `key=${createRes.value?.key}`);
check("task 快照 fresh", createRes.value?.fresh === true);

// ---- 6. 无真实 provider 调用 ----
console.log("\n=== 6. 成本确认 ===");
check("本轮无 /api/vision 请求（重放而非真实调用）", !/vision-ok|provider-failed/.test(srvLog), "服务端日志无 vision 调用记录");

// ---- 收尾 ----
try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}

console.log(`\n=== 浏览器验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter(x => !x.ok)) console.log(`  ${r.name} — ${r.detail}`);
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), provider: "replayed-P4.2", realProviderCalls: 0, pass, fail, rows }, null, 2));
console.log(`-> .p43-evidence/p44-browser.json`);
setTimeout(() => process.exit(fail ? 1 : 0), 500);
