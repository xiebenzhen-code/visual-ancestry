# measure.py — 采集索引的像素特征（与 MobileCLIP 向量同批算）
#
# 为什么需要：探索分支的"换构图""局部视觉语言"依赖像素特征
# （画幅、明度重心、不对称度、饱和度、对比度）。远端图片没有这些，
# 就参与不了分支——Phase 1 的数据断点就在这里。
#
# 口径与 scripts/p415/build-observables.py 一致：灰度 0-1、饱和度 0-1。

import argparse
import io
import json
import os

import numpy as np
from PIL import Image


def metrics_for(path):
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        small = im.resize((128, 128))
        arr = np.asarray(small, dtype=np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    top = float(lum[:42].mean())
    mid = float(lum[42:86].mean())
    bottom = float(lum[86:].mean())
    left = float(lum[:, :64].mean())
    right = float(lum[:, 64:].mean())
    # 不对称度：左右翻折后的平均绝对差
    asym = float(np.abs(lum - lum[:, ::-1]).mean())
    return {
        "width": w,
        "height": h,
        "aspect": round(w / h, 4),
        "meanLum": round(float(lum.mean()), 4),
        "contrast": round(float(lum.std()), 4),
        "meanSat": round(float(sat.mean()), 4),
        "warmthValue": round(float(r.mean() - b.mean()), 4),
        "warmth": "warm" if float(r.mean() - b.mean()) > 0.05 else ("cool" if float(r.mean() - b.mean()) < -0.05 else "neutral"),
        "lumTop": round(top, 4),
        "lumMid": round(mid, 4),
        "lumBottom": round(bottom, 4),
        "lumLeft": round(left, 4),
        "lumRight": round(right, 4),
        "asymmetry": round(asym, 4),
        "edgeDensity": round(float(np.abs(np.diff(lum, axis=1)).mean()), 4),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    items = json.load(open(args.manifest, encoding="utf-8"))
    metrics, errors = {}, {}
    for it in items:
        try:
            metrics[it["id"]] = metrics_for(it["path"])
        except Exception as e:  # noqa: BLE001
            errors[it["id"]] = f"{type(e).__name__}: {e}"
    json.dump({"count": len(metrics), "metrics": metrics, "errors": errors}, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[measure] {len(metrics)} 张 → {args.out}（失败 {len(errors)}）")


if __name__ == "__main__":
    main()
