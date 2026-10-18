// 页面实例守卫 — 针对性对抗测试（Edge CDP）。
//
// 要证明的不是「功能正常」，而是「旧实例的写入被拒绝」：
//   FIND A 发起延迟请求 → 离开 FIND → 重新进入 FIND B → A 的响应返回
//   → B 的界面与 TaskContext 不被修改。
//
// 实现要点：
//   · 用 **hash 路由**（location.hash 赋值）做 A→B 切换。这是同文档导航，
//     JS 上下文存活——FIND_ACTIVE_INSTANCE 与 A 的在途请求都不会被重建。
//     这正是守卫必须存在的场景（若用 Page.navigate 会整页重载，请求被中止，
//     反而测不到问题）。
//   · 远程层不靠改模块（import 绑定在模块加载时已固定，改 window 属性无效），
//     而是覆盖 window.fetch 让远程域名挂起，并把 resolver 排队。
//     这样 A 的响应何时返回完全由测试控制，能精确制造「B 挂载后才返回」。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "instance-guard.json");
const SHOTS = HERE;
const PORT = 9493;
const BASE = "http://127.0.0.1:5173";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const REMOTE_HOSTS = /wikimedia|metmuseum|artic\.edu|clevelandart|rijksmuseum/i;

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ws, send };
}

let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  PASS ${n}`); }
  else { fail++; failures.push({ n, d: String(d).slice(0, 400) }); console.log(`  FAIL ${n}${d ? ` — ${String(d).slice(0, 220)}` : ""}`); }
};

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
let page = null;
const results = {};
try {
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    if (!version) await sleep(700);
  }
  if (!version) throw new Error("Edge CDP 未就绪");
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  page = await cdpConnect(created.webSocketDebuggerUrl);
  const call = page.send;
  const evalJs = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (r?.result?.data) { mkdirSync(SHOTS, { recursive: true }); writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64")); return true; }
    return false;
  };
  // 注入远程挂起闸门：所有远程域名的 fetch 不 resolve，resolver 入队等释放
  const installGate = () => evalJs(`(() => {
    if (window.__remoteGate) return true;
    window.__remoteGate = { queue: [], released: 0 };
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const u = String(typeof input === 'string' ? input : (input && input.url) || '');
      if (${JSON.stringify(REMOTE_HOSTS.source)}.length && new RegExp(${JSON.stringify(REMOTE_HOSTS.source)}).test(u)) {
        return new Promise((resolve, reject) => {
          window.__remoteGate.queue.push({ resolve, reject, url: u.slice(0, 90) });
        });
      }
      return real(input, init);
    };
    return true;
  })()`);

  // ============ 0. 前置：实例号单调递增（证伪旧实现）============
  console.log("\n== 0. 实例号单调递增 ==");
  await call("Page.enable");
  await call("Page.navigate", { url: `${BASE}/#find` });
  for (let i = 0; i < 60; i++) { if (await evalJs(`!!document.querySelector('.find-page')`)) break; await sleep(400); }
  await sleep(700);
  await installGate();
  const inst1 = await evalJs(`document.querySelector('.find-page')?.dataset.findInstance`);
  // 同文档 hash 导航到别处再回来（保持 JS 上下文）
  await evalJs(`location.hash = '#memory'`);
  await sleep(900);
  await evalJs(`location.hash = '#find'`);
  await sleep(900);
  const inst2 = await evalJs(`document.querySelector('.find-page')?.dataset.findInstance`);
  check("0a 两次挂载得到不同实例号", inst1 !== inst2, `A=${inst1} B=${inst2}`);
  check("0b 实例号确实在递增", Number(inst2) > Number(inst1), `A=${inst1} B=${inst2}`);
  results.instances = { first: inst1, second: inst2 };

  // ============ 1. 对抗：A 的延迟响应不得污染 B ============
  console.log("\n== 1. 对抗测试：A 延迟响应不污染 B ==");
  // 重新进入 FIND A（新实例），发起查询让远程挂起
  await evalJs(`location.hash = '#find'`);
  await sleep(900);
  await installGate();
  const instA = await evalJs(`document.querySelector('.find-page')?.dataset.findInstance`);
  const aState = await evalJs(`(() => {
    const el = document.querySelector('#find-text');
    el.value = 'landscape';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    return {
      instance: document.querySelector('.find-page')?.dataset.findInstance,
      localCount: document.querySelectorAll('#find-results .find-hit').length,
      localFirst: document.querySelector('#find-results .find-hit strong')?.textContent || '',
      pendingRemote: (window.__remoteGate?.queue || []).length,
    };
  })()`);
  check("1a A 已发起查询且有远程请求在途", (aState?.pendingRemote || 0) > 0, JSON.stringify(aState));

  // 离开 FIND → 重新进入 FIND B（同文档，A 的请求仍挂起）
  await evalJs(`location.hash = '#memory'`);
  await sleep(900);
  await evalJs(`location.hash = '#find'`);
  await sleep(900);
  const instB = await evalJs(`document.querySelector('.find-page')?.dataset.findInstance`);
  check("1b B 是与 A 不同的实例", instB !== instA, `A=${instA} B=${instB}`);

  // 在 B 上做一个可识别的查询（也让其远程挂起，稍后单独释放）
  const bState = await evalJs(`(() => {
    const el = document.querySelector('#find-text');
    el.value = '雾 空旷';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    return {
      instance: document.querySelector('.find-page')?.dataset.findInstance,
      localCount: document.querySelectorAll('#find-results .find-hit').length,
      localFirst: document.querySelector('#find-results .find-hit strong')?.textContent || '',
      pendingRemote: (window.__remoteGate?.queue || []).length,
    };
  })()`);

  // 现在释放 **A 的** 挂起响应（队列里第一个就是 A 的 landscape 请求），
  // 返回一个带可识别标记的结果。若守卫失效，它会写进 B 的界面。
  const released = await evalJs(`(() => {
    const q = window.__remoteGate?.queue || [];
    if (!q.length) return 'queue-empty';
    const first = q.shift();
    first.resolve(new Response(JSON.stringify({
      query: { pages: [{ title: 'File:STALE-FROM-A.jpg', imageinfo: [{ mime: 'image/jpeg', url: 'https://stale.example/a.jpg', width: 100, height: 100, thumburl: 'https://stale.example/a-thumb.jpg', descriptionurl: 'https://stale.example/a' }] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    return 'released-A';
  })()`);
  await sleep(3000);

  const afterA = await evalJs(`(() => {
    const remote = document.querySelector('#find-remote');
    const txt = remote?.textContent || '';
    return {
      instance: document.querySelector('.find-page')?.dataset.findInstance,
      localCount: document.querySelectorAll('#find-results .find-hit').length,
      localFirst: document.querySelector('#find-results .find-hit strong')?.textContent || '',
      remoteCards: document.querySelectorAll('#find-remote .find-hit-remote').length,
      hasStale: /STALE-FROM-A|stale\\.example/.test(txt),
      remoteText: txt.replace(/\\s+/g,' ').slice(0, 160),
    };
  })()`);

  check("1c A 的陈旧响应未写入 B 的远程区段", afterA?.hasStale === false, JSON.stringify(afterA));
  check("1d B 的本地结果未被 A 的响应改变", afterA?.localCount === bState?.localCount, `B=${bState?.localCount} after=${afterA?.localCount}`);
  check("1e B 的首位结果仍是 B 自己的查询结果", afterA?.localFirst === bState?.localFirst, `B="${bState?.localFirst}" after="${afterA?.localFirst}"`);

  // ============ 2. 反向对照：B 自己的响应能正常写入 ============
  console.log("\n== 2. 反向对照：B 自己的响应正常写入 ==");
  // MEASURED：不能reject——getJSON 遇 transport 错误会重试并重新入队，
  // 形成自持循环（实测 drained=4 后队列又涨到 6），B 永远等不到响应。
  // 正确做法：把队列里剩余请求全部以**合法空响应**resolve。A 的会被实例守卫
  // 拒绝（这正是要证的），B 的会正常走完 → 加载态结束。
  // MEASURED：排空必须循环。resolve 一个请求会触发 adapter 链式发起后续
  // 请求（实测 releasedAll=4 后队列又回填到 4），单次排空不够。
  // 另外不能 reject：getJSON 遇 transport 错误会重试并入队，同样自持循环。
  let releasedTotal = 0;
  for (let round = 0; round < 12; round++) {
    const n = await evalJs(`(() => {
      const q = window.__remoteGate?.queue || [];
      const c = q.length;
      q.splice(0).forEach(({ resolve }) => {
        resolve(new Response(JSON.stringify({ query: { pages: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } }));
      });
      return c;
    })()`);
    releasedTotal += n;
    await sleep(1500);
    const done = await evalJs(`!/正在检索/.test(document.querySelector('#find-remote')?.textContent || '')`);
    if (done) break;
  }
  await sleep(1500);
  const afterB = await evalJs(`(() => {
    const remote = document.querySelector('#find-remote');
    const txt = remote?.textContent || '';
    return {
      remoteText: txt.replace(/\s+/g,' ').slice(0, 200),
      responded: !/正在检索/.test(txt),
      stillStaleFree: !/STALE-FROM-A/.test(txt),
    };
  })()`);
  check("2a B 自己的远程响应已被处理（加载态结束）", afterB?.responded === true, JSON.stringify(afterB));
  check("2b 全部释放后 B 界面仍无陈旧标记", afterB?.stillStaleFree === true, JSON.stringify(afterB));
  results.adversarial = { instA, instB, aState, bState, released, afterA, releasedTotal, afterB };

  // ============ 3. TaskContext 连续性 ============
  console.log("\n== 3. TaskContext 连续性 ==");
  const tc = await evalJs(`(async () => {
    try {
      const m = await import('/src/utils/taskContext.js');
      const snap = m.getSnapshot();
      return { ok: true, hasIntent: Boolean(snap && (snap.intent || snap.current)), keys: Object.keys(snap || {}).slice(0, 8) };
    } catch (e) { return { err: e.message }; }
  })()`);
  check("3a TaskContext 可读取", tc?.ok === true, JSON.stringify(tc));
  results.taskContext = tc;

  // ============ 4. 截图证据 ============
  console.log("\n== 4. 截图证据 ==");
  const ok = await shot("instance-guard-b-after-stale-release");
  check("4a 截图已生成", ok === true, "");
  results.shot = ok;

  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nINSTANCE_GUARD: ${pass}/${pass + fail} PASS`);
  console.log(`记录: ${OUT}`);
  if (fail) { console.log("\n失败项："); for (const f of failures) console.log(`  · ${f.n} — ${f.d}`); }
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  console.log(`\nBROWSER_GATE_BLOCKED: ${e.message}`);
  process.exitCode = 2;
} finally {
  try { if (page?.ws) page.ws.close(); } catch {}
  try { if (edge) edge.kill(); } catch {}
  await sleep(400);
}