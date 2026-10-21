# decode.py — PoC STEP 2 的「真实解码」环节
#
# 只做三件事：下载小尺寸预览 → 用 PIL 真正解码 → 记录尺寸/字节/失败原因。
# 不下载原图（候选里有 1920px 的 detail 链，这里一律用 thumb/preview）。

import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

ROOT = os.getcwd()
POC = os.path.join(ROOT, ".rc1-audit", "poc")
THUMBS = os.path.join(POC, "thumbs")
os.makedirs(THUMBS, exist_ok=True)

CANDIDATES = os.path.join(POC, "candidates.json")
OUT = os.path.join(POC, "decoded.json")
UA = {"User-Agent": "visual-ancestry-poc/0.1 (local research)"}


def small_url(work):
    img = work.get("image") or {}
    tiers = img.get("tiers") or {}
    return tiers.get("thumb") or tiers.get("preview") or img.get("url")


def main():
    doc = json.load(open(CANDIDATES, encoding="utf-8"))
    items = doc["items"]
    results = {}
    ok = 0
    existing = {}
    if os.path.exists(OUT):
        existing = json.load(open(OUT, encoding="utf-8")).get("items", {})

    def one(work):
        key = work["dedupeKey"]
        if key in existing and existing[key].get("ok"):
            return key, existing[key], True
        url = small_url(work)
        rec = {"id": work.get("sourceId"), "source": work.get("source"), "url": url, "ok": False}
        if not url:
            rec["error"] = "no-image-url"
            return key, rec, False
        started = time.time()
        path = os.path.join(THUMBS, key.replace("/", "_").replace(":", "_")[:120] + ".img")
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=12) as r:
                raw = r.read()
            rec["bytes"] = len(raw)
            with Image.open(io.BytesIO(raw)) as im:
                im.load()
                rec["width"], rec["height"] = im.size
                rec["mode"] = im.mode
            rec["ok"] = True
            rec["path"] = os.path.relpath(path, ROOT).replace("\\", "/")
            with open(path, "wb") as f:
                f.write(raw)
        except Exception as e:  # noqa: BLE001
            rec["error"] = f"{type(e).__name__}: {str(e)[:90]}"
        rec["latencyMs"] = int((time.time() - started) * 1000)
        return key, rec, rec["ok"]

    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for key, rec, good in pool.map(one, items):
            results[key] = rec
            done += 1
            if good:
                ok += 1
            if done % 25 == 0:
                print(f"  … {done}/{len(items)} 已解码 {ok}", flush=True)

    json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "total": len(items), "decoded": ok, "items": results},
              open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"  解码完成: {ok}/{len(items)}")
    return

    for i, work in enumerate(items, 1):
        key = work["dedupeKey"]
        if key in existing and existing[key].get("ok"):
            results[key] = existing[key]
            ok += 1
            continue

        url = small_url(work)
        rec = {"id": work.get("sourceId"), "source": work.get("source"), "url": url, "ok": False}
        if not url:
            rec["error"] = "no-image-url"
            results[key] = rec
            continue

        started = time.time()
        path = os.path.join(THUMBS, key.replace("/", "_").replace(":", "_")[:120] + ".img")
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                raw = r.read()
            rec["bytes"] = len(raw)
            # 真正的解码：PIL 打开并 load 一遍像素，坏图/HTML 会在这里抛错
            with Image.open(io.BytesIO(raw)) as im:
                im.load()
                rec["width"], rec["height"] = im.size
                rec["mode"] = im.mode
            rec["ok"] = True
            rec["path"] = os.path.relpath(path, ROOT).replace("\\", "/")
            with open(path, "wb") as f:
                f.write(raw)
            ok += 1
        except Exception as e:  # noqa: BLE001
            rec["error"] = f"{type(e).__name__}: {str(e)[:90]}"
        rec["latencyMs"] = int((time.time() - started) * 1000)
        results[key] = rec

        if i % 25 == 0:
            print(f"  … {i}/{len(items)} 已解码 {ok}", flush=True)

    json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "total": len(items), "decoded": ok, "items": results},
              open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"  解码完成: {ok}/{len(items)}")


if __name__ == "__main__":
    main()
