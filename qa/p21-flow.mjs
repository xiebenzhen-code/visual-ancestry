// p21-flow.mjs — Phase 2.1 端到端验收（真实浏览器，走 Edge CDP）
//
// 走的是产品路径，不是接口：
//   首页 → 作品详情（本地）→ 外部发现候选 → 点进外部作品 → 新详情 → 再次探索
// 全程记录 URL，任何一步离开画之旅（跳到馆方域名）即判失败。
//
// 另外验证：媒介切换不清空有效结果、没有证据时不写"同风格"、原始来源可追溯。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, ".rc1-audit/discovery/p21");
mkdirSync(OUT, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.QA_PORT || 4557);
const CDP = PORT + 4000;
const BASE = `http://127.0.0.1:${PORT}`;

const { createServer } = await import("node:net");
for (const p of [PORT, CDP]) {
  await new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(p, "127.0.0.1", () => s.close(res)); });
}

const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], { cwd: ROOT, windowsHide: true, stdio: "ignore" });
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "p21-"))}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { windowsHide: true, stdio: "ignore" });

let ws;
const waitFor = async (fn, label, tries = 150) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } throw Error(`超时: ${label}`); };

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  — " + detail : ""}`); };

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
  const goto = async (hash) => { await call("Page.navigate", { url: `${BASE}/${hash}` }); await sleep(1500); };

  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });

  /* 1. 首页 */
  await goto("#index");
  const home = await waitFor(() => evalJs(`(() => {
    const p = document.querySelectorAll(".plate").length;
    const d = document.querySelectorAll(".plate-discovered").length;
    return p >= 8 && d > 0 ? { plates: p, discovered: d } : null;
  })()`), "首页图片墙", 60).catch(() => ({ plates: 0, discovered: 0 }));
  record("首页可打开且有自动发现图", home.plates > 0 && home.discovered > 0, `plates=${home.plates} discovered=${home.discovered}`);
  await shot("01-home.png");

  /* 2. 从首页进入《雨天的巴黎街道》 */
  await goto("#artwork/local:paris-rainy-day").catch(() => null);
  await evalJs(`location.hash = "#artwork/local:paris-rainy-day"`);
  await sleep(1200);
  let exists = await evalJs(`Boolean(document.querySelector(".detail-page"))`);
  if (!exists) {
    await goto("#artwork/paris-rainy-day");
    exists = await evalJs(`Boolean(document.querySelector(".detail-page"))`);
  }
  record("本地作品详情打开", exists, await url());

  /* 3. 等外部候选 */
  const ext = await waitFor(() => evalJs(`(() => {
    const n = document.querySelectorAll(".explore-external").length;
    return n > 0 ? { n, status: document.querySelector("#explore-external-status")?.textContent || "" } : null;
  })()`), "外部候选").catch(() => null);
  record("作品页出现自动发现候选", Boolean(ext && ext.n > 0), ext ? `n=${ext.n} · ${ext.status}` : "无");
  await evalJs(`document.querySelector("#explore").scrollIntoView({block:"start"})`);
  await sleep(600);
  await shot("02-artwork-external.png");

  /* 4. 不得声称"同风格已验证" */
  const claims = await evalJs(`(() => {
    const claims = [...document.querySelectorAll(".explore-claim")].map((e) => e.textContent.trim());
    const badges = [...document.querySelectorAll(".explore-external .explore-badge")].map((e) => e.textContent.trim());
    const text = document.querySelector("#explore")?.innerText || "";
    return { claims, badges, saysVerified: /已验证同风格|已验证的风格|同风格已验证/.test(text) };
  })()`);
  record("外部候选不宣称已验证同风格", !claims.saysVerified && claims.claims.every((c) => /待验证|证据不足|同一视觉语言/.test(c)), claims.claims.join(" / "));

  /* 5. 原始来源可追溯（独立链接，且不吞掉内部导航） */
  const src = await evalJs(`(() => {
    const a = document.querySelector('.explore-external [data-raw-source]');
    return a ? { href: a.href, target: a.target } : null;
  })()`);
  record("外部卡片带原始馆藏链接", Boolean(src && /^https?:/.test(src.href) && src.target === "_blank"), src ? src.href.slice(0, 60) : "无");

  /* 5b. 本地页的媒介切换：本地分支与外部候选都要保留 */
  const localAll = await evalJs(`({ cards: document.querySelectorAll("#explore .explore-card").length, ext: document.querySelectorAll("#explore .explore-external").length })`);
  await evalJs(`document.querySelector('[data-explore-media="artwork"]').click()`);
  await sleep(500);
  const localArt = await evalJs(`({ cards: document.querySelectorAll("#explore .explore-card").length, ext: document.querySelectorAll("#explore .explore-external").length })`);
  await evalJs(`document.querySelector('[data-explore-media="all"]').click()`);
  await sleep(500);
  const localBack = await evalJs(`({ cards: document.querySelectorAll("#explore .explore-card").length, ext: document.querySelectorAll("#explore .explore-external").length })`);
  record(
    "本地页切换媒介：本地与外部结果都保留",
    localBack.cards === localAll.cards && localBack.ext === localAll.ext && localArt.ext > 0,
    `all=${localAll.cards}（外部 ${localAll.ext}）→ 绘画=${localArt.cards}（外部 ${localArt.ext}）→ 恢复=${localBack.cards}`
  );

  /* 6. 点进外部作品（内部路由，不跳站） */
  const extHref = await evalJs(`(() => {
    const a = document.querySelector(".explore-external .explore-external-open");
    return a ? a.getAttribute("href") : null;
  })()`);
  const beforeHost = await evalJs("location.host");
  await evalJs(`(async () => { const a = document.querySelector(".explore-external .explore-external-open"); a.click(); })()`);
  await sleep(2000);
  const afterUrl = await url();
  const afterHost = await evalJs("location.host");
  const remoteDetail = await evalJs(`(() => {
    const page = document.querySelector('.detail-page[data-remote="1"]');
    return page ? { title: page.querySelector("h1")?.textContent || "", origin: page.querySelector(".detail-origin")?.textContent || "" } : null;
  })()`);
  record("点击外部候选进入画之旅内详情", Boolean(remoteDetail) && afterHost === beforeHost && /#artwork\/r\./.test(afterUrl), `${extHref} → ${afterUrl.replace(BASE, "")}`);
  await shot("03-remote-detail.png");

  /* 7. 从远端作品再次探索 */
  const second = await waitFor(() => evalJs(`(() => {
    const n = document.querySelectorAll("#explore .explore-external").length;
    return n > 0 ? { n, total: document.querySelector("#explore-external-status")?.textContent || "" } : null;
  })()`), "远端二次候选").catch(() => null);
  record("远端作品可作为下一轮探索起点", Boolean(second && second.n > 0), second ? `n=${second.n}` : "无");
  await evalJs(`document.querySelector("#explore").scrollIntoView({block:"start"})`);
  await sleep(500);
  await shot("04-remote-explore.png");

  /* 8. 媒介切换不清空有效结果 */
  const before = await evalJs(`document.querySelectorAll("#explore .explore-card").length`);
  await evalJs(`document.querySelector('[data-explore-media="artwork"]').click()`);
  await sleep(500);
  const artOnly = await evalJs(`({ total: document.querySelectorAll("#explore .explore-card").length, ext: document.querySelectorAll("#explore .explore-external").length, note: document.querySelector("#explore-media-note")?.textContent || "" })`);
  await evalJs(`document.querySelector('[data-explore-media="all"]').click()`);
  await sleep(500);
  const backAll = await evalJs(`document.querySelectorAll("#explore .explore-external").length`);
  record("切换媒介后外部结果不丢失", backAll === (second ? second.n : -1), `all=${before} → 绘画=${artOnly.total}（外部 ${artOnly.ext}）→ 恢复 all=${backAll}`);

  await evalJs(`document.querySelector('[data-explore-media="animation"]').click()`);
  await sleep(400);
  const anim = await evalJs(`(() => {
    const cards = [...document.querySelectorAll("#explore .explore-external")];
    const kinds = cards.map((c) => c.dataset.extKind);
    return { ext: cards.length, kinds: [...new Set(kinds)], bad: kinds.filter((k) => k !== "animation-frame" && k !== "tv-episode-still").length,
             note: document.querySelector("#explore-media-note")?.textContent || "" };
  })()`);
  record("动画档只出动画帧，不用封面/绘画凑数", anim.bad === 0, `${anim.ext} 条 · 类型 ${anim.kinds.join(",") || "无"}`);
  await evalJs(`document.querySelector('[data-explore-media="all"]').click()`);

  /* 9. 回退路径仍然可用 */
  await goto("#index");
  record("返回首页正常", await evalJs(`document.querySelectorAll(".plate").length > 0`), "");

  /* 9b. 采入口保护（HTTP 层） */
  const crossOrigin = await fetch(`${BASE}/api/discovery/harvest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ query: "test-guard" }),
  }).then((r) => r.status).catch(() => 0);
  record("跨源触发被拒绝", crossOrigin === 403, `status=${crossOrigin}`);

  const c1 = await fetch(`${BASE}/api/discovery/harvest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "impressionism city street" }) }).then((r) => r.json()).catch(() => null);
  record("同一查询命中缓存，不重复抓取", Boolean(c1 && (c1.cached || (c1.job && c1.job.status === "cached"))), JSON.stringify(c1).slice(0, 90));

  let burst = [];
  for (let i = 0; i < 20; i += 1) {
    burst.push(await fetch(`${BASE}/api/discovery/harvest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `burst-${i}` }),
    }).then((r) => r.status).catch(() => 0));
  }
  record("同一 IP 高频触发被限速", burst.includes(429), `statuses=${[...new Set(burst)].join(",")}`);

  /* 10. 刷新远端详情仍可打开（说明数据在服务端有源） */
  const targetHash = afterUrl.split("/").pop();
  await call("Page.navigate", { url: `${BASE}/#artwork/${targetHash}` });
  await sleep(2200);
  record("远端详情可直接刷新打开", await evalJs(`Boolean(document.querySelector('.detail-page[data-remote="1"]'))`), targetHash);
} catch (e) {
  record("流程异常", false, e.message);
} finally {
  writeFileSync(path.join(OUT, "flow.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1), "utf8");
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 端到端 ${pass}/${results.length} PASS ===`);
  try { ws?.close(); } catch {}
  try { edge.kill(); } catch {}
  try { srv.kill(); } catch {}
  if (pass !== results.length) process.exitCode = 1;
}
