// p2-shots.mjs — Phase 2 界面证据截图（需要先跑 server 与 harvest/index）
//
// 只做两件事：打开首页与作品页，等外部发现图落地，截图。
// 网络只允许本机；不触发任何付费模型。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, ".rc1-audit/discovery/shots");
mkdirSync(OUT, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 4555, CDP = 9555, BASE = `http://127.0.0.1:${PORT}`;

const { createServer } = await import("node:net");
for (const port of [PORT, CDP]) {
  await new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(port, "127.0.0.1", () => s.close(res)); });
}

const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], { cwd: ROOT, windowsHide: true, stdio: "ignore" });
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "p2-shots-"))}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { windowsHide: true, stdio: "ignore" });

let ws;
const waitFor = async (fn, label, tries = 120) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } throw Error(`Timeout: ${label}`); };

try {
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, "server", 60);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"), "edge");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  const call = (m, p = {}) => new Promise((res, rej) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); rej(Error(`timeout ${m}`)); }, 30000); pending.set(n, (x) => { clearTimeout(t); x.error ? rej(Error(JSON.stringify(x.error))) : res(x.result); }); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  await call("Page.enable"); await call("Runtime.enable");
  const evalJs = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text); return r.result?.value; };
  const shot = async (name) => { const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); };
  const viewport = (w, h, mobile) => call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });

  /* 首页 */
  await viewport(1440, 980, false);
  await call("Page.navigate", { url: `${BASE}/#index` });
  await sleep(2500);
  const home = await evalJs(`({
    plates: document.querySelectorAll("#album-wall-wrap .plate").length,
    discovered: document.querySelectorAll("#album-wall-wrap .plate-discovered").length,
    sources: [...new Set([...document.querySelectorAll(".plate-discovered .plate-source")].map(e=>e.textContent))]
  })`);
  await shot("home-with-discovery.png");
  console.log("  首页:", JSON.stringify(home));

  /* 作品页：等外部候选注入 */
  await call("Page.navigate", { url: `${BASE}/#artwork/local:paris-rainy-day` });
  await sleep(1200);
  await evalJs(`(() => { const el = document.querySelector("#explore"); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 60); })()`);
  const ext = await waitFor(() => evalJs(`(() => {
    const n = document.querySelectorAll(".explore-external").length;
    return n > 0 ? { n, status: document.querySelector("#explore-external-status")?.textContent || "" } : null;
  })()`), "external cards", 90).catch(() => null);
  await sleep(600);
  const perBranch = await evalJs(`(() => {
    const out = {};
    for (const b of document.querySelectorAll("#explore .explore-branch")) {
      out[b.dataset.branch] = b.querySelectorAll(".explore-external").length;
    }
    return out;
  })()`);
  await shot("artwork-external-branches.png");
  console.log("  作品页外部候选:", JSON.stringify(ext), JSON.stringify(perBranch));

  /* 手机 */
  await viewport(390, 844, true);
  await sleep(700);
  await shot("artwork-external-mobile.png");
} catch (e) {
  console.log("SHOTS ERROR:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { edge.kill(); } catch {}
  try { srv.kill(); } catch {}
}
