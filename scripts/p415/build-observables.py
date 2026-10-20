# -*- coding: utf-8 -*-
"""build-observables.py — 生成「可观察特征」表（P4.15.1 第三条召回路径）

为什么不用模型：这一轮禁止付费调用，而 V2 语义分析只对少数图片有缓存。
所以这里用**确定性的像素测量**作为可观察语义的替代：明度、对比、饱和、
冷暖、上下/左右分区明度、边缘密度、左右对称度。它们能从图片本身算出来，
可复现、可核对，不含任何主观标签。

输出：experiment/p415/observables.json
"""

import json
import os
import math
from PIL import Image, ImageFilter, ImageStat

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "experiment", "p415", "observables.json")

ART_DIR = os.path.join(ROOT, "public", "assets", "artworks")
FILM_DIR = os.path.join(ROOT, "public", "assets", "film")
SIZE = 96


def hue_bucket(r, g, b):
    """主色调归到可读色族。用 HSV 判色相，饱和度过低则视为中性。"""
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == mn:
        return "neutral"
    if mx - mn < 26:
        return "neutral"
    h = 0
    if mx == r:
        h = (60 * ((g - b) / (mx - mn)) + 360) % 360
    elif mx == g:
        h = 60 * ((b - r) / (mx - mn)) + 120
    else:
        h = 60 * ((r - g) / (mx - mn)) + 240
    if h < 18 or h >= 330:
        return "red"
    if h < 45:
        return "orange"
    if h < 70:
        return "yellow"
    if h < 165:
        return "green"
    if h < 200:
        return "cyan"
    if h < 260:
        return "blue"
    if h < 330:
        return "purple"


def analyze(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    small = im.resize((SIZE, SIZE), Image.LANCZOS)

    gray = small.convert("L")
    stat = ImageStat.Stat(gray)
    mean_lum = stat.mean[0] / 255.0
    std_lum = stat.stddev[0] / 255.0

    hsv = small.convert("HSV")
    sat_stat = ImageStat.Stat(hsv.split()[1])
    mean_sat = sat_stat.mean[0] / 255.0

    # 分区明度（构图重量）
    def region_mean(box):
        return ImageStat.Stat(gray.crop(box)).mean[0] / 255.0

    third = SIZE // 3
    lum_top = region_mean((0, 0, SIZE, third))
    lum_mid = region_mean((0, third, SIZE, third * 2))
    lum_bottom = region_mean((0, third * 2, SIZE, SIZE))
    lum_left = region_mean((0, 0, third, SIZE))
    lum_center = region_mean((third, 0, third * 2, SIZE))
    lum_right = region_mean((third * 2, 0, SIZE, SIZE))

    # 边缘密度：细笔触/建筑线条/纹理多的画面高
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edge_density = ImageStat.Stat(edges).mean[0] / 255.0

    # 左右对称度：0=完全对称，越大越不对称
    left = gray.crop((0, 0, SIZE // 2, SIZE))
    right = gray.crop((SIZE // 2, 0, SIZE, SIZE)).transpose(Image.FLIP_LEFT_RIGHT)
    diff = ImageStat.Stat(Image.eval(Image.blend(left, right, 0.5), lambda v: v)).mean[0]
    # 用两半逐像素差更直接
    import numpy as np
    la = np.asarray(left, dtype=np.float32)
    ra = np.asarray(right, dtype=np.float32)
    asym = float(np.abs(la - ra).mean() / 255.0)

    rgb = ImageStat.Stat(small).mean
    r, g, b = rgb[0], rgb[1], rgb[2]
    warmth_v = (r - b) / 255.0
    warmth = "warm" if warmth_v > 0.05 else "cool" if warmth_v < -0.05 else "neutral"

    return {
        "width": w, "height": h,
        "aspect": round(w / h, 3),
        "meanLum": round(mean_lum, 4),
        "contrast": round(std_lum, 4),
        "meanSat": round(mean_sat, 4),
        "warmth": warmth,
        "warmthValue": round(warmth_v, 4),
        "hue": hue_bucket(r, g, b),
        "lumTop": round(lum_top, 4),
        "lumMid": round(lum_mid, 4),
        "lumBottom": round(lum_bottom, 4),
        "lumLeft": round(lum_left, 4),
        "lumCenter": round(lum_center, 4),
        "lumRight": round(lum_right, 4),
        "edgeDensity": round(edge_density, 4),
        "asymmetry": round(asym, 4),
    }


def collect(dir_path, kind):
    out = {}
    if not os.path.isdir(dir_path):
        return out
    for name in sorted(os.listdir(dir_path)):
        p = os.path.join(dir_path, name, "preview.webp")
        if not os.path.exists(p):
            continue
        try:
            out[name] = {"kind": kind, **analyze(p)}
        except Exception as e:  # 单张坏图不影响整表
            print("  skip", name, e)
    return out


def main():
    data = {"format": 1, "generatedBy": "scripts/p415/build-observables.py", "size": SIZE, "entries": {}}
    data["entries"].update(collect(ART_DIR, "artwork"))
    data["entries"].update(collect(FILM_DIR, "film"))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    n = len(data["entries"])
    print(f"  写入 {OUT}")
    print(f"  条目 {n}（绘画/影片共 {n}）")


if __name__ == "__main__":
    main()
