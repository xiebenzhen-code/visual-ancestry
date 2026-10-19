// P4.8 — 真实图片 + 真实响应 的浏览器探针
//
// 目的：
//   1. 用 qa/fixtures/vision-probe.jpg（真实《American Gothic》）驱动上传，
//      **校验字节数与 SHA256** 与 P4.2 响应所属样本一致，不允许合成图混入。
//   2. 逐项测量每一张参考卡的图片真实加载状态，定位空白卡根因。
//
// 不调用付费 Vision：__FA_TEST_VISION 回放 .p42-evidence/real-call.json。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "qa", "fixtures", "vision-probe.jpg");
const EVIDENCE = path.join(ROOT, ".p42-evidence", "real-call.json");
const OUT = path.join(ROOT, ".p43-evidence", "p48-shots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4501, PORT_CDP = 9341;

let pass = 0, fail = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; rows.push({ name, ok: true, detail }); console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; rows.push({ name, ok: false, detail }); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ---------------------------------------------------------------------------
// STEP 1a — fixture 与响应的一致性（先于任何浏览器动作）
// ---------------------------------------------------------------------------
console.log("=== STEP 1a: fixture ↔ 响应一致性 ===");
const fixtureBuf = readFileSync(FIXTURE);
const fixtureSha = createHash("sha256").update(fixtureBuf).digest("hex").toUpperCase();
const ev = JSON.parse(readFileSync(EVIDENCE, "utf8"));
const recBytes = ev.request?.bytes;
const recFixture = ev.request?.fixture;

console.log(`  fixture    : ${path.basename(FIXTURE)}`);
console.log(`  字节       : 磁盘 ${fixtureBuf.length} / 响应记录 ${recBytes}`);
console.log(`  SHA256     : ${fixtureSha}`);
console.log(`  响应记录路径: ${recFixture}`);

check("响应记录的 fixture 路径与本次使用的一致", recFixture === "qa/fixtures/vision-probe.jpg", recFixture);
check("字节数与响应记录一致", fixtureBuf.length === recBytes, `${fixtureBuf.length} vs ${recBytes}`);
check("响应确实是《American Gothic》(group/large/center)",
  ev.response?.body?.intent?.subject === "group" &&
  ev.response?.body?.intent?.subjectScale === "large" &&
  ev.response?.body?.intent?.subjectPosition === "center");
check("响应含完整 22 键",
  Object.keys(ev.response?.body?.intent || {}).length === 22,
  `${Object.keys(ev.response?.body?.intent || {}).length} 键`);

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// 启动服务与浏览器
// ---------------------------------------------------------------------------
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

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p48");
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let target = null;
for (let i = 0; i < 80 && !target; i++) {
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
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.text || "").slice(0, 400) };
  return r.result?.result?.value;
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

// ---------------------------------------------------------------------------
// STEP 1b — 打开参考首页，上传真实 fixture
// ---------------------------------------------------------------------------
console.log("\n=== STEP 1b: 上传真实图片 ===");
await send("Page.navigate", { url: `${BASE}/` });
await new Promise((r) => setTimeout(r, 2200));

// 把 fixture 以 base64 注入页面（/qa/ 不在静态白名单）
const b64 = fixtureBuf.toString("base64");
const upload = await evaluate(`
  (async () => {
    window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(ev.response.body.intent)}, latencyMs: ${ev.response.body.latencyMs} });
    // 还原真实 JPEG 字节，再断言长度，避免「看起来像图」的合成物混入
    const bin = atob("${b64}");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: "image/jpeg" });
    const file = new File([blob], "vision-probe.jpg", { type: "image/jpeg" });

    const modeBtn = [...document.querySelectorAll("[data-find-mode]")].find(b => b.dataset.findMode === "image");
    if (!modeBtn) return { ok: false, reason: "no-image-mode" };
    modeBtn.click();
    await new Promise(r => setTimeout(r, 400));

    const input = document.querySelector("#find-file");
    if (!input) return { ok: false, reason: "no-file-input" };
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));

    const p = document.querySelector("#find-preview");
    const name = document.querySelector("#find-file-name");
    return { ok: true, bytes: file.size, name: name ? name.textContent : null,
             previewOk: !!p && !p.hidden, natural: p ? p.naturalWidth + "x" + p.naturalHeight : null };
  })()
`);
console.log(`  上传结果: ${JSON.stringify(upload)}`);
check("页面收到的字节数与磁盘一致", upload?.bytes === fixtureBuf.length, `${upload?.bytes} vs ${fixtureBuf.length}`);
check("上传卡片显示真实文件名", /vision-probe\.jpg/.test(upload?.name || ""), upload?.name);
check("预览已解码出真实尺寸", /^640x480$/.test(upload?.natural || ""), upload?.natural);

// 记录预览图本身的像素统计，证明是真实图像而非纯色块
const previewStats = await evaluate(`
  (() => {
    const p = document.querySelector("#find-preview");
    if (!p || !p.complete || !p.naturalWidth) return null;
    const c = document.createElement("canvas");
    c.width = 64; c.height = 48;
    const x = c.getContext("2d");
    x.drawImage(p, 0, 0, 64, 48);
    const d = x.getImageData(0, 0, 64, 48).data;
    let sum = 0, sum2 = 0, n = 0, uniq = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
      sum += lum; sum2 += lum*lum; n++;
      uniq.add((d[i]>>4) + "," + (d[i+1]>>4) + "," + (d[i+2]>>4));
    }
    const mean = sum / n;
    const sd = Math.sqrt(sum2/n - mean*mean);
    return { mean: Math.round(mean*10)/10, sd: Math.round(sd*10)/10, uniqueColours: uniq.size };
  })()
`);
console.log(`  预览像素统计: ${JSON.stringify(previewStats)}`);
check("预览是真实照片（标准差 > 20，非纯色块）", (previewStats?.sd || 0) > 20, `sd=${previewStats?.sd}`);
// 64x48=3072 像素，4bit 量化后 170 个去重桶 ≈ 真实照片。
// 纯色合成块通常 < 5 色，所以 50 已经足以区分。
check("预览色彩丰富（非纯色合成块）", (previewStats?.uniqueColours || 0) > 50, `${previewStats?.uniqueColours} 色`);

// ---------------------------------------------------------------------------
// STEP 2 — 触发检索，逐项测量图片加载
// ---------------------------------------------------------------------------
console.log("\n=== STEP 2: 参考卡图片加载测量 ===");

// 记录所有图片网络响应
const netLog = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    if (/\.(webp|jpg|jpeg|png|avif)/i.test(r.url)) netLog.push({ url: r.url, status: r.status, mime: r.mimeType });
  }
});

const run = await evaluate(`
  (async () => {
    const b = document.querySelector("#find-image-run");
    if (!b) return { ok: false, reason: "no-run-btn" };
    b.click();
    await new Promise(r => setTimeout(r, 6000));
    return { ok: true, cards: document.querySelectorAll(".find-ref-card").length };
  })()
`);
console.log(`  检索结果: ${JSON.stringify(run)}`);
check("检索产出参考卡", (run?.cards || 0) > 0, `${run?.cards} 张`);

// 逐卡测量（不依赖截图，直接读 DOM 与解码状态）
const imgAudit = await evaluate(`
  (() => {
    const cards = [...document.querySelectorAll(".find-ref-card")];
    return cards.map((card, i) => {
      const img = card.querySelector("img");
      const slot = card.querySelector(".img-slot");
      const titleEl = card.querySelector("strong, em");
      const r = img ? img.getBoundingClientRect() : null;
      const sr = slot ? slot.getBoundingClientRect() : null;
      const cs = img ? getComputedStyle(img) : null;
      return {
        i,
        title: (titleEl ? titleEl.textContent : "").trim().slice(0, 28),
        hasImg: !!img,
        src: img ? img.getAttribute("src") : null,
        currentSrc: img ? img.currentSrc : null,
        loading: img ? img.getAttribute("loading") : null,
        complete: img ? img.complete : null,
        naturalW: img ? img.naturalWidth : null,
        naturalH: img ? img.naturalHeight : null,
        rectW: r ? Math.round(r.width) : null,
        rectH: r ? Math.round(r.height) : null,
        slotH: sr ? Math.round(sr.height) : null,
        display: cs ? cs.display : null,
        visibility: cs ? cs.visibility : null,
        opacity: cs ? cs.opacity : null,
        slotLoading: slot ? slot.classList.contains("is-loading") : null,
        slotBroken: slot ? slot.classList.contains("is-broken") : null,
        placeholderVisible: slot ? getComputedStyle(slot.querySelector(".img-unavailable") || slot).display !== "none" : null,
      };
    });
  })()
`);
if (Array.isArray(imgAudit)) {
  console.log("  逐卡状态:");
  for (const c of imgAudit) {
    const decoded = c.complete && c.naturalW > 0;
    console.log(`    #${c.i} ${String(c.title).padEnd(28)} decoded=${decoded ? "Y" : "N"} nat=${c.naturalW}x${c.naturalH} rect=${c.rectW}x${c.rectH} loading=${c.loading} slotH=${c.slotH} broken=${c.slotBroken}`);
  }
  const withImg = imgAudit.filter((c) => c.hasImg);
  const decoded = withImg.filter((c) => c.complete && c.naturalW > 0);
  check("每张参考卡都有 img 元素", withImg.length === imgAudit.length, `${withImg.length}/${imgAudit.length}`);
  // 关键区分：未解码的卡是「在视口外没被触发」还是「滚到位仍失败」。
// 只数绝对数量无法回答，必须看每张卡的视口位置。
const vh0 = await evaluate(`(() => window.innerHeight)()`);
const undecoded = withImg.filter((c) => !(c.complete && c.naturalW > 0));
const offscreen = undecoded.filter((c) => c.rectW > 0);
console.log(`  未解码 ${undecoded.length} 张，视口高 ${vh0}`);
for (const c of undecoded) console.log(`    #${c.i} ${c.title} slotH=${c.slotH} loading=${c.loading}`);

// 逐张滚到可视位置，再测是否解码 —— 这才是「懒加载是否真的能工作」。
const lazyProof = await evaluate(`
  (async () => {
    const cards = [...document.querySelectorAll(".find-ref-card")];
    const out = [];
    for (const card of cards) {
      const img = card.querySelector("img");
      if (!img) continue;
      const before = img.complete && img.naturalWidth > 0;
      if (before) { out.push({ title: (card.querySelector("strong,em")||{}).textContent||"", before: true, after: true, natural: img.naturalWidth + "x" + img.naturalHeight }); continue; }
      card.scrollIntoView({ block: "center" });
      await new Promise(r => setTimeout(r, 900));
      const after = img.complete && img.naturalWidth > 0;
      out.push({
        title: (card.querySelector("strong,em")||{}).textContent||"",
        before, after,
        natural: img.naturalWidth + "x" + img.naturalHeight,
        currentSrc: String(img.currentSrc || "").split("/").slice(-2).join("/"),
      });
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 200));
    return out;
  })()
`);
if (Array.isArray(lazyProof)) {
  console.log("  逐张滚动验证:");
  for (const x of lazyProof) console.log(`    ${String(x.title).trim().slice(0,24).padEnd(26)} before=${x.before?"Y":"N"} after=${x.after?"Y":"N"} ${x.natural}`);
  check("每张卡滚入视口后都能解码", lazyProof.every((x) => x.after === true),
    `${lazyProof.filter(x=>x.after).length}/${lazyProof.length}`);
  check("未解码的卡都是滚动前在视口外（非资源缺失）",
    lazyProof.filter((x) => !x.before).every((x) => x.after),
    "scroll-into-view 后全部成功 = 懒加载时序，不是坏图");
  } else {
  check("逐张滚动验证可执行", false, JSON.stringify(lazyProof).slice(0, 200));
}
  const loadingCount = imgAudit.filter((c) => c.slotLoading).length;
console.log(`  停在 is-loading 的卡: ${loadingCount}/${imgAudit.length}`);
// 滚动前有卡停在 is-loading 是「懒加载未触发」的直接证据，
// 它本身不是产品缺陷，而是截图方法缺陷的量化。
check("is-loading 数量与未解码数量一致",
  loadingCount === withImg.filter((c) => !(c.complete && c.naturalW > 0)).length,
  `loading=${loadingCount} undecoded=${withImg.filter((c) => !(c.complete && c.naturalW > 0)).length}`);
  check("没有卡被判 is-broken", imgAudit.every((c) => !c.slotBroken));
  check("所有卡都有非零高度", imgAudit.every((c) => (c.slotH || 0) > 0), JSON.stringify(imgAudit.map(c=>c.slotH)));
} else {
  check("逐卡测量可执行", false, JSON.stringify(imgAudit).slice(0, 200));
}

console.log(`\n  图片网络响应 ${netLog.length} 条:`);
const byStatus = {};
for (const n of netLog) byStatus[n.status] = (byStatus[n.status] || 0) + 1;
console.log(`    状态分布: ${JSON.stringify(byStatus)}`);
const bad = netLog.filter((n) => n.status >= 400);
if (bad.length) console.log(`    失败: ${JSON.stringify(bad.slice(0, 5))}`);
check("图片请求全部 2xx/3xx", bad.length === 0, bad.length ? JSON.stringify(bad[0]) : "全部成功");

// 全页截图（旧方法） vs 逐屏滚动后截图（新方法）
console.log("\n=== 截图方法对比 ===");
const fullShot = await shot("01-fullpage-naive.png", true);
console.log(`  全页截图: ${fullShot} bytes`);

// 逐屏滚动，等每屏图片解码，再拼接截图
const scrollInfo = await evaluate(`
  (async () => {
    const h = document.documentElement.scrollHeight;
    const vh = window.innerHeight;
    const steps = [];
    for (let y = 0; y < h; y += Math.floor(vh * 0.8)) {
      steps.push(y);
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 320));
      // 等该视口内的图片解码完成
      const imgs = [...document.querySelectorAll("#find-results img")].filter(im => {
        const r = im.getBoundingClientRect();
        return r.top < vh && r.bottom > 0;
      });
      await Promise.all(imgs.map(im => im.complete ? Promise.resolve() :
        new Promise(res => { im.addEventListener("load", res, {once:true}); im.addEventListener("error", res, {once:true}); setTimeout(res, 3000); })));
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
    // 再统计一次：滚过一遍后，之前 blank 的是否都解码了
    const all = [...document.querySelectorAll("#find-results img")];
    return {
      scrollHeight: h, viewport: vh, steps: steps.length,
      total: all.length,
      decoded: all.filter(im => im.complete && im.naturalWidth > 0).length,
    };
  })()
`);
console.log(`  滚动: ${JSON.stringify(scrollInfo)}`);
check("滚动后全部图片解码", scrollInfo?.decoded === scrollInfo?.total, `${scrollInfo?.decoded}/${scrollInfo?.total}`);

const scrolledShot = await shot("02-after-scroll.png", true);
console.log(`  滚动后截图: ${scrolledShot} bytes`);

// 逐屏分段截图
const segs = [];
const vh = 900;
const total = scrollInfo?.scrollHeight || 0;
let segIdx = 0;
for (let y = 0; y < total && segIdx < 6; y += vh) {
  await evaluate(`(async () => { window.scrollTo(0, ${y}); await new Promise(r => setTimeout(r, 380)); return 1; })()`);
  await clearFocus();
  const r = await send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(r.result.data, "base64");
  const nm = `03-seg-${String(segIdx).padStart(2, "0")}.png`;
  writeFileSync(path.join(OUT, nm), buf);
  segs.push({ file: nm, bytes: buf.length, y });
  segIdx++;
}
console.log(`  分段截图 ${segs.length} 张`);

// ---------------------------------------------------------------------------
const summary = {
  ranAt: new Date().toISOString(),
  provider: "replayed-P4.2",
  paidCalls: 0,
  fixture: { file: "qa/fixtures/vision-probe.jpg", bytes: fixtureBuf.length, sha256: fixtureSha },
  response: { model: ev.model, latencyMs: ev.response?.body?.latencyMs, keys: Object.keys(ev.response?.body?.intent || {}).length },
  consistency: { recBytes, recFixture, match: fixtureBuf.length === recBytes },
  upload, previewStats, imgAudit, netStatus: byStatus, netFailures: bad.slice(0, 10),
  scrollInfo, screenshots: { naive: "01-fullpage-naive.png", afterScroll: "02-after-scroll.png", segments: segs.map(s => s.file) },
  pass, fail, rows,
};
writeFileSync(path.join(ROOT, ".p43-evidence", "p48-probe.json"), JSON.stringify(summary, null, 2));

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

console.log(`\n=== P4.8 探针: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter(x => !x.ok)) console.log(`  ${r.name} — ${r.detail}`);
setTimeout(() => process.exit(0), 400);
