// P4.9 — 最小真实验收（A / B / C）
//
// A. 英文片名 Battleship Potemkin → 浏览器真实取到 Commons 新图像
// B. 上传真实图 + 仅电影 → 本地候选全为电影 + 远程发现如实返回
// C. 桌面与移动端 → 远程卡可读、图像解码、详情可展开
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".p43-evidence", "p49-shots");
const FIXTURE = path.join(ROOT, "qa", "fixtures", "vision-probe.jpg");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4507, PORT_CDP = 9347;

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

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p49");
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
const imgResp = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent" && /commons\.wikimedia\.org|upload\.wikimedia\.org|thumb\.wikimedia\.org/.test(m.params.request.url)) {
    commonsReqs.push(m.params.request.url);
  }
  if (m.method === "Network.responseReceived") {
    imgResp.set(m.params.requestId, { url: m.params.response.url, status: m.params.response.status, mime: m.params.response.mimeType });
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 });
  if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.text || "").slice(0, 400) };
  return r.result?.result?.value;
};
const viewport = async (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
const clearFocus = async () => { await evaluate("(() => { const a=document.activeElement; if(a&&a.blur)a.blur(); return 1; })()"); await new Promise(r=>setTimeout(r,80)); };

const shotSegmented = async (prefix, { maxSeg = 5 } = {}) => {
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
    const nm = prefix + "-seg" + i + ".png";
    writeFileSync(path.join(OUT, nm), buf);
    segs.push({ file: nm, bytes: buf.length, y });
  }
  await evaluate("(() => { window.scrollTo(0,0); return 1; })()");
  return segs;
};

const b64 = fixtureBuf.toString("base64");
const audit = {};

// ===========================================================================
// A. 英文片名 → Commons 新图像（桌面 + 移动）
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== A (${tag} ${w}x${h}): Battleship Potemkin ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2300));
  const before = commonsReqs.length;

  await evaluate(`
    (async () => {
      const fb = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
      if (fb) { fb.click(); await new Promise(r => setTimeout(r, 300)); }
      const input = document.querySelector("#find-text");
      input.value = "Battleship Potemkin";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const form = document.querySelector("#album-search");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // 轮询等待远程卡出现（Commons 冷启动 + 逐图请求，固定 13s 不稳）
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const n = document.querySelectorAll("#find-remote .find-hit-film").length;
        if (n > 0) { await new Promise(r => setTimeout(r, 2500)); break; }
      }
      return 1;
    })()
  `);

  const dom = await evaluate(`
    (() => {
      const host = document.querySelector("#find-remote");
      if (!host) return { ok: false };
      const cards = [...host.querySelectorAll(".find-hit-film")];
      const imgs = [...host.querySelectorAll("img")].map(im => ({
        ok: !!(im.complete && im.naturalWidth > 0), nw: im.naturalWidth,
        src: String(im.currentSrc || "").split("/").pop().slice(0, 40),
        decodedUrl: String(im.currentSrc || ""),
      }));
      const details = [...host.querySelectorAll(".find-remote-more")];
      const colCount = (() => {
        const g = host.querySelector(".find-remote-results");
        if (!g) return null;
        const cs = getComputedStyle(g);
        return cs.gridTemplateColumns ? cs.gridTemplateColumns.split(" ").length : null;
      })();
      return {
        ok: true, cards: cards.length, imgs,
        decoded: imgs.filter(i => i.ok).length,
        detailsCount: details.length,
        detailsClosed: details.every(d => !d.open),
        colCount,
        gridWidth: (() => { const g = host.querySelector(".find-remote-results"); return g ? Math.round(g.getBoundingClientRect().width) : null; })(),
        cardWidths: cards.map(c => Math.round(c.getBoundingClientRect().width)),
        hasLicence: /Public domain|公有领域|PD-/.test(host.innerText),
        hasStatement: /画面相似性尚未验证|待视觉核验|不是模型对图像的视觉分析/.test(host.innerText),
      };
    })()
  `);
  const reqs = commonsReqs.slice(before);
  console.log(`  卡片 ${dom?.cards} · 图片 ${dom?.decoded}/${dom?.imgs?.length} · 列数 ${dom?.colCount} · 请求 ${reqs.length}`);
  console.log(`  卡宽: ${JSON.stringify(dom?.cardWidths)}`);
  check(`A/${tag}: 真实发出 Commons 请求`, reqs.length > 0, `${reqs.length} 条`);
  check(`A/${tag}: 渲染出电影卡`, (dom?.cards || 0) > 0, `${dom?.cards} 张`);
  // 滚动逐张触发懒加载后再判定解码（全页瞬时测量会少算视口外的图）。
  const afterScroll = await evaluate(`
    (async () => {
      const cards = [...document.querySelectorAll("#find-remote .find-hit-film")];
      for (const c of cards) {
        c.scrollIntoView({ block: "center" });
        await new Promise(r => setTimeout(r, 320));
        const im = c.querySelector("img");
        if (im && !(im.complete && im.naturalWidth > 0)) {
          await new Promise(res => {
            im.addEventListener("load", res, { once: true });
            im.addEventListener("error", res, { once: true });
            setTimeout(res, 3000);
          });
        }
      }
      window.scrollTo(0, 0);
      const imgs = [...document.querySelectorAll("#find-remote img")];
      return { total: imgs.length, decoded: imgs.filter(im => im.complete && im.naturalWidth > 0).length };
    })()
  `);
  check(`A/${tag}: 远程图像已解码（滚动后）`, (afterScroll?.decoded || 0) > 0 && afterScroll?.decoded === afterScroll?.total,
    `${afterScroll?.decoded}/${afterScroll?.total}`);
  check(`A/${tag}: 详情默认收起`, dom?.detailsClosed === true, `${dom?.detailsCount} 个 details`);

  audit[`A-${tag}`] = { dom, reqs: reqs.slice(0, 10) };
  const segs = await shotSegmented(`A-${tag}`);
  console.log(`  A/${tag} 分段截图 ${segs.length} 张`);
}

// ===========================================================================
// B. 上传真实图 + 仅电影
// ===========================================================================
for (const [tag, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  console.log(`\n=== B (${tag} ${w}x${h}): 上传图 + 仅电影 ===`);
  await viewport(w, h);
  await send("Page.navigate", { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 2300));
  const before = commonsReqs.length;

  await evaluate(`
    (async () => {
      window.__FA_TEST_VISION = async () => ({ ok: true, raw: ${JSON.stringify(RAW)}, latencyMs: ${ev.response.body.latencyMs} });
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
      // 轮询等待远程电影区出结果（Commons 冷启动 + 多条请求，固定等待不稳）
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const t = document.querySelector("#find-remote")?.innerText || "";
        if (/件；|未找到|未发起|不支持|没有/.test(t) && !/正在按视觉概念检索/.test(t)) break;
      }
      await new Promise(r => setTimeout(r, 1200));
      return 1;
    })()
  `);

  // 先滚动逐张等远程图解码，再测量（否则视口外的图未请求，会误判为解码失败）。
  await evaluate(`
    (async () => {
      const cards = [...document.querySelectorAll("#find-remote .find-hit-film")];
      for (const c of cards) {
        c.scrollIntoView({ block: "center" });
        await new Promise(r => setTimeout(r, 300));
        const im = c.querySelector("img");
        if (im && !(im.complete && im.naturalWidth > 0)) {
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
  `);
  const dom = await evaluate(`
    (() => {
      const local = [...document.querySelectorAll("#find-results .find-ref-card")];
      const remoteHost = document.querySelector("#find-remote");
      const remoteCards = remoteHost ? [...remoteHost.querySelectorAll(".find-hit-film")] : [];
      const remoteImgs = remoteHost ? [...remoteHost.querySelectorAll("img")] : [];
      // 本地候选的媒介：卡片上是否出现"导演"字样（电影专用标签）
      const localDirectors = local.map(c => /导演/.test(c.innerText));
      const localPainters = local.map(c => /^[A-Z][a-z]+ [A-Z]/.test((c.querySelector("strong")||{}).textContent||""));
      return {
        localCards: local.length,
        localWithDirectorLabel: localDirectors.filter(Boolean).length,
        remoteCards: remoteCards.length,
        remoteDecoded: remoteImgs.filter(im => im.complete && im.naturalWidth > 0).length,
        remoteImgs: remoteImgs.length,
        remoteText: remoteHost ? (remoteHost.innerText||"").replace(/\\s+/g," ").slice(0, 320) : "",
        hasUnverifiedStatement: remoteHost ? /画面相似性尚未验证|待视觉核验/.test(remoteHost.innerText) : false,
        colCount: (() => { const g = remoteHost?.querySelector(".find-remote-results"); if (!g) return null; return getComputedStyle(g).gridTemplateColumns.split(" ").length; })(),
      };
    })()
  `);
  const reqs = commonsReqs.slice(before);
  console.log(`  本地卡 ${dom?.localCards}（导演标签 ${dom?.localWithDirectorLabel}）· 远程卡 ${dom?.remoteCards} · 远程图 ${dom?.remoteDecoded}/${dom?.remoteImgs} · Commons 请求 ${reqs.length}`);
  console.log(`  远程文本: ${(dom?.remoteText||"(空)").slice(0,220)}`);

  check(`B/${tag}: 本地候选全部为电影`, (dom?.localCards || 0) > 0 && dom?.localWithDirectorLabel === dom?.localCards,
    `${dom?.localWithDirectorLabel}/${dom?.localCards} 带导演标签`);
  check(`B/${tag}: 图片路径发出 Commons 请求（原缺失已修）`, reqs.length > 0, `${reqs.length} 条`);
  check(`B/${tag}: 远程候选如实返回或说明`, (dom?.remoteCards || 0) > 0 || /未找到|未发起|不支持/.test(dom?.remoteText || ""),
    `${dom?.remoteCards} 张 / 文本长度 ${(dom?.remoteText||"").length}`);
  // P4.9 收尾后，仅片名撞词的候选移入默认收起的探索区。
  // 实测诊断：远程区 5 张图全为 loading=lazy，其中第 5 张在收起的 details 里。
  // 所以判据应当是「滚动到每张正式区图片并等解码」，而不是一次性数解码数量。
  const visImgs = await evaluate(`
    (async () => {
      // 仅处理不在 details 里的图（正式区）；收起区不展开就不请求，是正确行为。
      const imgs = [...document.querySelectorAll("#find-remote img")].filter(im => !im.closest("details"));
      for (const im of imgs) {
        im.scrollIntoView({ block: "center" });
        await new Promise(r => setTimeout(r, 300));
        if (!(im.complete && im.naturalWidth > 0)) {
          await new Promise(res => {
            im.addEventListener("load", res, { once: true });
            im.addEventListener("error", res, { once: true });
            setTimeout(res, 3000);
          });
        }
      }
      window.scrollTo(0, 0);
      return { total: imgs.length, decoded: imgs.filter(im => im.complete && im.naturalWidth > 0).length };
    })()
  `);
  check(`B/${tag}: 正式区图片全部解码（收起区不计）`, (visImgs?.total || 0) === 0 || visImgs?.decoded === visImgs?.total,
    `${visImgs?.decoded}/${visImgs?.total} 正式区`);
  check(`B/${tag}: 明确标注画面相似性未验证`, dom?.hasUnverifiedStatement === true);

  audit[`B-${tag}`] = { dom, reqs: reqs.slice(0, 10) };
  const segs = await shotSegmented(`B-${tag}`);
  console.log(`  B/${tag} 分段截图 ${segs.length} 张`);
}

// ===========================================================================
// C. 详情可展开（在已有页面上验证）
// ===========================================================================
console.log("\n=== C: 详情可展开 ===");
await viewport(1440, 900);
await send("Page.navigate", { url: `${BASE}/` });
await new Promise((r) => setTimeout(r, 2300));
await evaluate(`
  (async () => {
    const fb = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
    if (fb) fb.click();
    await new Promise(r => setTimeout(r, 250));
    const input = document.querySelector("#find-text");
    input.value = "Battleship Potemkin";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#album-search")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 13000));
    return 1;
  })()
`);
const expand = await evaluate(`
  (() => {
    const d = document.querySelector("#find-remote .find-remote-more");
    if (!d) return { ok: false, reason: "no-details" };
    const closedH = Math.round(d.getBoundingClientRect().height);
    const wasOpen = d.open;
    d.open = true;
    return new Promise(res => setTimeout(() => {
      const openH = Math.round(d.getBoundingClientRect().height);
      const bodyText = d.innerText || "";
      res({
        ok: true, wasOpen, closedH, openH, expands: openH > closedH,
        hasIdentity: /电影身份/.test(bodyText),
        hasLicence: /版权依据/.test(bodyText),
        hasActions: d.querySelectorAll("[data-film-action]").length,
        hasSourceLink: [...d.querySelectorAll("a")].some(a => /commons\.wikimedia\.org/.test(a.href)),
        hasEvidenceForm: !!d.querySelector(".find-remote-flag"),
      });
    }, 300));
  })()
`);
console.log(`  ${JSON.stringify(expand)}`);
check("详情可展开并增高", expand?.expands === true, `${expand?.closedH}px → ${expand?.openH}px`);
check("展开区保留三轴核验", expand?.hasIdentity === true && expand?.hasLicence === true);
check("展开区保留三个动作按钮", (expand?.hasActions || 0) === 3, `${expand?.hasActions} 个 data-film-action`);
check("展开区保留原始来源链接", expand?.hasSourceLink === true);
check("展开区保留纠正表单", expand?.hasEvidenceForm === true);

const shotOpen = await evaluate("(() => { const d=document.querySelector('#find-remote .find-remote-more'); if(d) d.scrollIntoView({block:'center'}); return 1; })()");
await new Promise((r) => setTimeout(r, 500));
await clearFocus();
const rOpen = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(path.join(OUT, "C-details-open.png"), Buffer.from(rOpen.result.data, "base64"));

// ---------------------------------------------------------------------------
const summary = {
  ranAt: new Date().toISOString(),
  paidCalls: 0,
  fixture: { sha256: fixtureSha, bytes: fixtureBuf.length },
  commonsRequestTotal: commonsReqs.length,
  audit,
  expand,
  imageResponses: [...imgResp.values()].filter(v => /wikimedia/.test(v.url)).slice(0, 20),
  pass, fail, rows,
};
writeFileSync(path.join(ROOT, ".p43-evidence", "p49-acceptance.json"), JSON.stringify(summary, null, 2));

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

console.log(`\n=== P4.9 验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter(x => !x.ok)) console.log(`  ${r.n} — ${r.d}`);
setTimeout(() => process.exit(0), 400);
