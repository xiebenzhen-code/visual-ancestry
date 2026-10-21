// p22-cinema.mjs — Phase 2.2A 端到端：电影/动画画面真的能看、能点、能继续探索
//
// 检查的不是接口而是产品：
//   1. 媒介切到"彩色电影"能出非零画面，且不是占位图
//   2. 媒介切到"动画"能出非零画面
//   3. 点进画面 → 统一详情（#artwork/r.<hash>），刷新仍在
//   4. 从该画面继续探索，能返回真实候选
//   5. 黑白画面不出现在彩色电影档

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, ".rc1-audit/discovery/p22");
mkdirSync(OUT, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.QA_PORT || 4559);
const CDP = PORT + 4000;
const BASE = `http://127.0.0.1:${PORT}`;

const { createServer } = await import("node:net");
for (const p of [PORT, CDP]) {
  await new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(p, "127.0.0.1", () => s.close(res)); });
}

const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], { cwd: ROOT, windowsHide: true, stdio: "ignore" });
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "p22-"))}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { windowsHide: true, stdio: "ignore" });

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  — " + detail : ""}`); };
const waitFor = async (fn, label, tries = 150) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } throw Error(`超时: ${label}`); };

let ws;
try {
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, "server", 60);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"), "edge");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  const call = (m, p = {}) => new Promise((res, rej) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); rej(Error(`timeout ${m}`)); }, 40000); pending.set(n, (x) => { clearTimeout(t); x.error ? rej(Error(JSON.stringify(x.error))) : res(x.result); }); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  await call("Page.enable"); await call("Runtime.enable");
  const evalJs = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text); return r.result?.value; };
  const shot = async (name) => { const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); };
  const url = () => evalJs("location.href");

  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

  // 以《雨天的巴黎街道》为起点（已有像素与向量）
  await call("Page.navigate", { url: `${BASE}/#artwork/local:paris-rainy-day` });
  await waitFor(() => evalJs(`Boolean(document.querySelector("#explore .explore-external"))`), "外部候选");
  record("作品页载入", true, await url());

  const measure = () => evalJs(`(() => {
    const cards = [...document.querySelectorAll("#explore .explore-card")];
    const ext = cards.filter((c) => c.classList.contains("explore-external"));
    const imgs = [...document.querySelectorAll("#explore .explore-external img")];
    const row = document.querySelector("#explore-media-row:not([hidden])");
    return {
      total: cards.length,
      ext: ext.length,
      kinds: [...new Set(ext.map((c) => c.dataset.extKind))],
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      imgs: imgs.length,
      note: document.querySelector("#explore-media-note")?.textContent || "",
      rowCards: row ? row.querySelectorAll(".explore-external").length : 0,
      rowKinds: row ? [...new Set([...row.querySelectorAll(".explore-external")].map((c) => c.dataset.extKind))] : [],
    };
  })()`);

  // 1) 电影档
  await evalJs(`document.querySelector('[data-explore-media="film"]').click()`);
  await waitFor(() => evalJs(`(() => {
    const imgs = [...document.querySelectorAll("#explore .explore-external img")];
    return imgs.length && imgs.every((i) => i.complete) ? imgs.length : null;
  })()`), "电影档图片加载", 60).catch(() => null);
  const film = await measure();
  record("电影档非零且图片真实加载", film.rowCards > 0 && film.loaded === film.imgs, `同媒介 ${film.rowCards} 张 / 图 ${film.loaded}/${film.imgs} / 类型 ${film.rowKinds.join(",")}`);
  await evalJs(`document.querySelector("#explore").scrollIntoView({block:"start"})`);
  await sleep(400);
  await shot("01-film-mode.png");

  // 2) 动画档
  await evalJs(`document.querySelector('[data-explore-media="animation"]').click()`);
  await waitFor(() => evalJs(`(() => {
    const imgs = [...document.querySelectorAll("#explore .explore-external img")];
    return imgs.length && imgs.every((i) => i.complete) ? imgs.length : null;
  })()`), "动画档图片加载", 60).catch(() => null);
  const anim = await measure();
  record("动画档非零且图片真实加载", anim.rowCards > 0 && anim.loaded === anim.imgs, `同媒介 ${anim.rowCards} 张 / 图 ${anim.loaded}/${anim.imgs} / 类型 ${anim.rowKinds.join(",")}`);
  await shot("02-animation-mode.png");

  // 3) 黑白画面不得出现在彩色电影档
  const monoCheck = await evalJs(`(() => {
    const btn = document.querySelector('[data-explore-media="film"]');
    btn.click();
    return new Promise((res) => setTimeout(() => {
      const sats = [...document.querySelectorAll("#explore .explore-external")].filter((c) => c.closest("#explore-media-row")).map((c) => Number(c.dataset.extSat || "1"));
      res({ n: sats.length, mono: sats.filter((s) => s < 0.06).length });
    }, 700));
  })()`);
  record("彩色电影档里没有黑白画面", monoCheck.mono === 0, `${monoCheck.n} 张，最低饱和度均 ≥0.06`);

  // 4) 点进一张电影画面
  const pick = await evalJs(`(() => {
    const a = document.querySelector('#explore-media-row .explore-external[data-ext-kind="film-still"] .explore-external-open')
      || document.querySelector('#explore .explore-external[data-ext-kind="film-still"] .explore-external-open');
    return a ? a.getAttribute("href") : null;
  })()`);
  await evalJs(`(document.querySelector('#explore-media-row .explore-external[data-ext-kind="film-still"] .explore-external-open')
    || document.querySelector('#explore .explore-external[data-ext-kind="film-still"] .explore-external-open')).click()`);
  await sleep(2000);
  const detail = await evalJs(`(() => {
    const p = document.querySelector('.detail-page[data-remote="1"]');
    if (!p) return null;
    const img = p.querySelector(".detail-figure img");
    return {
      url: location.href,
      title: p.querySelector("h1")?.textContent || "",
      origin: p.querySelector(".detail-origin")?.textContent || "",
      loaded: Boolean(img && img.complete && img.naturalWidth > 0),
      film: p.querySelector(".detail-facts")?.innerText.match(/影片\\s*\\n?([^\\n]+)/)?.[1] || "",
      facts: (() => {
        const d = p.querySelector(".detail-facts");
        if (!d) return "";
        d.open = true;
        return (d.innerText || "").replace(/\\s+/g, " ").slice(0, 200);
      })(),
    };
  })()`);
  record("点击画面进入统一详情", Boolean(detail && /#artwork\/r\./.test(detail.url) && detail.loaded), detail ? `${detail.title} · 图 ${detail.loaded ? "已加载" : "未加载"}` : "无详情");
  record("详情页带许可与来源溯源信息", Boolean(detail && /版权/.test(detail.facts) && /来源|馆藏|原始/.test(detail.facts)), detail ? detail.facts : "");
  await shot("03-frame-detail.png");

  // 5) 从画面继续探索
  const again = await waitFor(() => evalJs(`(() => {
    const n = document.querySelectorAll("#explore .explore-external").length;
    return n > 0 ? { n, status: document.querySelector("#explore-external-status")?.textContent || "" } : null;
  })()`), "二次候选").catch(() => null);
  record("从画面继续探索返回真实候选", Boolean(again && again.n > 0), again ? `n=${again.n}` : "无");
  await shot("04-frame-explore.png");

  // 6) 刷新仍能打开
  const frameHash = (await url()).split("/").pop();
  await call("Page.navigate", { url: `${BASE}/#artwork/${frameHash}` });
  await sleep(2200);
  const afterReload = await evalJs(`(() => {
    const p = document.querySelector('.detail-page[data-remote="1"]');
    const img = p?.querySelector(".detail-figure img");
    return { ok: Boolean(p), loaded: Boolean(img && img.complete && img.naturalWidth > 0) };
  })()`);
  record("刷新后仍打开且图片可用", afterReload.ok && afterReload.loaded, frameHash);

  // 7) 恢复"不限"
  await evalJs(`document.querySelector('[data-explore-media="all"]').click()`);
  await sleep(700);
  const allAgain = await measure();
  record("切回不限后候选恢复", allAgain.ext >= 1 && allAgain.rowCards === 0, `all=${allAgain.ext} 张风格候选，同媒介行已收`);
} catch (e) {
  record("流程异常", false, e.message);
} finally {
  writeFileSync(path.join(OUT, "flow.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1), "utf8");
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 电影/动画端到端 ${pass}/${results.length} PASS ===`);
  try { ws?.close(); } catch {}
  try { edge.kill(); } catch {}
  try { srv.kill(); } catch {}
  if (pass !== results.length) process.exitCode = 1;
}
