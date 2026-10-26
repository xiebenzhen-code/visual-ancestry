"""v0.4 视觉质量实验 · 盲评对照图生成

为每个「查询 × 目标媒介」生成一张对照图：
  左侧 = 查询图；右侧 = 各方法 Top-K 候选的并集（去重），每格标注
  「方法排名」缩写（M=mobileclip, S=siglip-base, C=clip-large, H=hybrid）。
不含任何自动评分或提示语——判定由人看图给出。
"""
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(sys.argv[1]).resolve()
AUDIT = REPO / ".rc1-audit" / "p416"
OUT = AUDIT / "sheets"
OUT.mkdir(parents=True, exist_ok=True)

pool = json.loads((AUDIT / "pool.json").read_text(encoding="utf-8"))
ranks = json.loads((AUDIT / "ranks.json").read_text(encoding="utf-8"))
by_id = {e["id"]: e for e in pool["entries"]}

CELL = int(os.environ.get("P416_CELL", "190"))
LABEL_H = 18
QUERY_W = int(os.environ.get("P416_QUERY_W", "300"))


def img_path(entry):
    if entry.get("storedImage"):
        p = REPO / entry["storedImage"]
        if p.exists():
            return p
    eid = entry.get("id", "")
    for sub in ("artworks", "film"):
        for tier in ("preview", "detail"):
            p = REPO / "public" / "assets" / sub / eid / f"{tier}.webp"
            if p.exists():
                return p
    return None


def fit(im, size):
    im = im.convert("RGB")
    im.thumbnail((size, size))
    canvas = Image.new("RGB", (size, size), (18, 18, 20))
    canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
    return canvas


summary = []
for r in ranks["results"]:
    q = by_id[r["queryId"]]
    qp = img_path(q)
    # 各方法排名 → 候选并集。
    # 只取每个方法的 Top-5（评价口径就是 Top-5），并按方法轮流放入，
    # 否则先遍历的方法会把并集占满，其它方法的候选根本没被看到。
    order, marks = [], {}
    method_order = ["mobileclip", "siglip-base", "clip-large", "hybrid"]
    per_method = {name: m for name, m in r["methods"].items()}
    max_len = max((len(m.get("items", [])) + len(m.get("hybridItems", [])) for m in per_method.values()), default=0)
    for rank in range(max_len):
        for name in method_order:
            m = per_method.get(name)
            if not m:
                continue
            pool = m.get("items", []) + m.get("hybridItems", [])
            if rank >= len(pool):
                continue
            key = pool[rank]["id"]
            tag = {"mobileclip": "M", "siglip-base": "S", "clip-large": "C", "hybrid": "H"}.get(name, name[0].upper())
            if key not in marks:
                marks[key] = []
                order.append(key)
            marks[key].append(f"{tag}{rank + 1}")
    order = order[:16]

    cols = 4
    rows = (len(order) + cols - 1) // cols
    W = QUERY_W + cols * CELL + 20
    H = max(QUERY_W, rows * (CELL + LABEL_H) + 40)
    sheet = Image.new("RGB", (W, H), (245, 245, 247))
    d = ImageDraw.Draw(sheet)
    d.text((10, 8), f"{r['path']}  |  {r['queryLabel']}  |  target pool {r['targetPoolSize']}", fill=(20, 20, 20))

    if qp:
        sheet.paste(fit(Image.open(qp), QUERY_W - 20), (10, 34))
    d.text((10, 34 + QUERY_W - 20), "QUERY", fill=(60, 60, 60))

    for i, cid in enumerate(order):
        e = by_id[cid]
        p = img_path(e)
        x = QUERY_W + 10 + (i % cols) * CELL
        y = 34 + (i // cols) * (CELL + LABEL_H)
        if p:
            sheet.paste(fit(Image.open(p), CELL - 8), (x + 4, y))
        else:
            d.rectangle([x + 4, y, x + CELL - 4, y + CELL - 8], fill=(60, 60, 60))
        d.text((x + 5, y + CELL - 6), f"{chr(65 + i)} {'/'.join(marks[cid])[:26]}", fill=(15, 15, 15))
    name = f"{r['path'].replace('→', '_to_')}__{r['queryId']}.png".replace(" ", "_")
    sheet.save(OUT / name)
    summary.append({
        "sheet": name,
        "path": r["path"],
        "queryId": r["queryId"],
        "queryLabel": r["queryLabel"],
        "candidates": [{"label": chr(65 + i), "id": cid, "title": by_id[cid]["title"], "marks": marks[cid]} for i, cid in enumerate(order)],
    })
    print("sheet:", name, "candidates:", len(order))

(AUDIT / "sheets.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
print("wrote", AUDIT / "sheets.json")
