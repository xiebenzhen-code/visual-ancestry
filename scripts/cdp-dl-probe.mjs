// Probe: can we download a Wikimedia image via a headless Edge CDP session?
// Node 22 global WebSocket drives CDP; page-context fetch (same-origin after
// navigate) returns base64 bytes that we write to disk.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9399;
const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = process.cwd() + "\\work\\edge-dl-probe";

function edgePath() {
  return EDGE;
}

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send };
}

async function main() {
  const url = "https://commons.wikimedia.org/wiki/Special:FilePath/Great%20Wave%20off%20Kanagawa2.jpg?width=600";
  const edge = spawn(edgePath(), [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "about:blank",
  ], { stdio: "ignore" });

  // Wait for the CDP HTTP endpoint.
  let version = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      version = await r.json();
      break;
    } catch {}
    await sleep(700);
  }
  if (!version) {
    console.log("RESULT CDP-DOWN");
    edge.kill();
    return;
  }

  const { ws, send } = await cdpConnect(version.webSocketDebuggerUrl);

  // Create a page via /json/new (returns webSocketDebuggerUrl directly).
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
  const createdJson = await created.json();
  if (!createdJson.webSocketDebuggerUrl) {
    console.log("RESULT NO-PAGE-WS", JSON.stringify(createdJson).slice(0, 200));
    ws.close();
    edge.kill();
    return;
  }
  const page = await cdpConnect(createdJson.webSocketDebuggerUrl);
  const call = page.send;

  await call("Page.enable");
  await call(
    "Page.navigate",
    { url }
  );
  // Wait until document is ready and location matches the image.
  let lastHref = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const st = await call("Runtime.evaluate", {
      expression: `({ href: location.href, ready: document.readyState })`,
      returnByValue: true,
    });
    if (i === 0) console.log("RAW-EVAL-0", JSON.stringify(st).slice(0, 400));
    const v = st.result?.result?.value;
    lastHref = v && v.href ? v.href : null;
    if (v && v.href && v.href.includes("wikimedia")) break;
  }
  console.log("HREF-RAW", JSON.stringify(lastHref).slice(0, 200));

  const expr = `(async () => {
    try {
      const r = await fetch(location.href);
      if (!r.ok) return { err: 'http ' + r.status };
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      return { size: buf.length, b64: btoa(bin) };
    } catch (e) { return { err: String(e) }; }
  })()`;
  const ev = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const val = ev.result?.result?.value;
  if (!val || typeof val !== "object" || !val.b64) {
    console.log("RESULT FETCH-FAIL", JSON.stringify(val || ev.result?.exceptionDetails || ev.result).slice(0, 300));
  } else {
    mkdirSync("work/dl-test", { recursive: true });
    writeFileSync("work/dl-test/wave-600.jpg", Buffer.from(val.b64, "base64"));
    console.log("RESULT OK bytes=" + val.size);
  }
  ws.close();
  edge.kill();
}

main().catch((e) => {
  console.log("RESULT SCRIPT-ERR " + e.message);
  process.exit(1);
});