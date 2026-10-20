// analysis-cache.mjs — P4.15 STEP 3/5：候选与查询的视觉分析缓存
//
// 为什么要缓存：一次「查询图 + 候选图」的比较多图调用比单图贵得多，
// 同一张图在同一模型、同一提示版本下反复分析是纯浪费。
//
// 键 = 图片内容哈希 + 模型 ID + 提示版本。三者任一变化就必须重算，
// 绝不拿旧结果冒充新模型的分析。
//
// 落盘：一图一 sidecar，先写临时文件再 rename。与 library-store 同一套取舍。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CACHE_FORMAT = 1;

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 缓存键。顺序固定，避免同一输入产生两个键。 */
export function cacheKey(buffer, { model, promptVersion }) {
  return `${sha256(buffer)}|${model || "unknown"}|${promptVersion || "v0"}`;
}

export class AnalysisCache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _path(key) {
    const safe = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
    return path.join(this.dir, `${safe}.json`);
  }

  get(key) {
    const p = this._path(key);
    try {
      const rec = JSON.parse(fs.readFileSync(p, "utf8"));
      if (rec.format !== CACHE_FORMAT || rec.key !== key) return null;
      return rec;
    } catch {
      return null;
    }
  }

  put(key, { kind, model, promptVersion, payload, imageHash, meta }) {
    const p = this._path(key);
    const rec = {
      format: CACHE_FORMAT,
      key,
      kind,
      model,
      promptVersion,
      imageHash: imageHash || key.split("|")[0],
      createdAt: new Date().toISOString(),
      meta: meta || {},
      payload,
    };
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(rec), "utf8");
    fs.renameSync(tmp, p);
    return rec;
  }

  stats() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")); } catch { return { entries: 0, bytes: 0 }; }
    let bytes = 0;
    for (const f of files) {
      try { bytes += fs.statSync(path.join(this.dir, f)).size; } catch { /* 读不到就跳过 */ }
    }
    return { entries: files.length, bytes };
  }
}

/**
 * 取缓存，没有就算一次并写入。失败不写入缓存 —— 一次失败的调用不该被
 * 当成「这张图就是这样」永久记住。
 */
export async function cachedAnalysis({ cache, key, kind, model, promptVersion, imageHash, compute }) {
  const hit = cache.get(key);
  if (hit) return { hit: true, payload: hit.payload, createdAt: hit.createdAt };

  const result = await compute();
  if (!result || !result.ok) return { hit: false, error: result?.error || "compute-failed", detail: result?.detail };

  cache.put(key, { kind, model, promptVersion, imageHash, payload: result });
  return { hit: false, payload: result, createdAt: new Date().toISOString() };
}
