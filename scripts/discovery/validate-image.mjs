// validate-image.mjs — 图片真实可用的唯一判据。
//
// 只做三件事：取缩略图 → 检查 Content-Type/大小 → 读头部尺寸并（可选）整幅解码。
// 不解码就进索引的图，会让 MobileCLIP 产出无意义向量——这一步不是可选项。

import { getImage } from "./http.mjs";

/** 从字节头解析尺寸，不依赖任何图像库。失败返回 null。 */
export function dimensionsOf(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  // GIF
  if (buf.slice(0, 3).toString() === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
  }
  // WebP (VP8X / VP8 / VP8L)
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
    const kind = buf.slice(12, 16).toString();
    if (kind === "VP8X") {
      const w = 1 + (buf.readUIntLE(24, 3) & 0xffffff);
      const h = 1 + (buf.readUIntLE(27, 3) & 0xffffff);
      return { width: w, height: h, format: "webp" };
    }
    if (kind === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: "webp" };
    }
    if (kind === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: "webp" };
    }
  }
  // JPEG：扫 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: "jpeg" };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * 校验一张远程图。返回 { ok, bytes, contentType, width, height, error }。
 * 保存原图字节由调用方决定（store 负责落盘 + 哈希）。
 */
export async function validateImage(url, { minSide = 200 } = {}) {
  try {
    const { bytes, contentType } = await getImage(url);
    const dims = dimensionsOf(bytes);
    if (!dims || !dims.width || !dims.height) {
      return { ok: false, error: `无法解析尺寸（${contentType}）`, bytes: null };
    }
    if (Math.min(dims.width, dims.height) < minSide) {
      return { ok: false, error: `尺寸过小 ${dims.width}x${dims.height}`, bytes: null };
    }
    return { ok: true, bytes, contentType, width: dims.width, height: dims.height, format: dims.format };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 120), bytes: null };
  }
}
