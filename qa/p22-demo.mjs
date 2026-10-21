// p22-demo.mjs — 真实浏览器录屏 + ffmpeg 合成 1920×1080 演示视频
//
// 顺序（只导航一次作品页，避免录屏被重复加载打断）：
//   首页 → 作品详情（绘画分支）→ 动画档（绘画→动画）→ 电影档（绘画→电影）
//   → 点进电影画面（统一详情/溯源）→ 以画面为起点继续探索 → 回首页 → 收尾卡
//
// 每段独立 try/catch：某一段卡住只跳过该段，不让整条视频断在半路。
// 不做剪辑补功能：所有镜头都来自同一次真实会话。

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, ".rc1-audit/demo");
const FRAMES = path.join(OUT, "frames");
const W = 1920, H = 1080;
const PORT = Number(process.env.DEMO_PORT || 4572);
const CDP = PORT + 4000;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const { createServer } = await import("node:net");
for (const p of [PORT, CDP]) {
  await new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(p, "127.0.0.1", () => s.close(res)); });
}

const srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], {
  cwd: ROOT, windowsHide: true, stdio: "ignore",
  env: { ...process.env, DISCOVERY_RATE_PER_MINUTE: "400", DISCOVERY_RATE_PER_HOUR: "4000" },
});
const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "demo-"))}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--window-size=${W},${H}`, "about:blank",
], { windowsHide: true, stdio: "ignore" });

const waitFor = async (fn, label, tries = 120) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(150); } throw Error(`超时: ${label}`); };

let ws;
const stamps = [];
let shotIndex = 0;

try {
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, "server", 80);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"), "edge");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map();
  const call = (m, p = {}) => new Promise((res, rej) => {
    const n = ++id;
    const t = setTimeout(() => { pending.delete(n); rej(Error(`timeout ${m}`)); }, 12000);
    pending.set(n, (x) => { clearTimeout(t); x.error ? rej(Error(JSON.stringify(x.error))) : res(x.result); });
    ws.send(JSON.stringify({ id: n, method: m, params: p }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === "Page.screencastFrame") {
      writeFileSync(path.join(FRAMES, `${String(shotIndex++).padStart(5, "0")}.jpg`), Buffer.from(m.params.data, "base64"));
      stamps.push({ file: path.join(FRAMES, `${String(shotIndex - 1).padStart(5, "0")}.jpg`), ts: m.params.metadata.timestamp });
      call("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
    }
  };

  await call("Page.enable"); await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 246, g: 243, b: 237, a: 1 } });
  // 定时抓帧：screencast 只在画面变化时给帧，静态停留会被压缩成 1 帧，
  // 导致成片时长与真实会话不符。改成固定间隔抓图，时间戳就是真实停留。
  let capturing = true;
  const capture = (async () => {
    while (capturing) {
      const t0 = Date.now();
      try {
        const shot = await call("Page.captureScreenshot", { format: "jpeg", quality: 88 });
        const file = path.join(FRAMES, `${String(shotIndex++).padStart(5, "0")}.jpg`);
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        stamps.push({ file, ts: t0 / 1000 });  // 秒：拼片时按秒差算停留
      } catch { /* 页面切换瞬间抓帧失败，跳过这一帧 */ }
      await sleep(Math.max(0, 220 - (Date.now() - t0)));
    }
  })();

  const evalJs = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const caption = (text) => evalJs(`(() => {
    let el = document.querySelector("#demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:20px 48px;background:rgba(20,19,17,.84);color:#f4f1ea;font:400 23px/1.5 'Microsoft YaHei',sans-serif;letter-spacing:.02em";
      document.body.appendChild(el);
    }
    el.textContent = ${JSON.stringify(text)};
  })()`).catch(() => {});
  const go = async (hash) => { await call("Page.navigate", { url: `${BASE}/${hash}` }); await sleep(2600); };
  const scrollTo = async (sel, offset = -80) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + ${offset} }); })()`).catch(() => {});
  const scrollBy = (px) => evalJs(`window.scrollBy({ top: ${px} })`).catch(() => {});
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.log(`  [跳过] ${name}: ${e.message}`); } };

  const showMedia = async (mode) => {
    await evalJs(`document.querySelector('[data-explore-media="${mode}"]')?.click()`);
    await sleep(700);
    await scrollTo("#explore-media-row:not([hidden])", -70);
    await evalJs(`document.querySelectorAll('#explore img[loading="lazy"]').forEach((i) => { i.loading = "eager"; })`).catch(() => {});
    await waitFor(() => evalJs(`[...document.querySelectorAll("#explore .explore-external img")].filter((i) => i.complete && i.naturalWidth > 0).length >= 3`), `图片 ${mode}`, 60).catch(() => {});
    await sleep(600);
  };

  /* 1. 首页 */
  await step("首页", async () => {
    await go("#index");
    await waitFor(() => evalJs(`document.querySelectorAll(".plate").length >= 12`), "首页图片墙");
    await caption("首页 · 真实馆藏图与自动发现图混排，不靠人工维护清单");
    await sleep(6000);
    await scrollBy(640);
    await sleep(4200);
    await scrollBy(560);
    await sleep(3800);
  });

  /* 2. 作品详情 + 绘画分支 */
  await step("详情", async () => {
    await go("#artwork/local:paris-rainy-day");
    await waitFor(() => evalJs(`Boolean(document.querySelector("#explore .explore-external"))`), "外部候选");
    await caption("《雨天的巴黎街道》：保留画派，只换一个维度");
    await sleep(3200);
    await scrollTo("#explore", -40);
    await sleep(4200);
    await caption("每条候选都写明：保留了什么、换掉了什么、证据来自哪里");
    await sleep(4200);
  });

  /* 3. 动画档：绘画 → 动画画面 */
  await step("动画档", async () => {
    await showMedia("animation");
    await caption("动画档：Blender 开放影片抽帧 + 公有领域早期动画，共 20 张真实画面");
    await sleep(5200);
    await scrollBy(360);
    await sleep(3600);
  });

  /* 4. 电影档：绘画 → 电影画面 */
  await step("电影档", async () => {
    await showMedia("film");
    await caption("电影档：跨媒介候选只标「同媒介近邻 · 未做风格判定」");
    await sleep(5600);
    await scrollBy(300);
    await sleep(3200);
  });

  /* 5. 点进一张电影画面 */
  await step("画面详情", async () => {
    await evalJs(`(document.querySelector('#explore-media-row .explore-external[data-ext-kind="film-still"] .explore-external-open') || document.querySelector('#explore .explore-external[data-ext-kind="film-still"] .explore-external-open'))?.click()`);
    await sleep(3000);
    await caption("同一套作品详情页 · 来源、许可与署名可追溯");
    await sleep(3400);
    await evalJs(`(() => { const d = document.querySelector(".detail-facts"); if (d) d.open = true; })()`).catch(() => {});
    await scrollTo(".detail-facts", -240);
    await sleep(4200);
  });

  /* 6. 以画面为起点继续探索 */
  await step("画面继续探索", async () => {
    await scrollTo("#explore", -40);
    await sleep(1200);
    await evalJs(`document.querySelector('[data-explore-media="all"]')?.click()`).catch(() => {});
    await sleep(3000);
    await caption("以这张画面为起点继续探索：能一路走下去，不跳站");
    await sleep(4400);
  });

  /* 7. 换一件作品：同一套流程在另一件画上复现 */
  await step("第二件作品", async () => {
    await go("#artwork/local:american-gothic");
    await waitFor(() => evalJs(`Boolean(document.querySelector("#explore .explore-external"))`), "第二件候选");
    await caption("换一件作品（美国哥特式）：同一套探索入口，候选随画面重算");
    await sleep(5200);
    await scrollTo("#explore", -40);
    await sleep(4200);
    await scrollBy(300);
    await sleep(1600);
  });

  /* 8. 回首页收尾 */
  await step("回首页", async () => {
    await go("#index");
    await sleep(3600);
    await caption("Frame Atlas · 从一张图，找到它真正的视觉祖先");
    await sleep(3600);
  });

  capturing = false;
  await capture.catch(() => {});
  await sleep(300);
} catch (e) {
  console.log("DEMO ERROR:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { edge.kill(); } catch {}
  try { srv.kill(); } catch {}
}

/* ---------- 合成 ---------- */
try {
  const titleJpg = path.join(OUT, "card-title.jpg");
  const closeJpg = path.join(OUT, "card-closing.jpg");
  execFileSync("python", ["scripts/demo/cards.py", "--out", titleJpg, "--kind", "title"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("python", ["scripts/demo/cards.py", "--out", closeJpg, "--kind", "closing", "--meta",
    "绘画 · 电影 · 动画 三媒介视觉检索",
    "真实浏览器录制 · 未剪辑补功能",
    "github.com/xiebenzhen-code/visual-ancestry",
  ], { cwd: ROOT, stdio: "inherit" });

  const sorted = stamps.sort((a, b) => a.ts - b.ts);
  if (sorted.length < 30) throw Error(`帧数不足: ${sorted.length}`);
  const listFile = path.join(OUT, "concat.txt");
  const lines = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    // 静态页不产生新帧：间隔即"画面停留"，上限 6.5s 防止异常长段撑爆时长
    const d = Math.min(6.5, Math.max(1 / 30, sorted[i + 1].ts - sorted[i].ts));
    lines.push(`file '${sorted[i].file.replace(/\\/g, "/")}'`);
    lines.push(`duration ${d.toFixed(3)}`);
  }
  lines.push(`file '${sorted.at(-1).file.replace(/\\/g, "/")}'`, "duration 0.2");
  writeFileSync(listFile, lines.join("\n") + "\n", "utf8");

  // 首尾卡单独成片再拼：concat demuxer 对"静止图 + duration"不可靠，
  // 用 filter_complex 把两段真实拼接，时长可控且不会吃掉结尾。
  const mp4 = path.join(OUT, "frame-atlas-demo.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1", "-t", "3.0", "-i", titleJpg,
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-loop", "1", "-t", "2.8", "-i", closeJpg,
    "-filter_complex",
    `[0:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0xf6f3ed,setsar=1,format=yuv420p[v0];` +
    `[1:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0xf6f3ed,setsar=1,format=yuv420p[v1];` +
    `[2:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0xf6f3ed,setsar=1,format=yuv420p[v2];` +
    `[v0][v1][v2]concat=n=3:v=1:a=0[out]`,
    "-map", "[out]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart",
    mp4,
  ], { cwd: ROOT, stdio: "inherit" });
  console.log(`  视频: ${path.relative(ROOT, mp4)}`);
} catch (e) {
  console.log("合成失败:", e.message);
  process.exitCode = 1;
}
