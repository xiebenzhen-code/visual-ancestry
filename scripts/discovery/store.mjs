// store.mjs — 采集结果的本地状态（不进 Git：.rc1-audit/ 已忽略）。
//
// 目录：
//   works.ndjson   追加式作品记录（按 id 取最新）
//   images/<sha1>.<ext>  已校验的缩略图（只存小图）
//   index.json     内容哈希 → { vector, metrics, model, preprocess, at }
//   runs.ndjson    每次运行的来源统计（HTTP/条数/耗时/失败原因）
//
// 只追加、不改历史：同一个 id 多次出现时以最后一条为准，旧记录保留可追溯。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, ".rc1-audit/discovery");
const WORKS = path.join(DATA_DIR, "works.ndjson");
const RUNS = path.join(DATA_DIR, "runs.ndjson");
const INDEX = path.join(DATA_DIR, "index.json");
const IMAGES = path.join(DATA_DIR, "images");

export function ensureDirs() {
  fs.mkdirSync(IMAGES, { recursive: true });
}

export function readWorks() {
  if (!fs.existsSync(WORKS)) return [];
  const latest = new Map();
  for (const line of fs.readFileSync(WORKS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      latest.set(rec.id, rec);
    } catch { /* 坏行跳过 */ }
  }
  return [...latest.values()];
}

export function appendWorks(records) {
  if (!records.length) return;
  ensureDirs();
  fs.appendFileSync(WORKS, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export function appendRun(run) {
  ensureDirs();
  fs.appendFileSync(RUNS, JSON.stringify(run) + "\n", "utf8");
}

export function readRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readFileSync(RUNS, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function readIndex() {
  if (!fs.existsSync(INDEX)) return { model: null, preprocess: null, byHash: {} };
  try { return JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch { return { model: null, preprocess: null, byHash: {} }; }
}

export function writeIndex(doc) {
  ensureDirs();
  const tmp = INDEX + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc), "utf8");
  fs.renameSync(tmp, INDEX);
}

export function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/** 落盘一张缩略图，返回相对仓库的路径与哈希。已存在则直接复用。 */
export function saveImage(buf, contentType) {
  ensureDirs();
  const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : contentType.includes("gif") ? ".gif" : ".jpg";
  const hash = sha1(buf);
  const file = path.join(IMAGES, hash + ext);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { hash, file, rel: path.relative(ROOT, file).replace(/\\/g, "/"), ext };
}

export function imagePath(rec) {
  return rec.storedImage ? path.join(ROOT, rec.storedImage) : null;
}

export function stats() {
  const works = readWorks();
  const index = readIndex();
  const runs = readRuns();
  const byProvider = {};
  for (const w of works) byProvider[w.provider] = (byProvider[w.provider] || 0) + 1;
  return {
    works: works.length,
    byProvider,
    indexed: Object.keys(index.byHash || {}).length,
    model: index.model || null,
    runs: runs.length,
    images: fs.existsSync(IMAGES) ? fs.readdirSync(IMAGES).length : 0,
    bytesOnDisk: fs.existsSync(IMAGES) ? fs.readdirSync(IMAGES).reduce((n, f) => n + fs.statSync(path.join(IMAGES, f)).size, 0) : 0,
  };
}
