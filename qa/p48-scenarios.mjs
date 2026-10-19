// P4.8 STEP 5/6 — 能力边界实测 + 三个用户场景截图
//
// A. 真实《American Gothic》→ 颜色 + 视觉参考，无空白卡（桌面 + 移动）
// B. 文字片名 → Commons 真实新候选（桌面 + 移动）
// C. 上传图片 + 选电影 → 如实展示当前能力（桌面 + 移动）
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".p43-evidence", "p48-scenarios");
const FIXTURE = path.join(ROOT, "qa", "fixtures", "vision-probe.jpg");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4505, PORT_CDP = 9345;

let pass = 0, fail = 0;
const rows = [];
const check = (n, c, d = "") => {
  if (c) { pass++; rows.push({ n, ok: true, d }); console.log(`  PASS ${n}${d ? " — " + d : ""}`); }
  else { fail++; rows.push({ n, ok: false, d }); console.log(`  FAIL ${n}${d ? " — " + d : ""}`); }
};

mkdirSync(OUT, { recursive: true });
const fixtureBuf = readFileSync(FIXTURE);
const fixtureSha = createHash("sha256").update(fixtureBuf).digest("hex").toUpperCase();
const ev = JSON.parse(readFileSync(path.join(ROOT, ".p42-evidence", "real-call.json"), "utf8"));
const RAW = ev.response.body.intent;

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

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p48s");
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
const commonsReqs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent" && /commons\.wikimedia\.org/.test(m.params.request.url)) {
    commonsReqs.push(m.params.request.url);
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 });
  if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.text || "").slice(0, 400) };
  return r.result?.result?.value;
};
const viewport = async (w, h) => {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
};
const clearFocus = async () => { await evaluate(`(() => { const a=document.activeElement; if(a&&a.blur)a.blur(); return 1; })()`); await new Promise(r=>setTimeout(r,70)); };

// 逐屏滚动 + 等解码后再截图
// 分段截图：逐屏滚动 -> 等解码 -> 截当前视口。
// 不用 captureBeyondViewport：它会把 position:sticky 顶栏在长图里重复拼出来，
// 造成「页面渲染了两次」的假象（DOM 实测 topbarCount=1）。
const shotSegmented = async (prefix, { expectSel = "#find-results, #find-remote", maxSeg = 5 } = {}) => {
  await evaluate("(() => { window.scrollTo(0,0); return 1; })()");
  await new Promise((r) => setTimeout(r, 200));
  const total = await evaluate("(() => document.documentElement.scrollHeight)()");
  const vh = await evaluate("(() => window.innerHeight)()");
  const segs = [];
  for (let i = 0; i < maxSeg; i++) {
    const y = i * vh;
    if (y >= total) break;
    const selJson = JSON.stringify(expectSel);
    const expr =
      "(async () => {" +
      "  window.scrollTo(0, " + y + ");" +
      "  await new Promise(r => setTimeout(r, 420));" +
      "  const vh = window.innerHeight;" +
      "  const imgs = [...document.querySelectorAll(" + selJson + " + ' img')].filter(im => {" +
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
    const nm = prefix + "-seg" + i + ".png";
    writeFileSync(path.join(OUT, nm), buf);
    segs.push({ file: nm, bytes: buf.length, y });
  }
  await evaluate("(() => { window.scrollTo(0,0); return 1; })()");
  return segs;
};
const shotScrolled = async (name, { expectSel = "#find-results, #find-remote" } = {}) => {
  await evaluate(`
    (async () => {
      const h = document.documentElement.scrollHeight, vh = window.innerHeight;
      for (let y = 0; y < h; y += Math.floor(vh * 0.75)) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 260));
        const imgs = [...document.querySelectorAll(${JSON.stringify(expectSel)} + " img")].filter(im => {
          const r = im.getBoundingClientRect();
          return r.top < vh && r.bottom > 0 && !(im.complete && im.naturalWidth > 0);
        });
        await Promise.all(imgs.map(im => new Promise(res => {
          im.addEventListener("load", res, { once: true });
          im.addEventListener("error", res, { once: true });
          setTimeout(res, 2500);
        })));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 250));
      return 1;
    })()
  `);
  await clearFocus();
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const buf = Buffer.from(r.result.data, "base64");
  writeFileSync(path.join(OUT, name), buf);
  return buf.length;
};

const b64 = fixtureBuf.toString("base64");

// ===========================================================================
// A. 真实图片 → 颜色 + 视觉参考，无空白卡
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== 场景 A (${tag} ${w}x${h}) ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2300));

  const up = await evaluate(`
    (async () => {
      window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: ${ev.response.body.latencyMs} });
      const bin = atob("${b64}");
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([new Blob([arr], { type: "image/jpeg" })], "vision-probe.jpg", { type: "image/jpeg" });
      const mb = [...document.querySelectorAll("[data-find-mode]")].find(b => b.dataset.findMode === "image");
      if (mb) { mb.click(); await new Promise(r => setTimeout(r, 400)); }
      const input = document.querySelector("#find-file");
      if (!input) return { ok: false };
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      document.querySelector("#find-image-run")?.click();
      await new Promise(r => setTimeout(r, 7000));
      return { ok: true };
    })()
  `);

  const res = await evaluate(`
    (() => {
      const cards = [...document.querySelectorAll(".find-ref-card")];
      const imgs = cards.map(c => { const im = c.querySelector("img"); return im ? { complete: im.complete, nw: im.naturalWidth, src: String(im.currentSrc||"").split("/").slice(-1)[0].slice(0,40) } : null; }).filter(Boolean);
      const intent = document.querySelector("#find-intent");
      const colourLine = intent ? (intent.innerText.match(/明度[^\\n]*/)||[""])[0] : "";
      return {
        cards: cards.length,
        decoded: imgs.filter(i => i.complete && i.nw > 0).length,
        total: imgs.length,
        colourLine: colourLine.slice(0, 90),
        noBlankWarning: !/图像暂不可用/.test(document.body.innerText),
      };
    })()
  `);
  console.log(`  ${JSON.stringify(res)}`);
  // 截图前的瞬时数量：越小越说明懒加载在工作（视口外的图还没请求）。
  console.log(`  截图前瞬时: ${res?.decoded}/${res?.total} 已解码（其余在视口外，未触发懒加载）`);
  check(`A/${tag}: 参考卡有图像元素`, (res?.total || 0) > 0, `${res?.total} 张`);
  check(`A/${tag}: 有真实颜色信息`, /明度/.test(res?.colourLine || ""), res?.colourLine);
  check(`A/${tag}: 没有「图像暂不可用」占位`, res?.noBlankWarning === true);

  const cardLayout = await evaluate(`
    (() => {
      return [...document.querySelectorAll('.find-ref-card')].map((c, i) => {
        const img = c.querySelector('img');
        const head = c.querySelector('.find-ref-head');
        const titleEl = c.querySelector('strong');
        const emEl = c.querySelector('em');
        const lead = c.querySelector('.find-ref-lead');
        const cr = c.getBoundingClientRect();
        const ir = img ? img.getBoundingClientRect() : null;
        const hr = head ? head.getBoundingClientRect() : null;
        return {
          i,
          cardH: Math.round(cr.height),
          imgH: ir ? Math.round(ir.height) : null,
          headH: hr ? Math.round(hr.height) : null,
          headBelowImg: ir && hr ? (hr.top >= ir.bottom - 2) : null,
          title: titleEl ? titleEl.textContent.trim().slice(0,18) : null,
          subtitle: emEl ? emEl.textContent.trim().slice(0,20) : null,
          leadLen: lead ? lead.textContent.trim().length : 0,
          headVisible: hr ? (hr.height > 10 && getComputedStyle(head).display !== 'none') : false,
        };
      });
    })()
  `);
  console.log('  卡片排版:');
  for (const c of (cardLayout || [])) console.log(`    #${c.i} cardH=${c.cardH} imgH=${c.imgH} headH=${c.headH} below=${c.headBelowImg} title="${c.title}" lead=${c.leadLen}`);
  check(`A/${tag}: 每张卡都有可见标题区`, (cardLayout||[]).every(c => c.headVisible === true),
    JSON.stringify((cardLayout||[]).filter(c=>!c.headVisible).map(c=>c.i)));
  check(`A/${tag}: 标题在图片下方（未被图覆盖）`, (cardLayout||[]).every(c => c.headBelowImg !== false),
    JSON.stringify((cardLayout||[]).filter(c=>c.headBelowImg===false).map(c=>c.i)));
  check(`A/${tag}: 每张卡有且仅有一条核心依据`, (cardLayout||[]).every(c => c.leadLen > 0),
    JSON.stringify((cardLayout||[]).map(c=>c.leadLen)));

  const segA = await shotSegmented(`A-${tag}`);
  console.log(`  A/${tag} 分段截图 ${segA.length} 张`);

  // 截图后再测一次：shotScrolled 已逐屏滚动并等解码，此时仍失败的才是真问题。
  const afterScroll = await evaluate(`
    (() => {
      const cards = [...document.querySelectorAll(".find-ref-card")];
      const detail = cards.map((c, i) => {
        const im = c.querySelector("img");
        const slot = c.querySelector(".img-slot");
        return {
          i,
          title: ((c.querySelector("strong,em")||{}).textContent||"").trim().slice(0,20),
          ok: !!(im && im.complete && im.naturalWidth > 0),
          nw: im ? im.naturalWidth : null,
          src: im ? String(im.currentSrc||"").split("/").slice(-2).join("/") : null,
          slotLoading: slot ? slot.classList.contains("is-loading") : null,
          slotBroken: slot ? slot.classList.contains("is-broken") : null,
          placeholderShown: slot ? getComputedStyle(slot.querySelector(".img-unavailable")).display !== "none" : null,
        };
      });
      return { detail, decoded: detail.filter(d=>d.ok).length, total: detail.length };
    })()
  `);
  console.log(`  滚动后: ${afterScroll?.decoded}/${afterScroll?.total}`);
  for (const d of (afterScroll?.detail||[]).filter(x=>!x.ok)) {
    console.log(`    未解码 #${d.i} ${d.title} loading=${d.slotLoading} broken=${d.slotBroken} placeholder=${d.placeholderShown} src=${d.src}`);
  }
  check(`A/${tag}: 滚动后参考卡全部可解码`, afterScroll?.decoded === afterScroll?.total, `${afterScroll?.decoded}/${afterScroll?.total}`);
  check(`A/${tag}: 未解码的卡有明确占位说明（不留无说明空白）`,
    (afterScroll?.detail||[]).filter(x=>!x.ok).every(x=>x.placeholderShown === true),
    JSON.stringify((afterScroll?.detail||[]).filter(x=>!x.ok).map(x=>x.placeholderShown)));
}

// ===========================================================================
// B. 文字片名 → Commons 真实新候选
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== 场景 B (${tag} ${w}x${h}) ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2300));
  const before = commonsReqs.length;

  const r1 = await evaluate(`
    (async () => {
      const fb = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
      if (fb) { fb.click(); await new Promise(r => setTimeout(r, 300)); }
      const input = document.querySelector("#find-text");
      input.value = "Battleship Potemkin";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const form = document.querySelector("#album-search");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 12000));
      return { ok: true };
    })()
  `);

  const dom = await evaluate(`
    (() => {
      const host = document.querySelector("#find-remote");
      if (!host) return { ok: false };
      const imgs = [...host.querySelectorAll("img")].map(im => ({ complete: im.complete, nw: im.naturalWidth }));
      return {
        ok: true,
        decoded: imgs.filter(i => i.complete && i.nw > 0).length,
        total: imgs.length,
        hasCommons: /commons\\.wikimedia\\.org/.test(host.innerHTML),
        hasLicence: /Public domain|公有领域|PD-/.test(host.innerText),
        text: (host.innerText||"").replace(/\\s+/g," ").slice(0, 300),
      };
    })()
  `);
  const reqs = commonsReqs.slice(before);
  console.log(`  Commons 请求 ${reqs.length} · 图片 ${dom?.decoded}/${dom?.total} · 许可 ${dom?.hasLicence}`);
  console.log(`  文本: ${(dom?.text||"").slice(0, 200)}`);
  check(`B/${tag}: 真实发出 Commons 请求`, reqs.length > 0, `${reqs.length} 条`);
  check(`B/${tag}: 远程图片可解码`, (dom?.decoded || 0) > 0, `${dom?.decoded}/${dom?.total}`);
  check(`B/${tag}: 展示原始来源链接`, dom?.hasCommons === true);
  check(`B/${tag}: 展示许可状态`, dom?.hasLicence === true);

  const dupAudit = await evaluate(`
    (() => {
      const tops = [...document.querySelectorAll('.topbar')];
      const brands = [...document.querySelectorAll('.brand')];
      const sections = [...document.querySelectorAll('.find-page')];
      return {
        topbarCount: tops.length,
        brandCount: brands.length,
        findPageCount: sections.length,
        bodyScrollH: document.documentElement.scrollHeight,
        appChildCount: document.querySelector('#app') ? document.querySelector('#app').children.length : null,
        topbarRects: tops.map(t => { const r = t.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), pos: getComputedStyle(t).position }; }),
      };
    })()
  `);
  console.log(`  重复顶栏审计: ${JSON.stringify(dupAudit)}`);
  check(`B/${tag}: 页面只有一个顶栏（无重复渲染）`, dupAudit?.topbarCount === 1, `topbar=${dupAudit?.topbarCount} findPage=${dupAudit?.findPageCount}`);

  const segB = await shotSegmented(`B-${tag}`);
  console.log(`  B/${tag} 分段截图 ${segB.length} 张`);
}

// ===========================================================================
// C. 上传图片 + 选电影 → 如实展示能力边界
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== 场景 C (${tag} ${w}x${h}) ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2300));
  const before = commonsReqs.length;

  const c1 = await evaluate(`
    (async () => {
      window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: 1 });
      // 先选「电影」媒介，再切到上传图片
      const fb = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
      if (fb) { fb.click(); await new Promise(r => setTimeout(r, 250)); }
      const mb = [...document.querySelectorAll("[data-find-mode]")].find(b => b.dataset.findMode === "image");
      if (mb) { mb.click(); await new Promise(r => setTimeout(r, 400)); }
      const bin = atob("${b64}");
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([new Blob([arr], { type: "image/jpeg" })], "vision-probe.jpg", { type: "image/jpeg" });
      const input = document.querySelector("#find-file");
      if (!input) return { ok: false, reason: "no-input" };
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));
      document.querySelector("#find-image-run")?.click();
      await new Promise(r => setTimeout(r, 8000));
      const remoteHost = document.querySelector("#find-remote");
      return {
        ok: true,
        remoteHostExists: !!remoteHost,
        remoteText: remoteHost ? (remoteHost.innerText||"").replace(/\\s+/g," ").slice(0, 260) : "",
        remoteImgCount: remoteHost ? remoteHost.querySelectorAll("img").length : 0,
        activeMedia: [...document.querySelectorAll("[data-find-media]")].filter(b=>b.classList.contains("is-on")).map(b=>b.textContent.trim()),
      };
    })()
  `);
  const reqs = commonsReqs.slice(before);
  console.log(`  remoteHost=${c1?.remoteHostExists} 图片=${c1?.remoteImgCount} Commons请求=${reqs.length}`);
  console.log(`  媒介选中: ${JSON.stringify(c1?.activeMedia)}`);
  console.log(`  远程区文本: ${(c1?.remoteText||"(空)").slice(0, 200)}`);

  // 能力边界断言：图片路径不应产生任何远程电影候选
  check(`C/${tag}: 图片路径没有发出 Commons 请求`, reqs.length === 0, `${reqs.length} 条（0 = 图片路径不触发远程）`);
  check(`C/${tag}: 图片路径不产出远程电影候选`, (c1?.remoteImgCount || 0) === 0, `${c1?.remoteImgCount} 张`);

  const segC = await shotSegmented(`C-${tag}`);
  console.log(`  C/${tag} 分段截图 ${segC.length} 张`);
}

const summary = {
  ranAt: new Date().toISOString(),
  paidCalls: 0,
  fixture: { sha256: fixtureSha, bytes: fixtureBuf.length },
  commonsRequestTotal: commonsReqs.length,
  pass, fail, rows,
};
writeFileSync(path.join(ROOT, ".p43-evidence", "p48-scenarios.json"), JSON.stringify(summary, null, 2));

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

console.log(`\n=== P4.8 场景验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter((x) => !x.ok)) console.log(`  ${r.n} — ${r.d}`);
setTimeout(() => process.exit(0), 400);
