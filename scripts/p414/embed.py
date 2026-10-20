#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P4.14-D 视觉嵌入器 —— MobileCLIP-S0 (int8 ONNX, MIT License)

为什么是它：
  · 11.3 MB，CPU 可跑，无需 GPU / torch；
  · Apple ml-mobileclip 为 MIT 许可，无商用限制；
  · 视觉编码器可独立调用（不需要文本塔），正好只需要「图 → 向量」。

怎么用：
  python scripts/p414/embed.py --image <path> [--image ...]
  python scripts/p414/embed.py --manifest <json> --out <json>

  manifest: [{"id": "...", "path": "..."}]
  输出:     {"model": "...", "dim": 512, "vectors": {"<id>": [..512 floats..]}, "hashes": {"<id>": "sha256..."}}
  向量已做 L2 归一化，浏览器里直接点积就是余弦相似度。

模型不在仓库里（11 MB 二进制不进版本库）。首次运行会自动下载到 .rc1-audit/p414/models/。
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

MODEL_REPO = "Xenova/mobileclip_s0"
MODEL_FILE = "onnx/vision_model_int8.onnx"
MODEL_NAME = "mobileclip_s0_vision_int8"
UA = "VisualAncestryBot/1.0 (https://github.com/xiebenzhen-code/visual-ancestry; research use)"

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL_DIR = os.path.join(ROOT, ".rc1-audit", "p414", "models")
MODEL_PATH = os.path.join(MODEL_DIR, "vision_model_int8.onnx")

CROP = 256  # preprocessor_config.json: shortest_edge 256 + center crop 256
RESCALE = 1.0 / 255.0  # rescale_factor; do_normalize = false


def ensure_model():
    if os.path.exists(MODEL_PATH):
        return MODEL_PATH
    os.makedirs(MODEL_DIR, exist_ok=True)
    url = f"https://huggingface.co/{MODEL_REPO}/resolve/main/{MODEL_FILE}"
    print(f"[embed] 下载模型 {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(MODEL_PATH, "wb") as f:
        f.write(r.read())
    return MODEL_PATH


def preprocess(path, fit="crop"):
    """RGB → 256×256 → CHW float32（do_rescale=true，do_normalize=false）。

    fit 三种取景方式，对绘画差别很大：
      crop    中心裁切（模型自带 preprocessor_config 的默认做法）——
              竖幅画会被切掉两侧，横向构图信息直接丢失
      pad     等比缩放后居中补黑，保留整幅构图
      squash  直接拉伸成方形，最省事但会扭曲比例

    默认用 pad：这批数据是绘画，构图信息比「填满画面」更重要。
    """
    img = Image.open(path).convert("RGB")
    w, h = img.size
    if w <= 0 or h <= 0:
        raise ValueError("empty image")

    if fit == "squash":
        img = img.resize((CROP, CROP), Image.BICUBIC)
    elif fit == "crop":
        scale = CROP / min(w, h)
        nw, nh = max(CROP, int(round(w * scale))), max(CROP, int(round(h * scale)))
        img = img.resize((nw, nh), Image.BICUBIC)
        left, top = (nw - CROP) // 2, (nh - CROP) // 2
        img = img.crop((left, top, left + CROP, top + CROP))
    else:  # pad
        scale = CROP / max(w, h)
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        img = img.resize((nw, nh), Image.BICUBIC)
        canvas = Image.new("RGB", (CROP, CROP), (0, 0, 0))
        canvas.paste(img, ((CROP - nw) // 2, (CROP - nh) // 2))
        img = canvas

    arr = np.asarray(img, dtype=np.float32) * RESCALE
    return np.transpose(arr, (2, 0, 1))[None, ...]  # NCHW


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", action="append", default=[])
    ap.add_argument("--manifest")
    ap.add_argument("--out")
    ap.add_argument("--fit", choices=["pad", "crop", "squash"], default="pad")
    args = ap.parse_args()

    import onnxruntime as ort

    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(ensure_model(), sess_options=so, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    items = []
    if args.manifest:
        # Windows 上的 PowerShell 写 JSON 会带 BOM，utf-8-sig 兼容两者。
        with open(args.manifest, "r", encoding="utf-8-sig") as f:
            items = json.load(f)
    for p in args.image:
        items.append({"id": os.path.basename(p), "path": p})

    if not items:
        print("no input", file=sys.stderr)
        return 2

    vectors, hashes, errors = {}, {}, {}
    dim = None
    for it in items:
        try:
            x = preprocess(it["path"], fit=args.fit)
            y = sess.run([out_name], {input_name: x})[0]
            v = np.asarray(y, dtype=np.float32).reshape(-1)
            n = float(np.linalg.norm(v))
            if n <= 0:
                raise ValueError("zero vector")
            v = v / n  # L2 归一化：下游点积即余弦
            dim = int(v.shape[0])
            vectors[it["id"]] = [round(float(t), 6) for t in v]
            hashes[it["id"]] = sha256_file(it["path"])
        except Exception as e:  # 单张失败不影响整批，但要如实记录
            errors[it["id"]] = str(e)[:200]

    payload = {
        "model": MODEL_NAME,
        "fit": args.fit,
        "license": "MIT (Apple ml-mobileclip)",
        "dim": dim,
        "count": len(vectors),
        "vectors": vectors,
        "hashes": hashes,
        "errors": errors,
    }

    text = json.dumps(payload, ensure_ascii=False)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"[embed] {len(vectors)} 条 → {args.out} (dim={dim}, errors={len(errors)})", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
