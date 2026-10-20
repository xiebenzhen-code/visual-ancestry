// multimodalCompare.js — P4.15 STEP 2/4: visual analysis V2 and direct
// image-to-image comparison against an OpenAI-compatible multimodal endpoint.
//
// Deliberately separate from openaiProvider.mjs. That module owns the frozen
// single-image VisualIntent contract used by the shipping FIND path; changing
// it in place would put a live feature at risk while this experiment is still
// being proven. This module owns its own schema, its own prompt version and
// its own call accounting.
//
// Two rules are enforced here rather than left to the prompt:
//   1. A field the model could not determine must come back as null and be
//      listed in `unknown`. It is never filled with a plausible guess.
//   2. A verdict without at least one visible, quotable similarity is
//      downgraded. "Both are group portraits" is not a reason.

import { serverVisionConfig, visionConfigured } from "./openaiProvider.mjs";
import { budgetConfig, reserveCall, budgetStatus } from "../security/budget.mjs";

/** Bump when the prompt text changes. Part of every cache key. */
export const PROMPT_VERSION = "p415-v2.3";

export const VERDICTS = Object.freeze({
  HIGH: "high",
  PARTIAL: "partial",
  UNRELATED: "unrelated",
});

export const COMPARE_ERRORS = Object.freeze({
  NOT_CONFIGURED: "provider-not-configured",
  BUDGET: "budget-unavailable",
  LIMIT: "round-limit-reached",
  TIMEOUT: "timeout",
  NETWORK: "network",
  HTTP: "http-error",
  BAD_JSON: "invalid-json",
  BAD_SHAPE: "invalid-shape",
});

// ---------------------------------------------------------------- config

/** Env-derived config for this experiment. Never logs the credential. */
export function compareConfig(env = process.env) {
  const base = serverVisionConfig(env);
  const cfg = budgetConfig(env);
  const roundLimit = Number(env.VISION_ROUND_CALL_LIMIT || 0);
  return {
    model: base.model,
    endpoint: base.endpoint,
    credential: base.credential,
    configured: visionConfigured(base),
    budget: cfg,
    roundLimit: Number.isFinite(roundLimit) ? roundLimit : 0,
    timeoutMs: Number(env.VISION_TIMEOUT_MS || 45000),
  };
}

// ---------------------------------------------------------------- schema

/**
 * Shape the model must return for one candidate.
 * Kept flat on purpose: nested optional objects are where models start
 * inventing fields to satisfy a schema.
 */
export const CANDIDATE_SCHEMA = `{
  "similarPoints": ["可见的构图/组织上的具体相似之处，最多 3 条"],
  "compositionEvidence": "构图骨架层面的具体证据（骨架、主体位置、重心、留白）；没有就是 null",
  "subjectRelationEvidence": "人物/主体的数量、姿态、朝向、彼此关系的具体证据；无主体就是 null",
  "colorLightEvidence": "色彩与光线关系的具体证据（主导色、冷暖、明暗如何组织）；没有就是 null",
  "figureOrganization": "人物数量、姿态朝向、彼此关系的对照；没有人物写 null",
  "borrowableLight": "可以借鉴的光线处理；没有就是 null",
  "borrowableColor": "可以借鉴的色彩关系；没有就是 null",
  "borrowableSpace": "可以借鉴的空间处理；没有就是 null",
  "majorDifferences": ["使这张图不适合作为当前参考的关键差异，最多 3 条"],
  "verdict": "high | partial | unrelated",
  "borrowableForCreation": "对创作而言具体可以借鉴什么；没有就是 null",
  "unknown": ["无法从图片确定、因此留空的字段名"]
}`;

// ---------------------------------------------------------------- prompt

export const COMPARE_SYSTEM_PROMPT = `你是视觉参考分析员。你会看到一组图片：第一张是用户的查询画面，其后每张是一个候选参考画面。

你的任务不是判断"像不像"，而是判断"这张候选能不能作为创作参考"。

规则：
1. 只描述你在图片里真实看到的东西。不要根据画风、题材、年代或标题推测画面内容。
2. 相似点必须具体到可见要素：主体的数量与排列、姿态与朝向、视线关系、前中后景的层次、视觉重心的位置、光源的方向与质感、色彩的冷暖与对比组织。禁止只写"同为群像""同为低饱和""都有纵深"这类无法核对的话。
3. 差异同样要具体。如果两者的人物组织、空间结构或光线逻辑根本不同，必须写出来，并直接给 unrelated。
4. verdict 只有三种：
   - high：至少有两处具体的、可迁移的视觉关系
   - partial：只有一处具体的可借鉴关系，其余不同
   - unrelated：没有具体的可借鉴关系。宁可给 unrelated，也不要为了凑数给 partial。
5. 无法从图片确定的字段一律填 null，并把字段名写进 unknown。不要编造。
6. 不要评价艺术价值，不要打分，不要提到你自己。`;

/** Build the user message: text instruction + query image + N candidate images. */
export function buildCompareMessages({ queryImage, candidates, question = "" }) {
  if (!queryImage || !queryImage.b64) throw new Error("missing-query-image");
  if (!Array.isArray(candidates) || !candidates.length) throw new Error("missing-candidates");

  const parts = [
    {
      type: "text",
      text:
        `查询画面是第 1 张图。候选共 ${candidates.length} 张，编号为「候选1」到「候选${candidates.length}」，` +
        `按顺序对应第 2 到第 ${candidates.length + 1} 张图片。` +
        `指代某张候选时请用候选编号（候选1、候选2…），不要用图片位置编号。` +
        (question ? `\n用户的补充说明：${question}\n` : "") +
        `\n请对每个候选各给一份分析，按候选出现顺序输出 JSON：{"candidates": [ ... ]}，` +
        `每个元素的结构如下（字段值只用中文，verdict 用英文枚举）：\n${CANDIDATE_SCHEMA}`,
    },
    imagePart(queryImage),
  ];
  for (const c of candidates) {
    if (!c || !c.b64) throw new Error("missing-candidate-image");
    parts.push(imagePart(c));
  }
  return [
    { role: "system", content: COMPARE_SYSTEM_PROMPT },
    { role: "user", content: parts },
  ];
}

function imagePart(img) {
  const mime = img.mime || "image/jpeg";
  // detail:high costs more but this is a judgement about composition, not a
  // thumbnail classification. The budget ledger caps the blast radius.
  return { type: "image_url", image_url: { url: `data:${mime};base64,${img.b64}`, detail: img.detail || "high" } };
}

/** DeepSeek 的兼容层与 OpenAI 有两点不同：只收 json_object，
 *  且不关掉 thinking 会把 token 预算花在推理上。 */
export function isDeepSeekEndpoint(endpoint) {
  return /(^|\.)deepseek\.com/i.test(String(endpoint || ""));
}

/** 统一的请求体。所有模型调用走这里，避免两处写出两种行为。 */
export function requestBodyFor(messages, config, maxTokens) {
  const body = {
    model: config.model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  if (isDeepSeekEndpoint(config.endpoint)) body.thinking = { type: "disabled" };
  return body;
}

// ---------------------------------------------------------------- call

/**
 * One comparison call. Caller owns budgeting so a caller that batches can
 * reserve once and reuse; pass `{ reserve: true }` to let this function do it.
 */
export async function compareImages({
  queryImage,
  candidates,
  config,
  question = "",
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  reserve = false,
} = {}) {
  if (!config || !config.configured) {
    return { ok: false, error: COMPARE_ERRORS.NOT_CONFIGURED, detail: "VISION_API_BASE / VISION_API_KEY / VISION_MODEL 未配置" };
  }
  if (config.roundLimit > 0 && config.used >= config.roundLimit) {
    return { ok: false, error: COMPARE_ERRORS.LIMIT, detail: `本轮上限 ${config.roundLimit} 次已用完` };
  }
  if (reserve) {
    const gate = reserveCall(config.budget, clock(), { requireLedger: true });
    if (!gate.allowed) {
      return { ok: false, error: COMPARE_ERRORS.BUDGET, detail: gate.code || "budget-refused" };
    }
  }

  let messages;
  try {
    messages = buildCompareMessages({ queryImage, candidates, question });
  } catch (e) {
    return { ok: false, error: COMPARE_ERRORS.BAD_SHAPE, detail: e.message };
  }

  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.credential}` },
      body: JSON.stringify(requestBodyFor(messages, config, 2600)),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    const reason = e && e.name === "AbortError" ? COMPARE_ERRORS.TIMEOUT : COMPARE_ERRORS.NETWORK;
    return { ok: false, error: reason, detail: String(e && e.message).slice(0, 200), latencyMs: Date.now() - started };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: COMPARE_ERRORS.HTTP,
      status: res.status,
      detail: text.slice(0, 300),
      latencyMs: Date.now() - started,
    };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, error: COMPARE_ERRORS.BAD_JSON, latencyMs: Date.now() - started };
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: COMPARE_ERRORS.BAD_JSON, detail: "空的 message.content", latencyMs: Date.now() - started };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(content));
  } catch {
    return { ok: false, error: COMPARE_ERRORS.BAD_JSON, detail: content.slice(0, 200), latencyMs: Date.now() - started };
  }

  const normalized = parseComparison(parsed, candidates.length);
  if (!normalized.ok) {
    return { ok: false, error: COMPARE_ERRORS.BAD_SHAPE, detail: normalized.detail, latencyMs: Date.now() - started };
  }

  return {
    ok: true,
    judgments: normalized.judgments,
    dropped: normalized.dropped,
    usage: payload.usage || null,
    model: payload.model || config.model,
    promptVersion: PROMPT_VERSION,
    finishReason: payload?.choices?.[0]?.finish_reason || null,
    raw: content,          // 原始模型文本：只为本地复核，不上浏览器
    latencyMs: Date.now() - started,
  };
}

function stripFence(s) {
  const t = String(s).trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
}

/**
 * Normalize model output into judgments.
 *
 * Downgrades, rather than rejects, when the reason is thin: a `high` verdict
 * with zero concrete similarities becomes `partial`; with nothing at all it
 * becomes `unrelated`. Rejecting outright would waste the call and give the
 * caller nothing to inspect.
 */
export function parseComparison(parsed, expectedCount) {
  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : null;
  if (!list) return { ok: false, detail: "缺少 candidates 数组" };
  if (list.length !== expectedCount) {
    return { ok: false, detail: `候选数量不符：期望 ${expectedCount}，实得 ${list.length}` };
  }

  const judgments = [];
  const dropped = [];

  list.forEach((raw, i) => {
    const similar = toList(raw?.similarPoints).filter(isConcrete);
    const diffs = toList(raw?.majorDifferences).filter(Boolean);
    const verdict = normalizeVerdict(raw?.verdict);
    const unknown = toList(raw?.unknown).map(String);

    let finalVerdict = verdict;
    let note = null;
    if (verdict === VERDICTS.HIGH && similar.length < 2) {
      finalVerdict = similar.length === 1 ? VERDICTS.PARTIAL : VERDICTS.UNRELATED;
      note = "high 却给不出两处具体相似点，已降级";
    } else if (verdict === VERDICTS.PARTIAL && similar.length === 0) {
      finalVerdict = VERDICTS.UNRELATED;
      note = "partial 却给不出任何具体相似点，已降级";
    }
    if (finalVerdict === VERDICTS.UNRELATED && diffs.length === 0) {
      diffs.push("模型未给出具体差异");
    }

    const j = {
      index: i,
      verdict: finalVerdict,
      verdictFromModel: verdict,
      downgraded: Boolean(note),
      downgradeNote: note,
      similarPoints: similar,
      compositionEvidence: orNull(raw?.compositionEvidence),
      subjectRelationEvidence: orNull(raw?.subjectRelationEvidence),
      colorLightEvidence: orNull(raw?.colorLightEvidence),
      figureOrganization: orNull(raw?.figureOrganization),
      borrowableLight: orNull(raw?.borrowableLight),
      borrowableColor: orNull(raw?.borrowableColor),
      borrowableSpace: orNull(raw?.borrowableSpace),
      majorDifferences: diffs,
      borrowableForCreation: orNull(raw?.borrowableForCreation),
      unknown,
    };
    judgments.push(j);
    if (finalVerdict === VERDICTS.UNRELATED) dropped.push({ index: i, reasons: diffs });
  });

  return { ok: true, judgments, dropped };
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function orNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|unknown|无法确定|不确定)$/i.test(s)) return null;
  return s;
}

function normalizeVerdict(v) {
  const s = String(v || "").toLowerCase();
  if (s.includes("high") || s.includes("高度")) return VERDICTS.HIGH;
  if (s.includes("partial") || s.includes("部分")) return VERDICTS.PARTIAL;
  return VERDICTS.UNRELATED;
}

/**
 * A "concrete" similarity names something visible. A sentence that only
 * restates a category ("同为群像") is not evidence and is dropped here.
 */
export function isConcrete(text) {
  const s = String(text || "").trim();
  if (s.length < 6) return false;
  const vagueOnly = /^(同为|都是|均属|同属|都属于)?[^，。]{0,6}(群像|肖像|风景|静物|低饱和|高饱和|有纵深|有人物|古典|现代|暖色调|冷色调)[。]?$/;
  if (vagueOnly.test(s)) return false;
  // Must mention at least one observable: count, position, direction, layer,
  // light, colour relation, or a spatial term.
  const observable = /(数量|个|人|位|朝向|面向|视线|姿态|左|右|上|下|前|中|后|景|层|中心|重心|对角|水平|垂直|光|影|亮|暗|色|暖|冷|饱和|对比|深度|透视|排列|对称|留白|空间|边缘|轮廓)/;
  return observable.test(s);
}

// ---------------------------------------------------------------- step 2
// VisualAnalysis V2 — 单图理解。与 CANDIDATE_SCHEMA 同一套客观化纪律：
// 看不见就写 null 并列进 unknown，不用题材或年代推测构图。

export const ANALYSIS_V2_SCHEMA = `{
  "subject": {"description": "画面主体及其实数量", "count": 0},
  "figures": [{"pose": "姿态", "facing": "朝向", "relation": "与其他人物的关系"}],
  "space": {"foreground": "", "midground": "", "background": "", "depthCue": ""},
  "composition": {"skeleton": "构图骨架", "subjectPosition": "主体位置", "visualWeight": "视觉重心"},
  "color": {"dominant": "主要色彩关系", "temperature": "warm|cool|neutral", "contrast": "high|medium|low"},
  "light": {"direction": "光源方向", "quality": "硬/软、点/漫射", "organization": "明暗如何组织画面"},
  "scene": {"setting": "场景", "props": ["关键道具"]},
  "rendering": {"technique": "视觉表现方式", "texture": "肌理/笔触/颗粒"},
  "transferable": [{"method": "可迁移到 AIGC 创作的视觉方法", "why": "为什么有效"}],
  "unknown": ["无法从图片确定、因此留空的字段名"]
}`;

export const ANALYSIS_SYSTEM_PROMPT = `你是视觉分析员。你会看到一张图片。

只描述你在图里真实看到的东西。不要根据画风、题材、年代或标题推测画面内容；
看不到的都写 null，并把字段名放进 unknown。不要评价艺术价值，不要打分，
不要提到你自己。输出 JSON，字段结构见用户消息。`;

export function buildAnalysisMessages({ image }) {
  if (!image || !image.b64) throw new Error("missing-image");
  return [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `请按这个结构输出 JSON：\n${ANALYSIS_V2_SCHEMA}` },
        imagePart({ ...image, detail: image.detail || "high" }),
      ],
    },
  ];
}

/** Normalize an analysis result. Never invents a value for a null field.
 *
 *  核心字段缺一不可：以前只要"有一个字段非空"就返回 ok，于是模型漏掉构图和光影
 *  也能被当成成功，下游拿到一堆 null 还以为是「本来就没有」。现在缺核心块就明确失败，
 *  并把缺了哪几个报出来。 */
export const CORE_ANALYSIS_BLOCKS = Object.freeze(["subject", "composition", "light", "space"]);

export function parseAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") return { ok: false, detail: "不是对象" };
  const unknown = toList(parsed.unknown).map(String);
  const out = {
    subject: {
      description: orNull(parsed.subject?.description),
      count: Number.isFinite(Number(parsed.subject?.count)) ? Number(parsed.subject.count) : null,
    },
    figures: Array.isArray(parsed.figures)
      ? parsed.figures.map((f) => ({
          pose: orNull(f?.pose),
          facing: orNull(f?.facing),
          relation: orNull(f?.relation),
        }))
      : [],
    space: pickFields(parsed.space, ["foreground", "midground", "background", "depthCue"]),
    composition: pickFields(parsed.composition, ["skeleton", "subjectPosition", "visualWeight"]),
    color: pickFields(parsed.color, ["dominant", "temperature", "contrast"]),
    light: pickFields(parsed.light, ["direction", "quality", "organization"]),
    scene: { setting: orNull(parsed.scene?.setting), props: toList(parsed.scene?.props) },
    rendering: pickFields(parsed.rendering, ["technique", "texture"]),
    transferable: Array.isArray(parsed.transferable)
      ? parsed.transferable.map((t) => ({ method: orNull(t?.method), why: orNull(t?.why) })).filter((t) => t.method)
      : [],
    unknown,
  };

  const present = {
    subject: Boolean(out.subject.description) || out.subject.count != null,
    composition: Boolean(out.composition.skeleton || out.composition.subjectPosition || out.composition.visualWeight),
    light: Boolean(out.light.direction || out.light.quality || out.light.organization),
    space: Boolean(out.space.foreground || out.space.midground || out.space.background || out.space.depthCue),
  };
  const missing = CORE_ANALYSIS_BLOCKS.filter((k) => !present[k]);
  if (missing.length) {
    return {
      ok: false,
      error: "incomplete-analysis",
      missing,
      detail: `核心字段缺失: ${missing.join(", ")}`,
      partial: out,
    };
  }
  return { ok: true, analysis: out };
}

function pickFields(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = orNull(obj && obj[k]);
  return out;
}

export async function analyzeImage({ image, config, fetchImpl = globalThis.fetch, clock = Date.now, reserve = false } = {}) {
  if (!config || !config.configured) {
    return { ok: false, error: COMPARE_ERRORS.NOT_CONFIGURED, detail: "provider 未配置" };
  }
  if (config.roundLimit > 0 && config.used >= config.roundLimit) {
    return { ok: false, error: COMPARE_ERRORS.LIMIT, detail: `本轮上限 ${config.roundLimit} 次已用完` };
  }
  if (reserve) {
    const gate = reserveCall(config.budget, clock(), { requireLedger: true });
    if (!gate.allowed) return { ok: false, error: COMPARE_ERRORS.BUDGET, detail: gate.code || "budget-refused" };
  }

  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.credential}` },
      body: JSON.stringify(requestBodyFor(buildAnalysisMessages({ image }), config, 1800)),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    const reason = e && e.name === "AbortError" ? COMPARE_ERRORS.TIMEOUT : COMPARE_ERRORS.NETWORK;
    return { ok: false, error: reason, detail: String(e && e.message).slice(0, 200), latencyMs: Date.now() - started };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: COMPARE_ERRORS.HTTP, status: res.status, detail: text.slice(0, 300), latencyMs: Date.now() - started };
  }
  const payload = await res.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return { ok: false, error: COMPARE_ERRORS.BAD_JSON, latencyMs: Date.now() - started };
  let parsed;
  try { parsed = JSON.parse(stripFence(content)); }
  catch { return { ok: false, error: COMPARE_ERRORS.BAD_JSON, detail: content.slice(0, 200), latencyMs: Date.now() - started }; }
  const normalized = parseAnalysis(parsed);
  if (!normalized.ok) return { ok: false, error: COMPARE_ERRORS.BAD_SHAPE, detail: normalized.detail, latencyMs: Date.now() - started };
  return {
    ok: true,
    analysis: normalized.analysis,
    usage: payload.usage || null,
    model: payload.model || config.model,
    promptVersion: PROMPT_VERSION,
    finishReason: payload?.choices?.[0]?.finish_reason || null,
    raw: content,          // 原始模型文本：只为本地复核，不上浏览器
    latencyMs: Date.now() - started,
  };
}

export { budgetStatus };
