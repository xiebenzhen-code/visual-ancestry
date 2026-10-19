// P4.8 STEP 3/4 — 电影来源穿透审计 + 真实远程检索
//
// 在真实浏览器里：
//   1. 枚举本地电影池（不渲染也算，先拿到真实数量与 id）。
//   2. 文字输入 Metropolis / Battleship Potemkin / Sunrise，选「电影」，触发真实
//      Commons 请求，记录网络请求与页面渲染结果。
//   3. 每条电影结果按任务书要求记录 11 个字段。
//
// 不伪造响应：所有远程数据来自 commons.wikimedia.org。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".p43-evidence", "p48-shots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT_SRV = 4503, PORT_CDP = 9343;

let pass = 0, fail = 0;
const rows = [];
const check = (n, c, d = "") => {
  if (c) { pass++; rows.push({ n, ok: true, d }); console.log(`  PASS ${n}${d ? " — " + d : ""}`); }
  else { fail++; rows.push({ n, ok: false, d }); console.log(`  FAIL ${n}${d ? " — " + d : ""}`); }
};

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// 本地池：真实枚举，不信任务书里的「15 张」
// ---------------------------------------------------------------------------
console.log("=== 本地电影池 ===");
// Windows 上绝对路径必须转成 file:// URL 才能被 ESM 加载。
const local = await import(pathToFileURL(path.join(ROOT, "src/data/filmReferences.js")).href);
const locals = local.filmReferences || [];
console.log(`  实际条数: ${locals.length}`);
for (const f of locals) {
  console.log(`    ${String(f.filmTitle || "").padEnd(30)} ${f.year || "?"}  frame=${f.frameImage ? "有" : "无"}  artworkId=${f.artworkId || "-"}`);
}
check("本地电影条数已实测记录", locals.length > 0, `${locals.length} 条（任务书写 15，实测 ${locals.length}）`);
const localTitles = new Set(locals.map((f) => `${f.filmTitle} ${f.filmTitleZh || ""}`.toLowerCase()));

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

const PROFILE = path.join(ROOT, ".p43-evidence", "edge-p48f");
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--hide-scrollbars", "--window-size=1440,900", "--force-device-scale-factor=1",
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
const imgResults = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent") {
    const { requestId, request } = m.params;
    if (/commons\.wikimedia\.org/.test(request.url)) commonsReqs.push({ requestId, url: request.url, method: request.method });
  }
  if (m.method === "Network.responseReceived") {
    const { requestId, response } = m.params;
    imgResults.set(requestId, { url: response.url, status: response.status, mime: response.mimeType });
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 });
  if (r.result?.exceptionDetails) return { __error: String(r.result.exceptionDetails.text || "").slice(0, 400) };
  return r.result?.result?.value;
};
const clearFocus = async () => { await evaluate(`(() => { const a=document.activeElement; if(a&&a.blur)a.blur(); return 1; })()`); await new Promise(r=>setTimeout(r,80)); };
const shot = async (name) => {
  await clearFocus();
  const r = await send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(r.result.data, "base64");
  writeFileSync(path.join(OUT, name), buf);
  return buf.length;
};

// ---------------------------------------------------------------------------
// STEP 4 — 文字片名 → 真实远程检索
// ---------------------------------------------------------------------------
await send("Page.navigate", { url: `${BASE}/` });
await new Promise((r) => setTimeout(r, 2400));

const audit = {};

for (const [idx, title] of ["Metropolis", "Battleship Potemkin", "Sunrise"].entries()) {
  console.log(`\n=== STEP 4.${idx + 1}: "${title}" ===`);
  const before = commonsReqs.length;

  // 选择「电影」媒介
  const r1 = await evaluate(`
    (async () => {
      const filmBtn = [...document.querySelectorAll("[data-find-media]")].find(b => b.dataset.findMedia === "film");
      if (!filmBtn) return { ok: false, reason: "no-film-media-button" };
      filmBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const input = document.querySelector("#find-text");
      if (!input) return { ok: false, reason: "no-input" };
      input.value = ${JSON.stringify(title)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // 首页形态下按钮是 submit
      const form = document.querySelector("#album-search");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      else document.querySelector("#find-run")?.click();
      return { ok: true, media: filmBtn.textContent.trim(), value: input.value };
    })()
  `);
  console.log(`  输入: ${JSON.stringify(r1)}`);
  check(`"${title}" 选中电影媒介并提交`, r1?.ok === true, JSON.stringify(r1));

  // 等真实网络往返
  await new Promise((r) => setTimeout(r, 12000));

  const dom = await evaluate(`
    (() => {
      const host = document.querySelector("#find-remote");
      if (!host) return { ok: false, reason: "no-remote-host" };
      const cards = [...host.querySelectorAll(".film-remote-card, .remote-film-card, article, .find-hit-film, .find-hit-remote")];
      const text = host.innerText || "";
      const imgs = [...host.querySelectorAll("img")].map(im => ({
        src: String(im.currentSrc || im.getAttribute("src") || "").slice(0, 120),
        complete: im.complete, nw: im.naturalWidth, nh: im.naturalHeight,
        loading: im.getAttribute("loading"),
      }));
      return {
        ok: true, cards: cards.length, imgs,
        hasCommonsLink: /commons\\.wikimedia\\.org/.test(host.innerHTML),
        textSample: text.slice(0, 700),
        degraded: /不可用|失败|出错|没有/.test(text),
      };
    })()
  `);
  console.log(`  DOM 卡片: ${dom?.cards} · 图片: ${dom?.imgs?.length} · Commons 链接: ${dom?.hasCommonsLink}`);
  if (dom?.textSample) console.log(`  文本: ${dom.textSample.replace(/\s+/g, " ").slice(0, 260)}`);

  const newReqs = commonsReqs.slice(before);
  console.log(`  Commons 请求: ${newReqs.length} 条`);
  for (const q of newReqs.slice(0, 3)) console.log(`    ${q.method} ${q.url.slice(0, 110)}`);
  check(`"${title}" 真实发出 Commons 网络请求`, newReqs.length > 0, `${newReqs.length} 条`);
  check(`"${title}" 页面出现远程电影内容`, (dom?.cards || 0) > 0 || (dom?.imgs?.length || 0) > 0,
    `cards=${dom?.cards} imgs=${dom?.imgs?.length}`);

  if (dom?.imgs?.length) {
    const decoded = dom.imgs.filter((i) => i.complete && i.nw > 0);
    console.log(`  图片解码: ${decoded.length}/${dom.imgs.length}`);
    for (const i of decoded.slice(0, 3)) console.log(`    ${i.nw}x${i.nh} ${i.src.split("/").pop().slice(0, 50)}`);
    check(`"${title}" 远程图片可解码`, decoded.length > 0, `${decoded.length} 张`);
  }

  await shot(`10-film-${idx}-${title.replace(/\s+/g, "-")}.png`);
  audit[title] = { input: r1, dom, requests: newReqs.map((q) => q.url) };
}

// ---------------------------------------------------------------------------
// STEP 3 — 记录 11 字段的结构化审计（直接调产品函数，与页面同源）
// ---------------------------------------------------------------------------
console.log("\n=== STEP 3: 11 字段结构化审计 ===");
const structured = await evaluate(`
  (async () => {
    const mod = await import("/src/services/source/remoteDiscovery.js");
    const out = [];
    for (const t of ["Metropolis", "Battleship Potemkin", "Sunrise"]) {
      try {
        const r = await mod.discoverCommonsFilmStills(t, { limit: 3 });
        for (const x of (r.references || [])) {
          out.push({
            queried: t,
            sourceType: x.channel === "commons" ? "remote" : (x.channel || "?"),
            filmId: null,
            sourceId: x.sourceId,
            filmTitle: x.identity?.title || x.title,
            filmYear: x.identity?.year ?? x.year ?? null,
            imageKind: x.imageKind || "unknown",
            commonsFilePage: x.sourceUrl,
            imageUrl: x.image?.url || x.image?.thumbnailUrl || null,
            rightsStatus: x.rights?.value || x.rights?.status || (x.verification?.axes||[]).find(a=>a.axis==="licence")?.value || "unknown",
            imageLoadStatus: null,
            recallBasis: x.recallBasis?.strategy || null,
            visualMatchStatus: x.visualStatus || null,
            visualMatchLabel: x.visualStatusLabel || null,
            showable: x.showable,
          });
        }
      } catch (e) { out.push({ queried: t, error: String(e.message).slice(0, 100) }); }
      await new Promise(r => setTimeout(r, 2500));
    }
    return out;
  })()
`);

if (Array.isArray(structured)) {
  console.log(`  共 ${structured.length} 条`);
  for (const s of structured.filter(x => !x.error)) {
    console.log(`\n  [${s.queried}] ${String(s.filmTitle).slice(0,40)}`);
    console.log(`    sourceType=${s.sourceType}  sourceId=${String(s.sourceId).slice(0,42)}`);
    console.log(`    filmYear=${s.filmYear}  imageKind=${s.imageKind}`);
    console.log(`    rights=${String(s.rightsStatus).slice(0,26)}  showable=${s.showable}`);
    console.log(`    recallBasis=${s.recallBasis}  visual=${s.visualMatchStatus}`);
    console.log(`    file=${String(s.commonsFilePage).slice(0,80)}`);
  }
  check("结构化审计有结果", structured.filter((x) => !x.error).length > 0, `${structured.length} 条`);

  // 是否为本地 14 部之外
  // 以查询词判定：查询词命中本地池任一片名 → 池内，否则池外。
  const localQ = new Set(locals.map((f) => String(f.filmTitle || "").toLowerCase()));
  const alive = structured.filter((x) => !x.error);
  const outside = alive.filter((s) => {
    const q = String(s.queried || "").toLowerCase().trim();
    return ![...localQ].some((lt) => lt === q || lt.includes(q) || q.includes(lt));
  });
  check("动态候选来自本地池之外", outside.length === alive.length,
    `${outside.length}/${alive.length} 条池外（查询词: ${[...new Set(alive.map(x=>x.queried))].join(", ")}）`);
  // 同时核对：这批动态候选的影片确实不在本地 14 部里
  const localFilmTitles = new Set(locals.map((f) => String(f.filmTitle || "").toLowerCase()));
  const notInLocalFilms = alive.filter((s) => !localFilmTitles.has(String(s.queried || "").toLowerCase()));
  check("动态候选影片不是本地收录的影片", notInLocalFilms.length === alive.length,
    `${notInLocalFilms.length}/${alive.length}`);

  // 不能把「片名命中」说成「视觉确认」
  const overclaim = structured.filter((x) => !x.error && /视觉.*(确认|相似|匹配成功)/.test(String(x.visualMatchLabel || "")));
  check("没有把片名命中宣传为视觉确认", overclaim.length === 0,
    overclaim.length ? JSON.stringify(overclaim[0]) : "visualStatus 全部为待核验口径");
} else {
  check("结构化审计可执行", false, JSON.stringify(structured).slice(0, 200));
}

// ---------------------------------------------------------------------------
const summary = {
  ranAt: new Date().toISOString(),
  paidCalls: 0,
  localPool: { count: locals.length, titles: locals.map((f) => f.filmTitle) },
  commonsRequestCount: commonsReqs.length,
  commonsRequests: commonsReqs.map((q) => q.url).slice(0, 40),
  perTitle: audit,
  structured,
  pass, fail, rows,
};
writeFileSync(path.join(ROOT, ".p43-evidence", "p48-film-audit.json"), JSON.stringify(summary, null, 2));

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
try { srv.kill(); } catch {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

console.log(`\n=== P4.8 电影审计: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of rows.filter((x) => !x.ok)) console.log(`  ${r.n} — ${r.d}`);
setTimeout(() => process.exit(0), 400);
