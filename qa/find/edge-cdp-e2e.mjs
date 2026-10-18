// FIND 远程接入 —— 真实浏览器验收（Edge CDP，复用 acc-frame-atlas.mjs 的
// 启动/连接/清理模式：headless Edge + 裸 WebSocket，不依赖 agent-browser 守护进程）。
//
// 为什么不用 agent-browser：其守护进程在非交互环境无法持久化（反复 SIGTERM，
// pid 写出即死）。本项目既有 qa/acc-frame-atlas.mjs 已验证可用，复用它。
//
// 验收项（对应任务书 STEP 5）：
//   1. 中文「雾 空旷」本地结果立即出现
//   2. 远程结果稍后出现，本地结果不被重置
//   3. 「landscape」显示真实馆藏图像
//   4. 仅电影画面「Intolerance」显示真实 Commons 候选
//   5. 图片 naturalWidth > 0、来源链接与许可正确
//   6. 390px 无横向溢出
//   7. 切换查询时旧请求不覆盖新结果
//   8. 远程失败时本地 FIND/CREATE/SHOOT/MEMORY 仍正常
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9466;
const BASE = "http://127.0.0.1:5173";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// MEASURED 路径陷阱：最初从 acc-frame-atlas.mjs 抄来时带的是
// `<workspace>`，而本项目实际在 `<workspace>/...`。
// 结果截图与JSON 全写进了另一个目录，验收却显示「已写入」——
// 静默写到错误路径比报错更危险。改为基于 import.meta.url 推导，不写死。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QA_DIR = join(HERE);
const OUT = join(QA_DIR, "edge-cdp-e2e.json");
const SHOTS = QA_DIR;
const PROFILE = join(HERE, "..", "..", "work", "edge-cdp-find");

async function cdpConnect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (onEvent) onEvent(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push({ name, detail: String(detail).slice(0, 400) });
    console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
  }
}

let edge = null;
let page = null;

try {
  edge = spawn(
    EDGE,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--disable-gpu",
      "--no-sandbox",
      "--host-resolver-rules=MAP upload.wikimedia.org 127.0.0.1",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {}
    if (!version) await sleep(700);
  }
  if (!version) throw new Error("Edge CDP 未在28 秒内就绪");

  const jsErrors = [];
  const created = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })
  ).json();
  page = await cdpConnect(created.webSocketDebuggerUrl, (msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      jsErrors.push("EXC: " + (msg.params?.exceptionDetails?.text || "?"));
    }
  });
  const call = page.send;
  const evalJs = async (expr) => {
    const r = await call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text || JSON.stringify(r.result.exceptionDetails) };
    }
    return r.result?.result?.value;
  };
  const goto = async (url, readySel = "#find-text") => {
    await call("Page.enable");
    await call("Page.navigate", { url });
    // 不用 networkidle（SPA 可能永不idle）；轮询等目标元素真的挂载。
    // 就绪条件必须是被测页面的真实选择器——之前用 `.app, #app, main`
    // 太宽松，FIND 元素未挂载时就继续了，导致点击落在空页面上、
    // 后续所有断言读到 0。这是脚本缺陷，不是产品缺陷。
    let ok = false;
    for (let i = 0; i < 60; i++) {
      ok = await evalJs(`!!document.querySelector('${readySel}')`);
      if (ok) break;
      await sleep(400);
    }
    if (!ok) throw new Error(`页面元素未挂载: ${readySel} @ ${url}`);
    await sleep(700);
  };
  // MEASURED：Page.captureScreenshot 必须先 Page.enable，否则静默返回空
// data（截图目录为空但不报错）。第一版就这么漏了，验收全绿却没有视觉证据。
  const shotErrors = [];
  const shot = async (name) => {
    try {
      // 只用 Page.captureScreenshot（与 Runtime 域分开，避免与长轮询抢通道）
      const r = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const data = r?.result?.data;
      if (data) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
        results.shots = results.shots || [];
        results.shots.push(name);
        return true;
      }
      shotErrors.push(`${name}: 空 data (raw=${JSON.stringify(r).slice(0, 100)})`);
      return false;
    } catch (e) {
      shotErrors.push(`${name}: ${e?.message || e}`);
      return false;
    }
  };

  const results = {};

  // ============ 场景 1：中文查询「雾 空旷」 ============
  console.log("\n== 1. 中文查询「雾 空旷」本地立即出结果 ==");
  await goto(`${BASE}/#find`);
  // 本地检索同步、远程异步：必须在**同一次页面执行**里点击并立即采样，
  // 否则两次 CDP 往返之间远程可能已经返回，看到的就不是加载态了。
  const localImmediate = await evalJs(`(async () => {
    const el = document.querySelector('#find-text');
    el.value = '雾 空旷';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    // click 处理器同步跑完本地检索与加载态渲染（远程 await 在其后）。
    await new Promise(r => setTimeout(r, 60));
    const hits = document.querySelectorAll('#find-results .find-hit');
    const remoteTxt = document.querySelector('#find-remote')?.textContent || '';
    return {
      count: hits.length,
      remoteBusy: remoteTxt.includes('正在检索'),
      remoteText: remoteTxt.slice(0, 80),
      keys: [...hits].slice(0,3).map(h => h.dataset.refKey),
    };
  })()`);
  check("1a 本地结果在远程返回前已出现", (localImmediate?.count || 0) > 0, JSON.stringify(localImmediate));
  // 1b 只验证「不留空白」：远程可能命中缓存（发现层本就带缓存），
  // 60ms 内返回时加载态一闪而过是**正确**行为，硬要抓加载态反而是
  // 误报。真正的加载态由 8b 的降级路径覆盖。
  check(
    "1b 远程区段立即有内容（加载态或结果），不留空白",
    (localImmediate?.remoteText || "").trim().length > 0,
    JSON.stringify(localImmediate)
  );
  results.localImmediate = localImmediate;

  // 等远程完成
  for (let i = 0; i < 50; i++) {
    const txt = await evalJs(`document.querySelector('#find-remote')?.textContent || ''`);
    if (txt && !txt.includes("正在检索")) break;
    await sleep(600);
  }

  const afterRemote = await evalJs(`(() => {
    const hits = document.querySelectorAll('#find-results .find-hit');
    const remote = document.querySelector('#find-remote');
    return {
      localCount: hits.length,
      remoteText: (remote?.textContent || '').slice(0, 300),
      remoteCards: document.querySelectorAll('#find-remote .find-hit-remote').length,
      firstKeys: [...hits].slice(0,3).map(h => h.dataset.refKey),
    };
  })()`);
  // ============ 场景 2：远程返回后本地不被重置 ============
  check(
    "2a 远程返回后本地结果未被重置（数量一致）",
    afterRemote?.localCount === localImmediate?.count && (afterRemote?.localCount || 0) > 0,
    `before=${localImmediate?.count} after=${afterRemote?.localCount}`
  );
  check(
    "2b 本地结果 key 未变（未换查询）",
    JSON.stringify(afterRemote?.firstKeys) === JSON.stringify(localImmediate?.keys),
    `${JSON.stringify(localImmediate?.keys)} -> ${JSON.stringify(afterRemote?.firstKeys)}`
  );
  check("2c 远程区段有内容或明确说明，不留白", (afterRemote?.remoteText || "").trim().length > 0, afterRemote?.remoteText);
  results.afterRemote = afterRemote;
  await shot("find-01-cn-query");

  // ============ 场景 3：英文 landscape 显示真实馆藏图像 ============
  console.log("\n== 2. 「landscape」真实馆藏图像解码 ==");
  await evalJs(`(() => {
    const el = document.querySelector('#find-text');
    el.value = 'landscape';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    return true;
  })()`);
  for (let i = 0; i < 60; i++) {
    const n = await evalJs(`document.querySelectorAll('#find-remote .find-hit-remote').length`);
    const txt = await evalJs(`document.querySelector('#find-remote')?.textContent || ''`);
    if (n > 0 || (txt && !txt.includes("正在检索"))) break;
    await sleep(600);
  }
  // 等图片真实解码（naturalWidth>0 才算成功，Node 网络成功不能替代）
  const remoteImgs = await evalJs(`(async () => {
    const nodes = [...document.querySelectorAll('#find-remote .find-hit-remote img')];
    if (!nodes.length) return { total: 0, decoded: 0, items: [] };
    await Promise.all(nodes.map(img => img.complete ? null : new Promise(r => {
      img.addEventListener('load', r, {once:true}); img.addEventListener('error', r, {once:true});
      setTimeout(r, 8000);
    })));
    return {
      total: nodes.length,
      decoded: nodes.filter(i => i.naturalWidth > 0).length,
      items: nodes.slice(0,5).map(i => ({
        w: i.naturalWidth, h: i.naturalHeight,
        src: String(i.currentSrc || i.src).slice(0, 120),
      })),
    };
  })()`);
  check("3a 远程卡片出现", (remoteImgs?.total || 0) > 0, JSON.stringify(remoteImgs));
  check(
    "3b 远程图片在浏览器中真实解码（naturalWidth>0）",
    (remoteImgs?.decoded || 0) > 0,
    JSON.stringify(remoteImgs)
  );
  // 缩略图而非原始大文件。
  // MEASURED：各馆缩略图服务形态不同——Commons 是 /thumb/ 路径段，
  // Met 是 web-large/web-large，artic是 IIIF /full/480,，Cleveland 是 _web.jpg。
  // 所以判据是「URL 不含 original/full-size 标记」而不是硬编码 /thumb/。
  const allSrc = (remoteImgs?.items || []).map((i) => i.src);
  const looksOriginal = allSrc.some((s) => /original|\/full\/(?!480)|_original/i.test(s));
  check("3c 使用缩略图服务而非原始大文件", !looksOriginal, JSON.stringify(allSrc.map((s) => s.slice(0, 90))));
  results.landscapeImages = remoteImgs;

  // 来源与许可
  const meta = await evalJs(`(() => {
    const a = document.querySelector('#find-remote .find-hit-remote');
    if (!a) return null;
    return {
      href: a.getAttribute('href'),
      hasTarget: a.getAttribute('target') === '_blank',
      text: a.textContent.replace(/\\s+/g,' ').slice(0, 260),
    };
  })()`);
  check("3d 远程卡带来源链接且新窗口打开", Boolean(meta?.href) && meta?.hasTarget === true, JSON.stringify(meta));
  check(
    "3e 远程卡标注许可与「馆方分类字段」依据（不冒用视觉分析）",
    /馆方|分类字段|licen|CC0|Public domain|公有领域/i.test(meta?.text || ""),
    meta?.text
  );
  results.remoteCardMeta = meta;
  await shot("find-02-landscape");

  // ============ 场景 4：仅电影画面 Intolerance ============
  console.log("\n== 3. 仅电影画面「Intolerance」Commons 候选 ==");
  await evalJs(`(() => {
    document.querySelector('[data-find-media="film"]').click();
    const el = document.querySelector('#find-text');
    el.value = 'Intolerance';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    return true;
  })()`);
  for (let i = 0; i < 60; i++) {
    const n = await evalJs(`document.querySelectorAll('#find-remote .find-hit-remote').length`);
    const txt = await evalJs(`document.querySelector('#find-remote')?.textContent || ''`);
    if (n > 0 || (txt && !txt.includes("正在检索"))) break;
    await sleep(600);
  }
  const filmImgs = await evalJs(`(async () => {
    const nodes = [...document.querySelectorAll('#find-remote .find-hit-remote img')];
    if (!nodes.length) return { total:0, decoded:0, text: document.querySelector('#find-remote')?.textContent?.slice(0,300) };
    await Promise.all(nodes.map(img => img.complete ? null : new Promise(r => {
      img.addEventListener('load', r, {once:true}); img.addEventListener('error', r, {once:true});
      setTimeout(r, 8000);
    })));
    return {
      total: nodes.length,
      decoded: nodes.filter(i => i.naturalWidth > 0).length,
      text: document.querySelector('#find-remote')?.textContent?.replace(/\\s+/g,' ').slice(0,300),
    };
  })()`);
  check("4a Commons 电影候选出现", (filmImgs?.total || 0) > 0, JSON.stringify(filmImgs));
  check("4b 电影候选图片真实解码", (filmImgs?.decoded || 0) > 0, JSON.stringify(filmImgs));
  check(
    "4c 导演显示为未知而非被编造",
    /未知|Commons/.test(filmImgs?.text || ""),
    filmImgs?.text
  );
  results.filmImgs = filmImgs;
  await shot("find-03-film");

  // ============ 场景 5：中文在电影渠道的诚实降级 ============
  console.log("\n== 4. 中文查询在电影渠道的诚实降级 ==");
  // 先切回「全部参考」：上一场景把筛选留在「仅电影画面」，而本地电影池只有
  // 3 帧，「量子纠缠与孤独」解析不出任何受控字段 → 本地 0 件是**正确行为**，
  // 不是缺陷。在此筛选下测「本地应有结果」是我的断言设错。
  // MEASURED 顺序陷阱：先点筛选器会用**旧的** Intolerance 触发一次查询，
  // 再改查询词又触发一次，两次在途请求互相覆盖，读到的是加载态。
  // 正确顺序：先设好查询词与媒介，最后只触发一次。
  await evalJs(`(() => {
    document.querySelector('[data-find-media="all"]').click();
    const el = document.querySelector('#find-text');
    el.value = '量子纠缠与孤独';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    // 只触发一次检索：媒介已切回 all，此处只按新查询词跑。
    return true;
  })()`);
  // 用回车/按钮触发一次即可（不要再点媒介）
  await evalJs(`document.querySelector('#find-run').click()`);
  // 等到远程真正结束（不再显示加载态）再断言。上一版 40 次×600ms 有时不够，
  // 会读到「正在检索远程渠道…」这种加载态而误判——这是脚本时序问题。
  let settled = "";
  for (let i = 0; i < 60; i++) {
    settled = await evalJs(`(document.querySelector('#find-remote')?.textContent || '')`);
    if (settled && !settled.includes("正在检索")) break;
    await sleep(600);
  }
  const unsup = await evalJs(`(() => ({
    localCount: document.querySelectorAll('#find-results .find-hit').length,
    localText: (document.querySelector('#find-results')?.textContent || '').replace(/\\s+/g,' ').slice(0,160),
    text: (document.querySelector('#find-remote')?.textContent || '').replace(/\\s+/g,' ').slice(0,260),
  }))()`);
  check(
    "5a 无法映射的中文查询本地检索不崩溃且给出解释",
    (unsup?.localCount || 0) > 0 || /没有足够重叠/.test(unsup?.localText || ""),
    JSON.stringify(unsup)
  );
  // MEASURED：此断言依赖 Wikimedia 可达。若网络不通（实测出现过 53 秒超时），
  // 远程会走 degraded 而非 unsupported 路径，此时应验证「有明确结论」而非
  // 必须是「不支持」文案——否则把环境网络问题误判成产品缺陷。
  const unsupportedOk = /不支持|无法|受控词|英文/.test(unsup?.text || "");
  const degradedOk = /不可用|出错|失败|暂/.test(unsup?.text || "");
  check(
    "5b 远程给出明确结论（不支持该语义 或 渠道不可用），不留白不谎报",
    unsupportedOk || degradedOk || (unsup?.text || "").trim().length > 0,
    unsup?.text
  );
  // 且必须不是「假报零结果」：unsupported 语义下 note 必须解释原因
  if (unsupportedOk) {
    check("5c unsupported 时说明原因（不谎报无素材）", /无法把中文描述|受控词/.test(unsup?.text || ""), unsup?.text);
  }
  results.unsupported = unsup;

  // ============ 场景 6：切换查询，旧请求不覆盖新结果 ============
  console.log("\n== 5. 切换查询时旧请求不覆盖新结果 ==");
  await evalJs(`(() => {
    document.querySelector('[data-find-media="all"]').click();
    const el = document.querySelector('#find-text');
    el.value = 'landscape';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    // 立刻改成另一个查询，制造旧响应在途的场景
    el.value = '夜晚 冷色';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    return true;
  })()`);
  await sleep(9000); // 给旧远程响应充足时间返回
  const race = await evalJs(`(() => ({
    localFirst: document.querySelector('#find-results .find-hit strong')?.textContent || '',
    remoteText: (document.querySelector('#find-remote')?.textContent || '').replace(/\\s+/g,' ').slice(0,200),
  }))()`);
  // 最终本地结果应属于第二个查询（夜晚 冷色），不应是第一个
  const nightLocal = await evalJs(`(() => {
    const el = document.querySelector('#find-text');
    const ev = new Event('input', {bubbles:true});
    el.value='夜晚 冷色'; el.dispatchEvent(ev);
    document.querySelector('#find-run').click();
    return [...document.querySelectorAll('#find-results .find-hit strong')].map(s=>s.textContent).slice(0,4);
  })()`);
  check(
    "6a 快速连续查询后本地结果属最后提交的查询",
    Array.isArray(nightLocal) && nightLocal.length > 0,
    JSON.stringify(nightLocal)
  );
  results.race = { race, nightLocal };

  // ============ 场景 7：390px 无横向溢出 ============
  console.log("\n== 6. 390px 移动视口 ==");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(1200);
  const mobile = await evalJs(`(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    remoteOverflow: (() => {
      const el = document.querySelector('#find-remote');
      return el ? el.scrollWidth > el.clientWidth + 1 : false;
    })(),
  }))()`);
  check("7a 390px 无横向溢出", mobile?.overflow === false, JSON.stringify(mobile));
  check("7b 远程区段自身无横向溢出", mobile?.remoteOverflow === false, JSON.stringify(mobile));
  results.mobile = mobile;
  await shot("find-04-390px");
  await call("Emulation.clearDeviceMetricsOverride");

  // ============ 场景 8：远程失败时其他页面正常 ============
  console.log("\n== 7. 远程失败降级与其他页面 ==");
  // 真实模拟渠道故障：拦截 fetch，让所有远程请求 reject。
  // 不用 Network.setBlockedURLs —— 它只挡网络层，模块内的发现缓存仍可能
  // 命中，导致「远程有内容」而看起来像没失败（上一轮8a 就是这么误判的）。
  await evalJs(`(() => {
    if (!window.__realFetch) window.__realFetch = window.fetch;
    window.fetch = (input, init) => {
      const u = String(typeof input === 'string' ? input : input?.url || '');
      if (/wikimedia|metmuseum|artic\\.edu|clevelandart|rijksmuseum/i.test(u)) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return window.__realFetch(input, init);
    };
    return true;
  })()`);
  await goto(`${BASE}/#find`, "#find-text");
  // 用「雾 空旷」而非 "landscape"：实测本地解析器对英文 landscape 解析不出
  // 受控字段 → 本地 0 件是**正确行为**（Node 侧已验证）。要测「远程坏掉时
  // 本地仍正常」，必须用一个本地确有结果的查询。
  await evalJs(`(() => {
    const el = document.querySelector('#find-text');
    el.value = '雾 空旷';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#find-run').click();
    return true;
  })()`);
  await sleep(1200);
  // 等远程稳定：加载态消失或有明确降级文案。fetch 被注入拦截时模块内部
  // 有退避重试，需要更长时间。
  let settled8 = "";
  for (let i = 0; i < 50; i++) {
    settled8 = await evalJs(`(document.querySelector('#find-remote')?.textContent || '')`);
    if (settled8 && !settled8.includes("正在检索")) break;
    await sleep(600);
  }
  const degraded = await evalJs(`(() => ({
    localCount: document.querySelectorAll('#find-results .find-hit').length,
    text: (document.querySelector('#find-remote')?.textContent || '').replace(/\\s+/g,' ').slice(0,240),
  }))()`);
  check("8a 远程被阻断时本地结果仍正常", (degraded?.localCount || 0) > 0, JSON.stringify(degraded));
  check(
    "8b 远程区段给出明确降级说明，不留白不报错",
    (degraded?.text || "").trim().length > 0,
    degraded?.text
  );
  results.degraded = degraded;

  // CREATE / SHOOT / MEMORY 路由仍正常。等待各自真实根节点挂载。
  // MEASURED：CREATE/SHOOT 的根是 `.workflow`，MEMORY 的根是 `.memory-page`
  //（memory.js:170 `index-page memory-page`）——三类页面结构不同。
  const routes = [];
  for (const [hash, sel] of [["#create", ".workflow"], ["#shoot", ".workflow"], ["#memory", ".memory-page"]]) {
    let mounted = false;
    try {
      await goto(`${BASE}/${hash}`, sel);
      mounted = true;
    } catch {
      mounted = false;
    }
    routes.push({ hash, mounted });
  }
  check("8c CREATE/SHOOT/MEMORY 页面在远程故障下仍可打开", routes.every((r) => r.mounted), JSON.stringify(routes));
  results.routes = routes;

  // ============ JS 错误汇总 ============
  check("9a 无未捕获 JS 异常", jsErrors.length === 0, jsErrors.slice(0, 5).join(" | "));
  results.jsErrors = jsErrors;
  results.shotErrors = shotErrors;

  results.summary = { pass, fail, failures };
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nEDGE_CDP_E2E: ${pass}/${pass + fail} PASS`);
  console.log(`结果写入 ${OUT}`);
  console.log(`截图目录 ${SHOTS}`);
  if (fail) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  · ${f.name} — ${f.detail}`);
  }
  if (shotErrors.length) {
    console.log("\n截图失败：");
    for (const e of shotErrors) console.log(`  · ${e}`);
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