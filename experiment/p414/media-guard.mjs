// media-guard.mjs — P4.15 STEP 1：导入时用「实际图片」校验分类
//
// 起因（实测）：个人图库里那条被标成 film/animation 的记录，图片字节与
// public/assets/artworks/birth-of-venus/preview.webp **完全相同**。也就是说
// 「选动画出现《维纳斯的诞生》」不是筛选写错——筛选忠实执行了记录里的字段，
// 是记录本身就错了：导入时只信用户下拉框，从不看图片。
//
// 这里做两件不需要识图模型就能确定的事：
//   1. 内容哈希命中已知馆藏/影片 → 直接继承那张图真实媒介，记录里写明证据。
//   2. 声明自相矛盾（绘画却说自己是动画帧）→ 拒绝导入，不落一条错记录。
//
// 这不替代 STEP 2 的视觉理解，只负责「分类字段不许凭空自报」。

import fs from "node:fs";
import path from "node:path";
import { sha256, sniffImage } from "./library-store.mjs";
import { describeMedia } from "../../src/services/source/mediaTaxonomy.js";

/** 冲突与拒绝的机器码，前端据此给人话。 */
export const GUARD_ERRORS = Object.freeze({
  CONFLICT: "classification-conflict",
  NOT_IMAGE: "not-an-image",
});

const IMAGE_FILES = ["preview.webp", "detail.webp"];

let cachedIndex = null;
let cachedRoot = null;

/**
 * 扫描本地基础图库，建立 内容哈希 → 真实媒介 的索引。
 * 只在首次导入时建一次（几十个文件，几十毫秒），失败不算致命。
 */
export function baseHashIndex(root) {
  if (cachedIndex && cachedRoot === root) return cachedIndex;
  const index = new Map();
  const scan = (dir, kind) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const f of IMAGE_FILES) {
        const p = path.join(dir, e.name, f);
        let buf;
        try { buf = fs.readFileSync(p); } catch { continue; }
        if (!sniffImage(buf)) continue;
        index.set(sha256(buf), { id: e.name, kind, file: f });
      }
    }
  };
  scan(path.join(root, "public/assets/artworks"), "artwork");
  scan(path.join(root, "public/assets/film"), "film");
  cachedIndex = index;
  cachedRoot = root;
  return index;
}

/** 基础馆藏的真实 tradition（绘画才有），用来补齐被覆盖的分类。 */
let cachedTradition = null;
export async function baseTraditionMap() {
  if (cachedTradition) return cachedTradition;
  const map = new Map();
  try {
    const mod = await import("../../src/data/artworks.js");
    for (const a of mod.artworks || []) {
      // 不能读 a.tradition：作品记录里没有这个字段，流派存在 traditions 数组里。
      // 用 describeMedia 推导，与库条目上的 media.tradition 同一口径。
      if (a && a.id) map.set(a.id, describeMedia(a).tradition || null);
    }
  } catch {
    // 数据文件读不到不是致命问题：tradition 留空，媒介判断照样成立。
  }
  cachedTradition = map;
  return map;
}

/**
 * 校验并（必要时）改写导入条目的媒介。
 *
 * @param {{buffer:Buffer, declared:object, root:string}} input
 * @returns {Promise<{ok:true, media:object, evidence:string|null, note:string|null}
 *                  | {ok:false, error:string, detail:string}>}
 */
export async function deriveMedia({ buffer, declared = {}, root }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, error: GUARD_ERRORS.NOT_IMAGE, detail: "空文件" };
  }
  if (!sniffImage(buffer)) {
    return { ok: false, error: GUARD_ERRORS.NOT_IMAGE, detail: "不是 JPG / PNG / WebP" };
  }

  const medium = declared.medium === "film" ? "film" : "artwork";
  const visualForm = declared.visualForm || (medium === "film" ? "live-action" : "still-image");
  const tradition = declared.tradition || null;

  // 1) 自相矛盾：绘画不可能是动画帧，反过来也一样。
  //    这类声明一旦落库，就会在「动画」档里冒出一幅古典绘画。
  if (medium === "artwork" && visualForm === "animation") {
    return {
      ok: false,
      error: GUARD_ERRORS.CONFLICT,
      detail: "声明为绘画，却同时被标成动画帧；请确认这张图到底属于哪一类",
    };
  }

  // 2) 内容哈希命中已知条目 → 以图片为准
  const hit = baseHashIndex(root).get(sha256(buffer));
  if (hit) {
    const traditions = await baseTraditionMap();
    const real =
      hit.kind === "film"
        ? { medium: "film", visualForm: "live-action", tradition: null, imageKind: "frame" }
        : {
            medium: "artwork",
            visualForm: "still-image",
            tradition: traditions.get(hit.id) || null,
            imageKind: "artwork-reproduction",
          };
    const same =
      real.medium === medium &&
      real.visualForm === visualForm &&
      (real.tradition || null) === (tradition || null);
    return {
      ok: true,
      media: real,
      evidence: `base-image:${hit.id}`,
      note: same
        ? null
        : `这张图与馆藏「${hit.id}」是同一份文件，已按馆藏归类为${real.medium === "film" ? "影片" : "绘画"}`,
    };
  }

  // 3) anime 是 animation 的子类，不能脱离 animation 单独成立
  const normalizedForm = tradition === "anime" ? "animation" : visualForm;

  return {
    ok: true,
    media: {
      medium,
      visualForm: normalizedForm,
      tradition,
      imageKind: declared.imageKind || (medium === "film" ? "frame" : "artwork-reproduction"),
    },
    evidence: null,
    note: normalizedForm !== visualForm ? "tradition=anime 已按要求归入动画" : null,
  };
}
