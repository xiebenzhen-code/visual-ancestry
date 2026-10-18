// P5.6 STEP 7 — assistant scenario validation on the REAL 34-asset demo pool
// (work/portfolio-validation/demo-store = P5.3.2 stress pool + P5.4 live upload).
// Three real creation scenarios; zero provider, zero LLM — pure composition.
//
//   A 影视创作  「我要做一个孤独角色远行镜头」→ 个人电影参考 + 绘画参考都被召回
//   B AIGC 生成 「生成一个符合我的视觉方向的场景」→ 输出视觉约束（来自个人画像）
//   C 审美总结  「我收藏的东西有什么共同点」→ Profile 统计回答
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
// store binding at first import — bind to the REAL demo pool before importing
process.env.MEMORY_STORE_DIR = path.join(ROOT, "work", "portfolio-validation", "demo-store");

const results = [];
let pass = 0, fail = 0;
const check = (scene, desc, cond, detail) => {
  if (cond) { pass++; results.push({ scene, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ scene, desc, pass: false, detail: detail || "" }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
};

const { runAssistant } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "visualAssistant.js")).href
);

// ===================== 场景 A：影视创作 =======================================
console.log("场景 A — 影视创作：「我要做一个孤独角色远行镜头」");
{
  const r = await runAssistant({ task: "creative_support", query: "我要做一个孤独角色远行镜头" });
  const films = r.references.filter((x) => x.medium === "film");
  const paintings = r.references.filter((x) => x.medium === "painting");
  check("A", "基于真实样本（34 资产池）", r.basedOn.sampleSize === 34, `got ${r.basedOn.sampleSize}`);
  check("A", `个人电影参考被召回（${films.length} 条）`, films.length > 0, films.map((f) => f.title).join(","));
  check("A", `个人绘画参考被召回（${paintings.length} 条）`, paintings.length > 0, paintings.map((f) => f.title).join(","));
  check("A", "每条参考带真实理由", r.references.every((x) => x.reason.length > 0));
  console.log(`    电影: ${films.map((f) => f.title).join(" / ") || "—"}\n    绘画: ${paintings.map((f) => f.title).join(" / ") || "—"}`);
}

// ===================== 场景 B：AIGC 生成 ======================================
console.log("场景 B — AIGC 生成：「生成一个符合我的视觉方向的场景」");
{
  const r = await runAssistant({ task: "creative_support", query: "生成一个符合我的视觉方向的场景" });
  check("B", "输出视觉约束——空间维度来自个人画像", r.direction.space.length > 0, r.direction.space.join("|"));
  check("B", "输出视觉约束——色彩维度来自个人画像", r.direction.color.length > 0, r.direction.color.join("|"));
  check("B", "约束携带样本量与置信级", r.basedOn.sampleSize === 34 && ["tendency", "pattern"].includes(r.basedOn.confidence.level), JSON.stringify(r.basedOn));
  check("B", "约束附真实历史参考", r.references.length > 0);
  check("B", "边界明示：不是 AI 生成，是个人记忆整理", /不是 AI 创作/.test(r.note || ""));
}

// ===================== 场景 C：审美总结 =======================================
console.log("场景 C — 审美总结：「我收藏的东西有什么共同点」");
{
  const r = await runAssistant({ task: "understand_taste" });
  check("C", "回答来自 Profile（sampleSize=34）", r.ok && r.sampleSize === 34, `got ${r.sampleSize}`);
  check("C", "confidence = tendency（34 → 20–50 区间）", r.confidence.level === "tendency", JSON.stringify(r.confidence));
  check("C", "共同点有真实计数证据", r.evidence.length > 0 && r.evidence.some((e) => /%/.test(e)), r.evidence.slice(0, 3).join(" | "));
  const joined = JSON.stringify(r);
  check("C", "不评价审美（无等级/人格/比较）", !["审美等级", "人格", "比别人"].some((f) => joined.includes(f)));
  console.log(`    summary: ${r.summary}`);
}

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
const OUT = path.join(ROOT, "work", "p5.6-assistant", "assistant-scenarios-results.json");
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ total: pass + fail, pass, fail, results }, null, 2) + "\n", "utf8");
console.log(`→ ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
