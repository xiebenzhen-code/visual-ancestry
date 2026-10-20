// library-store.mjs — P4.14-E 个人参考图库的本地存储
//
// 设计取舍（对应 STEP 2/3 的要求）：
//   · 一图一 sidecar JSON + 一个清单，不用 SQLite —— 这是一台机器上的小工具，
//     加一个原生依赖换不到什么，反而让「重启后还在」变得难验证。
//   · 写入一律「先写临时文件再 rename」——rename 在同一个卷上原子，半写状态不会
//     变成一条看似正常的记录。
//   · 内容哈希用**原始字节**的 sha256。为什么不哈希解码后像素：解码器版本一变
//     哈希就变，等于把「同一张图」判成两张；而原始字节稳定、便宜、可复算。
//   · 版本指纹写进每条记录。模型、维度、预处理任一变化，旧向量标记为 stale，
//     检索时跳过并提示重建，**不静默混用**。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LIBRARY_FORMAT = 1;

/** 向量版本指纹。任一不一致，旧向量不可用于检索。 */
export const VECTOR_FINGERPRINT = Object.freeze({
  model: "mobileclip_s0_vision_int8",
  fit: "pad",
  dim: 512,
  // 预处理语义版本：改了 resize/crop/normalize 就要加一
  preproc: 1,
});

export function fingerprintKey(fp = VECTOR_FINGERPRINT) {
  return `${fp.model}|${fp.fit}|${fp.dim}|${fp.preproc}`;
}

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** magic bytes → 真实类型。扩展名只是提示，不算证据。 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Windows 保留名 + 路径分隔符，一律不允许成为文件名的一部分。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function isSafeName(name) {
  if (typeof name !== "string" || !name) return false;
  if (name.length > 200) return false;
  if (/[\\/:*?"<>|]/.test(name)) return false;
  if (name.includes("..")) return false;
  if (RESERVED.test(name)) return false;
  return true;
}

export class LibraryStore {
  /**
   * @param {string} rootDir 用户数据目录（应被 .gitignore 覆盖）
   */
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
    this.imagesDir = path.join(this.root, "images");
    this.recordsDir = path.join(this.root, "records");
    this.fs = fs;
    this._ensure();
  }

  _ensure() {
    fs.mkdirSync(this.imagesDir, { recursive: true });
    fs.mkdirSync(this.recordsDir, { recursive: true });
  }

  /** 原子写：同目录临时文件 + rename。失败不会留下半条记录。 */
  _atomicWrite(absPath, data) {
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, absPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

  _recordPath(id) {
    if (!isSafeName(`${id}.json`)) throw new Error("unsafe-id");
    return path.join(this.recordsDir, `${id}.json`);
  }

  _imagePath(storedName) {
    if (!isSafeName(storedName)) throw new Error("unsafe-name");
    const abs = path.join(this.imagesDir, storedName);
    if (!abs.startsWith(this.imagesDir + path.sep)) throw new Error("path-escape");
    return abs;
  }

  /** 读全部记录。单条损坏只跳过那一条，不影响整库。 */
  list() {
    const out = [];
    const broken = [];
    let names = [];
    try { names = fs.readdirSync(this.recordsDir); } catch { return { items: out, broken }; }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.recordsDir, n), "utf8"));
        if (!rec || !rec.id) throw new Error("missing id");
        out.push(rec);
      } catch (e) {
        broken.push({ file: n, error: String(e.message).slice(0, 120) });
      }
    }
    return { items: out, broken };
  }

  findByHash(hash) {
    return this.list().items.find((r) => r.hash === hash) || null;
  }

  findById(id) {
    try {
      const p = this._recordPath(id);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { return null; }
  }

  /**
   * 导入一张图。**已存在同一内容哈希时直接返回旧记录，不重复算向量。**
   *
   * @param {object} input
   * @param {Buffer} input.buffer 原始字节
   * @param {string} input.fileName 用户给的名字（只用于显示与扩展名提示）
   * @param {object} input.meta {title, creator, year, medium, visualForm, tradition, sourcePageURL, sourceNote}
   * @param {(absPath:string)=>Promise<{vector:number[], model:string, fit:string, dim:number}>} input.embed
   */
  async import(input) {
    const { buffer, fileName, meta, embed } = input;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("empty-file");

    const kind = sniffImage(buffer);
    if (!kind) throw new Error("not-an-image");

    const hash = sha256(buffer);
    const existing = this.findByHash(hash);
    if (existing) return { deduped: true, record: existing };

    const ext = kind === "jpeg" ? ".jpg" : `.${kind}`;
    if (!ALLOWED_EXT.has(ext)) throw new Error("unsupported-type");

    const storedName = `${hash}${ext}`;
    const absImage = this._imagePath(storedName);

    // 先落盘图片，再算向量，最后写记录。顺序保证「有记录就一定有图」。
    this._atomicWrite(absImage, buffer);

    const embedded = await embed(absImage);
    if (!embedded || !Array.isArray(embedded.vector)) throw new Error("embed-failed");

    const id = `u-${hash.slice(0, 16)}`;
    const rec = {
      format: LIBRARY_FORMAT,
      id,
      hash,
      storedName,
      originalName: isSafeName(fileName) ? fileName : `image${ext}`,
      bytes: buffer.length,
      width: embedded.width ?? null,
      height: embedded.height ?? null,
      media: {
        medium: meta?.medium === "film" ? "film" : "artwork",
        visualForm: meta?.visualForm || (meta?.medium === "film" ? "live-action" : "still-image"),
        tradition: meta?.tradition || null,
        imageKind: meta?.imageKind || (meta?.medium === "film" ? "frame" : "artwork-reproduction"),
      },
      originalWork: {
        title: meta?.title || null,
        creator: meta?.creator || null,
        year: meta?.year || null,
      },
      source: {
        pageURL: meta?.sourcePageURL || null,
        note: meta?.sourceNote || null,
        importedAt: new Date().toISOString(),
      },
      vector: {
        values: embedded.vector.map((x) => Math.round(x * 1e6) / 1e6),
        fingerprint: fingerprintKey(),
        model: embedded.model || VECTOR_FINGERPRINT.model,
        fit: embedded.fit || VECTOR_FINGERPRINT.fit,
        dim: embedded.dim || VECTOR_FINGERPRINT.dim,
      },
    };

    this._atomicWrite(this._recordPath(id), JSON.stringify(rec));
    return { deduped: false, record: rec };
  }

  /** 删除：先删记录再删图。留着孤儿图比留着孤儿记录安全。 */
  remove(id) {
    const rec = this.findById(id);
    if (!rec) return { removed: false };
    try { fs.unlinkSync(this._recordPath(id)); } catch {}
    try {
      const p = this._imagePath(rec.storedName);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
    return { removed: true, record: rec };
  }

  /** 图片文件绝对路径（用于 /api/user-media/:id 只读回传）。 */
  imagePathFor(id) {
    const rec = this.findById(id);
    if (!rec) return null;
    try {
      const p = this._imagePath(rec.storedName);
      return fs.existsSync(p) ? p : null;
    } catch { return null; }
  }

  /**
   * 统计与陈旧度。stale 表示「有向量但版本对不上」，检索时应跳过并提示重建。
   */
  stats() {
    const { items, broken } = this.list();
    const current = fingerprintKey();
    let stale = 0, usable = 0;
    const byForm = {};
    for (const r of items) {
      if (r.vector && r.vector.fingerprint === current) usable++;
      else stale++;
      const f = r.media?.visualForm || "unknown";
      byForm[f] = (byForm[f] || 0) + 1;
    }
    return {
      total: items.length,
      usable,
      stale,
      broken,
      byVisualForm: byForm,
      fingerprint: current,
    };
  }

  /** 只返回可用于检索的条目（版本一致）。 */
  usableItems() {
    const current = fingerprintKey();
    return this.list().items.filter((r) => r.vector && r.vector.fingerprint === current);
  }
}
