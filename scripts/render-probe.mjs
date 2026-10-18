// Render probe: open the feed at 4175, capture console errors, count tiles.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9422;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = process.cwd() + "\\work\\edge-render-probe2";

async function cdpConnect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (onEvent) onEvent(msg);
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let version = null;
for (let i = 0; i < 40 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
  if (!version) await sleep(700);
}
if (!version) { console.log("RESULT CDP-DOWN"); process.exit(1); }

const errors = [];
const { ws, send } = await cdpConnect(version.webSocketDebuggerUrl);
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await cdpConnect(created.webSocketDebuggerUrl, (msg) => {
  if (msg.method === "Runtime.exceptionThrown") {
    errors.push("EXC: " + (msg.params?.exceptionDetails?.text || "?"));
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params?.type)) {
    const text = (msg.params?.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    errors.push(msg.params.type.toUpperCase() + ": " + text.slice(0, 300));
  }
});
const call = page.send;

await call("Runtime.enable");
await call("Page.enable");
await call("Page.navigate", { url: "http://127.0.0.1:4175/#index" });
await sleep(4500);

const state = await call("Runtime.evaluate", {
  expression: `(() => ({
    hash: location.hash,
    tiles: document.querySelectorAll('.feed-tile').length,
    imgs: document.images.length,
    loadedImgs: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length,
    brokenImgs: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
    h1: (document.querySelector('h1')||{}).textContent || '',
    firstImgSrc: (document.querySelector('.feed-tile img')||{}).src || '',
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }))()`,
  returnByValue: true,
});
console.log("STATE " + JSON.stringify(state.result?.result?.value || state.result));
console.log("ERRORS " + JSON.stringify(errors));

ws.close();
edge.kill();
process.exit(0);