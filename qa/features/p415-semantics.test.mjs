// p415-semantics.test.mjs — P4.15.2 V2 语义召回路径
//
// 钉住四件事：
//   · 画像只能来自已核实的模型输出（预检单图分析 / 真实比较缓存），
//     Mock 缓存一律不算
//   · 没有画像的候选必须标 unanalyzed，不能拿标题/VisualIntent 冒充
//   · 语义命中必须有 ≥2 个维度的可核对词，并给出证据
//   · 固定的历史事实（含「舞蹈课曾接受后被移出」）必须随仓库保存

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const st = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (st.has(k) ? st.get(k) : null),
    setItem: (k, v) => st.set(k, String(v)),
    removeItem: (k) => st.delete(k),
  },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const sem = await imp("experiment/p415/semantics.mjs");

const CACHE = path.join(ROOT, ".rc1-audit/p415/cache");
const STATE = path.join(ROOT, ".rc1-audit/p415/preflight-state.json");
const FIXTURE = path.join(ROOT, "experiment/p415/fixtures/pinned-cases.json");

const table = sem.buildSemanticTable({ cacheDir: CACHE, statePath: STATE, fixturesPath: FIXTURE });

console.log("=== 1. 画像来源与可信度 ===");
await check("画像表非空，且记录了来源统计", () => {
  assert.ok(table.profiles.size > 0, "没有任何画像");
  assert.ok(table.stats.comparisonEntries >= 1, "没有真实比较条目");
});

await check("Mock 缓存不计入画像", () => {
  const mockIds = ["utamaro-three-beauties"]; // 只在 mock 里出现过，不应有真实画像
  for (const id of mockIds) {
    const p = table.profiles.get(id);
    if (p) assert.notEqual(p.source.model, "mock", `${id} 的画像来自 mock`);
  }
});

await check("《美国哥特式》有单图 V2 分析画像，含构图与光影", () => {
  const p = table.profiles.get("american-gothic");
  assert.ok(p, "缺少 AG 画像");
  assert.ok(p.composition.skeleton || p.composition.weight, "没有构图字段");
  assert.ok(p.colorLight.direction || p.colorLight.quality || p.colorLight.organization, "没有光影字段");
});

await check("比较判定产生的画像带 callId 与提示版本", () => {
  const p = table.profiles.get("whistlers-mother");
  assert.ok(p, "缺少 whistlers-mother 画像");
  assert.ok(p.source.callId, "没有 callId");
  assert.ok(p.source.promptVersion, "没有 promptVersion");
});

await check("查询画像可从差异文本反推，并标为 derived", () => {
  const p = table.profiles.get("paris-rainy-day");
  assert.ok(p, "paris 没有反推画像");
  assert.equal(p.kind, "derived-query");
  assert.ok(p.tokens.space.length + p.tokens.colorLight.length > 0, "反推出的词为空");
});

console.log("\n=== 2. 语义发现 ===");
await check("AG 查询能发现至少一个有画像的候选，且证据 ≥2 维", () => {
  const q = table.profiles.get("american-gothic");
  assert.ok(q);
  const cands = new Map();
  for (const [id, p] of table.profiles) if (id !== "american-gothic") cands.set(id, p);
  const r = sem.semanticDiscover(q, cands);
  assert.ok(r.hits.length > 0, "一个都没发现");
  for (const h of r.hits) {
    assert.ok(h.matchedDimensions.length >= 2, `${h.id} 只有 ${h.matchedDimensions.length} 维`);
    assert.ok(h.evidence.length >= 2);
  }
});

await check("没有画像的候选不会被语义路径凭空命中", () => {
  const q = table.profiles.get("american-gothic");
  const cands = new Map([["unanalyzed-x", { entryId: "unanalyzed-x", tokens: { composition: [], subject: [], space: [], colorLight: [] } }]]);
  const r = sem.semanticDiscover(q, cands);
  assert.equal(r.hits.length, 0);
});

await check("查询没有画像时明确跳过并说明原因", () => {
  const r = sem.semanticDiscover(null, new Map());
  assert.equal(r.hits.length, 0);
  assert.match(r.skipped, /没有语义画像/);
});

console.log("\n=== 3. 固定历史事实 ===");
await check("夹具随仓库存在，且记录「舞蹈课曾接受后被移出」", () => {
  assert.ok(fs.existsSync(FIXTURE), "缺少 pinned-cases.json");
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const accepted = fx.facts.find((f) => /曾接受《舞蹈课》/.test(f.fact));
  assert.ok(accepted, "缺少「曾接受」事实");
  assert.equal(accepted.detail.relation, "partial");
  assert.ok(accepted.detail.compositionEvidence.includes("芭蕾舞者"));
  const moved = fx.facts.find((f) => /移出 top8/.test(f.fact));
  assert.ok(moved, "缺少「被移出」事实");
  assert.equal(moved.detail.danceClassRecallRanks.vector, 3);
  assert.ok(!moved.detail.top8After.includes("dance-class"));
});

await check("夹具固定四组查询的前后排序", () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const q of ["american-gothic", "paris-rainy-day", "fan-kuan-travelers", "guo-xi-early-spring"]) {
    const r = fx.beforeAfter[q];
    assert.ok(r, `缺少 ${q}`);
    assert.ok(r.before.length === 5 && r.after.length === 8, `${q} 长度不符`);
  }
});

await check("夹具记录「向量碰撞」更正", () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const f = fx.facts.find((x) => /向量碰撞/.test(x.fact));
  assert.ok(f);
  assert.ok(f.detail.cosines["fan-kuan--shitao"] < 0.5, "余弦不该是这个值");
});

console.log(`\n=== P4.15.2 语义召回: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
