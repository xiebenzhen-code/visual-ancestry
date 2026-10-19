// P4.9 收尾 — 三组定向验收（A/B/C），真实浏览器 + 分段截图
//
// A. 片名查询：Commons 真实结果仍可访问，片名匹配不被误禁
// B. 视觉概念查询：仅片名命中的候选不宣称为视觉匹配，且被降入探索区
// C. 真实图片 + 电影：本地有视觉评分；远程未验证候选只作探索线索；
//    SHOOT → FIND 图片交接正常
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".p43-evidence", "p49-final-shots");
const FIXTURE = path.join(ROOT, "qa", "fixtures", "vision-probe.jpg");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4517, PORT_CDP = 9357;

let pass = 0, fail = 0;
const rows = [];
const check = (n, c, d = "") => {
  if (c) { pass++; rows.push({ n, ok: true, d }); console.log(`  PASS ${n}${d ? " — " + d : ""}`); }
  else { fail++; rows.push({ n, ok: false, d }); console.log(`  FAIL ${n}${d ? " — " + d : ""}`); }
};

mkdirSync(OUT, { recursive: true });
const fixtureBuf = readFileSync(FIXTURE);
const fixtureSha = createHash("sha256").update(fixtureBuf).digest("hex").toUpperCase();
const ev42 = JSON.parse(readFileSync(path.join(ROOT, ".p42-evidence", "real-call.json"), "utf8"));
const RAW = ev42.response.body.intent;
const b64 = fixtureBuf.toString("base64");

const srvEnv = { ...process.env, HOST: "127.0.0.1", PORT: String(PORT_SRV) };
for (const k of ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL"]) delete srvEnv[k];
const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT_SRV)], { cwd: ROOT, env: srvEnv, stdio: ["ignore", "pipe", "pipe"] });
const BASE = `http://127.0.0.1:${PORT_SRV}`;
let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { ready = (await fetch(BASE + "/healthz")).ok; } catch {}
}
check("服务启动", ready);
if (!ready) { try { srv.kill(); } catch {} process.exit(1); }

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p49f");
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let target = null;
for (let i = 0; i < 80 && !target; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`)).json(); target = l.find(t => t.type === "page" && t.webSocketDebuggerUrl) || null; } catch {}
  if (!target) await new Promise(r => setTimeout(r, 300));
}
check("Edge CDP 就绪", !!target);
if (!target) { try { srv.kill(); edge.kill(); } catch {} process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
const commonsReqs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent" && /wikimedia/.test(m.params.request.url)) commonsReqs.push(m.params.request.url);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 });
  if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.text || "").slice(0, 300) };
  return r.result?.result?.value;
};
const viewport = async (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
const clearFocus = async () => { await evaluate("(() => { const a=document.activeElement; if(a&&a.blur)a.blur(); return 1; })()"); await new Promise(r=>setTimeout(r,70)); };

const shotSegmented = async (prefix, { maxSeg = 4 } = {}) => {
  await evaluate("(() => { window.scrollTo(0,0); return 1; })()");
  await new Promise((r) => setTimeout(r, 200));
  const total = await evaluate("(() => document.documentElement.scrollHeight)()");
  const vh = await evaluate("(() => window.innerHeight)()");
  const segs = [];
  for (let i = 0; i < maxSeg; i++) {
    const y = i * vh;
    if (y >= total) break;
    const expr =
      "(async () => {" +
      "  window.scrollTo(0, " + y + ");" +
      "  await new Promise(r => setTimeout(r, 420));" +
      "  const vh = window.innerHeight;" +
      "  const imgs = [...document.querySelectorAll('#find-remote img, #find-results img')].filter(im => {" +
      "    const r = im.getBoundingClientRect();" +
      "    return r.top < vh && r.bottom > 0 && !(im.complete && im.naturalWidth > 0);" +
      "  });" +
      "  await Promise.all(imgs.map(im => new Promise(res => {" +
      "    im.addEventListener('load', res, { once: true });" +
      "    im.addEventListener('error', res, { once: true });" +
      "    setTimeout(res, 2500);" +
      "  })));" +
      "  return 1;" +
      "})()";
    await evaluate(expr);
    await clearFocus();
    const r = await send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(r.result.data, "base64");
    const nm = `${prefix}-seg${i}.png`;
    writeFileSync(path.join(OUT, nm), buf);
    segs.push({ file: nm, bytes: buf.length, y });
  }
  await evaluate("(() => { window.scrollTo(0,0); return 1; })()");
  return segs;
};

const audit = {};

// ===========================================================================
// A. 片名查询（桌面 + 移动）
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== A (${tag}): 片名查询 Battleship Potemkin ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2200));
  const before = commonsReqs.length;
  await evaluate(`
    (async () => {
      const fb = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
      if (fb) { fb.click(); await new Promise(r => setTimeout(r, 300)); }
      const input = document.querySelector("#find-text");
      input.value = "Battleship Potemkin";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#album-search")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 45; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const t = document.querySelector("#find-remote")?.innerText || "";
        if (t && !/正在检索远程渠道/.test(t)) break;
      }
      await new Promise(r => setTimeout(r, 1200));
      return 1;
    })()
  `);
  // 解码测量前逐张滚动等待（lazy 图在截图前可能还没请求）
  await evaluate(`
    (async () => {
      for (const im of document.querySelectorAll("#find-remote img")) {
        im.scrollIntoView({ block: "center" });
        await new Promise(r => setTimeout(r, 260));
        if (!(im.complete && im.naturalWidth > 0)) {
          await new Promise(res => {
            im.addEventListener("load", res, { once: true });
            im.addEventListener("error", res, { once: true });
            setTimeout(res, 3000);
          });
        }
      }
      window.scrollTo(0, 0);
      return 1;
    })()
  `);  const dom = await evaluate(`
    (() => {
      const host = document.querySelector("#find-remote");
      const cards = [...host.querySelectorAll(".find-hit-film")];
      const clues = host.querySelector(".find-remote-more-clues");
      const imgs = [...host.querySelectorAll("img")];
      return {
        cards: cards.length,
        decoded: imgs.filter(im => im.complete && im.naturalWidth > 0).length,
        imgs: imgs.length,
        hasCluesBlock: !!clues,
        cluesClosed: clues ? !clues.open : null,
        cluesSummary: clues ? (clues.querySelector("summary")?.textContent || "").trim() : null,
        hasTitleMatchWording: /片名匹配/.test(host.innerText),
        overclaim: /视觉匹配成功|已视觉匹配|画面相似已确认/.test(host.innerText),
        commonsLinks: host.querySelectorAll('a[href*="commons.wikimedia.org"]').length,
        text: (host.innerText||"").replace(/\\s+/g," ").slice(0, 240),
      };
    })()
  `);
  const reqs = commonsReqs.slice(before);
  console.log(`  卡片 ${dom?.cards} · 图 ${dom?.decoded}/${dom?.imgs} · 请求 ${reqs.length} · 线索区 ${dom?.hasCluesBlock}`);
  console.log(`  文本: ${(dom?.text||"").slice(0, 180)}`);
  check(`A/${tag}: Commons 请求真实发出`, reqs.length > 0, `${reqs.length} 条`);
  check(`A/${tag}: 片名结果正常展示（未被误禁）`, (dom?.cards || 0) > 0, `${dom?.cards} 张`);
  check(`A/${tag}: 片名匹配措辞正确`, dom?.hasTitleMatchWording === true);
  check(`A/${tag}: 无视觉匹配成功的宣称`, dom?.overclaim === false);
  check(`A/${tag}: 图片解码`, dom?.decoded > 0 && dom?.decoded === dom?.imgs, `${dom?.decoded}/${dom?.imgs}`);
  check(`A/${tag}: 保留 Commons 来源链接`, (dom?.commonsLinks || 0) > 0, `${dom?.commonsLinks} 个`);
  audit[`A-${tag}`] = dom;
  const segs = await shotSegmented(`A-${tag}`);
  console.log(`  截图 ${segs.length} 张`);
}

// ===========================================================================
// B. 视觉概念查询（桌面 + 移动）
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== B (${tag}): 视觉概念查询 人群 ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2200));
  const before = commonsReqs.length;
  await evaluate(`
    (async () => {
      const fb = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
      if (fb) { fb.click(); await new Promise(r => setTimeout(r, 300)); }
      const input = document.querySelector("#find-text");
      input.value = "人群";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#album-search")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 45; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const t = document.querySelector("#find-remote")?.innerText || "";
        if (t && !/正在检索远程渠道/.test(t)) break;
      }
      await new Promise(r => setTimeout(r, 1200));
      return 1;
    })()
  `);
  const dom = await evaluate(`
    (() => {
      const host = document.querySelector("#find-remote");
      const clues = host.querySelector(".find-remote-more-clues");
      // 先记录默认状态再展开（顺序反了就永远测不到「默认收起」）
      const cluesDefaultClosed = clues ? !clues.open : null;
      if (clues) clues.open = true;
      const primaryCards = host.querySelectorAll(".find-remote-results:not(.find-remote-exploratory) .find-hit-film").length;
      const exploratoryCards = host.querySelectorAll(".find-remote-exploratory .find-hit-film").length;
      return {
        primaryCards, exploratoryCards,
        hasCluesBlock: !!clues,
        cluesSummary: clues ? (clues.querySelector("summary")?.textContent || "").trim() : null,
        cluesDefaultClosed,
        overclaim: /视觉匹配成功|已视觉匹配|画面相似已确认/.test(host.innerText),
        unverifiedWording: /画面相似性尚未验证|待视觉核验|仅片名撞词/.test(host.innerText),
        text: (host.innerText||"").replace(/\\s+/g," ").slice(0, 260),
      };
    })()
  `);
  console.log(`  正式 ${dom?.primaryCards} · 探索 ${dom?.exploratoryCards} · 线索区 ${dom?.hasCluesBlock}`);
  console.log(`  summary: ${dom?.cluesSummary}`);
  check(`B/${tag}: 仅片名命中的候选被降入探索区`, dom?.hasCluesBlock === true && (dom?.exploratoryCards || 0) > 0,
    `探索区 ${dom?.exploratoryCards} 张`);
  check(`B/${tag}: 探索区默认收起`, dom?.cluesDefaultClosed === true);
  check(`B/${tag}: summary 明示未验证`, /尚未验证|未验证/.test(dom?.cluesSummary || ""), dom?.cluesSummary);
  check(`B/${tag}: 无视觉匹配成功的宣称`, dom?.overclaim === false);
  check(`B/${tag}: 有未验证措辞`, dom?.unverifiedWording === true);
  audit[`B-${tag}`] = dom;
  const segs = await shotSegmented(`B-${tag}`);
  console.log(`  截图 ${segs.length} 张`);
  // 展开探索区的截图
  await evaluate("(() => { const c = document.querySelector('.find-remote-more-clues'); if (c) { c.open = true; c.scrollIntoView({block:'center'}); } return 1; })()");
  await new Promise((r) => setTimeout(r, 600));
  await clearFocus();
  const ro = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, `B-${tag}-clues-open.png`), Buffer.from(ro.result.data, "base64"));
}

// ===========================================================================
// C. 真实图片 + 电影 + handoff（桌面 + 移动）
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== C (${tag}): 上传真实图 + 电影 ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2200));
  const before = commonsReqs.length;
  await evaluate(`
    (async () => {
      window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: 1 });
      const fb = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
      if (fb) { fb.click(); await new Promise(r => setTimeout(r, 250)); }
      const mb = [...document.querySelectorAll("[data-find-mode]")].find(b => b.dataset.findMode === "image");
      if (mb) { mb.click(); await new Promise(r => setTimeout(r, 400)); }
      const bin = atob("${b64}");
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([new Blob([arr], { type: "image/jpeg" })], "vision-probe.jpg", { type: "image/jpeg" });
      const input = document.querySelector("#find-file");
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));
      document.querySelector("#find-image-run")?.click();
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const t = document.querySelector("#find-remote")?.innerText || "";
        if (t && !/正在按视觉关键词检索/.test(t)) break;
      }
      await new Promise(r => setTimeout(r, 1500));
      return 1;
    })()
  `);
  const dom = await evaluate(`
    (() => {
      const local = [...document.querySelectorAll("#find-results .find-ref-card")];
      const remoteHost = document.querySelector("#find-remote");
      const clues = remoteHost?.querySelector(".find-remote-more-clues");
      const primary = remoteHost?.querySelectorAll(".find-remote-results:not(.find-remote-exploratory) .find-hit-film").length || 0;
      const exploratory = remoteHost?.querySelectorAll(".find-remote-exploratory .find-hit-film").length || 0;
      const localImgs = local.map(c => c.querySelector("img")).filter(Boolean);
      const localReasons = local.map(c => (c.querySelector(".find-ref-lead")||{}).textContent || "");
      return {
        localCards: local.length,
        localDecoded: localImgs.filter(im => im.complete && im.naturalWidth > 0).length,
        localLeadPresent: localReasons.filter(t => t.trim().length > 0).length,
        primary, exploratory,
        hasCluesBlock: !!clues,
        cluesClosed: clues ? !clues.open : null,
        overclaim: /视觉匹配成功|已视觉匹配|画面相似已确认/.test(remoteHost?.innerText || ""),
        text: (remoteHost?.innerText||"").replace(/\\s+/g," ").slice(0, 240),
      };
    })()
  `);
  const reqs = commonsReqs.slice(before);
  console.log(`  本地 ${dom?.localCards}（依据 ${dom?.localLeadPresent}）· 正式 ${dom?.primary} · 探索 ${dom?.exploratory} · 请求 ${reqs.length}`);
  check(`C/${tag}: 本地电影候选全部有视觉评分与依据`, dom?.localCards > 0 && dom?.localLeadPresent === dom?.localCards,
    `${dom?.localLeadPresent}/${dom?.localCards}`);
  check(`C/${tag}: 远程未验证候选只作探索线索`, dom?.hasCluesBlock === true && dom?.cluesClosed === true,
    `探索 ${dom?.exploratory} 张、默认收起`);
  check(`C/${tag}: 无视觉匹配成功宣称`, dom?.overclaim === false);
  audit[`C-${tag}`] = dom;
  const segs = await shotSegmented(`C-${tag}`);
  console.log(`  截图 ${segs.length} 张`);
}

// ===========================================================================
// SHOOT → FIND handoff（桌面）
// ===========================================================================
console.log("\n=== SHOOT → FIND handoff ===");
await viewport(1440, 900);
await send("Page.navigate", { url: `${BASE}/` });
await new Promise((r) => setTimeout(r, 2000));
await evaluate(`sessionStorage.setItem("fa-vision-summary", "大人物 / 空间次要 / 浅景"); 1`);
await send("Page.navigate", { url: `${BASE}/` });
await new Promise((r) => setTimeout(r, 2500));
const ho = await evaluate(`
  (() => {
    const imgPanel = document.querySelector('[data-find-panel="image"]');
    const on = [...document.querySelectorAll("[data-find-mode]")].filter(b => b.classList.contains("is-on")).map(b => b.textContent.trim());
    return {
      imagePanelVisible: imgPanel ? !imgPanel.hidden : null,
      activeOn: on,
      intentShown: /看到的画面/.test(document.querySelector("#find-intent")?.innerText || ""),
    };
  })()
`);
console.log(`  ${JSON.stringify(ho)}`);
check("SHOOT→FIND 交接：图片面板已展开", ho?.imagePanelVisible === true);
check("SHOOT→FIND 交接：上传图片为选中态", (ho?.activeOn || []).includes("上传图片"));
check("SHOOT→FIND 交接：intent 卡片显示", ho?.intentShown === true);
const rh = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(path.join(OUT, "handoff.png"), Buffer.from(rh.result.data, "base64"));

const summary = {
  ranAt: new Date().toISOString(), paidCalls: 0,
  fixture: { sha256: fixtureSha, bytes: fixtureBuf.length },
  commonsRequestTotal: commonsReqs.length,
  audit,
  pass, fail, rows,
};
writeFileSync(path.join(ROOT, ".p43-evidence", "p49-final.json"), JSON.stringify(summary, null, 2));
try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
console.log(`\n=== P4.9 收尾验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter(x => !x.ok)) console.log(`  ${r.n} — ${r.d}`);
setTimeout(() => process.exit(0), 400);
