// Diagnose: what actually renders on a fresh #index load?
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9440;
const BASE = "http://127.0.0.1:4175";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = "C:<local-path>";

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
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const events = [];
const page = await cdpConnect(created.webSocketDebuggerUrl, (msg) => {
  if (msg.method === "Runtime.exceptionThrown") {
    events.push("EXC: " + (msg.params?.exceptionDetails?.text || "") + " | " + JSON.stringify(msg.params?.exceptionDetails?.exception?.description || "").slice(0, 200));
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params?.type)) {
    const t = (msg.params?.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    events.push(msg.params.type.toUpperCase() + ": " + t.slice(0, 300));
  }
  if (msg.method === "Network.loadingFailed") {
    events.push("NET-FAIL: " + (msg.params?.errorText || "") + " " + (msg.params?.url || "").slice(0, 120));
  }
});
const call = page.send;
await call("Runtime.enable");
await call("Page.enable");

await call("Page.navigate", { url: `${BASE}/#index` });
await sleep(8000);

const st = await call("Runtime.evaluate", {
  expression: `(() => ({
    hash: location.hash,
    appLen: (document.querySelector('#app')||{}).innerHTML?.length || -1,
    appHead: (document.querySelector('#app')||{}).innerHTML?.slice(0, 120) || '',
    scripts: document.scripts.length,
    searchLayer: !!window.__searchLayer,
    bodyChildren: document.body.children.length,
  }))()`,
  returnByValue: true,
});
console.log("STATE " + JSON.stringify(st.result?.result?.value || st.result));
console.log("EVENTS " + JSON.stringify(events));
writeFileSync("C:<local-path>", JSON.stringify({ state: st.result?.result?.value, events }, null, 2));
page.ws.close();
edge.kill();
process.exit(0);