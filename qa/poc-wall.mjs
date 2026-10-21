// poc-wall.mjs — 把自动发现的近邻结果渲染成图片墙并截图（STEP 5 证据）
//
// 只做展示：读 nn-result.json + decoded.json，复制解码成功的缩略图，
// 起一个临时静态服务，Edge headless 截图。不联网、不调用模型。

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = process.cwd();
const POC = path.join(ROOT, ".rc1-audit/poc");
const WALL = path.join(POC, "wall");
fs.mkdirSync(WALL, { recursive: true });

const nn = JSON.parse(fs.readFileSync(path.join(POC, "nn-result.json"), "utf8"));
const decoded = JSON.parse(fs.readFileSync(path.join(POC, "decoded.json"), "utf8"));
const cand = JSON.parse(fs.readFileSync(path.join(POC, "candidates.json"), "utf8"));
const byKey = new Map(cand.items.map((w) => [w.dedupeKey, w]));

const QUERY_TITLE = "Paris Street; Rainy Day";

function extOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf.slice(0, 4).toString() === "RIFF") return ".webp";
  if (buf.slice(0, 3).toString() === "GIF") return ".gif";
  return ".bin";
}

const cards = [];
for (const row of nn.top) {
  const work = [...byKey.values()].find((w) => w.source === row.source && w.sourceId === row.rankKeySafe)
    || [...byKey.values()].find((w) => w.source === row.source && w.title === row.title);
  const key = work?.dedupeKey;
  const rec = key ? decoded.items[key] : null;
  if (!rec?.ok || !rec.path) continue;
  const buf = fs.readFileSync(path.join(ROOT, rec.path));
  const name = `r${String(row.rank).padStart(2, "0")}-${row.source}${extOf(buf)}`;
  fs.writeFileSync(path.join(WALL, name), buf);
  cards.push({ ...row, file: name, sameAsQuery: row.title === QUERY_TITLE });
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>自动发现图片墙</title>
<style>
  body{margin:0;background:#f6f4ef;color:#1b1b1b;font-family:"Microsoft YaHei",system-ui,sans-serif}
  header{padding:22px 34px 8px}
  h1{margin:0 0 6px;font-size:20px}
  .meta{font-size:12px;color:#6b6b6b;line-height:1.7}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;padding:18px 34px 40px}
  figure{margin:0;background:#fff;border:1px solid #e4e1d9;border-radius:8px;overflow:hidden}
  figure img{display:block;width:100%;height:190px;object-fit:cover;background:#eee}
  figcaption{padding:8px 10px 10px;font-size:11px;line-height:1.5}
  .t{font-size:12px;font-weight:600;margin-bottom:2px}
  .a{color:#6b6b6b;margin-bottom:4px}
  .row{display:flex;justify-content:space-between;color:#6b6b6b}
  .cos{color:#1a6b4a;font-weight:600}
  .src{display:inline-block;margin-top:4px;padding:1px 6px;border:1px solid #ddd;border-radius:99px;font-size:10px}
  .dup{color:#a35b00}
  @media(max-width:720px){.grid{grid-template-columns:repeat(2,1fr);padding:14px}}
</style></head><body>
<header>
  <h1>自动发现 → MobileCLIP → 近邻</h1>
  <div class="meta">
    查询：《雨天的巴黎街道》（paris-rainy-day）<br>
    语料：${nn.corpus.decoded} 张自动发现图（解码成功）｜向量 ${nn.corpus.embedded} 条｜模型 ${nn.query.model}<br>
    来源：AIC / Met / Cleveland / Rijks 的公开 API，关键词 rainy city street、mountain landscape、decorative painting
  </div>
</header>
<div class="grid">
${cards.map((c) => `
  <figure>
    <img src="./wall/${c.file}" alt="">
    <figcaption>
      <div class="t">${escapeHtml(c.title || "(无标题)")}${c.sameAsQuery ? ' <span class="dup">· 与查询同一件</span>' : ""}</div>
      <div class="a">${escapeHtml(c.artist || "")}${c.year ? " · " + escapeHtml(String(c.year)) : ""}</div>
      <div class="row"><span>cos ${c.cos.toFixed(3)}</span><span>#${c.rank}</span></div>
      <span class="src">${escapeHtml(c.source)} · ${escapeHtml(String(c.rights || "").slice(0, 24))}</span>
    </figcaption>
  </figure>`).join("")}
</div></body></html>`;
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
fs.writeFileSync(path.join(POC, "wall.html"), html, "utf8");

/* 临时静态服务 + 截图 */
const PORT = 4541, CDP = 9541, BASE = `http://127.0.0.1:${PORT}`;
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  const file = p === "/" || p === "/wall.html" ? path.join(POC, "wall.html") : path.join(POC, p.replace(/^\//, "").replace(/^wall\//, "wall/"));
  if (!file.startsWith(POC) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  const ext = path.extname(file);
  const mime = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "poc-wall-"))}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { windowsHide: true, stdio: "ignore" });

let ws;
try {
  let target;
  for (let i = 0; i < 80; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"); if (target) break; } catch {}
    await sleep(200);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  const call = (m, p = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (x) => x.error ? rej(Error(JSON.stringify(x.error))) : res(x.result)); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  await call("Page.enable"); await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `${BASE}/wall.html` });
  await sleep(1800);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(POC, "discovered-wall-desktop.png"), Buffer.from(shot.data, "base64"));
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(900);
  const shot2 = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(POC, "discovered-wall-mobile.png"), Buffer.from(shot2.data, "base64"));
  console.log(`  墙上有 ${cards.length} 张（其中与查询同一件 ${cards.filter((c) => c.sameAsQuery).length} 张）`);
  console.log("  截图: discovered-wall-desktop.png / discovered-wall-mobile.png");
} finally {
  try { ws?.close(); } catch {}
  try { edge.kill(); } catch {}
  server.close();
}
