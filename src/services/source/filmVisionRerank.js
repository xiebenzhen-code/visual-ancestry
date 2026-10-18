// filmVisionRerank.js — STEP 3：动态候选的**可选**图像分析与重排。
//
// 三道闸门，任何一道不过就返回覆盖率 0，并把原因如实上报：
//   1. 真实 Vision 服务可用（probeVisionStatus 真探 /api/vision/status）；
//   2. 调用方显式授权（authorized === true，默认 false，不持久化到任何存储）；
//   3. 预算上限（maxCandidates，默认 4）。
//
// 关键约束（与 remoteDiscovery.js 的立场一致）：
//   · 不接 QA 测试桩冒充真实分析。构造函数支持注入 provider 仅供**管道自检**，
//     注入时返回的 provenance 是 "stub"，调用方必须照实显示，不得标成 live。
//   · 失败就是失败：每条候选记 visionError（机器码），绝不静默变成"已分析"。
//   · 分析维度沿用既有 VisualIntent（normalizeVisionIntent 的同一套字段），
//     不新造分类体系；重排复用既有 scoreIntent()。
//   · 图片不落盘：只按需取一次缩略图 → Blob → File，传给既有 analyzeImage()。

import { analyzeImage, probeVisionStatus } from "../vision/visionService.js";
import { scoreIntent } from "../retrieval/scoring.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAsFile(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { error: `http-${res.status}` };
    const blob = await res.blob();
    if (!blob || !blob.type || !blob.type.startsWith("image/")) return { error: "not-an-image" };
    const name = (url.split("/").pop() || "frame.jpg").split("?")[0];
    return { file: new File([blob], name, { type: blob.type }) };
  } catch (e) {
    return { error: String(e?.name || "network").toLowerCase() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Array} references  discoverCommonsFilmStills 的候选
 * @param {object} opts
 * @param {boolean} opts.authorized      调用方显式授权（默认 false）
 * @param {number}  opts.maxCandidates   预算上限（默认 4）
 * @param {object}  opts.queryIntent     用户查询的 VisualIntent（用于重排，可空）
 * @param {function} opts.probe          注入的可用性探针（仅管道自检）
 * @param {function} opts.analyze        注入的分析函数（仅管道自检）
 * @returns {Promise<{analyzed:number, coverage:number, reason:string, provenance:string,
 *                    analyzedIds:string[], failures:Array, reranked:boolean, results:Array}>}
 */
export async function rerankWithVision(references, opts = {}) {
  const {
    authorized = false,
    maxCandidates = 4,
    queryIntent = null,
    probe = probeVisionStatus,
    analyze = analyzeImage,
  } = opts;
  const injected = typeof opts.analyze === "function";
  const results = references.slice();
  const base = {
    analyzed: 0,
    attempted: 0,
    coverage: 0,
    reason: "",
    provenance: "none",
    analyzedIds: [],
    failures: [],
    reranked: false,
    results,
  };

  // 闸门 1：真实 Vision 可用性（注入探针时按管道自检处理，标注 stub）。
  let available = false;
  try {
    available = Boolean(await probe());
  } catch {
    available = false;
  }
  if (!available) {
    return {
      ...base,
      reason: injected ? "stub-probe-unavailable" : "vision-unavailable",
      // 措辞按实测：同源状态端点是**可达**的（HTTP 200），但它报告
      // provider="not-configured" / visionEnabled=false。写成「没有桥接端点」
      // 会把「端点在、模型没配」说成另一件事，所以照实写。
      note: injected
        ? "管道自检：注入的探针返回不可用，未做任何分析。"
        : "同源状态端点可达但未配置模型（provider=not-configured），本次没有做任何图像分析。",
    };
  }

  // 闸门 2：显式授权。默认否，且不写任何存储——没有授权就不花钱。
  if (!authorized) {
    return {
      ...base,
      provenance: injected ? "stub" : "none",
      reason: injected ? "stub-not-authorized" : "not-authorized",
      note: injected
        ? "管道自检：探针可用但未授权，未做任何分析。"
        : "Vision 可用，但本次调用未获授权，因此没有做任何图像分析。",
    };
  }

  // 闸门 3：预算。只对可展示的候选分析，超出的明确记为 budget-capped。
  const targets = results.filter((r) => r.showable).slice(0, Math.max(0, maxCandidates));
  const capped = results.filter((r) => r.showable).length - targets.length;
  if (capped > 0) {
    base.failures.push({ id: "budget", reason: `budget-capped：${capped} 件超出本次预算上限，未做分析` });
  }

  for (const ref of targets) {
    base.attempted += 1;
    const url = ref.image?.thumbnailUrl || ref.image?.url;
    if (!url) {
      ref.visionError = "no-image-url";
      base.failures.push({ id: ref.sourceId, reason: "no-image-url" });
      continue;
    }
    const { file, error } = await fetchAsFile(url);
    if (error || !file) {
      ref.visionError = error || "fetch-failed";
      base.failures.push({ id: ref.sourceId, reason: ref.visionError });
      continue;
    }
    const outcome = await analyze(file);
    if (!outcome || !outcome.ok || !outcome.intent) {
      ref.visionError = (outcome && (outcome.error || outcome.reason)) || "analysis-failed";
      base.failures.push({ id: ref.sourceId, reason: ref.visionError });
      continue;
    }
    // 成功：intent 字段与绘画侧完全同一套（normalizeVisionIntent 的产物）。
    ref.intent = outcome.intent;
    ref.intentProvenance = injected ? "stub" : "vision-live";
    ref.visionError = null;
    base.analyzed += 1;
    base.analyzedIds.push(ref.sourceId);
    await sleep(120);
  }

  base.coverage = base.attempted ? Number((base.analyzed / base.attempted).toFixed(3)) : 0;
  base.provenance = base.analyzed ? (injected ? "stub" : "vision-live") : "none";
  base.reason = base.analyzed
    ? capped > 0
      ? "analyzed-with-budget-cap"
      : "analyzed"
    : base.failures.length
      ? "all-attempts-failed"
      : "no-targets";

  // 重排：只有在拿到 intent 且有查询意图时才排序，且明确标注是 vision 重排。
  if (base.analyzed > 0 && queryIntent) {
    const scored = results.map((r) => ({
      r,
      s: r.intent ? scoreIntent(queryIntent, { ...r.intent, visualIntent: r.intent, artwork: { visualIntent: r.intent } }) : null,
    }));
    scored.sort((a, b) => {
      if (a.s == null && b.s == null) return 0;
      if (a.s == null) return 1;
      if (b.s == null) return -1;
      return b.s - s.s;
    });
    base.results = scored.map((x) => x.r);
    base.reranked = true;
  }

  base.note = base.analyzed
    ? `已对 ${base.analyzed}/${base.attempted} 件候选做图像分析（provenance=${base.provenance}）。`
    : "没有任何候选完成图像分析；以下结果全部只有元数据依据。";
  return base;
}