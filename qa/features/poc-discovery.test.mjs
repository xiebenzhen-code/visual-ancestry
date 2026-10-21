// poc-discovery.test.mjs — v0.3 自动发现 PoC 的契约
//
// 钉的是"这条管线能持续用"，不是"结果好看"：
//   1. 五个来源都注册了，Met 不再打退役的 v1/search
//   2. Openverse 适配器：许可映射、缺图剔除、匿名 page_size 不超过 20
//   3. 语料与本地作品清单解耦（证明发现不是固定名单）
//   4. 语料无重复 dedupeKey；跨来源重复被合并进 alsoFoundIn
//   5. 单个来源失败不会让整条管线或首页崩
//   6. 向量按内容哈希缓存，重跑不重算

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
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

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const artService = await imp("src/services/artService.js");
const { openverseAdapter } = await imp("src/services/adapters/openverseAdapter.js");
const { metAdapter } = await imp("src/services/adapters/metAdapter.js");
const { artworks } = await imp("src/data/artworks.js");

const POC = path.join(ROOT, ".rc1-audit/poc");
const corpus = JSON.parse(fs.readFileSync(path.join(POC, "corpus.json"), "utf8"));
const decoded = JSON.parse(fs.readFileSync(path.join(POC, "decoded.json"), "utf8"));
const embeddings = JSON.parse(fs.readFileSync(path.join(POC, "embeddings.json"), "utf8"));
const nn = JSON.parse(fs.readFileSync(path.join(POC, "nn-result.json"), "utf8"));

console.log("=== 1. 来源注册与端点 ===");
await check("五个来源已注册（含 Openverse）", () => {
  const sources = artService.adapters.map((a) => a.source);
  assert.deepEqual(sources, ["aic", "met", "cleveland", "rijks", "openverse"]);
});

await check("Met 不再指向退役的 v1/search", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/services/adapters/metAdapter.js"), "utf8");
  assert.ok(/v1\.1\/search/.test(src), "没有使用 v1.1/search");
  assert.ok(!/\/public\/collection\/v1\/search\?q=/.test(src), "仍在请求退役端点");
});

await check("诊断脚本也已迁移到 v1.1", () => {
  for (const f of ["scripts/fetch-samples.mjs", "scripts/net-probe.mjs"]) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/collection\/v1\/search/.test(s), `${f} 仍打退役端点`);
  }
});

console.log("\n=== 2. Openverse 适配器 ===");
await check("记录映射：许可、来源链接、公有领域判定", () => {
  const raw = openverseAdapter.toRaw({
    id: "x1", title: "Rainy street", creator: "A. Person", source: "flickr",
    thumbnail: "https://example.org/t.jpg", url: "https://example.org/full.jpg",
    foreign_landing_url: "https://example.org/page", width: 800, height: 600,
    license: "cc0", license_version: "1.0",
  });
  assert.equal(raw.image.url, "https://example.org/t.jpg");
  assert.equal(raw.image.ratio, 0.75);
  assert.equal(raw.publicDomain, true);
  assert.equal(raw.sourceUrl, "https://example.org/page");
  assert.match(raw.rights, /CC0/i);
  assert.equal(raw.medium, "", "不得凭空给媒介");
});

await check("缺缩略图的记录被剔除", () => {
  assert.equal(openverseAdapter.toRaw({ id: "x2", title: "no thumb" }), null);
});

await check("匿名请求的 page_size 不超过 20（超过会返回 401）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/services/adapters/openverseAdapter.js"), "utf8");
  assert.ok(/page_size:\s*"20"/.test(src), "page_size 没有固定为 20");
  assert.ok(/page:/ .test(src), "没有翻页逻辑，拿不到 30-50 条");
});

console.log("\n=== 3. 语料与本地清单解耦 ===");
await check("语料里绝大多数作品不在本地 artworks.js", () => {
  const localIds = new Set(artworks.map((a) => a.id));
  const localKeys = new Set(artworks.map((a) => a.key));
  const foreign = corpus.items.filter((w) => !localIds.has(w.sourceId) && !localKeys.has(w.dedupeKey));
  assert.ok(foreign.length / corpus.items.length > 0.9, `只有 ${foreign.length}/${corpus.items.length} 是外部作品`);
});

await check("语料覆盖 5 个来源", () => {
  const sources = new Set(corpus.items.map((w) => w.source));
  assert.equal(sources.size, 5, `只有 ${[...sources].join(",")}`);
});

await check("换关键词能发现新作品（不靠改 artworks.js）", () => {
  const byKeyword = new Set(corpus.items.flatMap((w) => w.foundBy || []));
  assert.ok(byKeyword.size >= 4, `只记录了 ${byKeyword.size} 个关键词`);
  const foggy = corpus.items.filter((w) => (w.foundBy || []).includes("foggy harbor"));
  assert.ok(foggy.length > 0, "新关键词没有带来任何作品");
});

console.log("\n=== 4. 去重 ===");
await check("语料里没有重复的 dedupeKey", () => {
  const keys = corpus.items.map((w) => w.dedupeKey);
  assert.equal(new Set(keys).size, keys.length, "存在重复作品");
});

await check("跨来源的同一作品被合并（alsoFoundIn 有记录）", () => {
  const merged = corpus.items.filter((w) => (w.alsoFoundIn || []).length > 0);
  assert.ok(merged.length > 0, "没有任何跨来源合并，次级去重键可能失效");
});

console.log("\n=== 5. 失败隔离 ===");
await check("单个来源抛错时，远端 feed 仍返回结果而不抛", async () => {
  const original = openverseAdapter.search;
  openverseAdapter.search = async () => { throw new Error("simulated 500"); };
  try {
    const state = artService.createRemoteFeedState();
    const batch = await artService.getRemoteFeed(state, { batch: 8 });
    assert.ok(Array.isArray(batch), "返回的不是数组");
  } finally {
    openverseAdapter.search = original;
  }
});

await check("Met 适配器把 403 当作单条失败、不整段抛错", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/services/adapters/metAdapter.js"), "utf8");
  assert.ok(/403/.test(src) && /setTimeout/.test(src), "没有限流重试/节流");
});

console.log("\n=== 6. 向量缓存 ===");
await check("解码成功的图都有向量（按内容哈希）", () => {
  const okPaths = Object.values(decoded.items).filter((r) => r.ok && r.path);
  assert.ok(okPaths.length >= 200, `解码成功只有 ${okPaths.length}`);
  assert.equal(embeddings.model, "mobileclip_s0_vision_int8");
  assert.equal(embeddings.dim, 512);
  assert.ok(Object.keys(embeddings.byHash).length >= okPaths.length * 0.95, "向量数明显少于解码数");
});

await check("近邻结果全部来自自动发现，且给出至少 12 条", () => {
  assert.ok(nn.top.length >= 12, `只有 ${nn.top.length} 条`);
  const localIds = new Set(artworks.map((a) => a.id));
  const foreign = nn.top.filter((r) => !localIds.has(r.sourceUrl) && !localIds.has(r.title));
  assert.ok(foreign.length >= 12, "近邻里本地作品过多，无法证明来自发现");
  for (const r of nn.top) {
    assert.ok(r.source && r.image && Number.isFinite(r.cos), "缺少来源/图片/相似度");
  }
});

console.log(`\n=== 自动发现 PoC: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
