# contact_sheet.py — 把"起点 + 候选"排成人工复核用的对照图。
#
# 不是为了好看：复核者要能在同一视野里比较构图、色彩、光影、空间关系，
# 所以起点放在最左并标注 ORIGIN，候选按返回顺序排列并标序号。

import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H = 360, 300
PAD = 18
LABEL_H = 46
BG = (245, 242, 236)
INK = (38, 36, 33)
MUTED = (122, 116, 106)
ACCENT = (138, 92, 60)


def font(size, bold=False):
    for name in (["DejaVuSans-Bold.ttf", "arialbd.ttf"] if bold else ["DejaVuSans.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except Exception:  # noqa: BLE001
            continue
    return ImageFont.load_default()


def fit(path):
    img = Image.open(path)
    img = img.convert("RGB")
    img.thumbnail((CELL_W, CELL_H - LABEL_H), Image.LANCZOS)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--cols", type=int, default=5)
    args = ap.parse_args()

    rows = json.load(open(args.inp, encoding="utf-8"))
    cols = args.cols
    row_h = CELL_H + PAD
    width = PAD + cols * (CELL_W + PAD)
    height = PAD + len(rows) * row_h
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    f_small = font(13)
    f_tag = font(12, bold=True)

    for r, row in enumerate(rows):
        y = PAD + r * row_h
        cells = [("ORIGIN", row["origin"]["label"], row["origin"]["path"], True)]
        for i, c in enumerate(row["candidates"], start=1):
            cells.append((f"#{i}", c["label"], c["path"], False))
        for c, (tag, label, p, is_origin) in enumerate(cells):
            if c >= cols:
                break
            x = PAD + c * (CELL_W + PAD)
            try:
                img = fit(p)
            except Exception:  # noqa: BLE001
                draw.rectangle([x, y, x + CELL_W, y + CELL_H - LABEL_H], outline=(200, 190, 178))
                draw.text((x + 10, y + 10), "(missing image)", font=f_small, fill=MUTED)
                continue
            canvas.paste(img, (x, y))
            bx = x
            by = y + CELL_H - LABEL_H + 6
            draw.rectangle([bx, by - 4, bx + 52, by + 14], fill=ACCENT if is_origin else (170, 162, 150))
            draw.text((bx + 6, by - 2), tag, font=f_tag, fill=(255, 255, 255))
            text = label if len(label) <= 34 else label[:33] + "…"
            draw.text((bx + 58, by - 2), text, font=f_small, fill=INK)

    canvas.save(args.out, "PNG")
    print(f"[contact-sheet] {len(rows)} 行 → {args.out}")


if __name__ == "__main__":
    main()
