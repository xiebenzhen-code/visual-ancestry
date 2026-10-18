// Check whether AIC IIIF images load inside a real browser (same egress).
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9423;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = process.cwd() + "\\work\\edge-aic-probe";

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
if (!version) { console.log("CDP-DOWN"); process.exit(1); }

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await cdpConnect(created.webSocketDebuggerUrl);
const call = page.send;
await call("Page.enable");

const url = "https://www.artic.edu/iiif/2/9ea39501-a7c9-efb7-9fe8-ef58e2f18967/full/960,/0/default.jpg";
await call("Page.navigate", { url });
await sleep(6000);

const st = await call("Runtime.evaluate", {
  expression: `(() => {
    const img = new Image();
    return new Promise((resolve) => {
      img.onload = () => resolve({ loaded: true, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ loaded: false });
      img.src = "https://www.artic.edu/iiif/2/9ea39501-a7c9-efb7-9fe8-ef58e2f18967/full/960,/0/default.jpg";
      setTimeout(() => resolve({ loaded: "timeout" }), 15000);
    });
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("IMG-TEST " + JSON.stringify(st.result?.result?.value || st.result));

// Also test page-context fetch status
const ft = await call("Runtime.evaluate", {
  expression: `fetch("https://www.artic.edu/iiif/2/9ea39501-a7c9-efb7-9fe8-ef58e2f18967/full/960,/0/default.jpg").then(r => ({ status: r.status, type: r.headers.get("content-type") })).catch(e => ({ err: String(e) }))`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("FETCH-TEST " + JSON.stringify(ft.result?.result?.value || ft.result));

page.ws.close();
edge.kill();
process.exit(0);