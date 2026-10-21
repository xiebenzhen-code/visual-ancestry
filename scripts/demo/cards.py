# cards.py — 演示视频的首尾卡（与产品同一套视觉：米白底、衬线标题、细线）
#
# 不画假界面：卡片只放产品名、定位语与真实信息（分支 / commit / 仓库地址）。
# 界面部分全部来自真实浏览器录屏。

import argparse
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
BG = (246, 243, 237)
INK = (32, 30, 27)
MUTED = (122, 116, 106)
RULE = (206, 198, 186)
ACCENT = (138, 92, 60)


def font(names, size):
    for p in names:
        try:
            return ImageFont.truetype(p, size)
        except Exception:  # noqa: BLE001
            continue
    return ImageFont.load_default()


SERIF = ["C:/Windows/Fonts/georgia.ttf", "C:/Windows/Fonts/times.ttf"]
SANS = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]


def title_card(out):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.line([(160, 300), (W - 160, 300)], fill=RULE, width=2)
    f_name = font(SERIF, 132)
    f_sub = font(SANS, 40)
    f_small = font(SANS, 26)
    d.text((160, 360), "FRAME ATLAS", font=f_name, fill=INK)
    d.text((164, 540), "从一张图，找到它真正的视觉祖先", font=f_sub, fill=INK)
    d.text((164, 620), "VISUAL ANCESTRY · 绘画 / 电影 / 动画 三媒介检索", font=f_small, fill=MUTED)
    d.line([(160, 720), (W - 160, 720)], fill=RULE, width=1)
    d.text((164, 760), "真实馆藏 API · 本地视觉索引 · 无付费模型参与排序", font=f_small, fill=ACCENT)
    img.save(out, "JPEG", quality=92)


def closing_card(out, meta):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_name = font(SERIF, 96)
    f_sub = font(SANS, 34)
    f_small = font(SANS, 24)
    d.text((160, 300), "FRAME ATLAS", font=f_name, fill=INK)
    d.text((164, 440), "visual ancestry for images", font=f_sub, fill=MUTED)
    d.line([(160, 520), (W - 160, 520)], fill=RULE, width=1)
    y = 570
    for line in meta:
        d.text((164, y), line, font=f_small, fill=INK if y == 570 else MUTED)
        y += 46
    img.save(out, "PNG")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--kind", choices=["title", "closing"], required=True)
    ap.add_argument("--meta", nargs="*", default=[])
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    if a.kind == "title":
        title_card(a.out)
    else:
        closing_card(a.out, a.meta)
    print(f"[cards] {a.kind} → {a.out}")
