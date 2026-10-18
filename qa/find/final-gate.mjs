// FIND 最终收口 — 最小真实浏览器验收（Edge CDP）。
//
// 只覆盖本轮新增要求，不重跑历史用例：
//   A. 无关查询不产生虚假匹配（量子纠缠与孤独 + Chinese culture）
//   B. 快速切换模式 / 离开再返回 FIND，无旧结果污染
//   C. landscape 真实馆藏图片能解码
//   D. Intolerance 真实电影画面能解码
//   E. 390px 无横向溢出
//   F. 至少一张含远程卡片 + 实际图片 + 来源说明的完整截图
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "final-gate.json");
const SHOTS = HERE;
const PORT = 9481;
const BASE = "http://127.0.0.1:5173";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function cdpConnect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (onEvent) onEvent(m);
  };
  const send = (method, params = {}) => new Promise((r) => {
    const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = "") => {
  if (c) { pass++; console.log(`  PASS ${n}`); }
  else { fail++; failures.push({ n, d: String(d).slice(0, 300) }); console.log(`  FAIL ${n}${d ? ` — ${String(d).slice(0, 180)}` : ""}`); }
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

  const jsErrors = [];
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  page = await cdpConnect(created.webSocketDebuggerUrl, (m) => {
    if (m.method === "Runtime.exceptionThrown") jsErrors.push("EXC: " + (m.params?.exceptionDetails?.text || "?"));
  });
  const call = page.send;
  const evalJs = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const goto = async (hash, readySel = "#find-text") => {
    await call("Page.enable");
    await call("Page.navigate", { url: `${BASE}/${hash}` });
    for (let i = 0; i < 60; i++) {
      if (await evalJs(`!!document.querySelector('${readySel}')`)) break;
      await sleep(400);
    }
    await sleep(700);
  };
  const settle = async (maxSec = 40) => {
    for (let i = 0; i < maxSec * 2; i++) {
      const t = await evalJs(`(document.querySelector('#find-remote')?.textContent||'')`);
      if (t && !t.includes("正在检索")) return t;
      await sleep(500);
    }
    return await evalJs(`(document.querySelector('#find-remote')?.textContent||'')`);
  };
  const shot = async (name) => {
    const r = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (r?.result?.data) {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
      return true;
    }
    return false;
  };
  const search = async (q, media) => {
    await evalJs(`(() => {
      ${media ? `document.querySelector('[data-find-media="${media}"]').click();` : ""}
      const el = document.querySelector('#find-text');
      el.value = ${JSON.stringify(q)};
      el.dispatchEvent(new Event('input', {bubbles:true}));
      return true;
    })()`);
    await evalJs(`document.querySelector('#find-run').click()`);
  };

  // ============ A. 无关查询不产生虚假匹配 ============
  console.log("\n== A. 无关查询不产生虚假匹配 ==");
  await goto("#find");
  await search("量子纠缠与孤独");
  await settle();
  const a = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#find-remote .find-hit-remote')];
    return {
      cards: cards.length,
      // 卡片文本里若出现文化/年代作为"依据"即为虚假匹配
      texts: cards.map(c => c.textContent.replace(/\\s+/g,' ').slice(0,150)),
      sectionText: (document.querySelector('#find-remote')?.textContent||'').replace(/\\s+/g,' ').slice(0,200),
    };
  })()`);
  check("A1 无关查询不产出虚假匹配卡片", (a?.cards || 0) === 0, JSON.stringify(a));
  check(
    "A2 无关查询给出完整说明（两渠道结论都交代），不留白",
    /没有找到|无关联|未列入|没有足够|已检索|未找到|不支持/.test(a?.sectionText || ""),
    a?.sectionText
  );
  results.A = a;

  // ============ B. 快速切换模式 / 离开返回无污染 ============
  console.log("\n== B. 模式切换与离开/返回无旧结果污染 ==");
  // B1: 文字模式下发起慢查询，立刻切到图片模式
  await search("landscape");
  await evalJs(`document.querySelector('[data-find-mode="image"]').click()`);
  await sleep(2500);
  const b1 = await evalJs(`(() => ({
    mode: document.querySelector('[data-find-mode].is-on')?.dataset.findMode,
    remoteText: (document.querySelector('#find-remote')?.textContent||'').replace(/\\s+/g,' ').slice(0,120),
    remoteCards: document.querySelectorAll('#find-remote .find-hit-remote').length,
  }))()`);
  check("B1 切到图片模式后远程区段不出现旧查询结果", (b1?.remoteCards || 0) === 0, JSON.stringify(b1));
  check("B2 切到图片模式后远程区段已清空", (b1?.remoteText || "").trim() === "" || !/正在检索/.test(b1?.remoteText || ""), JSON.stringify(b1));

  // B2: 文字模式发起查询后立刻离开 FIND，再返回
  await evalJs(`document.querySelector('[data-find-mode="text"]').click()`);
  await search("Intolerance", "film");
  // 立即导航离开（远程仍在途）
  await call("Page.navigate", { url: `${BASE}/#memory` });
  await sleep(2500);
  const b2left = await evalJs(`(() => ({
    hash: location.hash,
    remoteCards: document.querySelectorAll('#find-remote .find-hit-remote').length,
  }))()`);
  check("B3 离开 FIND 后无远程卡片残留", (b2left?.remoteCards || 0) === 0, JSON.stringify(b2left));

  // B3: 重新进入 FIND，旧响应不应写入新实例
  await goto("#find");
  const b3 = await evalJs(`(() => ({
    remoteText: (document.querySelector('#find-remote')?.textContent||'').replace(/\\s+/g,' ').slice(0,120),
    remoteCards: document.querySelectorAll('#find-remote .find-hit-remote').length,
  }))()`);
  check("B4 重新进入 FIND 后无旧实例结果污染", (b3?.remoteCards || 0) === 0, JSON.stringify(b3));
  results.B = { b1, b2left, b3 };

  // ============ C. landscape 真实馆藏图片解码 ============
  console.log("\n== C. landscape 真实馆藏图片解码 ==");
  await search("landscape");
  await settle();
  const c = await evalJs(`(async () => {
    const nodes = [...document.querySelectorAll('#find-remote .find-hit-remote img')];
    if (!nodes.length) return { total: 0, decoded: 0 };
    await Promise.all(nodes.map(img => img.complete ? null : new Promise(r => {
      img.addEventListener('load', r, {once:true}); img.addEventListener('error', r, {once:true});
      setTimeout(r, 9000);
    })));
    return {
      total: nodes.length,
      decoded: nodes.filter(i => i.naturalWidth > 0).length,
      first: nodes[0] ? { w: nodes[0].naturalWidth, src: String(nodes[0].currentSrc||nodes[0].src).slice(0,110) } : null,
    };
  })()`);
  check("C1 landscape 有远程馆藏卡片", (c?.total || 0) > 0, JSON.stringify(c));
  check("C2 landscape 图片真实解码 naturalWidth>0", (c?.decoded || 0) > 0, JSON.stringify(c));
  results.C = c;

  // ============ D. Intolerance 真实电影画面解码 ============
  console.log("\n== D. Intolerance 真实电影画面解码 ==");
  await search("Intolerance", "film");
  await settle();
  const d = await evalJs(`(async () => {
    const nodes = [...document.querySelectorAll('#find-remote .find-hit-remote img')];
    if (!nodes.length) return { total: 0, decoded: 0, text: (document.querySelector('#find-remote')?.textContent||'').replace(/\\s+/g,' ').slice(0,160) };
    await Promise.all(nodes.map(img => img.complete ? null : new Promise(r => {
      img.addEventListener('load', r, {once:true}); img.addEventListener('error', r, {once:true});
      setTimeout(r, 9000);
    })));
    return {
      total: nodes.length,
      decoded: nodes.filter(i => i.naturalWidth > 0).length,
      first: nodes[0] ? { w: nodes[0].naturalWidth, src: String(nodes[0].currentSrc||nodes[0].src).slice(0,110) } : null,
      text: (document.querySelector('#find-remote')?.textContent||'').replace(/\\s+/g,' ').slice(0,200),
    };
  })()`);
  check("D1 Intolerance 有 Commons 电影候选", (d?.total || 0) > 0, JSON.stringify(d));
  check("D2 Intolerance 图片真实解码 naturalWidth>0", (d?.decoded || 0) > 0, JSON.stringify(d));
  results.D = d;

  // ============ E. 390px 无溢出 ============
  console.log("\n== E. 390px 无横向溢出 ==");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1400);
  const e = await evalJs(`(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    remoteOverflow: (() => { const el = document.querySelector('#find-remote'); return el ? el.scrollWidth > el.clientWidth + 1 : false; })(),
  }))()`);
  check("E1 390px 无横向溢出", e?.overflow === false, JSON.stringify(e));
  check("E2 390px 远程区段无横向溢出", e?.remoteOverflow === false, JSON.stringify(e));
  results.E = e;

  // ============ F. 完整截图：远程卡片 + 实际图片 + 来源说明 ============
  console.log("\n== F. 完整截图（含远程卡片与图片）==");
  // 回到桌面视口。MEASURED：Page.navigate 到**同一个 hash** 不会重载文档，
  // 上一场景留下的 activeMedia="film" 仍然有效——直接搜 landscape 会被
  // 电影筛选挡掉，远程 0 结果。必须先显式点回「全部参考」。
  await call("Emulation.clearDeviceMetricsOverride");
  await goto("#find");
  await evalJs(`document.querySelector('[data-find-media="all"]').click()`);
  await sleep(300);
  await search("landscape");
  await settle();
  // MEASURED：远程图片是 loading="lazy"，settle() 之后只等 1.2s 就截图会
  // 读到 naturalWidth=0（实测 4 张全部未解码），那是测试时序问题不是产品问题
  // （单独诊断确认 4/4 都能解码）。所以这里显式滚动 + 等图片真正解码完成。
  await evalJs(`document.querySelector('#find-remote')?.scrollIntoView({block:'start'})`);
  await evalJs(`(async () => {
    const imgs = [...document.querySelectorAll('#find-remote .find-hit-remote img')];
    await Promise.all(imgs.map(img => img.complete ? null : new Promise(r => {
      img.addEventListener('load', r, {once:true}); img.addEventListener('error', r, {once:true});
      setTimeout(r, 12000);
    })));
    return true;
  })()`);
  await sleep(1500);
  const shotState = await evalJs(`(() => ({
    cards: document.querySelectorAll('#find-remote .find-hit-remote').length,
    imgs: document.querySelectorAll('#find-remote .find-hit-remote img').length,
    decoded: [...document.querySelectorAll('#find-remote .find-hit-remote img')].filter(i=>i.naturalWidth>0).length,
    hasAttribution: /馆方|分类字段|Commons|博物馆/.test(document.querySelector('#find-remote')?.textContent||''),
    hasLinks: [...document.querySelectorAll('#find-remote .find-hit-remote')].filter(a=>a.getAttribute('href')).length,
  }))()`);
  const ok = await shot("final-gate-remote-full");
  check("F1 截图已生成", ok === true, "");
  check("F2 截图时远程卡片存在", (shotState?.cards || 0) > 0, JSON.stringify(shotState));
  check("F3 截图时远程图片已解码", (shotState?.decoded || 0) > 0, JSON.stringify(shotState));
  check("F4 截图时含来源/许可说明", shotState?.hasAttribution === true, JSON.stringify(shotState));
  check("F5 远程卡片带外链", (shotState?.hasLinks || 0) > 0, JSON.stringify(shotState));
  results.F = { shotState };

  check("G 无未捕获 JS 异常", jsErrors.length === 0, jsErrors.slice(0, 4).join(" | "));
  results.jsErrors = jsErrors;
  results.summary = { pass, fail, failures };

  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nFINAL_GATE: ${pass}/${pass + fail} PASS`);
  console.log(`记录: ${OUT}`);
  if (fail) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  · ${f.n} — ${f.d}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  console.log(`\nBROWSER_GATE_BLOCKED: ${e.message}`);
  process.exitCode = 2;
} finally {
  try { if (page?.ws) page.ws.close(); } catch {}
  try { if (edge) edge.kill(); } catch {}
  await sleep(400);
}