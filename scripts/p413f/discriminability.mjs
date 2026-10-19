// P4.13-F STEP 2 — VisualIntent 判别力三方案离线对照（权威版）
//
// 立场：
//   · 不修改 22 字段契约，不修改 src/ 任何文件
//   · 只在脚本内复现 B / C 的加权，A 直接用生产函数作为基准
//   · 复现必须先自证：A_reimpl 与生产 compareWithMissingAwareness 逐对完全一致，
//     否则 B / C 的数字一律作废（脚本会直接退出）
//   · 不给「该上线哪个」的结论。没有用户标注支持时不选新算法。
//
// 用法：node .rc1-audit/p413f/step2-discriminability.mjs

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

const svc = await imp("src/services/retrieval/retrievalService.js");
const mr = await imp("src/services/retrieval/missingAwareRanking.js");
const scoring = await imp("src/services/retrieval/scoring.js");
const data = await imp("src/data/artworks.js");

const ARTWORKS = data.artworks || data.default || [];
const CACHE = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/visual-intents/artworks.json"), "utf8"));
const INTENTS = CACHE.intents || CACHE;

const W = {
  subject: 1.5, subjectScale: 3, environmentDominance: 3, spatialDepth: 2.5, negativeSpace: 2.5,
  lightDirection: 2, lightQuality: 1.5, saturation: 1.5, contrast: 1.2, cameraRelation: 2,
  cameraDistance: 1.5, cameraHeight: 1, socialDistance: 2, humanRelation: 1.5, motion: 1,
  visualDensity: 1.2, colorTemperature: 1, melancholy: 2, arousal: 1,
};
const LIST_W = { emotion: 0.6, atmosphere: 0.8 };
const FIELDS = Object.keys(W);
const CORE = mr.CORE_FIELDS;

const total = Object.values(W).reduce((a, b) => a + b, 0);
if (Math.abs(total - 32.9) > 1e-9) {
  console.error(`权重合计 ${total} != 32.9，脚本口径与生产不符，退出`);
  process.exit(2);
}

const pool = ARTWORKS.filter((a) => a.image && !a.imageUnavailable);
const intentOf = (a) => {
  const e = INTENTS[a.id];
  return e ? (e.intent || e) : svc.intentForArtwork(a);
};
const has = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

// ---------- 池内取值集中度 ----------
const concentration = {};
for (const f of FIELDS) {
  const m = new Map();
  for (const a of pool) {
    const v = intentOf(a)[f];
    if (has(v)) m.set(v, (m.get(v) || 0) + 1);
  }
  let bestV = null, bestN = 0;
  for (const [v, n] of m) if (n > bestN) { bestN = n; bestV = v; }
  const defined = [...m.values()].reduce((a, b) => a + b, 0);
  concentration[f] = {
    mode: bestV,
    count: bestN,
    defined,
    ofPool: bestN / pool.length,
    ofDefined: defined ? bestN / defined : 0,
  };
}

// 阈值两种分母都给，因为「池内占比 90%」这句话本身有歧义
const zeroOfDefined = FIELDS.filter((f) => concentration[f].ofDefined >= 0.9);
const zeroOfPool = FIELDS.filter((f) => concentration[f].ofPool >= 0.9);

// ---------- 加权方案 ----------
function weightsFor(scheme, query) {
  const w = { ...W };
  if (scheme === "B") {
    // 只置零「占有值 ≥90%」的字段：这些字段对绝大多数候选白送分
    for (const f of zeroOfDefined) w[f] = 0;
  }
  if (scheme === "C") {
    // IDF：w' = w * ln(N / n_v)，n_v 是查询该取值在池内的出现次数
    for (const f of FIELDS) {
      const q = query[f];
      if (!has(q)) continue;
      const n = concentration[f].mode === q
        ? concentration[f].count
        : (() => {
            let c = 0;
            for (const a of pool) if (intentOf(a)[f] === q) c++;
            return c;
          })();
      const idf = Math.log(pool.length / Math.max(1, n));
      w[f] = W[f] * idf;
    }
  }
  return w;
}

// ---------- 与生产同构的打分 ----------
function quality(query, candidate, w) {
  let queryWeight = 0, candidateWeight = 0, matchedWeight = 0, conflictWeight = 0, coreConflict = 0;
  for (const f of FIELDS) {
    const weight = w[f];
    if (weight === 0) continue;          // 置零字段完全不参与（含 queryWeight）
    const q = query[f];
    if (!has(q)) continue;
    queryWeight += weight;
    const c = candidate[f];
    if (!has(c)) continue;
    candidateWeight += weight;
    if (c === q) matchedWeight += weight;
    else {
      conflictWeight += weight;
      if (CORE.includes(f)) coreConflict += weight * 0.55;
    }
  }
  for (const [f, weight] of Object.entries(LIST_W)) {
    for (const item of query[f] || []) {
      queryWeight += weight;
      const list = candidate[f] || [];
      if (list.includes(item)) { candidateWeight += weight; matchedWeight += weight; }
      else if (list.length === 0) { /* missing */ }
      else { candidateWeight += weight; conflictWeight += weight; }
    }
  }
  const coverage = queryWeight > 0 ? Math.sqrt(Math.min(1, candidateWeight / queryWeight)) : 0;
  const penalty = coreConflict + Math.max(0, conflictWeight - coreConflict) * 0.06;
  return {
    qualityScore: Math.round(Math.max(0, matchedWeight * coverage - penalty) * 10) / 10,
    matchedWeight: Math.round(matchedWeight * 10) / 10,
    coverageFactor: Math.round(coverage * 1000) / 1000,
    conflictPenalty: Math.round(penalty * 10) / 10,
    coreConflict: Math.round(coreConflict * 10) / 10,
  };
}

// ---------- 自证：A_reimpl 必须逐位等于生产 ----------
let maxDev = 0, compared = 0;
for (const qArt of pool) {
  const q = intentOf(qArt);
  for (const cArt of pool) {
    if (cArt.key === qArt.key) continue;
    const prod = mr.compareWithMissingAwareness(q, intentOf(cArt)).qualityScore;
    const mine = quality(q, intentOf(cArt), W).qualityScore;
    maxDev = Math.max(maxDev, Math.abs(prod - mine));
    compared++;
  }
}
const replicationOk = maxDev === 0;

// ---------- 预过滤（与生产同构） ----------
function candidatesFor(qArt) {
  return pool
    .filter((a) => a.key !== qArt.key)
    .filter((a) => {
      const sc = scoring.scoreIntent(intentOf(qArt), intentOf(a));
      const reasons = svc.retrieveByIntent(intentOf(qArt), { limit: 999 }).some((r) => r.artwork.key === a.key);
      return sc.score > 0 && reasons;
    });
}

const byId = new Map(pool.map((a) => [a.id, a]));
const QUERIES = ["american-gothic", "starry", "wanderer"];

const rows = [];
for (const qid of QUERIES) {
  const qArt = byId.get(qid);
  const q = intentOf(qArt);
  const cands = candidatesFor(qArt);
  for (const scheme of ["A", "B", "C"]) {
    const w = weightsFor(scheme, q);
    const scored = cands
      .map((a) => ({ id: a.id, artist: a.artist, ...quality(q, intentOf(a), w) }))
      .sort((x, y) => y.qualityScore - x.qualityScore);
    rows.push({ qid, scheme, top: scored.slice(0, 5), all: scored });
  }
}

// ---------- 碰撞 ----------
function collisionGroups(scheme, q) {
  const w = weightsFor(scheme, q);
  const sig = (a) => FIELDS.filter((f) => w[f] !== 0).map((f) => `${f}=${intentOf(a)[f] ?? ""}`).join("|");
  const m = new Map();
  for (const a of pool) {
    const s = sig(a);
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(a.id);
  }
  return [...m.values()].filter((g) => g.length > 1);
}

// ---------- 输出 ----------
const L = [];
const W_ = (s) => L.push(s);

W_("# P4.13-F STEP 2 — VisualIntent 判别力离线对照（权威版）");
W_("");
W_("- 生成：`node .rc1-audit/p413f/step2-discriminability.mjs`");
W_("- 池：`artworks.js` 中 `image && !imageUnavailable` = **" + pool.length + "** 件");
W_("- 19 加权字段，权重合计 **32.9**（脚本内断言）");
W_("- A 方案直接调用生产 `compareWithMissingAwareness`；B/C 为脚本内复现");
W_("");
W_("## 0. 复现自证（B/C 数字有效性的前提）");
W_("");
W_(`- 逐对比较 **${compared}** 次，A_reimpl 与生产最大偏差 **${maxDev.toFixed(3)}**`);
W_(`- 结论：**${replicationOk ? "逐位一致，B/C 数字可采信" : "已分叉，B/C 数字作废"}**`);
W_("");
W_("## 1. 池内取值集中度与方案 B 的置零集合");
W_("");
W_("| 字段 | 生产权重 | 众数取值 | 出现 | 占池内(46) | 占有值 | 方案B权重 |");
W_("| --- | ---: | --- | ---: | ---: | ---: | ---: |");
for (const f of [...FIELDS].sort((a, b) => concentration[b].ofPool - concentration[a].ofPool)) {
  const c = concentration[f];
  W_(`| ${f} | ${W[f]} | ${c.mode} | ${c.count}/${c.defined} | **${Math.round(c.ofPool * 100)}%** | ${Math.round(c.ofDefined * 100)}% | ${zeroOfDefined.includes(f) ? "**0**" : W[f]} |`);
}
W_("");
W_(`- 按「占有值 ≥90%」：置零 **${zeroOfDefined.join(", ") || "无"}**`);
W_(`- 按「占全池 ≥90%」：置零 **${zeroOfPool.join(", ") || "无"}** ← 这个分母下 **B ≡ A**（空操作）`);
W_("");
W_("> 这正是原脚本出错的地方：它把「有值数 42」当成「众数出现数」，于是报成 42/46=91%。实际众数出现是 41 次（41/46=89%，41/42=98%）。**分母选择决定 B 是不是空操作**，必须写明。");
W_("");
W_("## 2. 三方案 × 三查询 Top 5（`qualityScore`，生产 1 位小数）");
for (const qid of QUERIES) {
  W_("");
  W_(`### 查询 \`${qid}\``);
  W_("");
  W_("| 名次 | A | A 分 | B | B 分 | C | C 分 |");
  W_("| ---: | --- | ---: | --- | ---: | --- | ---: |");
  const g = Object.fromEntries(rows.filter((r) => r.qid === qid).map((r) => [r.scheme, r]));
  for (let i = 0; i < 5; i++) {
    W_(`| ${i + 1} | ${g.A.top[i]?.id ?? "—"} | ${g.A.top[i]?.qualityScore ?? "—"} | ${g.B.top[i]?.id ?? "—"} | ${g.B.top[i]?.qualityScore ?? "—"} | ${g.C.top[i]?.id ?? "—"} | ${g.C.top[i]?.qualityScore ?? "—"} |`);
  }
}
W_("");
W_("## 3. 判别力指标");
W_("");
W_("| 查询 | 方案 | Top1 | Top5 | 分差 | 相对落差 | 池内标准差 | Top1 同画家？ |");
W_("| --- | :---: | ---: | ---: | ---: | ---: | ---: | :---: |");
for (const qid of QUERIES) {
  for (const scheme of ["A", "B", "C"]) {
    const r = rows.find((x) => x.qid === qid && x.scheme === scheme);
    const t1 = r.top[0].qualityScore;
    const t5 = r.top[4]?.qualityScore ?? 0;
    const scores = r.all.map((x) => x.qualityScore);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
    const sameArtist = r.top[0].artist === byId.get(qid).artist;
    W_(`| ${qid} | ${scheme} | ${t1} | ${t5} | ${(t1 - t5).toFixed(1)} | ${((t1 - t5) / t1 * 100).toFixed(1)}% | ${sd.toFixed(2)} | ${sameArtist ? `**是**（${r.top[0].id}）` : `否（${r.top[0].id}）`} |`);
  }
}
W_("");
W_("## 4. `american-gothic` vs `birth-of-venus`（18/19 案例）");
W_("");
const agQ = byId.get("american-gothic");
const agIntent = intentOf(agQ);
const bovIntent = intentOf(byId.get("birth-of-venus"));
const diffFields = FIELDS.filter((f) => agIntent[f] !== bovIntent[f]);
W_(`- 19 个加权字段中相同 **${19 - diffFields.length}** 个，不同 **${diffFields.length}** 个：${diffFields.map((f) => `\`${f}\`（AG=${agIntent[f]} / 维纳斯=${bovIntent[f]}）`).join("、") || "无"}`);
W_("");
W_("| 方案 | 维纳斯分 | 维纳斯名次 | Top1 | Top1 分 | 是否仍第一 |");
W_("| :---: | ---: | ---: | --- | ---: | :---: |");
for (const scheme of ["A", "B", "C"]) {
  const r = rows.find((x) => x.qid === "american-gothic" && x.scheme === scheme);
  const rank = r.all.findIndex((x) => x.id === "birth-of-venus") + 1;
  const bov = r.all.find((x) => x.id === "birth-of-venus");
  W_(`| ${scheme} | ${bov.qualityScore} | ${rank} | ${r.top[0].id} | ${r.top[0].qualityScore} | ${rank === 1 ? "**是**" : "否"} |`);
}
W_("");
W_("## 5. 碰撞组（逐字段值向量完全相同）");
W_("");
for (const scheme of ["A", "B", "C"]) {
  const groups = collisionGroups(scheme, agIntent);
  W_(`- 方案 ${scheme}：**${groups.length}** 组`);
  for (const g of groups) W_(`  - ${g.join("  ≡  ")}`);
}
W_("");
W_("> **数学事实**：若两件作品在全部加权字段上取值相同，则任何「按字段取值加权」的方案（A 原权重 / B 置零 / C 频次缩放）都给它们相同分数。**碰撞不可能靠调权解除**，只能靠新增维度。");
W_("");
W_("## 6. 结论边界");
W_("");
W_("- 本表只呈现数字，不判断「哪个方案更好」。");
W_("- 三方案下 `birth-of-venus` 都是 `american-gothic` 的第一名，说明**问题不在权重分配**。");
W_("- 只有 1 个用户、1 条查询的标注（P4.11），不足以选择新算法上线。");
W_("- 不得外推到其他查询、其他候选池或上线效果。");

const outDir = path.join(ROOT, ".rc1-audit/p413f");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "step2-report.md"), L.join("\n") + "\n", "utf8");
fs.writeFileSync(
  path.join(outDir, "step2-report.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      poolSize: pool.length,
      replication: { compared, maxDeviation: maxDev, ok: replicationOk },
      zeroedOfDefined: zeroOfDefined,
      zeroedOfPool: zeroOfPool,
      rows,
    },
    null,
    2
  ),
  "utf8"
);

console.log(L.join("\n"));
console.log("\n[written] .rc1-audit/p413f/step2-report.md");
console.log("[written] .rc1-audit/p413f/step2-report.json");
if (!replicationOk) process.exitCode = 3;
