// 生成全量色彩/材质签名索引（离线、确定性、面向 183 个 webp）
// 只读 public/assets，输出 JSON 到 src/data/。
import fs from "node:fs";
import path from "node:path";
import { analyzeImageSignature } from "../src/services/retrieval/colorSignature.js";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "src", "data", "color-signatures.json");

const collect = (baseDir, kind) => {
  const root = path.join(ROOT, baseDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, kind, detail: path.join(root, d.name, "detail.webp") }))
    .filter((x) => fs.existsSync(x.detail));
};

const items = [...collect("public/assets/artworks", "artwork"), ...collect("public/assets/film", "film")];
console.log(`found ${items.length} asset dirs with detail.webp`);

const out = { generatedAt: new Date().toISOString(), method: "deterministic-local-pixel", count: 0, signatures: {} };
let ok = 0, failed = 0;
const t0 = Date.now();
for (const it of items) {
  const sig = await analyzeImageSignature(it.detail);
  if (!sig.ok) {
    failed++;
    out.signatures[it.id] = { ok: false, kind: it.kind, reason: sig.reason };
    console.log(`  SKIP ${it.id}: ${sig.reason}`);
    continue;
  }
  ok++;
  out.signatures[it.id] = { ok: true, kind: it.kind, ...sig };
}
out.count = ok;
out.failed = failed;
const ms = Date.now() - t0;
out.buildMs = ms;

fs.writeFileSync(OUT, JSON.stringify(out, null, 0), "utf8");
console.log(`\nindexed ${ok} ok, ${failed} failed in ${ms} ms (${(ms / items.length).toFixed(0)} ms/item)`);
console.log(`-> ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
