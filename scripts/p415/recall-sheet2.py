# -*- coding: utf-8 -*-
"""recall-sheet2.py — P4.15.2 三排对照：旧 top5 / 融合 top8 / 比较集(5-6)"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, ".rc1-audit", "p415", "recall-v2.json")
OUT = os.path.join(ROOT, ".rc1-audit", "p415", "shots", "recall-v2.png")

PAPER, INK, MUTED, RULE, MAT = (243, 237, 223), (17, 17, 15), (118, 112, 103), (200, 190, 170), (227, 216, 191)
ACCENT = (124, 74, 50)
FONT, FONT_B = "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"


def font(size, bold=False):
    p = FONT_B if bold else FONT
    return ImageFont.truetype(p, size) if os.path.exists(p) else ImageFont.load_default()


def personal_map():
    m = {}
    d = os.path.join(ROOT, ".rc1-user-library", "records")
    if not os.path.isdir(d):
        return m
    for f in os.listdir(d):
        if f.endswith(".json"):
            try:
                r = json.load(open(os.path.join(d, f), encoding="utf-8"))
                if r.get("id") and r.get("storedName"):
                    m[r["id"]] = r["storedName"]
            except Exception:
                pass
    return m


PERSONAL = personal_map()


def img_path(pid):
    if pid.startswith("u-"):
        name = PERSONAL.get(pid)
        return os.path.join(ROOT, ".rc1-user-library", "images", name) if name else ""
    return os.path.join(ROOT, "public", "assets", "artworks", pid, "preview.webp")


def thumb(pid, w, h):
    box = Image.new("RGB", (w, h), MAT)
    try:
        im = Image.open(img_path(pid)).convert("RGB")
        im.thumbnail((w - 6, h - 6))
        box.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
    except Exception:
        ImageDraw.Draw(box).text((6, h // 2 - 6), "无图", font=font(11), fill=MUTED)
    return box


data = json.load(open(DATA, encoding="utf-8"))
CELL, GAP, LABEL_H, PAD = 112, 8, 32, 26
ROW_W = 8
W = PAD * 2 + ROW_W * (CELL + GAP)
H = 120
for q in data["queries"]:
    H += 30 + 3 * (CELL + LABEL_H + 8) + 54
sheet = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(sheet)
d.text((PAD, 24), "P4.15.2 候选质量：旧 top5 / 融合 top8 / 比较集", font=font(22, True), fill=INK)
d.text((PAD, 56), "第三排是下一轮真正会送进 DeepSeek 的 5–6 张。带 * 的是语义通路带回、不在融合前 5 里的候选。",
       font=font(12), fill=MUTED)
d.text((PAD, 74), f"可用语义画像：{data['semanticStats']['candidateProfiles']} 张候选 + {data['semanticStats']['queryAnalyses']} 张单图分析 + {data['semanticStats']['attributed']} 个反推查询；其余标为未分析。",
       font=font(11), fill=MUTED)

y = 104
for q in data["queries"]:
    sem = q["semantic"]
    d.text((PAD, y), f"{q['title']}（{q['id']}）", font=font(15, True), fill=INK)
    prof = "单图 V2 分析" if sem["queryProfile"].get("kind") == "single-image-analysis" else ("差异反推" if sem["queryProfile"].get("kind") == "derived-query" else "无")
    d.text((PAD + 300, y + 2), f"查询画像：{prof} · 已分析 {sem['analyzedCount']}/{sem['analyzedCount'] + sem['unanalyzedCount']} · 语义命中 {len(sem['hits'])} · 因语义进入 {len(sem['broughtIn'])}",
           font=font(11), fill=MUTED)
    y += 26

    rows = [
        ("旧 top5", [(i, None) for i in q["legacy"]]),
        ("融合 top8", [(f["id"], None) for f in q["fused"]]),
        ("比较集", [(c["id"], c["semantic"]) for c in q["compareSet"]]),
    ]
    for label, items in rows:
        d.text((PAD, y), label, font=font(11), fill=MUTED)
        x = PAD + 68
        for idx, (pid, is_sem) in enumerate(items):
            sheet.paste(thumb(pid, CELL, CELL), (x, y - 4))
            d.rectangle([x, y - 4, x + CELL - 1, y - 4 + CELL - 1], outline=RULE)
            name = pid if len(pid) <= 16 else pid[:15] + "…"
            d.text((x, y + CELL - 2), f"{idx+1}. {name}{' *' if is_sem else ''}", font=font(9), fill=ACCENT if is_sem else INK)
            x += CELL + GAP
        y += CELL + LABEL_H + 4

    d.text((PAD, y), f"未分析候选 {sem['unanalyzedCount']} 张（不参与语义路径）：{', '.join(sem['unanalyzed'][:8])}{' …' if sem['unanalyzedCount'] > 8 else ''}",
           font=font(10), fill=ACCENT)
    y += 48

os.makedirs(os.path.dirname(OUT), exist_ok=True)
sheet.save(OUT)
print("  写入", OUT, sheet.size)
