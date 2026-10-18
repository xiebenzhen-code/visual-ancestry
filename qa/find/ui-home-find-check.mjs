// Home + FIND UI 验收 — 真实浏览器（Edge CDP），多视口。
//
// 只覆盖本轮 UI 改动可验证的部分，不重跑历史用例，不触发任何 provider 调用，
// 不写预算账本（全程只用文字检索与静态页面）。
//
//   1. 首页首屏图片密度（桌面目标 8–12 张可见）、原始比例、无统一裁切
//   2. 首页说明默认隐藏；桌面 hover 才出现；触摸（hover:none）说明在图片下方
//   3. 首页搜索框 → FIND 的参数传递：查询文本与媒介选择都被保留并落地到结果
//   4. FIND 结果以图片为主；来源/授权/馆藏文本匹配/视觉分析仍分区标注
//   5. 1440 / 834 / 390 三种宽度均无横向溢出
//   6. CREATE / SHOOT / MEMORY / 作品详情路由仍可用
//
// 用法: node qa/find/ui-home-find-check.mjs <baseUrl> <label>
//   label 只用于输出目录与端口，便于对同一脚本跑 before / after 两套证据。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const LABEL = process.argv[3] || "after";
const OUTDIR = join(HERE, "ui-shots", LABEL);
const PORT = LABEL === "before" ? 9488 : 9489;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
mkdirSync(OUTDIR, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
const check = (n, c, d = "") => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    failures.push({ n, d: String(d).slice(0, 300) });
    console.log(`  FAIL ${n}${d ? ` — ${String(d).slice(0, 200)}` : ""}`);
  }
};

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
    const mid = ++id;
    pending.set(mid, r);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 834, height: 1112, mobile: true },
  { name: "phone", width: 390, height: 844, mobile: true },
];

const HOME_METRICS = `(() => {
  const q = (s) => document.querySelector(s);
  const plates = [...document.querySelectorAll('.edition-plates .plate')];
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; };
  const inFirst = plates.filter(vis);
  const firstImgs = inFirst.map((p) => p.querySelector('img')).filter(Boolean);
  const cap = q('.plate-info');
  const cs = cap ? getComputedStyle(cap) : null;
  const fig = cap ? cap.closest('figure') : null;
  const slot = fig ? fig.querySelector('.img-slot') : null;
  const overlays = (() => {
    if (!cap || !slot) return null;
    if (getComputedStyle(cap).position !== 'absolute') return false;
    const ir = slot.getBoundingClientRect();
    const cr = cap.getBoundingClientRect();
    return cr.top < ir.bottom - 1;
  })();
  const platesEl = q('.edition-plates');
  return {
    viewport: innerWidth + 'x' + innerHeight,
    hoverFine: matchMedia('(hover: hover) and (pointer: fine)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    plates: plates.length,
    platesInFirstScreen: inFirst.length,
    plateColumns: platesEl ? getComputedStyle(platesEl).columnCount : null,
    firstScreenImages: firstImgs.length,
    firstScreenImagesLoaded: firstImgs.filter((i) => i.naturalWidth > 0).length,
    firstScreenImagesBroken: firstImgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    captionPosition: cs && cs.position,
    captionDisplay: cs && cs.display,
    captionVisible: cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01) : null,
    captionOverlaysImage: overlays,
    captionText: cap ? cap.textContent.replace(/\\s+/g, ' ').trim() : null,
    mastheadBottom: q('.edition-masthead') ? Math.round(q('.edition-masthead').getBoundingClientRect().bottom) : null,
    searchBoxBottom: q('.home-find') ? Math.round(q('.home-find').getBoundingClientRect().bottom) : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    wideElements: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 4)
      .map((el) => (typeof el.className === 'string' && el.className ? el.className : el.tagName) + '@' + Math.round(el.getBoundingClientRect().right)),
    promoCardBlock: !!q('.edition-destinations'),
    verbsLine: !!q('.edition-verbs'),
    searchPlaceholder: q('#home-find-input') ? q('#home-find-input').placeholder : null,
    mediaChips: [...document.querySelectorAll('[data-home-media]')].map((b) => b.textContent.trim() + (b.classList.contains('is-on') ? '*' : '')),
    examples: [...document.querySelectorAll('[data-home-example]')].map((b) => b.textContent.trim()),
    documentHeight: document.documentElement.scrollHeight,
  };
})()`;

const FIND_METRICS = `(() => {
  const q = (s) => document.querySelector(s);
  const hits = [...document.querySelectorAll('#find-results .find-hit')];
  const imgs = hits.map((h) => h.querySelector('img')).filter(Boolean);
  const remoteHost = q('#find-remote');
  return {
    hash: location.hash,
    textareaValue: q('#find-text') ? q('#find-text').value : null,
    mediaOn: [...document.querySelectorAll('[data-find-media]')].filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.findMedia),
    mediaLabels: [...document.querySelectorAll('[data-find-media]')].map((b) => b.textContent.trim()),
    localHits: hits.length,
    localHitImages: imgs.length,
    localHitImagesLoaded: imgs.filter((i) => i.naturalWidth > 0).length,
    localHitBrokenSlots: hits.filter((h) => h.querySelector('.img-slot.is-broken')).length,
    localHitBlankSlots: hits.filter((h) => {
      const s = h.querySelector('.img-slot');
      const i = h.querySelector('img');
      return Boolean(s) && !s.classList.contains('is-broken') && (!i || i.naturalWidth === 0);
    }).length,
    firstHitStrong: q('#find-results .find-hit strong') ? q('#find-results .find-hit strong').textContent.trim() : null,
    firstHitProvenance: q('#find-results .find-hit > div small:last-of-type') ? q('#find-results .find-hit > div small:last-of-type').textContent.trim() : null,
    firstHitText: q('#find-results .find-hit > div') ? q('#find-results .find-hit > div').textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    intentCard: !!q('.intent-card'),
    intentFields: [...document.querySelectorAll('.intent-card li')].map((li) => li.textContent.trim()).slice(0, 12),
    remoteText: remoteHost ? remoteHost.textContent.replace(/\\s+/g, ' ').trim().slice(0, 240) : null,
    remoteCards: remoteHost ? remoteHost.querySelectorAll('.find-hit-remote').length : 0,
    remoteLoading: !!remoteHost && /正在检索/.test(remoteHost.textContent),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    wideElements: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 4)
      .map((el) => (typeof el.className === 'string' && el.className ? el.className : el.tagName) + '@' + Math.round(el.getBoundingClientRect().right)),
    visibleChips: [...document.querySelectorAll('.find-media button')].length,
    mediaBarHeight: q('.find-media') ? Math.round(q('.find-media').getBoundingClientRect().height) : 0,
  };
})()`;

const HOME_READY = "!!document.querySelector('.edition-plates .plate')";
const FIND_READY = "!!document.querySelector('#find-text')";

const NAME_METRICS = `(() => {
  const host = document.querySelector('#find-name-hits');
  const cards = host ? [...host.querySelectorAll('.find-name-hit')] : [];
  const visual = [...document.querySelectorAll('#find-results .find-hit')];
  const visualKeys = visual.map((a) => a.dataset.refKey).filter(Boolean);
  const nameKeys = cards.map((a) => a.dataset.refKey).filter(Boolean);
  return {
    present: !!host,
    hidden: host ? host.hidden : null,
    title: host && host.querySelector('.find-name-title') ? host.querySelector('.find-name-title').textContent.trim() : null,
    note: host && host.querySelector('.quiet-note') ? host.querySelector('.quiet-note').textContent.replace(/\\s+/g, ' ').trim() : null,
    cards: cards.length,
    nameKeys,
    tiers: cards.map((c) => (c.querySelector('.find-name-tier') ? c.querySelector('.find-name-tier').textContent.replace(/\\s+/g, ' ').trim() : '')),
    emptyNotice: host && !cards.length ? (host.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    visualHits: visual.length,
    visualKeys,
    duplicatedKeys: nameKeys.filter((k) => visualKeys.includes(k)),
    images: cards.filter((c) => c.querySelector('img')).length,
    imagesLoaded: cards.filter((c) => { const i = c.querySelector('img'); return i && i.naturalWidth > 0; }).length,
    hrefs: cards.map((c) => c.getAttribute('href')),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    wideElements: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 4)
      .map((el) => (typeof el.className === 'string' && el.className ? el.className : el.tagName) + '@' + Math.round(el.getBoundingClientRect().right)),
  };
})()`;

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
let page = null;
const results = { label: LABEL, base: BASE, viewports: {} };

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
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
      jsErrors.push("ERR: " + (m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 160));
    }
  });
  const call = page.send;
  const evalJs = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    const ex = r.result?.exceptionDetails;
    if (ex) return { __err: ex.text + " " + (ex.exception?.description || "") };
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await sleep(120);
    }
    return false;
  };
  const setViewport = async ({ width, height, mobile }) => {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await call("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  };
  const shot = async (name, full = false) => {
    let restore = null;
    if (full) {
      const h = await evalJs("document.documentElement.scrollHeight");
      const w = await evalJs("innerWidth");
      restore = { width: w, height: h };
      await call("Emulation.setDeviceMetricsOverride", { width: w, height: Math.min(h, 12000), deviceScaleFactor: 1, mobile: false });
      await sleep(400);
    }
    const r = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
    if (r.result?.data) writeFileSync(join(OUTDIR, `${name}.png`), Buffer.from(r.result.data, "base64"));
    if (full && restore) await setViewport({ width: restore.width, height: restore.height, mobile: false });
    return Boolean(r.result?.data);
  };
  // 硬导航：先回 about:blank 再进目标 hash。否则「导航到当前 URL」是
  // same-document 跳转，页面不会重载，读到的是上一步的 DOM——会把上一步的
  // 状态误当成「默认状态」，得出错误的结论。
  // readyExpr：等目标路由真的挂载完再测量，避免冷缓存下读到空 DOM。
  const goto = async (hash, readyExpr = null) => {
    await call("Page.enable");
    await call("Page.navigate", { url: "about:blank" });
    await sleep(200);
    await call("Page.navigate", { url: `${BASE}/${hash}` });
    await sleep(400);
    await waitFor("document.readyState === 'complete'", 10000);
    if (readyExpr) await waitFor(readyExpr, 15000);
    await sleep(600);
  };
  const clickAt = async (x, y) => {
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  // 结果区通常在首屏之下，而图片是 lazy 的：不滚动到结果区就不会发起图片请求。
  // 测量前必须滚动 + 等解码，否则会把「还没加载」误读成「空白槽位」。
  const settleResultImages = async () => {
    await evalJs("document.querySelector('#find-results')?.scrollIntoView({ block: 'start' })");
    for (let i = 0; i < 24; i++) {
      const ok = await evalJs(`(() => {
        const hits = [...document.querySelectorAll('#find-results .find-hit')];
        if (!hits.length) return false;
        return hits.every((h) => {
          const s = h.querySelector('.img-slot');
          const im = h.querySelector('img');
          return Boolean(s && s.classList.contains('is-broken')) || Boolean(im && im.naturalWidth > 0);
        });
      })()`);
      if (ok === true) return true;
      await sleep(500);
    }
    return false;
  };

  // 名称命中卡的图片同样是 lazy 的：先滚动到该区再等解码，避免把「还没加载」
  // 读成「图像不可用」。renderImg 的占位说明是隐藏的，只有真失败才会显现。
  const settleNameImages = async () => {
    await evalJs("document.querySelector('#find-name-hits')?.scrollIntoView({ block: 'center' })");
    for (let i = 0; i < 24; i++) {
      const ok = await evalJs(`(() => {
        const cards = [...document.querySelectorAll('#find-name-hits .find-name-hit')];
        if (!cards.length) return false;
        return cards.every((c) => {
          const s = c.querySelector('.img-slot');
          const im = c.querySelector('img');
          return Boolean(s && s.classList.contains('is-broken')) || Boolean(im && im.naturalWidth > 0);
        });
      })()`);
      if (ok === true) return true;
      await sleep(500);
    }
    return false;
  };

  // ============ 1. 首页 — 三种视口 ============
  for (const vp of VIEWPORTS) {
    console.log(`\n== 1. 首页 @ ${vp.name} ${vp.width}x${vp.height} ==`);
    await setViewport(vp);
    await goto("#index", HOME_READY);
    const m = await evalJs(HOME_METRICS);
    results.viewports[vp.name] = { home: m };
    check(`${vp.name} 首页无 JS 异常`, jsErrors.length === 0, jsErrors.join(" | "));
    check(`${vp.name} 首页无横向溢出`, m && m.overflowX === false && (m.wideElements || []).length === 0, JSON.stringify(m && m.wideElements));
    check(`${vp.name} 首屏图片全部加载`, m && m.firstScreenImages > 0 && m.firstScreenImagesLoaded === m.firstScreenImages && m.firstScreenImagesBroken === 0, JSON.stringify(m && { total: m.firstScreenImages, ok: m.firstScreenImagesLoaded, broken: m.firstScreenImagesBroken }));
    check(`${vp.name} 已移除首屏产品宣传卡片`, m && m.promoCardBlock === false, JSON.stringify(m && { destinations: m.promoCardBlock, verbs: m.verbsLine }));
    check(`${vp.name} 首页搜索框存在且有输入提示`, m && typeof m.searchPlaceholder === "string" && /画面|构图|情绪|作品/.test(m.searchPlaceholder), m && m.searchPlaceholder);
    check(`${vp.name} 媒介筛选三项可见`, m && m.mediaChips.length === 3, JSON.stringify(m && m.mediaChips));
    check(`${vp.name} 有可解析的搜索示例`, m && m.examples.length >= 3, JSON.stringify(m && m.examples));

    if (vp.mobile) {
      check(`${vp.name} 触摸设备：说明不覆盖图片（默认在图片下方）`, m && m.captionOverlaysImage === false, JSON.stringify(m && { pos: m.captionPosition, overlays: m.captionOverlaysImage, hoverNone: m.hoverNone, coarse: m.pointerCoarse }));
    } else {
      check(`${vp.name} 桌面：说明默认隐藏`, m && m.captionVisible === false, JSON.stringify(m && { pos: m.captionPosition, visible: m.captionVisible, opacity: m.captionOpacity }));
      const box = await evalJs("(() => { const p = document.querySelector('.edition-plates .plate'); const r = p.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 120)) }; })()");
      if (box && box.x) {
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
        await sleep(400);
        const hov = await evalJs("(() => { const c = document.querySelector('.edition-plates .plate:hover .plate-info'); return c ? { opacity: getComputedStyle(c).opacity, text: c.textContent.replace(/\\\\s+/g,' ').trim() } : null; })()");
        check(`${vp.name} 桌面 hover 显示少量信息`, hov && parseFloat(hov.opacity) > 0.9, JSON.stringify(hov));
        results.viewports[vp.name].homeHover = hov;
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
        await sleep(300);
      }
    }

    await shot(`home-${vp.name}`);
    if (vp.name === "desktop") await shot("home-desktop-full", true);

    if (vp.name === "desktop") {
      check("desktop 首屏可见作品数在 8–12 之间", m && m.platesInFirstScreen >= 8 && m.platesInFirstScreen <= 12, JSON.stringify({ plates: m && m.plates, inFirst: m && m.platesInFirstScreen, columns: m && m.plateColumns }));
    }
    if (vp.name === "phone") {
      check("phone 首屏仍以图片为主且未退化为说明书布局", m && m.platesInFirstScreen >= 2, JSON.stringify({ plates: m && m.plates, inFirst: m && m.platesInFirstScreen, columns: m && m.plateColumns }));
    }
  }

  // ============ 2. 首页 → FIND 参数传递（桌面） ============
  console.log("\n== 2. 首页搜索 → FIND ==");
  await setViewport(VIEWPORTS[0]);
  await goto("#index", HOME_READY);
  const filled = await evalJs(`(() => {
    const i = document.querySelector('#home-find-input');
    i.value = '雾 空旷';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-home-media="film"]').click();
    return { value: i.value, filmOn: document.querySelector('[data-home-media="film"]').classList.contains('is-on') };
  })()`);
  const btn = await evalJs("(() => { const b = document.querySelector('.home-find-run'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
  await clickAt(btn.x, btn.y);
  const landed = await waitFor("location.hash === '#find' && !!document.querySelector('.find-page')", 8000);
  check("点击查找后进入 FIND 路由", landed === true, JSON.stringify(await evalJs("location.hash")));
  const settled = await settleResultImages();
  check("FIND 结果区滚动到视口后图片完成解码", settled === true, String(settled));
  const f1 = await evalJs(FIND_METRICS);
  results.searchHandoff = { filled, find: f1 };
  check("FIND 保留了首页输入的查询", f1 && f1.textareaValue === "雾 空旷", JSON.stringify(f1 && f1.textareaValue));
  check("FIND 保留了首页选择的媒介（电影画面）", f1 && f1.mediaOn.length === 1 && f1.mediaOn[0] === "film", JSON.stringify(f1 && f1.mediaOn));
  check("FIND 自动执行检索并给出本地结果", f1 && f1.localHits > 0, JSON.stringify(f1 && { hits: f1.localHits }));
  // 「电影画面」里有只有档案元数据、没有可展示帧的作品（filmReferences 只有元数据，
  // 真正有帧的 filmStills 是 3 条）。它们不该是一个沉默的空白：要么解码出图片，
  // 要么给出明确的不可用说明。
  check(
    "FIND 每个命中要么有图、要么有明确说明（无沉默空白）",
    f1 && f1.localHits > 0 && f1.localHitImagesLoaded + f1.localHitBrokenSlots === f1.localHits && f1.localHitBlankSlots === 0,
    JSON.stringify(f1 && { hits: f1.localHits, imgOK: f1.localHitImagesLoaded, broken: f1.localHitBrokenSlots, blank: f1.localHitBlankSlots })
  );
  check("FIND 结果标注检索依据（不把文本匹配说成视觉分析）", f1 && typeof f1.firstHitProvenance === "string" && /Retrieval score/.test(f1.firstHitProvenance) && /依据/.test(f1.firstHitProvenance), JSON.stringify(f1 && { provenance: f1.firstHitProvenance, text: f1.firstHitText }));
  check("FIND 无横向溢出", f1 && f1.overflowX === false && (f1.wideElements || []).length === 0, JSON.stringify(f1 && f1.wideElements));
  // remoteDiscovery 单次 12s timeout × 1 次重试（总上限约 24s），所以这里给足 40s，
  // 而不是把「还没到上限」误判成「卡在加载态」。
  await waitFor("!/正在检索/.test(document.querySelector('#find-remote')?.textContent || '')", 40000);
  const f2 = await evalJs(FIND_METRICS);
  results.searchHandoff.findSettled = f2;
  check("远程区段有明确结论（结果或说明，不停留在加载态）", f2 && f2.remoteLoading === false && typeof f2.remoteText === "string" && f2.remoteText.length > 0, JSON.stringify(f2 && f2.remoteText));
  await shot("find-desktop-after-home-search");

  // 媒介筛选：切换到「仅艺术作品」后仍可用
  // 注意：上面刚把结果区滚进视口，媒介栏此时在视口之上，直接按坐标点击会落空。
  await evalJs("document.querySelector('[data-find-media=\"artwork\"]').scrollIntoView({ block: 'center' })");
  await sleep(400);
  const mediaClick = await evalJs("(() => { const b = document.querySelector('[data-find-media=\"artwork\"]'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), h: Math.round(r.height) }; })()");
  await clickAt(mediaClick.x, mediaClick.y);
  await sleep(300);
  const mediaAfter = await evalJs("(() => ({ on: [...document.querySelectorAll('[data-find-media]')].filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.findMedia) }))()");
  check("媒介筛选按钮可点击且状态唯一", mediaAfter && mediaAfter.on.length === 1 && mediaAfter.on[0] === "artwork", JSON.stringify(mediaAfter));
  check("媒介筛选有可见高度（不再是未样式化的默认外观）", mediaClick.h >= 24, JSON.stringify({ h: mediaClick.h }));

  // ============ 3. 直接进入 FIND（无 handoff）不回归 ============
  await goto("#find", FIND_READY);
  const f3 = await evalJs(FIND_METRICS);
  results.directFind = f3;
  check("直接进入 FIND 无 handoff 时使用默认示例查询", f3 && typeof f3.textareaValue === "string" && f3.textareaValue.length > 0, JSON.stringify(f3 && f3.textareaValue));
  check("直接进入 FIND 媒介默认「全部参考」", f3 && f3.mediaOn.length === 1 && f3.mediaOn[0] === "all", JSON.stringify(f3 && f3.mediaOn));
  check("直接进入 FIND 不自动检索（保持原有交互）", f3 && f3.localHits === 0, JSON.stringify(f3 && { hits: f3.localHits }));

  // ============ 3b. 名称命中（作品名称检索，本轮新增） ============
  console.log("\n== 3b. 名称命中（作品名称检索） ==");
  const hasNameHost = await evalJs("!!document.querySelector('#find-name-hits')");
  if (!hasNameHost) {
    console.log("  SKIP 此版本没有名称命中区（改前基线）");
    results.nameHits = { skipped: true, reason: "no #find-name-hits host" };
  } else {
    // ---- 十个本地真实作品的名称逐个回归（纯本地匹配器，不触发远程与模型） ----
    const matcher = await evalJs(`(async () => {
      const { matchNames, namePool } = await import('/src/utils/nameMatch.js');
      const { artworks } = await import('/src/data/artworks.js');
      const ten = artworks.filter((a) => a.image && !a.imageUnavailable).slice(0, 10);
      const perTitle = ten.map((a) => {
        const zh = a.titleZh || a.title;
        const en = a.titleEn || null;
        const rZh = matchNames(namePool('all'), zh);
        const rEn = en ? matchNames(namePool('all'), en) : [];
        const selfZh = rZh.find((m) => m.artwork.key === a.key) || null;
        const selfEn = rEn.find((m) => m.artwork.key === a.key) || null;
        return {
          key: a.key, zh, en,
          zhHits: rZh.length, zhSelf: !!selfZh, zhSelfTier: selfZh ? selfZh.tier : null, zhSelfField: selfZh ? selfZh.label : null,
          enHits: rEn.length, enSelf: en ? !!selfEn : null, enSelfTier: selfEn ? selfEn.tier : null,
        };
      });
      const controls = [
        { q: '量子纠缠与孤独', why: '无关查询', expect: 0 },
        { q: '海', why: '单字（长度不足）', expect: 0 },
        { q: '戴耳环的少女', why: '漏字，非连续包含', expect: 0 },
        { q: 'girl pearl earring', why: '英文漏词', expect: 0 },
        { q: '戴珍珠耳环', why: '中文连续前缀', expect: 1 },
        { q: 'Wanderer above', why: '英文连续前缀', expect: 1 },
        { q: '雾海上的旅人', why: '完整中文名', expect: 1 },
        { q: 'The Kid', why: '电影片名', expect: 1 },
      ].map((c) => {
        const hits = matchNames(namePool('all'), c.q);
        return { q: c.q, why: c.why, expect: c.expect, hits: hits.length, tiers: hits.map((m) => m.tier), keys: hits.map((m) => m.artwork.key) };
      });
      return {
        pool: { all: namePool('all').length, artwork: namePool('artwork').length, film: namePool('film').length },
        perTitle, controls,
        filmNames: namePool('film').map((f) => ({ key: f.key, titleZh: f.titleZh, title: f.title, titleEn: f.titleEn || null })),
      };
    })()`);
    results.nameHits = { ...matcher };
    const withEn = matcher ? matcher.perTitle.filter((p) => p.en) : [];
    check("名称匹配池与检索池同口径（46 绘画 + 3 电影 = 49）", matcher && matcher.pool.all === 49 && matcher.pool.artwork === 46 && matcher.pool.film === 3, JSON.stringify(matcher && matcher.pool));
    check("十个真实作品的中文名都命中自己，且是完整名称档", matcher && matcher.perTitle.length === 10 && matcher.perTitle.every((p) => p.zhSelf === true && p.zhSelfTier === "exact"), JSON.stringify(matcher && matcher.perTitle.filter((p) => !(p.zhSelf && p.zhSelfTier === "exact"))));
    check("十个真实作品的英文名都命中自己，且是完整名称档", matcher && withEn.length > 0 && withEn.every((p) => p.enSelf === true && p.enSelfTier === "exact"), JSON.stringify(withEn.filter((p) => !(p.enSelf && p.enSelfTier === "exact"))));
    check("无关查询与单字不产生名称命中", matcher && ["量子纠缠与孤独", "海"].every((q) => matcher.controls.find((c) => c.q === q)?.hits === 0), JSON.stringify(matcher && matcher.controls.filter((c) => ["量子纠缠与孤独", "海"].includes(c.q))));
    check("漏字/漏词不被当作命中（不做模糊重叠）", matcher && ["戴耳环的少女", "girl pearl earring"].every((q) => matcher.controls.find((c) => c.q === q)?.hits === 0), JSON.stringify(matcher && matcher.controls.filter((c) => ["戴耳环的少女", "girl pearl earring"].includes(c.q))));
    check("连续包含才命中，且标为「名称包含」", matcher && ["戴珍珠耳环", "Wanderer above"].every((q) => { const c = matcher.controls.find((x) => x.q === q); return c && c.hits === 1 && c.tiers[0] === "partial"; }), JSON.stringify(matcher && matcher.controls.filter((c) => ["戴珍珠耳环", "Wanderer above"].includes(c.q))));
    check("电影片名按现有数据命中（无编造字段）", matcher && matcher.controls.find((c) => c.q === "The Kid")?.hits === 1, JSON.stringify(matcher && matcher.controls.find((c) => c.q === "The Kid")));

    // ---- UI 级：一个不含任何意图词的作品名，应当由名称区回答 ----
    await goto("#find", FIND_READY);
    await evalJs("(() => { const t = document.querySelector('#find-text'); t.value = '戴珍珠耳环的少女'; document.querySelector('#find-run').click(); return 1; })()");
    await waitFor("!!document.querySelector('#find-name-hits .find-name-hit')", 8000);
    const independence = await evalJs("(() => { const h = document.querySelector('#find-remote'); return { remoteText: h ? h.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : null }; })()");
    const nameSettled = await settleNameImages();
    const nDesktop = await evalJs(NAME_METRICS);
    results.nameHits.ui = { desktop: nDesktop, independence, nameSettled };
    check("输入作品名后出现名称命中区", nDesktop && nDesktop.hidden === false && nDesktop.cards >= 1, JSON.stringify(nDesktop && { hidden: nDesktop.hidden, cards: nDesktop.cards }));
    check("名称区标题就是「名称命中 · 非视觉相似度评分」", nDesktop && nDesktop.title === "名称命中 · 非视觉相似度评分", nDesktop && nDesktop.title);
    check("命中的正是这件作品，且标为完整名称", nDesktop && nDesktop.nameKeys.includes("local:pearl") && nDesktop.tiers.some((t) => t.startsWith("完整名称")), JSON.stringify(nDesktop && { keys: nDesktop.nameKeys, tiers: nDesktop.tiers }));
    check("名称区没有等远程渠道（远程仍在检索时名称结果已出）", Boolean(independence.remoteText) && /检索/.test(independence.remoteText), JSON.stringify(independence));
    check("名称卡图片可用且指向既有详情路由", nameSettled === true && nDesktop && nDesktop.imagesLoaded === nDesktop.images && nDesktop.hrefs.every((h) => typeof h === "string" && (h.startsWith("#artwork/") || h.startsWith("#film/"))), JSON.stringify(nDesktop && { settled: nameSettled, imagesLoaded: nDesktop.imagesLoaded, hrefs: nDesktop.hrefs }));
    check("该查询的视觉结果为 0（证明是名称区在回答）", nDesktop && nDesktop.visualHits === 0, JSON.stringify(nDesktop && { visualHits: nDesktop.visualHits }));
    check("名称区无横向溢出", nDesktop && nDesktop.overflowX === false && (nDesktop.wideElements || []).length === 0, JSON.stringify(nDesktop && nDesktop.wideElements));
    // 交付截图要能一眼看到「完整名称 · 命中中文名「…」」这一行，所以对齐区块顶端再拍。
    await evalJs("document.querySelector('#find-name-hits')?.scrollIntoView({ block: 'start' })");
    await sleep(400);
    await shot("find-name-hits-desktop");

    // ---- 描述式查询不得产生名称噪声，且视觉检索不回归 ----
    await evalJs("(() => { const t = document.querySelector('#find-text'); t.value = '雾 空旷'; document.querySelector('#find-run').click(); return 1; })()");
    await sleep(1500);
    const nDesc = await evalJs(NAME_METRICS);
    results.nameHits.ui.descQuery = nDesc;
    check("描述式查询不产生名称命中（不留噪声）", nDesc && nDesc.cards === 0 && nDesc.hidden === true, JSON.stringify(nDesc && { cards: nDesc.cards, hidden: nDesc.hidden }));
    check("「雾 空旷」既有视觉检索不回归", nDesc && nDesc.visualHits > 0, JSON.stringify(nDesc && { visualHits: nDesc.visualHits }));

    // ---- 同一作品不得在两个区重复出现 ----
    await evalJs("(() => { const t = document.querySelector('#find-text'); t.value = '雾海上的旅人'; document.querySelector('#find-run').click(); return 1; })()");
    await sleep(1500);
    const nDup = await evalJs(NAME_METRICS);
    results.nameHits.ui.dupeQuery = nDup;
    check("同一作品不在名称区与视觉区重复出现", nDup && nDup.duplicatedKeys.length === 0, JSON.stringify(nDup && { nameKeys: nDup.nameKeys, visualKeys: nDup.visualKeys }));
    check("重复件数被如实说明，不当作额外命中", nDup && nDup.cards === 0 && /另有 1 件/.test(nDup.note || ""), JSON.stringify(nDup && { cards: nDup.cards, note: nDup.note }));

    // ---- 电影片名命中：走既有 #film 路由与既有导演/年份/许可说明 ----
    await evalJs("(() => { const t = document.querySelector('#find-text'); t.value = '孩子'; document.querySelector('#find-run').click(); return 1; })()");
    await waitFor("!!document.querySelector('#find-name-hits .find-name-hit')", 8000);
    const nFilm = await evalJs(`(() => {
      const c = document.querySelector('#find-name-hits .find-name-hit');
      return c ? {
        key: c.dataset.refKey,
        href: c.getAttribute('href'),
        title: c.querySelector('strong') ? c.querySelector('strong').textContent : null,
        creator: c.querySelector('em') ? c.querySelector('em').textContent : null,
        credit: c.querySelector('.find-film-credit') ? c.querySelector('.find-film-credit').textContent : null,
        tier: c.querySelector('.find-name-tier') ? c.querySelector('.find-name-tier').textContent : null,
      } : null;
    })()`);
    results.nameHits.ui.filmQuery = nFilm;
    check("电影片名命中走既有 #film 路由", nFilm && nFilm.href === "#film/film-s02-the-kid" && nFilm.key === "film-s02-the-kid", JSON.stringify(nFilm));
    check("电影命中卡用既有导演/年份/许可说明（未编造元数据）", nFilm && /导演/.test(nFilm.creator || "") && /导演/.test(nFilm.credit || "") && /（\d{4}）/.test(nFilm.credit || ""), JSON.stringify(nFilm && { creator: nFilm.creator, credit: nFilm.credit }));
    check("电影命中同样标为完整名称", nFilm && /^完整名称/.test(nFilm.tier || ""), nFilm && nFilm.tier);
  }

  // ============ 4. 其余路由回归（桌面 + 手机） ============
  const ROUTES = [
    { hash: "#create", sel: ".create-picks, .workflow-input, .primary-action" },
    { hash: "#shoot", sel: ".drop-zone, .mode-art, .primary-action, .ghost-action" },
    { hash: "#memory", sel: ".memory-page, .memory-card, main, section" },
  ];
  for (const r of ROUTES) {
    await goto(r.hash);
    const ok = await waitFor(`!!document.querySelector('${r.sel}')`, 6000);
    const over = await evalJs("document.documentElement.scrollWidth > document.documentElement.clientWidth");
    check(`${r.hash} 正常渲染且无横向溢出`, ok === true && over === false, JSON.stringify({ ok, over }));
    const body = await evalJs("document.body.innerText.replace(/\\s+/g,' ').slice(0,80)");
    results[`route${r.hash}`] = { ok, over, body };
    await shot(`route-${r.hash.replace("#", "")}`);
  }

  // 作品详情路由（首页 plates 的落地页）
  await goto("#index", HOME_READY);
  const artHref = await evalJs("document.querySelector('.edition-plates .plate')?.getAttribute('href')");
  await goto(artHref || "#artwork/wanderer", "!!document.querySelector('h1')");
  const artOk = await waitFor("!!document.querySelector('.artwork-page, .detail-page, h1')", 6000);
  check("首页作品可进入详情路由", artOk === true, JSON.stringify({ artHref, hash: await evalJs("location.hash") }));
  results.artworkDetail = { artHref, ok: artOk, hash: await evalJs("location.hash") };

  // 电影画面（FIND 结果里的 film 命中）
  await goto("#film/film-s02-the-kid", "!!document.querySelector('h1')");
  const filmOk = await waitFor("!!document.querySelector('h1')", 6000);
  check("电影画面详情路由可用", filmOk === true, JSON.stringify({ hash: await evalJs("location.hash") }));
  results.filmDetail = { ok: filmOk };

  // ============ 5. 手机视口：FIND 结果与首页 ============
  console.log("\n== 5. 手机 390px ==");
  await setViewport(VIEWPORTS[2]);
  await goto("#index", HOME_READY);
  await evalJs(`(() => { const i = document.querySelector('#home-find-input'); i.value = '孤独 夜晚'; sessionStorage.setItem('fa-find-handoff', JSON.stringify({ q: '孤独 夜晚', media: 'all' })); return 1; })()`);
  await goto("#find", FIND_READY);
  const phoneSettled = await settleResultImages();
  const fp = await evalJs(FIND_METRICS);
  results.phoneFind = fp;
  check("phone FIND 保留了 handoff 查询", fp && fp.textareaValue === "孤独 夜晚", JSON.stringify(fp && fp.textareaValue));
  check("phone FIND 无横向溢出", fp && fp.overflowX === false && (fp.wideElements || []).length === 0, JSON.stringify(fp && fp.wideElements));
  check(
    "phone FIND 结果图片全部解码",
    phoneSettled === true && fp && fp.localHits > 0 && fp.localHitImagesLoaded + fp.localHitBrokenSlots === fp.localHits && fp.localHitBlankSlots === 0,
    JSON.stringify(fp && { settled: phoneSettled, hits: fp.localHits, ok: fp.localHitImagesLoaded, broken: fp.localHitBrokenSlots, blank: fp.localHitBlankSlots })
  );
  check("phone FIND 媒介栏可见", fp && fp.visibleChips === 3 && fp.mediaBarHeight >= 24, JSON.stringify(fp && { chips: fp.visibleChips, h: fp.mediaBarHeight }));
  await shot("find-phone");

  // 手机视口：名称命中区（同一实例守卫、同一渲染，只是窄屏）
  if (hasNameHost) {
    await evalJs("(() => { const t = document.querySelector('#find-text'); t.value = '圣马太蒙召'; document.querySelector('#find-run').click(); return 1; })()");
    await waitFor("!!document.querySelector('#find-name-hits .find-name-hit')", 8000);
    const namePhoneSettled = await settleNameImages();
    const np = await evalJs(NAME_METRICS);
    results.phoneNameHits = { ...np, settled: namePhoneSettled };
    check("phone 名称命中区可见且无横向溢出", np && np.hidden === false && np.cards >= 1 && np.overflowX === false && (np.wideElements || []).length === 0, JSON.stringify(np && { cards: np.cards, overflowX: np.overflowX, wide: np.wideElements }));
    check("phone 名称卡图片全部解码", namePhoneSettled === true && np && np.images > 0 && np.imagesLoaded === np.images, JSON.stringify({ settled: namePhoneSettled, images: np && np.images, loaded: np && np.imagesLoaded }));
    await evalJs("document.querySelector('#find-name-hits')?.scrollIntoView({ block: 'start' })");
    await sleep(400);
    await shot("find-name-hits-phone");
  }

  results.jsErrors = jsErrors;
  results.summary = { pass, fail };
  writeFileSync(join(OUTDIR, "ui-home-find.json"), JSON.stringify(results, null, 2));
  console.log(`\nUI_HOME_FIND(${LABEL}): ${pass}/${pass + fail} PASS`);
  console.log(`证据目录: ${OUTDIR}`);
  if (fail) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  · ${f.n} — ${f.d}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  console.log(`\nBROWSER_GATE_BLOCKED: ${e.message}`);
  console.log(`已收集：${JSON.stringify(results).slice(0, 400)}`);
  process.exitCode = 2;
} finally {
  try { if (page?.ws) page.ws.close(); } catch {}
  try { edge.kill(); } catch {}
  await sleep(400);
}
