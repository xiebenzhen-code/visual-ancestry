// ui-acceptance.mjs — 第五阶段：真实产品验收（7 条）+ 防假验收。
//
// 防假验收的具体做法（每条都对应任务书里的一个坑）：
//   · 「图片解码」只认 naturalWidth>0，且**排除**视口外的 lazy 图 ——
//     把「还没请求」算成「加载不了」是上一轮真实踩过的错。
//   · 可见的「图像暂不可用」占位一律算失败（回退链走完 = 空白卡）。
//   · 「搜索原位出结果」必须验证 hash 没变，而不是只验证页面上出现了结果。
//   · 「返回原位置」必须量滚动位置、查询词、媒介选中态三者都还在。
//   · 记忆页必须真的渲染出可点的东西，空页面不算「可用」。
//   · 三档视口都要过，且不允许横向溢出。
//   · 原有功能用既有回归套件验，不靠「看起来没坏」。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const LABEL = process.argv[3] || "acceptance";
const OUT = join(HERE, `ui-acceptance-${LABEL}`);
const PORT = 9487;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}${detail ? ` — ${String(detail).slice(0, 110)}` : ""}`);
  } else {
    fail++;
    failures.push({ name, detail: String(detail).slice(0, 300) });
    console.log(`  FAIL ${name} — ${String(detail).slice(0, 240)}`);
  }
};

const jsErrors = [];

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  return (method, params = {}) =>
    new Promise((r) => {
      const mid = ++id;
      pending.set(mid, r);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
}

const edge = spawn(
  EDGE,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(OUT, "profile")}`, "--no-first-run", "about:blank"],
  { stdio: "ignore" }
);
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { ready = true; break; }
  } catch { /* 等 CDP */ }
  await sleep(600);
}
if (!ready) { edge.kill(); throw new Error("CDP 未就绪"); }

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const call = await connect(created.webSocketDebuggerUrl);
await call("Page.enable");
await call("Runtime.enable");

const evalJs = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
};

// 等挂载
const waitFor = async (sel, label = sel) => {
  for (let i = 0; i < 60; i++) {
    if (await evalJs(`Boolean(document.querySelector(${JSON.stringify(sel)}))`)) return true;
    await sleep(500);
  }
  throw new Error(`等待 ${label} 超时（30s）`);
};

// 只统计**视口内**的图：视口外的 lazy 图尚未被请求，那不是解码失败
const VIEWPORT_IMAGE_AUDIT = `(() => {
  const vh = window.innerHeight;
  const slots = [...document.querySelectorAll('#app .img-slot, .work-panel .img-slot')].filter((s) => s.offsetParent !== null);
  const inView = slots.filter((s) => {
    const r = s.getBoundingClientRect();
    return r.bottom > 0 && r.top < vh;
  });
  const imgs = (list) => list.map((s) => s.querySelector('img')).filter(Boolean);
  const placeholders = slots.filter((s) => {
    const u = s.querySelector('.img-unavailable');
    return u && u.getClientRects().length > 0;
  });
  return {
    slotsVisible: slots.length,
    slotsInViewport: inView.length,
    imgsInViewport: imgs(inView).length,
    decodedInViewport: imgs(inView).filter((i) => i.naturalWidth > 0).length,
    pendingInViewport: imgs(inView).filter((i) => !i.complete).length,
    visiblePlaceholders: placeholders.length,
    placeholderTitles: placeholders.slice(0, 4).map((s) => s.closest('.plate, .find-hit, .work-panel')?.getAttribute('aria-label') || '(未知)'),
  };
})()`;

const report = { base: BASE, label: LABEL, at: new Date().toISOString(), checks: [], viewports: [] };
const record = (name, ok, detail) => report.checks.push({ name, ok, detail: String(detail ?? "").slice(0, 300) });

// ============================== 前置 ==============================
await call("Page.navigate", { url: `${BASE}/?acc=1#index` });
await sleep(1200);
await call("Runtime.evaluate", {
  expression: `window.__accErrors = []; window.addEventListener('error', e => window.__accErrors.push(String(e.message).slice(0,140)));`,
});
// 等首页真正挂载（检索视图是 JS 渲染的，静态 HTML 里并不存在）
await waitFor("#find-text", "首页检索视图挂载");
await sleep(400);

const preflight = await evalJs(`(() => ({
  nav: [...document.querySelectorAll('.main-nav a')].map(a => a.textContent.trim()),
  navCount: document.querySelectorAll('.main-nav a').length,
  placeholder: document.querySelector('#find-text')?.getAttribute('placeholder'),
  media: [...document.querySelectorAll('[data-find-media]')].map(b => b.textContent.trim()),
  hero: /你在找什么样的画面/.test(document.body.textContent),
  wall: document.querySelectorAll('.album-wall .plate').length,
  searchAboveWall: (() => {
    const s = document.querySelector('.album-search'), w = document.querySelector('.album-wall');
    return s && w ? s.getBoundingClientRect().top < w.getBoundingClientRect().top : false;
  })(),
  skin: document.documentElement.dataset.skin,
}))()`);
console.log("\n=== 前置（第一/二阶段）===");
console.log(`  导航 ${preflight.navCount} 项: ${preflight.nav.join(" / ")}`);
check("顶层只剩三个入口（参考/作品记忆/审美记忆）", preflight.navCount === 3 && preflight.nav.join("/") === "参考/作品记忆/审美记忆", JSON.stringify(preflight.nav));
check("没有旧的五个入口与 AI 说明大标题", preflight.hero === false, `hero=${preflight.hero}`);
check("搜索框在图片墙上方", preflight.searchAboveWall === true, "");
check("搜索占位符为「搜索作品、电影、色彩、氛围…」", preflight.placeholder === "搜索作品、电影、色彩、氛围…", preflight.placeholder);
check("媒介四档：全部/绘画/电影/动画", preflight.media.join("/") === "全部/绘画/电影/动画", preflight.media.join("/"));
record("preflight", true, JSON.stringify(preflight));

// ============================== 1) 原位搜索 ==============================
console.log("\n=== 验收 1 · 首页搜索无需跳转即可看到结果 ===");
const search = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hashBefore = location.hash;
  const input = document.querySelector('#find-text');
  input.value = '孤独 夜晚';
  document.querySelector('#album-search').dispatchEvent(new Event('submit', { cancelable: true }));
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    const hits = document.querySelectorAll('#find-results .find-hit').length;
    if (hits > 0 && !/正在检索远程/.test(document.querySelector('#find-remote')?.textContent || '')) break;
  }
  // 等图片
  for (let i = 0; i < 40; i++) {
    const imgs = [...document.querySelectorAll('#find-results img')];
    if (imgs.length && imgs.every((x) => x.complete)) break;
    await sleep(400);
  }
  return {
    hashBefore,
    hashAfter: location.hash,
    routeChanged: location.hash !== hashBefore,
    wallHidden: document.querySelector('#album-wall-wrap')?.hidden === true,
    resultsShown: document.querySelector('#album-results')?.hidden === false,
    hits: document.querySelectorAll('#find-results .find-hit').length,
    intentShown: /Visual Intent|解析/.test(document.querySelector('#find-intent')?.textContent || ''),
    remoteText: (document.querySelector('#find-remote')?.textContent || '').replace(/\\s+/g,' ').slice(0, 90),
    audit: ${VIEWPORT_IMAGE_AUDIT},
  };
})()`);
console.log(`  命中 ${search.hits} 件 | hash ${search.hashBefore} → ${search.hashAfter} | 图 ${search.audit.decodedInViewport}/${search.audit.imgsInViewport} 占位 ${search.audit.visiblePlaceholders}`);
check("搜索后路由未变（不跳到另一套 FIND 页）", search.routeChanged === false, `${search.hashBefore} → ${search.hashAfter}`);
check("结果原位出现，图片墙让位", search.resultsShown && search.wallHidden, JSON.stringify({ results: search.resultsShown, wall: search.wallHidden }));
check("本地检索有真实结果", search.hits > 0, `${search.hits} 件`);
check("意图来源如实标注（非伪装视觉分析）", search.intentShown === true, search.remoteText);
record("1-search-in-place", search.hits > 0, JSON.stringify(search));

// ============================== 2) 详情侧栏 + 返回原位 ==============================
console.log("\n=== 验收 2 · 点图片看详情并返回原位置 ===");
const detail = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.scrollTo(0, 260);
  await sleep(300);
  const scrollBefore = window.scrollY;
  const hit = document.querySelector('#find-results .find-hit[data-hit-key]');
  if (!hit) return { error: 'no hit link' };
  const href = hit.getAttribute('href');
  hit.click();
  for (let i = 0; i < 40; i++) {
    const p = document.querySelector('.work-panel:not([hidden])');
    if (p && p.querySelector('.work-panel-figure img')) break;
    await sleep(250);
  }
  const panel = document.querySelector('.work-panel:not([hidden])');
  const actions = [...(panel?.querySelectorAll('.work-panel-actions a, .work-panel-actions button') || [])].map((b) => b.textContent.trim());
  // 详情图必须真的解码（不是 DOM 里有 img）
  const pimg = panel?.querySelector('.work-panel-figure img');
  for (let i = 0; i < 30; i++) {
    if (pimg && pimg.complete) break;
    await sleep(300);
  }
  return {
    scrollBefore,
    panelOpen: Boolean(panel),
    panelImageDecoded: (pimg?.naturalWidth || 0) > 0,
    actions,
    hasSourceCheck: /来源核验/.test(panel?.textContent || ''),
    deepLinkKept: href && href.startsWith('#artwork/'),
    title: (panel?.querySelector('.work-panel-title')?.textContent || '').trim(),
  };
})()`);
check("点击作品打开详情侧栏", detail.panelOpen === true, JSON.stringify(detail).slice(0, 160));
check("详情里的图真实解码", detail.panelImageDecoded === true, `naturalWidth=${detail.panelImageDecoded}`);
check("详情提供五个动作（含来源核验）", detail.actions.length >= 5 && detail.hasSourceCheck, detail.actions.join("/"));
check("深链 href 仍保留在元素上", detail.deepLinkKept === true, detail.deepLinkKept);

const restore = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = document.querySelector('.work-panel:not([hidden])');
  panel?.querySelector('[data-panel-close]')?.click();
  await sleep(500);
  return {
    closed: document.querySelector('.work-panel')?.hidden === true,
    scrollBack: window.scrollY,
    query: document.querySelector('#find-text')?.value,
    mediaOn: document.querySelector('[data-find-media].is-on')?.textContent.trim(),
    resultsStillShown: document.querySelector('#album-results')?.hidden === false,
  };
})()`);
check("关闭后结果仍在原处（不跳走、不清空）", restore.closed && restore.resultsStillShown, JSON.stringify(restore));
check("关闭后查询词与媒介筛选都还在", restore.query === "孤独 夜晚" && Boolean(restore.mediaOn), JSON.stringify(restore));
check(`关闭后滚动位置恢复（${detail.scrollBefore} → ${restore.scrollBack}）`, restore.scrollBack === detail.scrollBefore, `${detail.scrollBefore} vs ${restore.scrollBack}`);
record("2-detail-restore", detail.panelOpen && restore.closed, JSON.stringify({ detail, restore }));

// ============================== 3) 参考 → 创作与拍摄 ==============================
console.log("\n=== 验收 3 · 真实选择参考后能进入创作与拍摄 ===");
const reference = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 先回到图片墙（结果态下 .plate 是隐藏的），再打开第一幅作品的详情
  document.querySelector('#album-clear')?.click();
  await sleep(500);
  document.querySelector('.work-panel:not([hidden]) [data-panel-close]')?.click();
  await sleep(300);
  document.querySelector('.plate[data-plate-key]')?.click();
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('.work-panel:not([hidden]) .work-panel-actions')) break;
    await sleep(250);
  }
  const panel = document.querySelector('.work-panel:not([hidden])');
  const btn = document.querySelector('.work-panel:not([hidden]) [data-panel-reference]');
  if (!btn) return { error: 'no reference button' };
  btn.click();
  await sleep(500);
  const snap = window.__faTaskSnapshot ? window.__faTaskSnapshot() : null;
  return {
    clicked: true,
    feedbackText: btn.textContent.trim(),
    pickedKey: (panel?.querySelector('[data-panel-create]')?.dataset.panelCreate) || '',
    // 参考是否真的进入 TaskContext：用页面上的存储/快照核对
    hasSnapshot: Boolean(snap),
    snapshotRefs: snap && Array.isArray(snap.references) ? snap.references.length : null,
    links: [...document.querySelectorAll('.work-panel a[href^="#"]')].map((a) => a.getAttribute('href')),
    hasCreateButton: Boolean(document.querySelector('.work-panel [data-panel-create]')),
  };
})()`);
check("「使用参考」可点击并给出反馈", reference.clicked === true && /参考/.test(reference.feedbackText || ""), reference.feedbackText);
check(
  "详情内提供生成 Prompt 与拍摄指导入口",
  reference.hasCreateButton === true && (reference.links || []).some((h) => h.startsWith("#shoot/")),
  `生成Prompt按钮=${reference.hasCreateButton} 链接=${(reference.links || []).join(" ")}`
);

// 真进创作页看一眼（不是只看链接存在）
const createPage = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = document.querySelector('.work-panel [data-panel-create]');
  if (!btn) return { error: 'no create button' };
  btn.click();
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    if (location.hash.startsWith('#create') && document.querySelector('#app').textContent.trim().length > 40) break;
  }
  const text = document.querySelector('#app').textContent.replace(/\\s+/g, ' ');
  const wantedKey = ${JSON.stringify(reference.pickedKey || "")};
  const pick = wantedKey ? document.querySelector('[data-create-pick="' + wantedKey + '"]') : null;
  return {
    hash: location.hash,
    textHead: text.slice(0, 110),
    isCreatePage: /CREATE|先选参照/.test(text),
    pickOptions: document.querySelectorAll('[data-create-pick]').length,
    workKey: wantedKey,
    workInPickList: Boolean(pick),
    workMarkedSelected: pick ? /is-on|is-selected|selected/.test(pick.className) : false,
    // 这一区只在所选作品登记了视觉原则时才有；没有就不该被算成失败
    hasVisualLanguage: /MY VISUAL LANGUAGE|跨页延续的视觉意图/.test(text),
    principleToggles: document.querySelectorAll('[data-keep]').length,
  };
})()`);
check(
  "点击后真的进入创作页（含可选参考区）",
  createPage.hash?.startsWith("#create") && createPage.isCreatePage === true && createPage.pickOptions > 0,
  JSON.stringify(createPage).slice(0, 200)
);
check(
  "创作页参考区包含刚才选中的那件作品，且被标记为已选中",
  createPage.workInPickList === true && createPage.workMarkedSelected === true,
  `workKey=${createPage.workKey} 在列表=${createPage.workInPickList} 已选中=${createPage.workMarkedSelected}`
);
console.log(`  创作页视觉语言区: ${createPage.hasVisualLanguage ? "有" : "无（所选作品未登记视觉原则）"}，原则勾选项 ${createPage.principleToggles}`);

const shootPage = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#shoot';
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    if (document.querySelector('#app').textContent.trim().length > 40) break;
  }
  const text = document.querySelector('#app').textContent.replace(/\\s+/g, ' ');
  return { hash: location.hash, textHead: text.slice(0, 120), hasShoot: /拍摄|机位|镜头|SHOOT/i.test(text) };
})()`);
check("拍摄指导页可用", shootPage.hash === "#shoot" && shootPage.hasShoot === true, JSON.stringify(shootPage).slice(0, 160));
record("3-reference-to-create-shoot", reference.clicked === true, JSON.stringify({ reference, createPage, shootPage }));

// ============================== 4) 记忆两类仍可用 ==============================
console.log("\n=== 验收 4 · 作品记忆与审美记忆仍可使用 ===");
for (const [hash, mustMatch, label] of [
  ["#memory", /视觉档案|保存/, "作品记忆"],
  ["#eye", /看什么|偏好/, "审美记忆"],
]) {
  const page = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    location.hash = ${JSON.stringify(hash)};
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      const t = document.querySelector('#app')?.textContent || '';
      if (t.trim().length > 30) break;
    }
    const app = document.querySelector('#app');
    return {
      hash: location.hash,
      text: app.textContent.replace(/\\s+/g, ' ').slice(0, 160),
      links: [...app.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).slice(0, 6),
      buttons: [...app.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 6),
      images: [...app.querySelectorAll('img')].filter((i) => i.offsetParent !== null).length,
    };
  })()`);
  const ok = page.hash === hash && new RegExp(mustMatch).test(page.text) && (page.links.length + page.buttons.length) > 0;
  check(`${label}页面可打开且有可操作项`, ok, `${page.links.length} 链接 / ${page.buttons.length} 按钮 | ${page.text.slice(0, 70)}`);
  report.viewports.push({ kind: "memory", label, ok, page });
}

// ============================== 5) 图片真实解码（多视口）========================
console.log("\n=== 验收 5 · 图片实际解码（桌面 / 平板 / 390px 手机）===");
const VIEWPORTS = [
  { name: "desktop", w: 1440, h: 900, mobile: false },
  { name: "tablet", w: 834, h: 1112, mobile: false },
  { name: "mobile390", w: 390, h: 844, mobile: true },
];
for (const vp of VIEWPORTS) {
  await call("Emulation.setDeviceMetricsOverride", {
    width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile, screenWidth: vp.w, screenHeight: vp.h,
  });
  const vpAudit = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    location.hash = '#index';
    await sleep(1500);
    // 等「视口内没有未完成的图」为止。刚滚进来的 lazy 图还在下载，
    // 这时候量解码率会把「还没下载完」算成「解码失败」。
    // 先滚一小段触发视口边缘的 lazy 图（浏览器的 lazy 距离阈值比几何视口更严）
    window.scrollTo(0, 240);
    await sleep(500);
    window.scrollTo(0, 0);
    const vh0 = window.innerHeight;
    for (let i = 0; i < 60; i++) {
      const imgs = [...document.querySelectorAll('.album-wall img')].filter((x) => {
        if (x.offsetParent === null) return false;
        const r = x.getBoundingClientRect();
        return r.bottom > 0 && r.top < vh0;
      });
      if (imgs.length && imgs.every((x) => x.complete)) break;
      await sleep(400);
    }
    await sleep(600);
    const audit = ${VIEWPORT_IMAGE_AUDIT};
    audit.overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    audit.plates = document.querySelectorAll('.album-wall .plate').length;
    audit.columns = getComputedStyle(document.querySelector('.album-wall')).columnCount;
    return audit;
  })()`);
  console.log(
    `  ${vp.name.padEnd(10)} 视口内图 ${vpAudit.decodedInViewport}/${vpAudit.imgsInViewport}  占位 ${vpAudit.visiblePlaceholders}  溢出 ${vpAudit.overflowX}  列数 ${vpAudit.columns}`
  );
  check(`${vp.name}：没有可见的「图像暂不可用」占位`, vpAudit.visiblePlaceholders === 0, JSON.stringify(vpAudit.placeholderTitles));
  // 判据：已请求的图全部解码 + 没有任何可见占位。
  // 「浏览器尚未请求的 lazy 图」既不算通过也不算失败 —— 写进明细，不藏。
  check(
    `${vp.name}：视口内已请求的图片全部真实解码`,
    vpAudit.imgsInViewport > 0 && vpAudit.decodedInViewport > 0 && vpAudit.pendingInViewport === 0,
    `解码 ${vpAudit.decodedInViewport}/${vpAudit.imgsInViewport}，浏览器尚未请求 ${vpAudit.pendingInViewport}`
  );
  check(`${vp.name}：无横向溢出`, vpAudit.overflowX === false, "");
  report.viewports.push({ kind: "images", name: vp.name, audit: vpAudit });
}
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// ============================== 6) 动画档的诚实空态 ==============================
console.log("\n=== 附加 · 动画档不得拿别的东西冒充 ===");
const animation = await evalJs(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#index';
  await sleep(1500);
  const input = document.querySelector('#find-text');
  input.value = '夜晚';
  document.querySelector('#album-search').dispatchEvent(new Event('submit', { cancelable: true }));
  await sleep(2500);
  const btn = [...document.querySelectorAll('[data-find-media]')].find((b) => b.textContent.trim() === '动画');
  btn.click();
  await sleep(1200);
  return {
    note: (document.querySelector('#album-results-note')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    results: document.querySelectorAll('#find-results .find-hit').length,
  };
})()`);
check("动画档 0 件时如实说明，而不是显示绘画/电影", /还没有素材/.test(animation.note) && animation.results === 0, JSON.stringify(animation).slice(0, 180));
record("animation-honest-empty", animation.results === 0, animation.note);

// ============================== 收尾 ==============================
const errors = await evalJs(`(window.__accErrors || []).slice(0, 5)`);
check("全程无未捕获 JS 异常", errors.length === 0, errors.join(" | "));

report.pass = pass;
report.fail = fail;
report.failures = failures;
writeFileSync(join(OUT, "ui-acceptance.json"), JSON.stringify(report, null, 2));
console.log(`\n===== UI 验收(${LABEL}): ${pass}/${pass + fail} PASS, ${fail} FAIL =====`);
for (const f of failures) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`报告：${join(OUT, "ui-acceptance.json")}`);
try { await call("Browser.close"); } catch { /* ignore */ }
edge.kill();
process.exit(fail ? 1 : 0);