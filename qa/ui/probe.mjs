// probe.mjs — 一次性浏览器探针：在指定视口打开一个 hash 路由，求值一段表达式，打印 JSON。
//
// 用法: node qa/ui/probe.mjs <baseUrl> <hash> <width> <height> <exprFile> [mobile]
//   exprFile: 一个 .js 文件，内容是一个表达式（可跨行），例如 `(() => ({...}))()`
//
// 只用于开发期测量，不产出验收结论；验收以 qa/ui/round3-check.mjs 为准。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const [BASE, HASH, W, H, EXPR_FILE, MOBILE] = process.argv.slice(2);
const PORT = 9490;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const expr = readFileSync(EXPR_FILE, "utf8");

const edge = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(HERE, "probe-edge-profile")}`,
  "--no-first-run",
  "about:blank",
], { stdio: "ignore" });

async function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (onEvent) onEvent(m);
  };
  return {
    ws,
    send: (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); }),
  };
}

let version = null;
for (let i = 0; i < 40; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch {}
  await sleep(600);
}
if (!version) throw new Error("CDP 未就绪");

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const errs = [];
const page = await connect(created.webSocketDebuggerUrl, (m) => {
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params?.exceptionDetails?.text || "?");
});
const call = page.send;
await call("Emulation.setDeviceMetricsOverride", { width: Number(W), height: Number(H), deviceScaleFactor: 1, mobile: MOBILE === "mobile" });
await call("Emulation.setTouchEmulationEnabled", { enabled: MOBILE === "mobile", maxTouchPoints: MOBILE === "mobile" ? 5 : 0 });
await call("Page.enable");
await call("Page.navigate", { url: `${BASE}/${HASH}` });
await sleep(4500);
const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) console.log("EXCEPTION", JSON.stringify(r.result.exceptionDetails).slice(0, 500));
console.log(JSON.stringify(r.result?.result?.value ?? null, null, 1));
if (errs.length) console.log("JS ERRORS:", errs.slice(0, 5));
try { await call("Browser.close"); } catch {}
edge.kill();
process.exit(0);
