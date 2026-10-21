// v03-shots.mjs — Phase 1 交付截图（允许访问馆方公开接口，不涉及任何模型调用）
//
// 做的事情：
//   1) 首页：等远端补位落地，截桌面 + 手机
//   2) 三个作品页：滚到 EXPLORE 区截图（装饰性绘画 / 城市建筑 / 中国山水）
//   3) 动画档的空状态截图
// 记录：补到多少张远端图、来自哪些馆、页面是否有未捕获异常。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, ".rc1-audit/v03");
mkdirSync(OUT, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 4535, CDP = 9535, BASE = `http://127.0.0.1:${PORT}`;

const { createServer } = await import("node:net");
for (const port of [PORT, CDP]) {
  await new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(port, "127.0.0.1", () => s.close(res)); });
}

const env = { ...process.env };
for (const k of Object.keys(env)) if (/VISION|OPENAI|ANTHROPIC|DEEPSEEK/i.test(k)) delete env[k];
const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], { cwd: ROOT, env, windowsHide: true, stdio: "ignore" });

let edge, ws;
const errors = [];
const apiHosts = new Set();
const waitFor = async (fn, label, tries = 120) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } throw Error(`Timeout: ${label}`); };

try {
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, "server", 60);
  edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "va-shots-"))}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], { windowsHide: true, stdio: "ignore" });
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"), "Edge");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(Error(`CDP timeout ${method}`)); }, 30000);
    pending.set(n, (m) => { clearTimeout(timer); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (/^https?:/.test(u) && !u.startsWith(BASE)) { try { apiHosts.add(new URL(u).host); } catch {} }
    }
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("Network.enable");
  await call("Network.setCacheDisabled", { cacheDisabled: false });

  const evalJs = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const shot = async (name) => {
    const s = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64"));
  };
  const viewport = (w, h, mobile) => call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  const go = async (hash) => { await call("Page.navigate", { url: `${BASE}/${hash}` }); await sleep(800); };

  /* 首页：等远端补位 */
  await viewport(1440, 980, false);
  await go("#index");
  await waitFor(() => evalJs('document.querySelectorAll("#album-wall-wrap .plate").length >= 8'), "local wall", 60);
  const remote = await waitFor(async () => {
    const st = await evalJs('document.querySelector("#album-remote")?.dataset.state');
    return st === "ready" || st === "error" ? st : null;
  }, "remote state", 200);
  // 等远端图真正解码完成（met/cleveland 的大图要几秒），否则截图是灰块
  await waitFor(() => evalJs(`(() => {
    const imgs = [...document.querySelectorAll("#album-wall-wrap .plate-remote img")];
    if (imgs.length < 8) return false;
    return imgs.filter(i => i.complete && i.naturalWidth > 0).length >= Math.max(6, Math.floor(imgs.length * 0.7));
  })()`), "remote images decoded", 90).catch(() => null);
  await sleep(600);
  const home = await evalJs(`({
    local: document.querySelectorAll("#album-wall-wrap .plate:not(.plate-remote)").length,
    remote: document.querySelectorAll("#album-wall-wrap .plate-remote").length,
    decoded: [...document.querySelectorAll("#album-wall-wrap .plate-remote img")].filter(i => i.complete && i.naturalWidth > 0).length,
    state: document.querySelector("#album-remote")?.dataset.state,
    sources: [...new Set([...document.querySelectorAll("#album-wall-wrap .plate-remote .plate-source")].map(e=>e.textContent.split(" · ")[0]))],
    firstSources: [...document.querySelectorAll("#album-wall-wrap .plate-remote .plate-source")].slice(0,4).map(e=>e.textContent)
  })`);
  await shot("home-desktop.png");

  await viewport(390, 844, true);
  await go("#index");
  await sleep(2500);
  await shot("home-mobile.png");
  await viewport(1440, 980, false);

  /* 三个作品页：滚到 EXPLORE */
  for (const [id, tag] of [["american-gothic", "decorative"], ["paris-rainy-day", "city"], ["fan-kuan-travelers", "landscape"]]) {
    await go(`#artwork/local:${id}`);
    await sleep(1000);
    const scrolled = await evalJs(`(() => {
      const el = document.querySelector("#explore");
      if (!el) return -1;
      const top = el.getBoundingClientRect().top + window.scrollY - 60;
      window.scrollTo(0, Math.max(0, top));
      return window.scrollY;
    })()`);
    await sleep(600);
    const y = await evalJs("window.scrollY");
    console.log(`  ${tag}: scrollY=${y} (请求 ${scrolled})`);
    await shot(`explore-${tag}-desktop.png`);
  }

  /* 动画档空状态 */
  await go("#artwork/local:guo-xi-early-spring");
  await sleep(800);
  await evalJs(`(() => {
    const el = document.querySelector("#explore");
    if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 60));
    return window.scrollY;
  })()`);
  await sleep(400);
  await evalJs('document.querySelector(\'[data-explore-media="animation"]\')?.click()');
  await sleep(500);
  await shot("explore-animation-empty-desktop.png");

  /* 手机端作品页 */
  await viewport(390, 844, true);
  await go("#artwork/local:paris-rainy-day");
  await sleep(900);
  await evalJs('document.querySelector("#explore")?.scrollIntoView({block:"start"}); window.scrollBy(0,-40);');
  await sleep(400);
  await shot("explore-city-mobile.png");

  const summary = { at: new Date().toISOString(), home, apiHosts: [...apiHosts].slice(0, 12), errors };
  writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 1));
} catch (e) {
  console.log(`SHOTS ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { edge?.kill(); } catch {}
  try { srv.kill(); } catch {}
}
