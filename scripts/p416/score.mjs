// v0.4 · 从盲评判定表计算各方法的 Top-5 有效率（success@5）
//
// 口径：
//   success@5 = 该方法 Top-5 中至少有一件被判「有效」的起点占比
//   同时报告 Top-5 内的 有效/弱/错误 分布，以及每条跨媒介路径的单路径数字
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(process.argv[2] || ".");
const AUDIT = path.join(REPO, ".rc1-audit", "p416");

const sheets = JSON.parse(fs.readFileSync(path.join(AUDIT, "sheets.json"), "utf8"));
const judgements = JSON.parse(fs.readFileSync(path.join(AUDIT, "judgements.json"), "utf8"))._legend;
const ranks = JSON.parse(fs.readFileSync(path.join(AUDIT, "ranks.json"), "utf8"));

// 判定表 → id 映射
const verdictById = new Map(); // sheetKey → Map(id → verdict)
const verdictBySheet = new Map();
for (const s of sheets) {
  const key = s.sheet;
  const j = judgements[key];
  if (!j) { console.warn("no judgement for sheet", key); continue; }
  const m = new Map();
  for (const c of s.candidates) {
    const v = j[c.label] ? j[c.label][0] : (j._rest || "弱");
    m.set(c.id, v);
  }
  verdictBySheet.set(key, m);
}

const METHODS = ["mobileclip", "siglip-base", "clip-large", "hybrid", "hybrid-siglip"];
const out = { at: new Date().toISOString(), topk: ranks.topk, methods: {} };

for (const method of METHODS) {
  const perPath = {};
  let hits = 0, total = 0;
  const dist = { 有效: 0, 弱: 0, 错误: 0 };
  for (const r of ranks.results) {
    const sheetName = `${r.path.replace("→", "_to_")}__${r.queryId}.png`.replace(" ", "_");
    const vm = verdictBySheet.get(sheetName);
    const items = (r.methods[method]?.items || []).slice(0, ranks.topk);
    const labels = items.map((it) => (vm ? vm.get(it.id) || "弱" : "未判"));
    const hasEffective = labels.includes("有效");
    labels.forEach((l) => { if (dist[l] !== undefined) dist[l]++; });
    const p = (perPath[r.path] ||= { queries: 0, hits: 0, rows: [] });
    p.queries++; p.hits += hasEffective ? 1 : 0;
    p.rows.push({
      query: r.queryLabel,
      success: hasEffective,
      top5: items.map((it, i) => ({ rank: i + 1, title: (it.title || it.id).slice(0, 42), verdict: labels[i] })),
    });
    hits += hasEffective ? 1 : 0; total++;
  }
  out.methods[method] = {
    successAt5: total ? Number((hits / total).toFixed(3)) : 0,
    hits, total,
    perPath: Object.fromEntries(Object.entries(perPath).map(([k, v]) => [k, { success: v.hits, queries: v.queries, rate: v.queries ? Number((v.hits / v.queries).toFixed(3)) : 0 }])),
    top5Distribution: dist,
  };
}

fs.writeFileSync(path.join(AUDIT, "metrics.json"), JSON.stringify(out, null, 1));
console.log("method          success@5   有效/弱/错误(Top-5 合计)   每路径命中/起点");
for (const [m, v] of Object.entries(out.methods)) {
  const paths = Object.entries(v.perPath).map(([k, x]) => `${k} ${x.hits}/${x.queries}`).join("  ");
  console.log(`${m.padEnd(15)} ${String(Math.round(v.successAt5 * 100) + "%").padEnd(10)} ${JSON.stringify(v.top5Distribution).padEnd(28)} ${paths}`);
}
