"""v0.4 视觉质量实验 · 批量嵌入

对给定图片清单，用指定视觉编码器计算 L2 归一化向量，输出 JSON。

用法：
  PYTHONPATH=<pylibs> python scripts/p416/embed.py \
      --model google/siglip-base-patch16-224 \
      --pool .rc1-audit/p416/pool.json \
      --out .rc1-audit/p416/emb-siglip-base.json \
      [--batch 8] [--limit N]

设计要点：
- 纯本地 CPU 推理，不调用任何付费服务；模型权重从 HuggingFace 公开仓库下载一次。
- 每条图片路径都做存在性检查，缺失的记录进 skipped，不静默跳过。
- 输出里写明模型、维度、许可来源与图片数，便于报告引用。
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch
from PIL import Image


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--pool", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--repo-root", default=".")
    return ap.parse_args()


def image_path_for(entry, root: Path):
    """条目 → 本地图片路径。发现库条目带 storedImage；本地档案条目走 public/assets。"""
    if entry.get("storedImage"):
        p = root / entry["storedImage"]
        if p.exists():
            return p
    eid = entry.get("id", "")
    for sub in ("artworks", "film"):
        for tier in ("preview", "detail"):
            p = root / "public" / "assets" / sub / eid / f"{tier}.webp"
            if p.exists():
                return p
    return None


def main():
    args = parse_args()
    root = Path(args.repo_root).resolve()
    pool = json.loads(Path(args.pool).read_text(encoding="utf-8"))

    from transformers import AutoModel, AutoProcessor

    t0 = time.time()
    print(f"[embed] loading {args.model} ...", flush=True)
    processor = AutoProcessor.from_pretrained(args.model)
    model = AutoModel.from_pretrained(args.model)
    model.eval()
    torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
    print(f"[embed] loaded in {time.time() - t0:.1f}s", flush=True)

    def embed_batch(paths):
        images = []
        for p in paths:
            im = Image.open(p)
            im = im.convert("RGB")
            images.append(im)
        inputs = processor(images=images, return_tensors="pt")
        with torch.no_grad():
            out = model.get_image_features(**inputs)
        # transformers 5.x 里 get_image_features 的返回形态不统一：
        # 有时是 Tensor，有时是 list/tuple，有时是 ModelOutput。
        if isinstance(out, (list, tuple)):
            out = out[0]
        if not isinstance(out, torch.Tensor):
            pooler = getattr(out, "pooler_output", None)
            hidden = getattr(out, "last_hidden_state", None)
            if pooler is not None:
                out = pooler
            elif hidden is not None:
                out = hidden[:, 0]
            else:
                raise TypeError(f"unsupported get_image_features output: {type(out)}")
        out = out.float()
        out = out / out.norm(dim=-1, keepdim=True).clamp_min(1e-8)
        return out.cpu().tolist()

    entries = [e for e in pool["entries"] if e.get("hasVector")]
    if args.limit:
        entries = entries[: args.limit]

    vectors, skipped, done = {}, [], 0
    batch_paths, batch_ids = [], []
    for e in entries:
        p = image_path_for(e, root)
        if p is None:
            skipped.append({"id": e["id"], "why": "image file not found"})
            continue
        batch_paths.append(p)
        batch_ids.append(e["id"])

    t0 = time.time()
    for i in range(0, len(batch_paths), args.batch):
        chunk, cids = batch_paths[i : i + args.batch], batch_ids[i : i + args.batch]
        try:
            vecs = embed_batch(chunk)
        except Exception as exc:  # 单批失败不影响其它批
            for cid in cids:
                skipped.append({"id": cid, "why": f"batch error: {str(exc)[:80]}"})
            continue
        for cid, v in zip(cids, vecs):
            vectors[cid] = [round(x, 6) for x in v]
        done += len(chunk)
        if (i // args.batch) % 5 == 0:
            rate = done / max(1e-6, time.time() - t0)
            eta = (len(batch_paths) - done) / max(1e-6, rate)
            print(f"[embed] {done}/{len(batch_paths)} ({rate:.1f}/s, eta {eta/60:.1f}min)", flush=True)

    dim = len(next(iter(vectors.values()))) if vectors else 0
    out = {
        "model": args.model,
        "dim": dim,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(vectors),
        "skipped": skipped,
        "seconds": round(time.time() - t0, 1),
        "vectors": vectors,
    }
    Path(args.out).write_text(json.dumps(out), encoding="utf-8")
    print(f"[embed] wrote {args.out}: {len(vectors)} vectors, dim {dim}, skipped {len(skipped)}, {out['seconds']}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
