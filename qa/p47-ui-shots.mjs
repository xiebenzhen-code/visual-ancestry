// P4.7 — UI 视觉验收：Desktop 1440x900 + Mobile 390x844
//
// 只做 UI 冒烟：不重跑历史测试，复用 P4.2 已保存响应，0 次付费调用。
//
// 用法：
//   node qa/p47-ui-shots.mjs before   → 输出到 .p43-evidence/p47-shots/before/
//   node qa/p47-ui-shots.mjs after    → 输出到 .p43-evidence/p47-shots/after/
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PHASE = process.argv[2] || "after";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4497, PORT_CDP = 9337;
const OUT = path.join(ROOT, ".p43-evidence", "p47-shots", PHASE);

let pass = 0, fail = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; rows.push({ name, ok: true }); console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; rows.push({ name, ok: false, detail }); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

mkdirSync(OUT, { recursive: true });
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

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p47");
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
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
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.text || "").slice(0, 300) };
  return r.result?.result?.value;
};
const viewport = async (w, h) => {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
};
const clearFocus = async () => {
  await evaluate(`(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()`);
  await new Promise((r) => setTimeout(r, 80));
};
const shot = async (name, full = true) => {
  await clearFocus();
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
  const buf = Buffer.from(r.result.data, "base64");
  writeFileSync(path.join(OUT, name), buf);
  return buf.length;
};
const gotoFind = async () => {
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 1800));
  await evaluate(`(() => { window.location.hash = ""; window.dispatchEvent(new HashChangeEvent("hashchange")); return 1; })()`);
  await new Promise((r) => setTimeout(r, 1600));
};

// ---------------------------------------------------------------------------
// 度量：横向溢出、焦点可见、首屏层级
// ---------------------------------------------------------------------------
const measure = async () => evaluate(`
  (() => {
    const doc = document.documentElement;
    const app = document.querySelector("#app");
    const vw = window.innerWidth;
    const overflows = [...document.querySelectorAll("body *")]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > vw + 2 || r.left < -2);
      })
      .slice(0, 8)
      .map(el => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0,40), right: Math.round(el.getBoundingClientRect().right) }));
    const parseColor = (str) => {
      const m = String(str).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(",").map((x) => parseFloat(x));
      const [r, g, b] = parts;
      const a = parts.length > 3 ? parts[3] : 1;
      return { r, g, b, a };
    };
    const darkSolid = [...document.querySelectorAll("button, .tab, a.btn")]
      .filter(el => {
        const c = parseColor(getComputedStyle(el).backgroundColor);
        if (!c || c.a < 0.5) return false;
        return (c.r + c.g + c.b) / 3 < 90;
      })      .map(el => (el.textContent || "").trim().slice(0, 14));
    return {
      vw, scrollW: doc.scrollWidth, overflowX: doc.scrollWidth > vw + 2,
      overflows, darkSolidButtons: [...new Set(darkSolid)],
      htmlLen: app ? app.innerHTML.length : 0,
    };
  })()
`);

// 用真实 Tab 键推进焦点。程序化 focus() 不会触发 :focus-visible，
// 所以必须真的按键，才能判断「键盘用户是否看得见焦点」。
const focusProbe = async () => {
  await evaluate(`(() => { document.body.focus(); return 1; })()`);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" });
    await new Promise((r) => setTimeout(r, 60));
    const info = await evaluate(`
      (() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const ow = parseFloat(cs.outlineWidth) || 0;
        const visible = (cs.outlineStyle !== "none" && ow > 0) || cs.boxShadow !== "none";
        return { tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 30),
                 text: (el.textContent || "").trim().slice(0, 16),
                 outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
                 outlineColor: cs.outlineColor, visible };
      })()
    `);
    if (info) seen.push(info);
  }
  const visibleCount = seen.filter((x) => x.visible).length;
  return { ok: seen.length > 0, seen: seen.slice(0, 6), visibleCount, total: seen.length,
           visible: seen.length > 0 && visibleCount === seen.length };
};

// ---------------------------------------------------------------------------
// DESKTOP 1440x900
// ---------------------------------------------------------------------------
console.log("\n=== Desktop 1440x900 ===");
await viewport(1440, 900);
await gotoFind();

const routeProbe = await evaluate(`
  (() => {
    const hasFile = !!document.querySelector("#find-file");
    const hasWall = !!document.querySelector("#album-wall-wrap");
    const hasText = !!document.querySelector("#find-text");
    return { hash: window.location.hash, hasFile, hasWall, hasText };
  })()
`);
check("进入参考首页（含上传入口与作品墙）", routeProbe?.hasFile === true && routeProbe?.hasWall === true, JSON.stringify(routeProbe));

const d1 = await measure();
// 截图前先记录按钮真实样式，再把焦点移开 —— 否则 Tab 探针留下的
// focus-visible 轮廓会出现在截图里，看起来像「按钮有方框」。
const btnStyle = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll("[data-find-media]")].find(x => x.classList.contains("is-on"));
    if (!b) return null;
    const cs = getComputedStyle(b);
    const after = getComputedStyle(b, "::after");
    return { text: b.textContent.trim(), border: cs.border, bg: cs.backgroundColor,
             outline: cs.outline, underline: after.backgroundColor, afterH: after.height,
             color: cs.color, fontWeight: cs.fontWeight };
  })()
`);
console.log(`  选中 Tab 样式: ${JSON.stringify(btnStyle)}`);
check("选中 Tab 不是实心深色块", btnStyle && !/rgb\(2[0-9], 2[0-9], 2[0-9]\)|rgb\(1[0-9], 1[0-9], 1[0-9]\)/.test(btnStyle.bg || ""), btnStyle?.bg);
check("选中 Tab 有下划线", btnStyle && btnStyle.underline !== "rgba(0, 0, 0, 0)", btnStyle?.underline);
check("选中 Tab 无边框", btnStyle && (btnStyle.border || "").includes("0px"), btnStyle?.border);
await evaluate(`(() => { document.activeElement && document.activeElement.blur(); return 1; })()`);
await new Promise((r) => setTimeout(r, 120));
const s1 = await shot("desktop-01-default.png");
check("Desktop 无横向溢出", d1?.overflowX === false, `scrollW=${d1?.scrollW} vw=${d1?.vw}`);
check("Desktop 默认无预览图", await evaluate(`(() => { const p = document.querySelector("#find-preview"); return !p || p.hidden; })()`) === true);
const f1 = await focusProbe();
check("Desktop 键盘焦点可见", f1?.visible === true, JSON.stringify(f1));

// 上传驱动（用 P4.2 重放，不付费）
await evaluate(`
  window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: 1 });
  1;
`);
const uploadRes = await evaluate(`
  (async () => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 480;
    const x = c.getContext("2d");
    x.fillStyle = "#6b5a44"; x.fillRect(0,0,640,480);
    x.fillStyle = "#2f2a22"; x.fillRect(150,180,150,240);
    x.fillStyle = "#3a2f26"; x.fillRect(350,170,150,250);
    x.fillStyle = "#c9c0b0"; x.fillRect(160,120,340,70);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    const file = new File([blob], "probe-scene.jpg", { type: "image/jpeg" });
    const btn = [...document.querySelectorAll("[data-find-mode]")].find(b => b.dataset.findMode === "image");
    if (btn) { btn.click(); await new Promise(r => setTimeout(r, 400)); }
    const input = document.querySelector("#find-file");
    if (!input) return { ok: false, reason: "no-input" };
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const p = document.querySelector("#find-preview");
    return {
      ok: true, previewShown: !!p && !p.hidden,
      previewNatural: p ? (p.naturalWidth + "x" + p.naturalHeight) : null,
      hasFileName: !!document.querySelector("#find-file-name, .find-file-name, [data-file-name]"),
      hasRemove: !!document.querySelector("#find-clear, .find-clear, [data-find-clear]"),
    };
  })()
`);
check("Desktop 上传预览出现", uploadRes?.previewShown === true, `natural=${uploadRes?.previewNatural}`);
check("Desktop 预览显示文件名", uploadRes?.hasFileName === true);
check("Desktop 预览有移除操作", uploadRes?.hasRemove === true);
// 四种状态必须明确：未上传 / 加载中 / 成功 / 失败（含未配置）。
const states = await evaluate(`
  (() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && !el.hidden;
    };
    return {
      drop: vis("#find-drop"),
      uploadCard: vis("#find-upload-card"),
      preview: vis("#find-preview"),
      progress: vis("#find-image-progress"),
      error: vis("#find-image-error"),
      runBtn: vis("#find-image-run"),
    };
  })()
`);
check("上传后：拖拽入口隐藏", states?.drop === false, JSON.stringify(states));
check("上传后：预览卡显示", states?.uploadCard === true && states?.preview === true);
check("成功后：进度条已收起", states?.progress === false);
check("成功后：无错误提示残留", states?.error === false);

const s2 = await shot("desktop-02-uploaded.png");

// 移除操作必须真的把状态清空（而不是只隐藏 DOM）。
const clearRes = await evaluate(`
  (async () => {
    const clr = document.querySelector("#find-clear");
    if (!clr) return { ok: false, reason: "no-clear-btn" };
    clr.click();
    await new Promise(r => setTimeout(r, 400));
    const vis = (sel) => { const el = document.querySelector(sel); return !!el && !el.hidden && getComputedStyle(el).display !== "none"; };
    const input = document.querySelector("#find-file");
    return { ok: true, dropBack: vis("#find-drop"), cardGone: !vis("#find-upload-card"),
             inputCleared: !input || input.value === "", runGone: !vis("#find-image-run") };
  })()
`);
check("移除后：回到未上传状态", clearRes?.dropBack === true && clearRes?.cardGone === true, JSON.stringify(clearRes));
check("移除后：文件输入已清空", clearRes?.inputCleared === true);

// 重新上传，供后续结果验证
await evaluate(`
  (async () => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 480;
    const x = c.getContext("2d");
    x.fillStyle = "#6b5a44"; x.fillRect(0,0,640,480);
    x.fillStyle = "#2f2a22"; x.fillRect(150,180,150,240);
    x.fillStyle = "#3a2f26"; x.fillRect(350,170,150,250);
    x.fillStyle = "#c9c0b0"; x.fillRect(160,120,340,70);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    const file = new File([blob], "probe-scene.jpg", { type: "image/jpeg" });
    const input = document.querySelector("#find-file");
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    return 1;
  })()
`);

const runRes = await evaluate(`
  (async () => {
    const b = document.querySelector("#find-image-run");
    if (!b) return { ok: false, reason: "no-run-btn" };
    b.click();
    await new Promise(r => setTimeout(r, 5000));
    const cards = document.querySelectorAll(".find-ref-card");
    return {
      ok: true, cards: cards.length,
      firstCard: (() => {
        const c = cards[0]; if (!c) return null;
        return { hasImg: !!c.querySelector("img"), hasTitle: !!c.querySelector("em, strong"), inlineReasons: c.querySelectorAll(".find-ref-lead").length, extraInClosedDetails: c.querySelectorAll(".find-ref-more-body li").length, detailsClosed: [...c.querySelectorAll("details")].every(x => !x.open) };
      })(),
      detailsCount: document.querySelectorAll(".find-story, details").length,
      wallAboveResults: (() => {
        const wall = document.querySelector("#album-wall-wrap");
        const res = document.querySelector("#find-results");
        if (!wall || !res) return null;
        const wr = wall.getBoundingClientRect(), rr = res.getBoundingClientRect();
        return wr.height > 100 && wr.top < rr.top;
      })(),
      resultsTop: document.querySelector("#find-results")?.getBoundingClientRect().top + window.scrollY,
    };
  })()
`);
check("Desktop 检索出结果卡", (runRes?.cards || 0) > 0, `cards=${runRes?.cards}`);
check("Desktop 结果卡有图与标题", runRes?.firstCard?.hasImg === true && runRes?.firstCard?.hasTitle === true);
check("Desktop 每卡默认≤1 条核心依据", (runRes?.firstCard?.inlineReasons || 0) <= 1, `inline=${runRes?.firstCard?.inlineReasons}`);
check("Desktop 结果不被作品墙压到下方", runRes?.wallAboveResults === false, `resultsTop=${Math.round(runRes?.resultsTop || 0)}px`);
const s3 = await shot("desktop-03-results.png");

// 首屏 900px 内必须有结果
const firstScreen = await evaluate(`
  (() => {
    const r = document.querySelector("#find-results");
    if (!r) return null;
    const top = r.getBoundingClientRect().top + window.scrollY;
    return { top: Math.round(top), withinFirstScreen: top < window.innerHeight };
  })()
`);
check("Desktop 结果进入首屏 900px", firstScreen?.withinFirstScreen === true, `top=${firstScreen?.top}px`);

// ---------------------------------------------------------------------------
// MOBILE 390x844
// ---------------------------------------------------------------------------
console.log("\n=== Mobile 390x844 ===");
await viewport(390, 844);
await gotoFind();
const m1 = await measure();
check("Mobile 无横向溢出", m1?.overflowX === false, `scrollW=${m1?.scrollW} vw=${m1?.vw}`);
if (m1?.overflows?.length) console.log("    溢出元素:", JSON.stringify(m1.overflows));
const sm1 = await shot("mobile-01-default.png");
const fm = await focusProbe();
check("Mobile 键盘焦点可见", fm?.visible === true, JSON.stringify(fm));

const mUpload = await evaluate(`
  (async () => {
    window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: 1 });
    const c = document.createElement("canvas"); c.width = 480; c.height = 640;
    const x = c.getContext("2d");
    x.fillStyle = "#6b5a44"; x.fillRect(0,0,480,640);
    x.fillStyle = "#2f2a22"; x.fillRect(100,240,120,300);
    x.fillStyle = "#c9c0b0"; x.fillRect(120,160,240,60);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    const file = new File([blob], "portrait-scene.jpg", { type: "image/jpeg" });
    const btn = [...document.querySelectorAll("[data-find-mode]")].find(b => b.dataset.findMode === "image");
    if (btn) { btn.click(); await new Promise(r => setTimeout(r, 400)); }
    const input = document.querySelector("#find-file");
    if (!input) return { ok: false };
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const p = document.querySelector("#find-preview");
    const pr = p ? p.getBoundingClientRect() : null;
    return { ok: true, previewShown: !!p && !p.hidden, previewW: pr ? Math.round(pr.width) : 0, vw: window.innerWidth };
  })()
`);
check("Mobile 上传预览出现", mUpload?.previewShown === true);
check("Mobile 预览不超视口宽", (mUpload?.previewW || 0) <= (mUpload?.vw || 390), `${mUpload?.previewW}px / ${mUpload?.vw}px`);
const sm2 = await shot("mobile-02-uploaded.png");

const mRun = await evaluate(`
  (async () => {
    const b = document.querySelector("#find-image-run");
    if (b) { b.click(); await new Promise(r => setTimeout(r, 5000)); }
    const cards = document.querySelectorAll(".find-ref-card");
    const r = document.querySelector("#find-results");
    const top = r ? r.getBoundingClientRect().top + window.scrollY : null;
    const cw = cards[0] ? Math.round(cards[0].getBoundingClientRect().width) : 0;
    return { cards: cards.length, top: top ? Math.round(top) : null, cardWidth: cw, vw: window.innerWidth,
             details: document.querySelectorAll("details").length };
  })()
`);
check("Mobile 检索出结果卡", (mRun?.cards || 0) > 0, `cards=${mRun?.cards}`);
const m2 = await measure();
check("Mobile 结果页仍无横向溢出", m2?.overflowX === false, `scrollW=${m2?.scrollW}`);
const sm3 = await shot("mobile-03-results.png");

// 详情可展开
const expand = await evaluate(`
  (() => {
    const d = document.querySelector("#find-results details, .find-ref-card details");
    if (!d) return { ok: false, reason: "no-details" };
    const before = d.open;
    d.open = true;
    const h = d.getBoundingClientRect().height;
    d.open = false;
    const h2 = d.getBoundingClientRect().height;
    return { ok: true, expands: !before && h > h2, openedH: Math.round(h), closedH: Math.round(h2) };
  })()
`);
check("详情可展开/收起", expand?.expands === true, `${expand?.closedH}px → ${expand?.openedH}px`);

// ---------------------------------------------------------------------------
const summary = {
  phase: PHASE, ranAt: new Date().toISOString(), provider: "replayed-P4.2", paidCalls: 0,
  desktop: { htmlLen: d1?.htmlLen, darkSolidButtons: d1?.darkSolidButtons, scrollW: d1?.scrollW },
  mobile: { scrollW: m1?.scrollW, darkSolidButtons: m1?.darkSolidButtons },
  upload: uploadRes, results: runRes, mobileResults: mRun,
  pass, fail, rows,
};
writeFileSync(path.join(ROOT, ".p43-evidence", `p47-${PHASE}.json`), JSON.stringify(summary, null, 2));

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

console.log(`\n=== P4.7 UI 冒烟 (${PHASE}): ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter(x => !x.ok)) console.log(`  ${r.name} — ${r.detail}`);
console.log(`截图: .p43-evidence/p47-shots/${PHASE}/`);
if (d1?.darkSolidButtons?.length) console.log(`深色实心按钮(Desktop): ${JSON.stringify(d1.darkSolidButtons)}`);
setTimeout(() => process.exit(0), 400);
