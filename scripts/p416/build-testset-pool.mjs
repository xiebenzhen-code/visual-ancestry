// v0.4 · 独立测试集：把采集清单转成 embed.py 可吃的池格式，并做跨方向排序
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(process.argv[2] || ".");
const AUDIT = path.join(REPO, ".rc1-audit", "p416");
const manifest = JSON.parse(fs.readFileSync(path.join(AUDIT, "testset", "testset.json"), "utf8"));

const entries = [];
for (const d of manifest.directions) {
  for (const it of d.items) {
    entries.push({
      id: it.id,
      hash: it.id,
      bucket: d.dir,
      provider: "commons-testset",
      imageKind: it.visualKind,
      title: it.title,
      creator: it.artist,
      year: it.dateOriginal,
      medium: null,
      licence: it.licence,
      rightsStatus: it.usageTerms,
      sourceUrl: it.sourceUrl,
      imageUrl: "",
      storedImage: it.file,
      hasVector: true,
      dim: 0,
      metrics: null,
    });
  }
}
const pool = {
  at: new Date().toISOString(),
  note: "v0.4 独立测试集（授权合规，四个跨媒介方向）",
  indexModel: null,
  indexDim: null,
  counts: { totalEntries: entries.length },
  entries,
};
fs.writeFileSync(path.join(AUDIT, "testset-pool.json"), JSON.stringify(pool));
// 基线 embed.py（MobileCLIP ONNX）吃的是 [{id, path}] 数组
fs.writeFileSync(path.join(AUDIT, "testset-manifest.json"), JSON.stringify(entries.map((e) => ({ id: e.id, path: e.storedImage })), null, 1));
console.log("testset-pool.json:", entries.length, "entries");
for (const d of manifest.directions) {
  const kinds = {};
  const lic = {};
  for (const i of d.items) { kinds[i.visualKind] = (kinds[i.visualKind] || 0) + 1; lic[i.licence] = (lic[i.licence] || 0) + 1; }
  console.log(`  ${d.dir.padEnd(12)} ${String(d.count).padStart(2)} 件 | ${JSON.stringify(kinds)} | 许可 ${JSON.stringify(lic).slice(0, 90)}`);
}
