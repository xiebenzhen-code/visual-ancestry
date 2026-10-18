// P6.3.2 — VisualIntent V1 validator (PRODUCTION)
//
// STATUS: 已接入生产 bridge（scripts/server.mjs）。
//        在 Provider 返回成功、Bridge 即将返回 HTTP 200 前执行严格校验。
//
// PURPOSE
//   修复 E08：此前 bridge 用 `intent: result.raw` 原样透传 provider 输出，
//   字段错位也返回 200 / ok:true，错误 intent 会静默流入冻结核心模块。
//   本 validator 采用 fail-closed：任一违规即拒绝，不补齐、不清洗。
//
// SCOPE
//   - 输入：openaiProvider 的 result.raw（已 JSON.parse 的对象）
//   - 输出：{ ok, code, message, violations }
//   - 纯函数，无 I/O、无 env、无网络
//
// CONTRACT SOURCE
//   契约常量独立声明在此（方案 B），**不 import 冻结模块**，
//   以免触碰 openaiProvider.mjs 的冻结状态。
//   一致性由 work/p6.3.2/test/validator-selftest.mjs 保证：
//   该测试**执行**冻结模块捕获真实 schema 对象并逐项比对（不是正则匹配）。
//
// NOT IN SCOPE（明确不做）
//   ❌ 不修改冻结的 V1 schema（字段定义、枚举值、字段数量）
//   ❌ 不自动补齐缺失字段
//   ❌ 不自动清洗非法枚举
//   ❌ 不要求内部字段 source / composition / geometry
//   ❌ violations.detail 不得进日志或回传客户端

const MAX_LIST_ITEMS = 3;

const ENUM_FIELDS = {
  subject: ["single-figure", "figure", "portrait", "group", "place", "none"],
  subjectScale: ["small", "medium", "large"],
  subjectPosition: ["low", "center", "high", "edge"],
  spatialDepth: ["deep", "shallow"],
  negativeSpace: ["high", "low"],
  environmentDominance: ["high", "low"],
  lightDirection: ["side", "back", "front", "top"],
  lightQuality: ["diffuse", "directional", "rim"],
  colorTemperature: ["cool", "warm", "neutral"],
  saturation: ["low", "medium", "high"],
  contrast: ["low", "medium", "high"],
  humanRelation: ["isolated", "together", "crowd"],
  cameraDistance: ["far", "medium", "near"],
  cameraHeight: ["low", "eye", "high"],
  cameraRelation: ["observational", "immersive", "confrontational"],
  motion: ["still", "moving"],
  visualDensity: ["sparse", "dense"],
  arousal: ["low", "medium", "high"],
  socialDistance: ["low", "medium", "high"],
  melancholy: ["low", "medium", "high"],
};

const EMOTION_TOKENS = ["平静", "悲伤", "孤独", "喜悦", "敬畏", "不安", "温暖"];
const ATMOSPHERE_TOKENS = ["空旷", "寂静", "夜晚", "雾", "热闹", "阴郁"];

// The 22 required keys = 20 enum fields + emotion + atmosphere.
// NOTE: `source` is NOT here. It is injected browser-side by
// normalizeVisionIntent.js:49, never produced by the provider.
// `composition` / `geometry` exist in visualIntent.js but NOT in buildSchema() —
// receiving them from upstream means an unexpected field.
const REQUIRED_KEYS = [...Object.keys(ENUM_FIELDS), "emotion", "atmosphere"];
const ALLOWED_KEYS = new Set(REQUIRED_KEYS);

const LIST_FIELDS = {
  emotion: EMOTION_TOKENS,
  atmosphere: ATMOSPHERE_TOKENS,
};

function violation(rule, detail) {
  return { rule, detail };
}

/**
 * Validate a provider response against VisualIntent V1.
 * Fail-closed: any violation returns ok:false with a machine-readable code.
 */
export function validateVisualIntent(raw) {
  const violations = [];

  // Rule 1 — must be a non-array object.
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      code: "intent-not-an-object",
      message: "上游返回的不是 JSON 对象。",
      violations: [violation("R1", typeof raw)],
    };
  }

  const keys = Object.keys(raw);

  // Rule 2 — all 22 required keys must be PRESENT. Absence is a failure;
  // we never fill defaults.
  const missing = REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    violations.push(violation("R2", `missing keys: ${missing.join(", ")}`));
  }

  // Rule 3 — no additional properties (additionalProperties: false).
  const extra = keys.filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length > 0) {
    violations.push(violation("R3", `unexpected keys: ${extra.join(", ")}`));
  }

  // Rule 4 — each enum field must be null, or a string inside ITS OWN list.
  const badTypes = [];
  const badEnums = [];
  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    if (!(field in raw)) continue; // absence already reported by R2
    const value = raw[field];
    if (value === null) continue;          // null is a legal value
    if (typeof value !== "string") {        // Rule 4a — type
      badTypes.push(`${field}=${JSON.stringify(value)}`);
      continue;
    }
    if (!allowed.includes(value)) {         // Rule 4b — enum membership
      badEnums.push(`${field}=${JSON.stringify(value)}`);
    }
  }
  if (badTypes.length) violations.push(violation("R4a", `invalid type: ${badTypes.join("; ")}`));
  if (badEnums.length) violations.push(violation("R4b", `invalid enum: ${badEnums.join("; ")}`));

  // Rules 5 & 6 — lists: Array, length <= MAX, every item whitelisted.
  const badLists = [];
  const badTokens = [];
  for (const [field, allowed] of Object.entries(LIST_FIELDS)) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (!Array.isArray(value)) {
      badLists.push(`${field} is ${Array.isArray(value) ? "array" : typeof value}, not Array`);
      continue;
    }
    if (value.length > MAX_LIST_ITEMS) {
      badLists.push(`${field} has ${value.length} items (max ${MAX_LIST_ITEMS})`);
    }
    for (const item of value) {
      if (typeof item !== "string" || !allowed.includes(item)) {
        badTokens.push(`${field}: ${JSON.stringify(item)}`);
      }
    }
  }
  if (badLists.length) violations.push(violation("R5", badLists.join("; ")));
  if (badTokens.length) violations.push(violation("R6", badTokens.join("; ")));

  if (violations.length > 0) {
    // First violation decides the machine-readable code (stable precedence).
    const byRule = { R1: "intent-not-an-object", R2: "intent-missing-fields", R3: "intent-unexpected-fields", R4a: "intent-invalid-type", R4b: "intent-invalid-enum", R5: "intent-invalid-type", R6: "intent-invalid-token" };
    const first = violations[0];
    let code = "intent-invalid";
    for (const v of violations) { if (byRule[v.rule]) { code = byRule[v.rule]; break; } }
    if (first.rule === "R5" && violations.some((v) => v.rule === "R5")) {
      const onlyTooMany = violations.filter((v) => v.rule === "R5").every((v) => v.detail.includes("items (max"));
      if (onlyTooMany && violations.length === 1) code = "intent-too-many-items";
    }
    return { ok: false, code, message: `VisualIntent V1 校验失败（${violations.length} 项）。`, violations };
  }

  return { ok: true, code: null, message: null, violations: [] };
}

// ---- LOG SAFETY ------------------------------------------------------------
// The validator NEVER returns raw model output or user data. Its verdict carries
// only a machine code, a generic message, and RULE-LEVEL counts.
// `violations[].detail` may contain user-derived enum values, so it is kept for
// in-process assertions ONLY and is explicitly marked unsafe for logging.
//
// Log-safe summary shape (the ONLY thing that may reach a log sink):
//   { code, ruleCounts: { R2: 1, R4b: 2 }, fieldCount: 22 }
// No values, no field names from user data, no raw content.
export function toLogSafeSummary(verdict) {
  const ruleCounts = {};
  for (const v of verdict.violations || []) {
    ruleCounts[v.rule] = (ruleCounts[v.rule] || 0) + 1;
  }
  return {
    code: verdict.code,
    ruleCounts,
    violationCount: (verdict.violations || []).length,
    // Field NAMES are contract constants (safe). Values never are.
    rulesTriggered: Object.keys(ruleCounts),
  };
}

export const CONTRACT = { REQUIRED_KEYS, ENUM_FIELDS, LIST_FIELDS, MAX_LIST_ITEMS };