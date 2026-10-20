// scripts/p415/preflight.mjs — P4.15 能力探测（默认不花钱）
//
// 目的：在跑任何验收之前，先用最少的请求确认三件事：
//   1. 端点通、密钥有效、模型 ID 正确
//   2. 这个模型真的能吃图片（不因为「兼容 OpenAI 格式」就默认支持）
//   3. 能把两张图放进同一次请求里比较（STEP 4 的前提）
//
// 硬上限 5 次；任何一步失败立即停止，不继续烧预算。
// 默认 --dry：只打印计划与配置状态，不发请求。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareConfig } from "../../server/vision/multimodalCompare.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const RUN = process.argv.includes("--run");
const HARD_CAP = 5;

const cfg = compareConfig();
let used = 0;

const b = (v) => (v ? "是" : "否");

console.log("== 配置状态 ==");
console.log(`  VISION_API_BASE    ${b(cfg.endpoint)}`);
console.log(`  VISION_API_KEY     ${b(cfg.credential)}`);
console.log(`  VISION_MODEL       ${cfg.model || "(未设置)"}`);
console.log(`  模型已配置         ${b(cfg.configured)}`);
console.log(`  预算账本           ${b(cfg.budget && cfg.budget.file)}`);
console.log(`  本轮上限           硬上限 ${HARD_CAP} 次`);
if (cfg.endpoint) console.log(`  端点               ${cfg.endpoint}`);

if (!cfg.configured) {
  console.log("\n未配置，不发请求。");
  console.log("需要：仓库根 .env 里设置 VISION_API_BASE / VISION_API_KEY / VISION_MODEL，");
  console.log("并用 `node --env-file-if-exists=.env ...` 启动，或直接导出为进程环境变量。");
  process.exit(2);
}

if (!RUN) {
  console.log("\n这是 --dry。将按顺序发起以下探测（最多 3 次，硬上限 5 次）：");
  console.log("  1. 单图请求      → 验证密钥、模型、图片输入");
  console.log("  2. 双图请求      → 验证多图比较能力（STEP 4 的前提）");
  console.log("\n确认后加 --run 执行。");
  process.exit(0);
}

// ---- 取证用的最小图片：用本地已有作品，不额外造图
const sample = path.join(ROOT, "public/assets/artworks/american-gothic/preview.webp");
const sample2 = path.join(ROOT, "public/assets/artworks/the-kiss/preview.webp");
if (!fs.existsSync(sample) || !fs.existsSync(sample2)) {
  console.error("找不到本地样图，无法探测。");
  process.exit(2);
}
const toImg = (p) => ({ b64: fs.readFileSync(p).toString("base64"), mime: "image/webp" });

const call = async (label, fn) => {
  if (used >= HARD_CAP) {
    console.log(`  ${label}: 跳过（已达硬上限 ${HARD_CAP}）`);
    return { ok: false, error: "round-limit" };
  }
  used++;
  console.log(`\n[${used}/${HARD_CAP}] ${label} …`);
  const r = await fn();
  if (r.ok) {
    console.log(`  成功  ${r.latencyMs}ms  model=${r.model || cfg.model}`);
    if (r.usage) console.log(`  tokens: ${JSON.stringify(r.usage)}`);
  } else {
    console.log(`  失败  ${r.error}  ${String(r.detail || "").slice(0, 160)}`);
  }
  return r;
};

const result = { endpoint: cfg.endpoint, model: cfg.model, calls: 0, singleImage: false, multiImage: false };

const one = await call("单图请求", async () => {
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.credential}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 32,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这张图里有几个人？只回答一个数字。" },
          { type: "image_url", image_url: { url: `data:image/webp;base64,${toImg(sample).b64}`, detail: "low" } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, detail: await res.text().catch(() => "") };
  const j = await res.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "空回复", detail: JSON.stringify(j).slice(0, 200) };
  console.log(`  回答: ${text.trim().slice(0, 80)}`);
  return { ok: true, model: j.model, usage: j.usage, latencyMs: 0 };
});
result.singleImage = one.ok;
result.calls = used;

if (!one.ok) {
  console.log("\n单图就不通，停止。多图能力无从谈起。");
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

const two = await call("双图请求", async () => {
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.credential}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 64,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "第一张和第二张图分别有几个人？只输出两个数字，用逗号分隔。" },
          { type: "image_url", image_url: { url: `data:image/webp;base64,${toImg(sample).b64}`, detail: "low" } },
          { type: "image_url", image_url: { url: `data:image/webp;base64,${toImg(sample2).b64}`, detail: "low" } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, detail: await res.text().catch(() => "") };
  const j = await res.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "空回复", detail: JSON.stringify(j).slice(0, 200) };
  console.log(`  回答: ${text.trim().slice(0, 80)}`);
  // 两个数字说明它真的看了两张；只回一个数字说明只有一张被读到
  const nums = (text.match(/\d+/g) || []).length;
  if (nums < 2) {
    console.log("  注意：只回了一个数字，可能只读到了第一张图。标记为「不可靠」。");
    return { ok: false, error: "multi-image-unreliable", detail: text.trim().slice(0, 120) };
  }
  return { ok: true, model: j.model, usage: j.usage };
});
result.multiImage = two.ok;
result.calls = used;

const outDir = path.join(ROOT, ".rc1-audit/p415");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "preflight.json"), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));

console.log("\n== 结论 ==");
console.log(`  端点可用        ${b(result.singleImage)}`);
console.log(`  支持图片输入    ${b(result.singleImage)}`);
console.log(`  支持多图比较    ${b(result.multiImage)}`);
console.log(`  实际请求次数    ${result.calls} / ${HARD_CAP}`);

if (!result.multiImage) {
  console.log("\n多图比较不可用 → STEP 4 不能按原方案做。");
  console.log("不能退化成「分别单图分析 + 用文字对比」冒充图像对照——那是两件不同的事，");
  console.log("必须回来改方案（例如逐候选单图分析 + 明确标注「非联合比较」）。");
}
process.exit(result.multiImage ? 0 : 1);
