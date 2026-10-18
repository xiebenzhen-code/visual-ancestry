// ui-shots.mjs — 两套视觉方案 × 五个画面，真实浏览器截图（Phase 3 交付）。
//
// 交付的不是「我改好了」，而是可比较的图：album 与 archive 并排，
// 覆盖首页、搜索结果、作品详情、作品记忆、审美记忆。
//
// 截图用 CDP 的 Emulation.setDeviceMetricsOverride 固定视口，避免窗口大小影响版面；
// 截图前统一等图片落地（complete），否则会拍到半空的图位。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const OUT = join(HERE, "ui-shots");
const PORT = 9486;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const SKINS = ["album"];   // STEP 1 已批准 A「画册」；archive 保留为设计存档
const VIEWPORTS = [
  { key: "desktop", width: 1440, height: 900, mobile: false },
  { key: "mobile390", width: 390, height: 844, mobile: true },
];
// 桌面拍全五屏；390px 只拍首页与详情（详情层在移动端形态不同，值得单独看）
const SCENES = [
  { key: "1-home", hash: "#index", viewport: "desktop", kind: "home" },
  { key: "2-search-results", hash: "#index", viewport: "desktop", kind: "results" },
  { key: "3-work-detail", hash: "#index", viewport: "desktop", kind: "detail" },
  { key: "4-create-picks", hash: "#create", viewport: "desktop", kind: "create" },
  { key: "5-work-memory", hash: "#memory", viewport: "desktop", kind: "static" },
  { key: "6-aesthetic-memory", hash: "#eye", viewport: "desktop", kind: "static" },
  { key: "1-home-mobile", hash: "#index", viewport: "mobile390", kind: "home" },
  { key: "3-work-detail-mobile", hash: "#index", viewport: "mobile390", kind: "detail" },
];

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

// 等应用真的挂载：冷加载要重新取模块图，固定 sleep 会拍到空页。
const waitForApp = async () => {
  // 不依赖页面根元素的类名：实测「作品记忆」的根类名就不在预设列表里，
  // 按选择器等待会误判成「没挂载」。判据改为 #app 里有实质文本。
  for (let i = 0; i < 60; i++) {
    const ok = await evalJs(`(() => {
      const app = document.querySelector('#app');
      return Boolean(app && app.children.length && app.textContent.replace(/\\s+/g, ' ').trim().length > 20);
    })()`);
    if (ok) return true;
    await sleep(500);
  }
  throw new Error('等待应用挂载超时（30s）—— 拒绝在未挂载的页面上截图');
};

const evalJs = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
};

// 渐进滚动一遍再等落地：首屏之外的 lazy 图需要被触发才开始下载。
// 只滚不等的测量会得出「还没加载」，被误读成「加载不了」—— 这正是本轮修掉的
// 那类误判，不能在验收脚本里再犯一次。
const scrollAll = `(async () => {
  for (let y = 0; y <= document.body.scrollHeight; y += 500) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 90));
  }
  window.scrollTo(0, 0);
  return 1;
})()`;

const settleImages = `(async () => {
  // 只等**视口内**的图片落地。视口外的 lazy 图浏览器不会请求，
  // 那不是「解码失败」，把它算进失败就是自己骗自己。
  const deadline = Date.now() + 30000;
  for (;;) {
    const vh = window.innerHeight;
    const imgs = [...document.querySelectorAll('#app img, .work-panel img')].filter((i) => {
      if (i.offsetParent === null) return false;
      const r = i.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    });
    const pending = imgs.filter((i) => !i.complete);
    if (!pending.length) return imgs.length;
    if (Date.now() > deadline) return imgs.length + '(timeout)';
    await new Promise((r) => setTimeout(r, 300));
  }
})()`;

const shot = async (file) => {
  const r = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, file), Buffer.from(r.result.data, "base64"));
  return file;
};

// 预热：先访问一次首页并等图片落地，把 HTTP 缓存热起来。
// 实测第一套皮肤（冷缓存）会出现 4 张「图像暂不可用」占位，热缓存 0 张。
// 这里显式预热并在报告里记下冷启动数字，而不是让它随机决定这次拍到什么。
async function warmUp() {
  await call("Page.navigate", { url: `${BASE}/?warm=1#index` });
  await sleep(900);
  await waitForApp();
  await evalJs(settleImages);
  const cold = await evalJs(`(() => {
    const slots = [...document.querySelectorAll('.album-wall .img-slot')];
    const ph = slots.filter((s) => {
      const u = s.querySelector('.img-unavailable');
      return u && u.getClientRects().length > 0;
    }).length;
    return { slots: slots.length, placeholdersOnColdStart: ph };
  })()`);
  console.log(`  预热完成：冷启动时 ${cold.slots - cold.placeholdersOnColdStart}/${cold.slots} 张可用（占位 ${cold.placeholdersOnColdStart} 张）`);
  return cold;
}

const report = { at: new Date().toISOString(), base: BASE, shots: [], notes: [], coldStart: null };
let shotSeq = 0;

const coldStart = await warmUp();

report.coldStart = coldStart;

for (const skin of SKINS) {
  for (const scene of SCENES) {
    const vp = VIEWPORTS.find((v) => v.key === scene.viewport);
    // 每个场景都做一次**真实文档加载**：加 cache-busting 查询参数。
    // 只改 hash 不会重新加载，之前的视口覆盖就会落在已渲染的页面上，
    // 合成器把两帧拼在一起 —— 拍出来是 2×2 重复的半尺寸画面。
    shotSeq += 1;
    await call("Page.navigate", { url: `${BASE}/?t=${shotSeq}${scene.hash}` });
    await sleep(900);
    await call("Emulation.setDeviceMetricsOverride", {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: vp.mobile,
      screenWidth: vp.width,
      screenHeight: vp.height,
    });
    await waitForApp();
    // 拍摄卫生：收起上一个场景可能残留的侧栏（共用同一 hash 时不会触发 hashchange）
    await evalJs(`(() => {
      const p = document.querySelector('.work-panel:not([hidden])');
      if (p) p.querySelector('[data-panel-close]')?.click();
      const b = document.querySelector('.work-panel-backdrop');
      if (b) b.hidden = true;
      return 1;
    })()`);
    await sleep(250);
    // 切皮肤（不改文件，只改属性，便于同一份代码对比两套视觉）
    await evalJs(`(() => { document.documentElement.dataset.skin = ${JSON.stringify(skin)}; return 1; })()`);
    await sleep(500);

    let extra = "";
    if (scene.kind === "results") {
      await evalJs(`(async () => {
        const i = document.querySelector('#find-text');
        i.value = '孤独 夜晚';
        document.querySelector('#album-search').dispatchEvent(new Event('submit', { cancelable: true }));
        await new Promise((r) => setTimeout(r, 2500));
        return 1;
      })()`);
      await evalJs(settleImages);
    } else if (scene.kind === "detail") {
      await evalJs(`(async () => {
        const hit = document.querySelector('.plate[data-plate-key]');
        if (!hit) return 0;
        hit.click();
        await new Promise((r) => setTimeout(r, 800));
        return 1;
      })()`);
      await evalJs(settleImages);
    } else if (scene.kind === "create") {
      await evalJs(`(async () => {
        const { artworks } = await import('/src/data/artworks.js');
        const { recordReference, beginTask } = await import('/src/utils/taskContext.js');
        const target = artworks.find((a) => /bahram/i.test(a.id || ''));
        location.hash = '#index';                       // 先离开，确保后面切回时真的会重渲染
        await new Promise((r) => setTimeout(r, 800));
        beginTask();
        if (target) recordReference(target.key);
        location.hash = '#create';
        await new Promise((r) => setTimeout(r, 1800));
        const pick = document.querySelector('[data-create-pick="' + (target ? target.id : '') + '"]');
        return pick ? (pick.classList.contains('is-on') ? 1 : -1) : 0;
      })()`);
      await evalJs(settleImages);
    } else {
      await evalJs(settleImages);
    }

    const file = `${skin}-${scene.key}.png`;
    await shot(file);
    const stat = {
      skin,
      scene: scene.key,
      viewport: `${vp.width}x${vp.height}`,
      file,
      images: await evalJs(`(() => {
        // 只量「真的显示出来」的图：隐藏面板里的图即使加载了也不该算进版面验收
        const vh = window.innerHeight;
        const imgs = [...document.querySelectorAll('#app img, .work-panel img')].filter((i) => {
          if (i.offsetParent === null) return false;
          const r = i.getBoundingClientRect();
          return r.bottom > 0 && r.top < vh;
        });
        // 占位也要算：回退链走完时 <img> 被移除、槽位标记 is-broken，
        // 只数 <img> 会把「彻底失败」的卡片漏出统计。
        const slots = [...document.querySelectorAll('#app .img-slot, .work-panel .img-slot')].filter(
          (s) => s.offsetParent !== null
        );
        const placeholders = slots.filter((s) => {
          const u = s.querySelector('.img-unavailable');
          return u && u.getClientRects().length > 0;
        }).length;
        return {
          total: imgs.length,
          decoded: imgs.filter((i) => i.naturalWidth > 0).length,
          placeholders,
        };
      })()`),
      panelOpen: await evalJs(`Boolean(document.querySelector('.work-panel:not([hidden])'))`),
      overflowX: await evalJs(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`),
    };
    report.shots.push(stat);
    console.log(
      `  ${stat.skin.padEnd(8)} ${scene.key.padEnd(22)} ${vp.width}x${vp.height}  ` +
        `图 ${stat.images.decoded}/${stat.images.total}  占位=${stat.images.placeholders}  侧栏=${stat.panelOpen}  横向溢出=${stat.overflowX}`
    );
  }
}

writeFileSync(join(OUT, "ui-shots.json"), JSON.stringify(report, null, 2));
console.log(`\n→ ${OUT}`);
const bad = report.shots.filter(
  (s) => (s.images.total > 0 && s.images.decoded < s.images.total) || s.images.placeholders > 0
);
if (bad.length) {
  console.log("⚠ 有未解码完成的画面（需人工确认是否慢加载）：");
  for (const b of bad) console.log(`    ${b.skin}/${b.scene}: ${b.images.decoded}/${b.images.total}`);
} else {
  console.log("全部画面的图片都真实解码。");
}
try { await call("Browser.close"); } catch { /* ignore */ }
edge.kill();
process.exit(0);