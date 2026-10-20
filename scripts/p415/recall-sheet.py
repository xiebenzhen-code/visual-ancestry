# -*- coding: utf-8 -*-
"""recall-sheet.py — 把扩大召回前后的候选渲染成对照图"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, ".rc1-audit", "p415", "recall-before-after.json")
OUT = os.path.join(ROOT, ".rc1-audit", "p415", "shots", "recall-before-after.png")

PAPER = (243, 237, 223)
INK = (17, 17, 15)
MUTED = (118, 112, 103)
RULE = (200, 190, 170)
MAT = (227, 216, 191)

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"


def font(size, bold=False):
    p = FONT_B if bold else FONT
    return ImageFont.truetype(p, size) if os.path.exists(p) else ImageFont.load_default()


def _personal_files():
    """个人条目落盘名是内容哈希，不是条目 id；这里建 id -> storedName 映射。"""
    m = {}
    d = os.path.join(ROOT, ".rc1-user-library", "records")
    if not os.path.isdir(d):
        return m
    for f in os.listdir(d):
        if not f.endswith(".json"):
            continue
        try:
            r = json.load(open(os.path.join(d, f), encoding="utf-8"))
            if r.get("id") and r.get("storedName"):
                m[r["id"]] = r["storedName"]
        except Exception:
            pass
    return m


PERSONAL = _personal_files()


def img_path(rec):
    pid = rec["id"]
    if rec.get("image", "").startswith("/api/user-media"):
        name = PERSONAL.get(pid)
        return os.path.join(ROOT, ".rc1-user-library", "images", name) if name else ""
    kind = "film" if "/film/" in rec.get("image", "") else "artworks"
    return os.path.join(ROOT, "public", "assets", kind, pid, "preview.webp")


def thumb(rec, w, h):
    box = Image.new("RGB", (w, h), MAT)
    try:
        im = Image.open(img_path(rec)).convert("RGB")
        im.thumbnail((w - 6, h - 6))
        box.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
    except Exception:
        d = ImageDraw.Draw(box)
        d.text((8, h // 2 - 6), "图片缺失", font=font(12), fill=MUTED)
    return box


data = json.load(open(DATA, encoding="utf-8"))
queries = data["queries"]

CELL = 118
GAP = 10
LABEL_H = 34
ROW_H = CELL + LABEL_H
PAD = 28
W = PAD * 2 + 8 * (CELL + GAP)
H = 96 + len(queries) * (ROW_H * 2 + 56) + 40

sheet = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(sheet)
d.text((PAD, 26), "扩召回前后：实际候选清单", font=font(24, True), fill=INK)
d.text((PAD, 60), "上排＝旧单路 top5（MobileCLIP 向量＋结构融合）；下排＝多路融合 top8。标 * 表示被两路以上命中。",
       font=font(12), fill=MUTED)

y = 100
for q in queries:
    d.text((PAD, y), f"查询：{q['query']['title']}（{q['id']}）", font=font(15, True), fill=INK)
    d.text((PAD + 420, y + 2), q.get("why", ""), font=font(11), fill=MUTED)
    y += 26

    for label, key, mark in [("之前 top5", "before", False), ("之后 top8", "after", True)]:
        d.text((PAD, y), label, font=font(11), fill=MUTED)
        x = PAD + 74
        for rec in q[key]:
            sheet.paste(thumb(rec, CELL, CELL), (x, y - 6))
            d.rectangle([x, y - 6, x + CELL - 1, y - 6 + CELL - 1], outline=RULE)
            name = rec["id"] if len(rec["id"]) <= 18 else rec["id"][:17] + "…"
            suffix = ""
            if mark and rec.get("multiPath"):
                suffix = " *"
            if mark and rec.get("vectorTwinOf"):
                suffix += " ≈"
            d.text((x, y + CELL - 2), f"{rec['rank']}. {name}{suffix}", font=font(9), fill=INK)
            x += CELL + GAP
        y += ROW_H + 6

    gained = q.get("gained", [])
    lost = q.get("lost", [])
    d.text((PAD, y), f"新增 {len(gained)}：{', '.join(gained) or '—'}", font=font(10), fill=(124, 74, 50))
    d.text((PAD, y + 15), f"掉出 {len(lost)}：{', '.join(lost) or '—'}", font=font(10), fill=(124, 74, 50))
    y += 52

os.makedirs(os.path.dirname(OUT), exist_ok=True)
sheet.save(OUT)
print("  写入", OUT, sheet.size)
