// prepareVisionImage — client-side resize/compress before the vision call.
//
// The provider only needs enough structure to classify the frame, so the
// image is downscaled (longest edge ≤ MAX_EDGE) and re-encoded as JPEG
// (quality ≈ 0.82) before it leaves the browser. The ORIGINAL file is left
// untouched for local preview — this module never modifies or persists it.
//
// Failure to decode/draw degrades to the original file (the 12MB gate in
// visionService still applies). Returns:
//   { file, width, height, srcW, srcH, skipped }
// width/height are the delivered dimensions (0 when skipped); srcW/srcH the
// original ones (0 when undecodable).

const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

export async function prepareVisionImage(file) {
  if (typeof createImageBitmap === "undefined" && typeof Image === "undefined") {
    return { file, width: 0, height: 0, srcW: 0, srcH: 0, skipped: true };
  }
  try {
    const { bitmap, srcW, srcH } = await decode(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (typeof bitmap.close === "function") bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return { file, width: w, height: h, srcW, srcH, skipped: true };
    const base = String(file.name || "image").replace(/\.[^.]+$/, "");
    const out = new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: file.lastModified || Date.now() });
    return { file: out, width: w, height: h, srcW, srcH, skipped: false };
  } catch {
    return { file, width: 0, height: 0, srcW: 0, srcH: 0, skipped: true };
  }
}

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { bitmap, srcW: bitmap.width, srcH: bitmap.height };
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ bitmap: img, srcW: img.naturalWidth, srcH: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image-decode-failed"));
    };
    img.src = url;
  });
}
