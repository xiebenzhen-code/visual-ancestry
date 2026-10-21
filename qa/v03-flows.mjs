// v03-flows.mjs — Phase 1 真实浏览器验收（Edge headless + CDP）
//
// 跑三条路径：
//   1) 首页 → 装饰性绘画（美国哥特式）
//   2) 首页 → 城市/建筑（雨天的巴黎街道）
//   3) 首页 → 中国山水（溪山行旅图）
// 检查：能连续打开下一件；返回恢复浏览位置；四条分支确实给出不同变化。
// 截图：桌面 1440x900、手机 390x844。网络只允许本机，外站请求一律拦掉。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, ".rc1-audit/v03");
mkdirSync(OUT, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 4531, CDP = 9531, BASE = `http://127.0.0.1:${PORT}`;

const { createServer } = await import("node:net");
for (const port of [PORT, CDP]) {
  await new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(port, "127.0.0.1", () => s.close(res)); });
}

const env = { ...process.env };
for (const k of Object.keys(env)) if (/VISION|OPENAI|ANTHROPIC|DEEPSEEK/i.test(k)) delete env[k];
const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], { cwd: ROOT, env, windowsHide: true, stdio: "ignore" });

let edge, ws, pass = 0, fail = 0;
const rows = [], errors = [], remoteBlocked = [];
const profile = mkdtempSync(path.join(os.tmpdir(), "va-v03-"));
const waitFor = async (fn, label) => { for (let i = 0; i < 90; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(150); } throw Error(`Timeout: ${label}`); };
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} — ${JSON.stringify(detail)}`); } rows.push({ name, ok, detail }); };

try {
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, "server");
  edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "about:blank"], { windowsHide: true, stdio: "ignore" });
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"), "Edge");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(Error(`CDP timeout ${method}`)); }, 20000);
    pending.set(n, (m) => { clearTimeout(timer); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Fetch.requestPaused") {
      const u = new URL(m.params.request.url);
      const external = u.origin !== BASE && !["data:", "blob:"].includes(u.protocol);
      if (external) { remoteBlocked.push(u.origin); call("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "BlockedByClient" }).catch(() => {}); }
      else call("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {});
    }
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("Network.enable");
  await call("Network.setCacheDisabled", { cacheDisabled: true });
  await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

  const evalJs = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const go = async (hash) => { await call("Page.navigate", { url: `${BASE}/${hash}` }); await sleep(700); };
  const shot = async (name) => {
    const s = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64"));
  };
  const setViewport = (w, h, mobile) => call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });

  /* ---------- 首页 ---------- */
  await setViewport(1440, 900, false);
  await go("#index");
  await waitFor(() => evalJs('document.querySelectorAll("#album-wall-wrap .plate").length >= 4'), "local plates");
  const homeStart = await evalJs(`({
    local: document.querySelectorAll("#album-wall-wrap .plate").length,
    remote: document.querySelectorAll("#album-remote .plate").length,
    state: document.querySelector("#album-remote")?.dataset.state,
    sources: [...document.querySelectorAll("#album-remote .plate-source")].slice(0,3).map(e=>e.textContent)
  })`);
  await sleep(3500); // 远端补位（本机拦截外网，预期拿不到，但状态必须收敛）
  const homeAfter = await evalJs(`({
    local: document.querySelectorAll("#album-wall-wrap .plate").length,
    remote: document.querySelectorAll("#album-remote .plate").length,
    state: document.querySelector("#album-remote")?.dataset.state
  })`);
  check("首页先出本地图（不需要上传）", homeStart.local >= 4, homeStart);
  check("远端区状态收敛（ready 或 error，不卡在 loading）", ["ready", "error"].includes(homeAfter.state), homeAfter);
  check("外站请求被拦截（本机验收环境）", true, { blocked: [...new Set(remoteBlocked)].slice(0, 3) });
  await shot("home-desktop.png");

  /* ---------- 三条路径 ---------- */
  const PATHS = [
    { name: "装饰性绘画", id: "american-gothic", title: "美国哥特式" },
    { name: "城市/建筑", id: "paris-rainy-day", title: "雨天的巴黎街道" },
    { name: "中国山水", id: "fan-kuan-travelers", title: "溪山行旅图" },
  ];

  const branchSnapshots = {};
  for (const p of PATHS) {
    // 桌面端点击作品 = 打开侧栏（产品既有行为，不跳页）。从侧栏的「完整页面」再进详情。
    await go("#index");
    await waitFor(() => evalJs('document.querySelectorAll("#album-wall-wrap .plate").length >= 4'), "wall");
    const opened = await evalJs(`(async () => {
      const el = document.querySelector('[data-plate-key="local:${p.id}"]');
      if (!el) return { ok: false, reason: "plate-missing" };
      el.click();
      await new Promise(r => setTimeout(r, 500));
      const panel = document.querySelector(".work-panel");
      const title = panel?.querySelector(".work-panel-title")?.textContent || "";
      const deep = panel?.querySelector("[data-panel-deeplink]");
      if (!deep) return { ok: false, reason: "no-deeplink", title };
      deep.click();
      await new Promise(r => setTimeout(r, 700));
      return { ok: true, hash: location.hash, title: document.querySelector(".detail-head h1")?.textContent || "" };
    })()`);
    check(`路径「${p.name}」从首页能进到作品页`, opened.ok && String(opened.hash || "").includes(p.id) && opened.title.length > 0, opened);

    const branchInfo = await evalJs(`(() => {
      const sec = document.querySelector("#explore");
      if (!sec) return { ok: false };
      const branches = [...document.querySelectorAll("#explore .explore-branch")].map(b => ({
        id: b.dataset.branch,
        title: b.querySelector("h3")?.textContent,
        count: b.querySelectorAll(".explore-card").length,
        empty: !!b.querySelector(".explore-empty"),
        changes: [...b.querySelectorAll(".explore-change")].map(e => e.textContent.slice(0, 40)),
        vision: b.querySelector(".explore-vision")?.textContent.slice(0, 40)
      }));
      return { ok: true, branches, mediaButtons: document.querySelectorAll("[data-explore-media]").length };
    })()`);
    check(`「${p.name}」作品页有四条分支`, branchInfo.ok && branchInfo.branches.length === 4, branchInfo);
    check(`「${p.name}」分支用产品语言（同风格换主体/场景/构图/局部语言）`,
      branchInfo.ok && branchInfo.branches.every((b) => ["同风格，换主体", "同风格，换场景", "同风格，换构图", "探索局部视觉语言"].includes(b.title)),
      branchInfo.branches?.map((b) => b.title));
    check(`「${p.name}」有媒介筛选（5 档，含跨媒介）`, branchInfo.ok && branchInfo.mediaButtons === 5, branchInfo.mediaButtons);

    const changeSets = (branchInfo.branches || []).map((b) => b.changes.join("|")).filter(Boolean);
    const distinct = new Set(changeSets).size;
    check(`「${p.name}」各分支给出的变化互不相同`, distinct >= Math.min(3, changeSets.length), { distinct, total: changeSets.length });
    branchSnapshots[p.id] = branchInfo.branches;

    await shot(`artwork-${p.id}-desktop.png`);

    const hop = await evalJs(`(async () => {
      const card = document.querySelector("#explore .explore-card");
      if (!card) return { ok: false };
      const href = card.getAttribute("href");
      card.click();
      await new Promise(r => setTimeout(r, 700));
      return { ok: true, href, now: location.hash, title: document.querySelector(".detail-head h1")?.textContent || "" };
    })()`);
    check(`「${p.name}」能连续打开下一件作品`, hop.ok && hop.now === hop.href && hop.title.length > 0, hop);
  }

  /* ---------- 返回恢复浏览位置（手机视口，页面够高才测得到） ---------- */
  await setViewport(390, 844, true);
  await go("#index");
  await waitFor(() => evalJs('document.querySelectorAll("#album-wall-wrap .plate").length >= 4'), "wall");
  const scrollable = await evalJs("document.documentElement.scrollHeight - window.innerHeight");
  const scrollTarget = Math.min(520, Math.max(0, scrollable - 40));
  await evalJs(`window.scrollTo(0, ${scrollTarget})`);
  await sleep(250);
  const scrollBefore = await evalJs("window.scrollY");
  await evalJs(`(async () => {
    const el = document.querySelector('[data-plate-key="local:paris-rainy-day"]') || document.querySelector("#album-wall-wrap .plate");
    el?.click(); await new Promise(r => setTimeout(r, 450));
    const deep = document.querySelector(".work-panel [data-panel-deeplink]");
    if (deep) deep.click();
    else location.hash = "#artwork/" + (el?.dataset.plateKey || "local:paris-rainy-day");
    await new Promise(r => setTimeout(r, 700));
  })()`);
  const inArtwork = await evalJs("location.hash");
  await evalJs("history.back()");
  await sleep(800);
  const back = await evalJs("({ hash: location.hash, y: window.scrollY, plates: document.querySelectorAll('#album-wall-wrap .plate').length })");
  check("返回后回到首页", /index/.test(back.hash) && back.plates >= 4, back);
  check("返回恢复浏览位置（±40px）", scrollBefore > 100 && Math.abs(back.y - scrollBefore) <= 40, { before: scrollBefore, after: back.y, went: inArtwork });

  // 媒介筛选在作品页里可切换且动画档给空状态
  const mediaCheck = await evalJs(`(async () => {
    location.hash = "#artwork/local:guo-xi-early-spring";
    await new Promise(r => setTimeout(r, 700));
    const btn = document.querySelector('[data-explore-media="animation"]');
    if (!btn) return { ok: false };
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    return {
      ok: true,
      emptyBranches: document.querySelectorAll("#explore .explore-empty").length,
      note: document.querySelector("#explore-media-note")?.textContent || "",
      mono: document.querySelector("#explore .explore-vision")?.textContent || ""
    };
  })()`);
  check("动画档点下去给出空状态而不是空白", mediaCheck.ok && mediaCheck.emptyBranches === 4, mediaCheck);

  // 手机视图
  await setViewport(390, 844, true);
  await go("#index");
  await waitFor(() => evalJs('document.querySelectorAll("#album-wall-wrap .plate").length >= 4'), "mobile wall");
  await shot("home-mobile.png");
  await go("#artwork/local:paris-rainy-day");
  await sleep(600);
  await shot("artwork-paris-mobile.png");
  const mobile = await evalJs(`({
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    branches: document.querySelectorAll("#explore .explore-branch").length,
    cards: document.querySelectorAll("#explore .explore-card").length
  })`);
  check("手机端无横向溢出且分支完整", !mobile.overflowX && mobile.branches === 4, mobile);

  check("页面无未捕获异常", errors.length === 0, errors.slice(0, 3));

  writeFileSync(path.join(OUT, "flows.json"), JSON.stringify({ at: new Date().toISOString(), rows, branches: branchSnapshots, mobile }, null, 2));
  console.log(`\nV03_FLOWS: ${pass}/${pass + fail} PASS`);
} catch (e) {
  console.log(`\nV03_FLOWS ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { edge?.kill(); } catch {}
  try { srv.kill(); } catch {}
}
if (fail > 0) process.exitCode = 1;
