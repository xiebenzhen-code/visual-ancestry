// v0.4 独立测试集 · 跨方向排序对比
//
// 每个方向里的每一张都作为查询，目标为**另一个方向**的全部图片。
// 输出每个方法的 Top-5，并计算方法间 Top-5 一致率（客观指标，不替代人工判定）。
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(process.argv[2] || ".");
const AUDIT = path.join(REPO, ".rc1-audit", "p416");

const pool = JSON.parse(fs.readFileSync(path.join(AUDIT, "testset-pool.json"), "utf8"));
const models = {};
for (const f of fs.readdirSync(AUDIT)) {
  if (!f.startsWith("emb-testset-") || !f.endsWith(".json")) continue;
  const name = f.replace("emb-testset-", "").replace(".json", "");
  const j = JSON.parse(fs.readFileSync(path.join(AUDIT, f), "utf8"));
  if (j.vectors && Object.keys(j.vectors).length) models[name] = j.vectors;
}
if (!Object.keys(models).length) { console.log("no testset embeddings yet"); process.exit(0); }

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const byDir = {};
for (const e of pool.entries) (byDir[e.bucket] ||= []).push(e);
const dirs = Object.keys(byDir);

const results = [];
for (const qd of dirs) {
  for (const td of dirs) {
    if (qd === td) continue;
    for (const q of byDir[qd]) {
      const perMethod = {};
      for (const [name, vecs] of Object.entries(models)) {
        const qv = vecs[q.id];
        if (!qv) { perMethod[name] = { note: "query vector missing", items: [] }; continue; }
        const scored = byDir[td]
          .filter((c) => vecs[c.id])
          .map((c) => ({ id: c.id, title: c.title, licence: c.licence, visualKind: c.imageKind, cos: Number(cos(qv, vecs[c.id]).toFixed(4)) }))
          .sort((a, b) => b.cos - a.cos);
        perMethod[name] = { items: scored.slice(0, 5), poolSize: scored.length };
      }
      results.push({ queryDir: qd, targetDir: td, queryId: q.id, queryTitle: q.title, methods: perMethod });
    }
  }
}

// 方法间 Top-5 一致率（Jaccard）
const agreement = {};
const names = Object.keys(models);
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    let same = 0, tot = 0;
    for (const r of results) {
      const a = (r.methods[names[i]]?.items || []).map((x) => x.id);
      const b = (r.methods[names[j]]?.items || []).map((x) => x.id);
      if (!a.length || !b.length) continue;
      tot++;
      if (a.filter((x) => b.includes(x)).length / Math.max(a.length, b.length) >= 0.2) same++;
    }
    agreement[`${names[i]} vs ${names[j]}`] = tot ? Number((same / tot).toFixed(3)) : null;
  }
}

fs.writeFileSync(path.join(AUDIT, "testset-ranks.json"), JSON.stringify({ at: new Date().toISOString(), results, agreement }, null, 1));
console.log("testset-ranks.json written:", results.length, "query-target pairs");
console.log("Top-5 一致率:", JSON.stringify(agreement));
for (const r of results.slice(0, 6)) {
  console.log(`\n${r.queryDir} → ${r.targetDir} | ${String(r.queryTitle).slice(0, 40)}`);
  for (const [n, m] of Object.entries(r.methods)) {
    console.log(`   ${n.padEnd(12)} ${(m.items || []).map((x) => `${String(x.title).slice(0, 26)}(${x.cos})`).join(" | ") || m.note}`);
  }
}
