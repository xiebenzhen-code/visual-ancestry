// p22b-crossmedia.mjs — 跨媒介真实检索验收（四条路径）
//
// 做法：对每个真实起点调用线上同源接口 /api/discovery/neighbors，把"起点 + 候选"
// 拼成一张对照图，供人工复核；同时把结构化结果写进 JSON。
//
// 不做的事：不放宽阈值、不把向量近邻说成同风格、不替候选编造视觉关联。
// 判定由人看对照图后填写（见 verdicts.json），脚本只负责取数与排版。

import fs, { mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, ".rc1-audit/discovery/p22b");
const PORT = Number(process.env.QA_PORT || 4562);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });


// 验收脚本自起一个服务：触发额度临时放宽，避免把 429 误读成"没有候选"。
let srv = null;
if (!process.env.BASE) {
  const { spawn } = await import("node:child_process");
  srv = spawn(process.execPath, ["scripts/server.mjs", ".", String(PORT)], {
    cwd: ROOT, windowsHide: true, stdio: "ignore",
    env: { ...process.env, DISCOVERY_RATE_PER_MINUTE: "200", DISCOVERY_RATE_PER_HOUR: "2000" },
  });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const works = new Map();
for (const line of fs.readFileSync(path.join(ROOT, ".rc1-audit/discovery/works.ndjson"), "utf8").split("\n")) {
  if (line.trim()) { const w = JSON.parse(line); works.set(w.id, w); }
}
const all = [...works.values()];

const byKind = (k) => all.filter((w) => w.imageKind === k && w.imageHash);
const paintings = (() => {
  // 本地绘画：有预生成向量的 46 件
  const lv = JSON.parse(fs.readFileSync(path.join(ROOT, ".rc1-audit/discovery/local-vectors.json"), "utf8"));
  return Object.keys(lv.vectors || {});
})();

const filmFrames = byKind("film-still");
const animFrames = byKind("animation-frame");

async function neighbors(payload) {
  const res = await fetch(`${BASE}/api/discovery/neighbors`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return res.json();
}

/** 从响应里取指定媒介的候选（先看风格分支，再看同媒介近邻）。 */
function pickTarget(res, media) {
  const kindOfMedia = media === "film" ? ["film-still", "tv-episode-still"]
    : media === "animation" ? ["animation-frame", "tv-episode-still"]
    : ["artwork"];
  const fromBranches = Object.values(res.branches || {}).flat().filter((c) => kindOfMedia.includes(c.imageKind));
  const fromRow = (res.mediaNeighbors?.[media] || []).filter((c) => kindOfMedia.includes(c.imageKind));
  const merged = [...fromBranches, ...fromRow];
  const seen = new Set();
  return merged.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).slice(0, 4);
}

const localPreview = (id) => path.join(ROOT, "public/assets/artworks", id, "preview.webp");
const storedImage = (w) => path.join(ROOT, w.storedImage);

function sheet(rows, file) {
  // 用 python/PIL 排版：每行一张起点 + 3–4 张候选，带标题
  const payload = rows.map((r) => ({
    origin: { label: r.originLabel, path: r.originPath },
    candidates: r.candidates.map((c) => ({ label: c.label, path: c.path })),
  }));
  const jsonFile = file.replace(/\.png$/, ".json");
  fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 1), "utf8");
  execFileSync("python", ["scripts/discovery/contact_sheet.py", "--in", path.relative(ROOT, jsonFile), "--out", path.relative(ROOT, file)], { cwd: ROOT, stdio: "inherit" });
}

const results = [];

async function runPath({ name, media, origins }) {
  const rows = [];
  for (const origin of origins) {
    const payload = origin.hash ? { hash: origin.hash } : { artworkId: origin.id };
    const res = await neighbors(payload);
    const picked = res.ok ? pickTarget(res, media) : [];
    const originPath = origin.hash ? storedImage(origin.work) : localPreview(origin.id);
    rows.push({
      name,
      origin: { id: origin.id || origin.hash, label: origin.label },
      originLabel: origin.label,
      originPath,
      candidates: picked.map((c) => ({ label: `${c.title} [${c.imageKind}]`, path: path.join(ROOT, ".rc1-audit/discovery/images", findImageFile(c.id)), c })),
      ok: res.ok,
      total: res.total,
      note: res.error || null,
    });
    results.push({
      path: name,
      media,
      origin: origin.id || origin.hash,
      originLabel: origin.label,
      returned: picked.length,
      candidates: picked.map((c) => ({ id: c.id, title: c.title, kind: c.imageKind, cos: c.cos, level: c.level, claim: c.claim })),
      error: res.ok ? null : res.error,
    });
  }
  const sheetFile = path.join(OUT, `sheet-${name.replace("→", "-to-")}.png`);
  try { sheet(rows.filter((r) => r.candidates.length), sheetFile); } catch (e) { console.log("  对照图生成失败:", e.message); }
  return rows;
}

function findImageFile(id) {
  const w = works.get(id);
  return w ? path.basename(w.storedImage) : "";
}

/* ---------- 起点的挑选：覆盖不同视觉条件，不挑"好看"的 ---------- */
// 三个起点覆盖不同视觉条件：湿冷街景 / 强动态海浪 / 正面肖像（低饱和）
const localPick = ["paris-rainy-day", "wave", "american-gothic"].filter((id) => paintings.includes(id));
const fallbackLocal = paintings.slice(0, 4);
const paintingIds = localPick.length >= 3 ? localPick.slice(0, 3) : fallbackLocal.slice(0, 3);

const paintingOrigins = paintingIds.map((id) => {
  const lv = JSON.parse(fs.readFileSync(path.join(ROOT, ".rc1-audit/discovery/local-vectors.json"), "utf8")).vectors[id];
  return { id, label: lv?.title || id };
});

// 电影/动画起点也尽量分散：真人 vs 动画，冷调 vs 暖调
const filmOrigins = (() => {
  const tos = filmFrames.filter((w) => w.provider === "blender").slice(0, 2);
  const commonsFilm = filmFrames.filter((w) => w.provider === "commons");
  return [...tos, ...commonsFilm].slice(0, 3).map((w) => ({ hash: w.imageHash, label: w.title, work: w }));
})();
const animOrigins = (() => {
  const bbb = animFrames.filter((w) => w.provider === "blender").slice(0, 2);
  const commonsAnim = animFrames.filter((w) => w.provider === "commons");
  return [...bbb, ...commonsAnim].slice(0, 3).map((w) => ({ hash: w.imageHash, label: w.title, work: w }));
})();

console.log("  绘画起点:", paintingOrigins.map((o) => o.label).join(" / "));

const path1 = await runPath({ name: "painting→film", media: "film", origins: paintingOrigins });
const path2 = await runPath({ name: "film→painting", media: "artwork", origins: filmOrigins });
const path3 = await runPath({ name: "painting→animation", media: "animation", origins: paintingOrigins });
const path4 = await runPath({ name: "animation→painting", media: "artwork", origins: animOrigins });

fs.writeFileSync(path.join(OUT, "crossmedia.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1), "utf8");

for (const [label, rows] of [["绘画→电影", path1], ["电影→绘画", path2], ["绘画→动画", path3], ["动画→绘画", path4]]) {
  const withCand = rows.filter((r) => r.candidates.length).length;
  console.log(`  ${label}: ${withCand}/${rows.length} 个起点有候选 | 共 ${rows.reduce((n, r) => n + r.candidates.length, 0)} 张`);
  const errs = rows.filter((r) => r.note).map((r) => r.note);
  if (errs.length) console.log(`     错误: ${[...new Set(errs)].join(", ")}`);
}
if (srv) srv.kill();
