// server/vision/openaiProvider.mjs
//
// SERVER-SIDE RESERVED — real multimodal vision provider (single,
// OpenAI-compatible chat-completions vision API). This module NEVER ships to
// the browser. In P2.1 it will be mounted behind a same-origin POST /api/vision
// bridge; secret slot names are server-held only:
//   VISION_API_BASE / VISION_API_KEY / VISION_MODEL
// (loaded from the server process env, never from env.js / VITE_* / public /
// dist / localStorage).
//
// Scope: observable visual structure only. Identity / story / psychology /
// intent / symbolism / genre / "artist X style" are out of scope. Uncertain
// fields are null — nothing is padded.
//
// Contract: async callVisionProvider(fileLike, config, opts)
//   -> { ok: true, raw: <object>, latencyMs } | { ok: false, error, reason }

export const VISION_ERRORS = {
  UNSUPPORTED: "unsupported-format",
  TOO_LARGE: "too-large",
  FAILED: "vision-failed",
  INCOMPLETE: "incomplete",
  EMPTY: "empty-intent",
};

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_LIST_ITEMS = 3;

// ---- Server-side config (env only) ----------------------------------------//

export function serverVisionConfig(env = process.env, has = (n) => n !== undefined && n !== "") {
  const use = (name, dflt = "") => (has(env[name]) ? env[name] : dflt);
  // P3.1：Mock Provider 模式下视作「Provider 已配置」。
  //
  // 为什么必须这样：visionConfigured() 是预算 fail-closed 与轮次上限的**上游前提**。
  // 若 mock 不算已配置，桥接层在 provider-not-configured 就返回，后面那些门禁
  // 永远走不到，演练就变成测了个寂寞（第一版正是如此，19 条断言全红）。
  //
  // 这里填**哨兵值**而非凭据：mock 在任何 fetch 之前短路返回，
  // Authorization 头永远不会带上它。
  const mock = mockScenario(env);
  if (mock && !has(env.VISION_API_BASE)) {
    return { endpoint: `mock://${mock}`, credential: "mock-sentinel-not-a-secret", model: `mock:${mock}`, mock };
  }
  const config = {
    endpoint: use("VISION_API_BASE"),
    credential: use("VISION_API_KEY"),
    model: use("VISION_MODEL", DEFAULT_MODEL),
  };
  if (mock) config.mock = mock;
  return config;
}

// One accessor for the credential slot, so no caller has to spell it as an
// object-literal key. Accepts both the `credential` shape produced above and a
// legacy `apiKey` property supplied by any other caller.
export function credentialOf(config) {
  if (!config || typeof config !== "object") return "";
  return config.credential || config.apiKey || "";
}

export function visionConfigured(config) {
  return !!(config && config.endpoint && credentialOf(config));
}

// ---- Structured-output schema (mirrors normalizeVisionIntent whitelist) ----//

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

const FIELD_DESCRIPTIONS = {
  subject: "画面主体类型：single-figure 单人 / figure 人物 / portrait 肖像 / group 多人 / place 场所 / none 无明确主体",
  subjectScale: "主体在画面中的体量：small 小 / medium 中等 / large 大",
  subjectPosition: "主体位置：low 下方 / center 居中 / high 上方 / edge 边缘",
  spatialDepth: "空间纵深感：deep 深远 / shallow 扁平",
  negativeSpace: "留白程度：high 大量留白 / low 很少留白",
  environmentDominance: "环境是否主导画面：high 环境主导 / low 环境次要",
  lightDirection: "主光方向：side 侧光 / back 逆光 / front 顺光 / top 顶光",
  lightQuality: "光线质感：diffuse 柔和散射 / directional 硬朗直射 / rim 轮廓光",
  colorTemperature: "色温：cool 冷 / warm 暖 / neutral 中性",
  saturation: "饱和度：low / medium / high",
  contrast: "对比度：low / medium / high",
  humanRelation: "画面人物关系：isolated 孤立 / together 相伴 / crowd 人群",
  cameraDistance: "镜头距离：far 远景 / medium 中景 / near 近景",
  cameraHeight: "机位高度：low 低机位 / eye 平视 / high 俯视",
  cameraRelation: "镜头与主体的关系：observational 旁观 / immersive 沉浸 / confrontational 直面",
  motion: "运动感：still 静止 / moving 动态",
  visualDensity: "画面信息密度：sparse 稀疏 / dense 密集",
  arousal: "情绪唤起强度：low / medium / high",
  socialDistance: "人际疏离感：low 贴近 / medium 中等 / high 疏离",
  melancholy: "忧郁感：low / medium / high",
};

const EMOTION_TOKENS = ["平静", "悲伤", "孤独", "喜悦", "敬畏", "不安", "温暖"];
const ATMOSPHERE_TOKENS = ["空旷", "寂静", "夜晚", "雾", "热闹", "阴郁"];

function buildSchema() {
  const properties = {};
  for (const [field, values] of Object.entries(ENUM_FIELDS)) {
    properties[field] = {
      type: ["string", "null"],
      enum: values,
      description: FIELD_DESCRIPTIONS[field] || "",
    };
  }
  properties.emotion = {
    type: "array",
    maxItems: MAX_LIST_ITEMS,
    items: { type: "string", enum: EMOTION_TOKENS },
    description: "仅在表情/姿态明确可读时填写，最多 3 项。",
  };
  properties.atmosphere = {
    type: "array",
    maxItems: MAX_LIST_ITEMS,
    items: { type: "string", enum: ATMOSPHERE_TOKENS },
    description: "仅限明确可读的整体氛围，最多 3 项。",
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [...Object.keys(ENUM_FIELDS), "emotion", "atmosphere"],
    properties,
  };
}

const SYSTEM_PROMPT = [
  "你是视觉结构提取器。你只描述画面中可以直接观察到的视觉结构，严格依据给定枚举输出 JSON，不做任何推断。",
  "硬性规则：",
  "1. 只输出你高度确定的字段；不确定的字段必须返回 null。绝不为了填满 schema 而编造。",
  "2. 严禁推断以下内容：人物身份、国籍、年代、故事、情节、心理状态、创作意图、象征意义、隐喻、艺术流派、媒介、技法名称、或“像某位艺术家/某部作品”。",
  "3. 所有字段值只能来自枚举；列表字段最多 3 项且只填明确可读的。",
  "4. 如果整张图完全无法读取，全部返回 null。",
].join("\n");

// ---- Provider dialect (P2.7) -----------------------------------------------//
// The frozen contract is OpenAI-compatible chat-completions carrying a strict
// json_schema response_format. DeepSeek's /chat/completions accepts ONLY
// `text` or `json_object` in that slot — a json_schema body is refused with
// HTTP 400 (measured through the bridge: `upstream-request`, status 400).
// DeepSeek also defaults to thinking mode, which spends the output budget on
// reasoning before the answer.
//
// The dialect is therefore selected BY ENDPOINT and only for DeepSeek:
// json_object mode, thinking disabled, and a prompt that spells the whole
// object out (json_object carries no schema). Every other provider keeps the
// exact frozen request shape, untouched.
//
// Nothing here repairs or fabricates a field: the VisualIntent validator
// downstream still demands all 22 keys, the exact enums and the list rules, so
// a non-conforming answer keeps failing closed.
function isDeepSeekEndpoint(endpoint) {
  try {
    const host = new URL(String(endpoint)).hostname.toLowerCase();
    return host === "deepseek.com" || host.endsWith(".deepseek.com");
  } catch {
    return false;
  }
}

// json_object mode enforces no schema, so the field list must live in the
// prompt. It is DERIVED from the same ENUM_FIELDS / FIELD_DESCRIPTIONS tables
// that build the strict schema, so the two dialects cannot drift apart.
function buildDeepSeekSystemPrompt() {
  const lines = [
    SYSTEM_PROMPT,
    "",
    "输出格式（必须严格遵守）：",
    "1. 只输出一个完整的 JSON 对象。不要 markdown 代码块，不要任何解释文字，不要输出第二个对象或重复对象。",
    "2. 该对象必须且只能包含以下 22 个键，键名必须完全一致：",
  ];
  for (const [field, values] of Object.entries(ENUM_FIELDS)) {
    lines.push(`   - ${field}: ${values.join(" / ")}，或 null（${FIELD_DESCRIPTIONS[field] || ""}）`);
  }
  lines.push(
    `   - emotion: 数组，最多 ${MAX_LIST_ITEMS} 项，取值仅限 ${EMOTION_TOKENS.join(" / ")}；无则填空数组 []`,
    `   - atmosphere: 数组，最多 ${MAX_LIST_ITEMS} 项，取值仅限 ${ATMOSPHERE_TOKENS.join(" / ")}；无则填空数组 []`,
    "3. 22 个键必须全部出现；不确定的键填 null，不得省略、不得用空字符串代替。",
    "4. 除上述键之外不得增加任何字段。"
  );
  return lines.join("\n");
}

// ---- Provider call ---------------------------------------------------------//

const TRANSIENT_REASONS = new Set(["network", "timeout", "server"]);

// P3.1：实验模式关闭全部自动重试。
//
// 原来这段会静默再发一次：
//     if (!result.ok && TRANSIENT_REASONS.has(result.reason)) result = await attempt();
// 静默重试有两个问题，实验里都不能接受：
//   1. 成本。桥接层只在**发请求前**预留一次预算，所以一次逻辑失败会变成两次
//      上游计费，而账本只记 1 次 —— 账本与账单从此对不上。
//   2. 验收。任务书要求「失败仍计入实际调用记录、不自动重试」；只要还留着这行，
//      「最多 4 次尝试」就名不副实。
//
// VISION_NO_RETRY=1 关闭它。默认保持原行为，避免改变既有部署的语义；
// 本轮实验实例会显式设上这个变量。
function retrySuppressed(env = process.env) {
  return env.VISION_NO_RETRY === "1";
}

// ---- Mock Provider（P3.1 第三阶段：零费用模拟）---------------------------//
//
// 只在 VISION_PROVIDER_MOCK 被显式设置时生效，**不发任何网络请求**，
// 用来演练失败形态：超时 / 非法 JSON / 重复对象 / 上游 429 / 网络错误 /
// schema 违规 / 正常返回。
//
// 为什么需要它：上面那条静默重试只有真发一次请求才会暴露，而真请求要花钱。
// 用 mock 数「实际尝试次数」，才能在不花钱的前提下证明「超时没有触发第二次」。
//
// 安全边界：
//   · 默认不启用（没有这个环境变量就是普通 provider）
//   · mock 路径不读取凭据、不带 Authorization 头、不碰网络
//   · 每次尝试打一行 [fa-vision-mock] 日志，便于从 stdout 数尝试次数
export const MOCK_SCENARIOS = ["ok", "timeout", "network", "invalid-json", "duplicate", "quota", "auth", "bad-enum"];
const MOCK_ATTEMPTS = { n: 0 };

function mockScenario(env = process.env) {
  const raw = env.VISION_PROVIDER_MOCK;
  if (!raw) return null;
  return MOCK_SCENARIOS.includes(raw) ? raw : null;
}

// 一个字段齐全但全部不确定的对象：用于验证 validator 的 fail-closed 行为。
const MOCK_INTENT_ALL_NULL = {
  subject: null, subjectScale: null, subjectPosition: null, spatialDepth: null,
  negativeSpace: null, environmentDominance: null, lightDirection: null, lightQuality: null,
  colorTemperature: null, saturation: null, contrast: null, humanRelation: null,
  cameraDistance: null, cameraHeight: null, cameraRelation: null, motion: null,
  visualDensity: null, arousal: null, socialDistance: null, melancholy: null,
  emotion: [], atmosphere: [],
};

// 一个「看起来很认真」的合规对象：用于验证成功路径与 schema 合法。
const MOCK_INTENT_OK = { ...MOCK_INTENT_ALL_NULL, subject: "place", negativeSpace: "high", colorTemperature: "cool" };

async function mockCall(scenario, { timeoutMs = 45000 } = {}) {
  MOCK_ATTEMPTS.n += 1;
  const n = MOCK_ATTEMPTS.n;
  const started = Date.now();
  const log = (kind) => console.log(`[fa-vision-mock] scenario=${scenario} attempt=${n} ${kind}`);
  switch (scenario) {
    case "timeout": {
      // 挂到调用方超时为止，模拟上游不返回也不报错。
      log("hang-until-timeout");
      await new Promise((resolve) => setTimeout(resolve, timeoutMs + 5000));
      return outcome(false, "timeout", {});
    }
    case "network":
      log("network-error");
      return outcome(false, "network", {});
    case "quota":
      log("upstream-429");
      return outcome(false, "quota", { status: 429 });
    case "auth":
      log("upstream-401");
      return outcome(false, "auth", { status: 401 });
    case "invalid-json":
      // 真实链路里「HTTP 200 但内容不是 JSON」会落到 parse 失败分支，返回
      // reason=invalid-json。mock 复现**同一个 outcome**，否则测的是 mock 自己
      // 发明的形状，桥接层的错误码路径根本没被验证。
      log("invalid-json");
      return outcome(false, "invalid-json", { status: 200 });
    case "duplicate":
      // P2.7.1：重复对象同样 fail closed 为 invalid-json（绝不合并两份 JSON）。
      log("duplicated-json-object");
      return outcome(false, "invalid-json", { status: 200, duplicated: true });
    case "bad-enum":
      log("schema-violation");
      return { ok: true, raw: { ...MOCK_INTENT_OK, colorTemperature: "coldish" }, latencyMs: Date.now() - started };
    case "ok":
    default:
      log("ok");
      return { ok: true, raw: { ...MOCK_INTENT_OK }, latencyMs: Date.now() - started };
  }
}

export function mockAttemptCount() {
  return MOCK_ATTEMPTS.n;
}

export async function callVisionProvider(fileLike, config, { timeoutMs = 45000, inputW = 0, inputH = 0 } = {}) {
  const mock = mockScenario();
  if (mock) return mockCall(mock, { timeoutMs });

  const b64 = await fileLikeToBase64(fileLike);
  const mime = fileLike && fileLike.type && fileLike.type !== "application/octet-stream" ? fileLike.type : "image/jpeg";
  const started = Date.now();

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentialOf(config)}` },
        body: JSON.stringify(requestBody(mime, b64, config)),
        signal: controller.signal,
      });
      const status = res.status;
      if (status === 401 || status === 403) return outcome(false, "auth", { status });
      if (status === 429) return outcome(false, "quota", { status });
      if (status >= 500) return outcome(false, "server", { status });
      if (status !== 200) return outcome(false, "request", { status });
    const text = await res.text();

// P6.3.2 / E15 — raw provider payloads are user-derived content and must never
// reach a log sink. Structural facts only; no content preview.
console.log("[vision-debug]", {
  status,
  contentType: res.headers.get("content-type"),
  bodyBytes: text.length,
});

let data;
try {
  data = JSON.parse(text);
} catch {
  // P2.5 diagnostic (read-only; normal behavior unchanged). L1 — provider
// HTTP 200 but transport body is not valid JSON.
  diag("transport-invalid", {
    contentType: res.headers.get("content-type"),
    bodyBytes: text.length,
    bodyLooksHtml: /^\s*</.test(text),
    bodyEmpty: text.trim().length === 0,
    // P6.3.2 / E15 — no content preview. Structural facts only.
  });
  return outcome(false, "invalid-json", { status });
}
      const content =
        data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== "string" || !content.trim()) {
        // P2.5 diagnostic (read-only). Confirms B/C shape: outer JSON valid
        // but choices/message/content missing or empty.
        const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || null;
        diag("content-empty", {
          contentType: res.headers.get("content-type"),
          outerJsonValid: true,
          topLevelKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 12) : [],
          choicesCount: Array.isArray(data && data.choices) ? data.choices.length : 0,
          finishReason: data && data.choices && data.choices[0] ? (data.choices[0].finish_reason ?? null) : null,
          messageKeys: msg && typeof msg === "object" ? Object.keys(msg) : [],
          contentValue: content === null ? "null" : typeof content,
          refusalPresent: !!(msg && typeof msg.refusal === "string" && msg.refusal !== ""),
          usage: pickUsage(data),
        });
        return outcome(false, "empty-response", { status });
      }
      let raw;
      try {
        raw = JSON.parse(stripFence(content));
      } catch (parseErr) {
        // P2.7.1 — a malformed answer is REJECTED, never repaired. This includes
        // the duplicated-JSON-object shape (`{...}{...}`): the contract is ONE
        // complete object, and merging a second object would fabricate fields
        // the model never returned. The answer fails closed as `invalid-json`
        // and the FIND UI falls back to text input. `detectDuplicatedJsonObject`
        // only CLASSIFIES the defect for the log — it never yields a value.
        const stripped = stripFence(content);
        const dup = detectDuplicatedJsonObject(stripped);
        const err = parseErr && typeof parseErr === "object" ? parseErr : new Error(String(parseErr));
        const at = locateSyntaxDefect(stripped, err);
        const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || null;
        diag("syntax-defect", {
          contentType: res.headers.get("content-type"),
          outerJsonValid: true,
          choicesCount: Array.isArray(data && data.choices) ? data.choices.length : 0,
          finishReason: data && data.choices && data.choices[0] ? (data.choices[0].finish_reason ?? null) : null,
          contentLength: typeof content === "string" ? content.length : -1,
          refusalPresent: !!(msg && typeof msg.refusal === "string" && msg.refusal !== ""),
          usage: pickUsage(data),
          innerJsonValid: false,
          duplicatedObject: dup.duplicated,
          parseErrorName: err && err.name ? err.name : null,
          parseErrorMessage: err && err.message ? err.message : null,
          position: at.position,
          line: at.line,
          column: at.column,
          // P6.3.2 / E15 — localContext/carets would echo the offending
          // payload (user-derived). Position facts are enough to locate it.
        });
        return outcome(false, "invalid-json", { status });
      }
      // P2.5 diagnostic (read-only) — symmetric structure record for the
      // CONTROL (successful) sample so the divergence point is visible.
      const msgOk = (data && data.choices && data.choices[0] && data.choices[0].message) || null;
      diag("content-ok", {
        contentType: res.headers.get("content-type"),
        outerJsonValid: true,
        topLevelKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 12) : [],
        choicesCount: Array.isArray(data && data.choices) ? data.choices.length : 0,
        finishReason: data && data.choices && data.choices[0] ? (data.choices[0].finish_reason ?? null) : null,
        messageKeys: msgOk && typeof msgOk === "object" ? Object.keys(msgOk) : [],
        contentLength: typeof content === "string" ? content.length : -1,
        refusalPresent: !!(msgOk && typeof msgOk.refusal === "string" && msgOk.refusal !== ""),
        usage: pickUsage(data),
        innerJsonValid: true,
      });
      return { ok: true, raw, latencyMs: Date.now() - started };
    } catch (err) {
      const reason = err && err.name === "AbortError" ? "timeout" : "network";
      return outcome(false, reason, {});
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await attempt();
  if (!result.ok && !retrySuppressed() && TRANSIENT_REASONS.has(result.reason)) {
    console.log(`[fa-vision-server] transient-retry reason=${result.reason} suppressed=false`);
    result = await attempt();
  }

  logVision({
    model: config.model,
    latencyMs: Date.now() - started,
    inputW,
    inputH,
    bytes: Math.round((b64.length * 3) / 4),
    ok: result.ok,
    reason: result.ok ? "" : result.reason,
  });
  return result;
}

// Exported so the dialect can be asserted offline, without a provider call.
export function requestBody(mime, b64, config) {
  const deepseek = isDeepSeekEndpoint(config.endpoint);
  const body = {
    model: config.model,
    temperature: 0,
    max_tokens: 2048,
    response_format: deepseek
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: { name: "visual_intent", strict: true, schema: buildSchema() } },
    messages: [
      { role: "system", content: deepseek ? buildDeepSeekSystemPrompt() : SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: deepseek
              ? "请分析这张图片的视觉结构，严格按上述字段说明输出单个完整 JSON 对象。"
              : "请分析这张图片的视觉结构，严格按 schema 输出 JSON。",
          },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}`, detail: "low" } },
        ],
      },
    ],
  };
  // Thinking mode would spend the token budget on reasoning before the answer;
  // this task wants the object only. DeepSeek-only field.
  if (deepseek) body.thinking = { type: "disabled" };
  return body;
}

function outcome(ok, reason, extra) {
  return { ok, error: ok ? undefined : VISION_ERRORS.FAILED, reason, ...extra };
}

function stripFence(content) {
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : content.trim();
}

function logVision(entry) {
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug("[fa-vision-server]", JSON.stringify(entry));
  }
}

// ---- P2.5 read-only diagnostics (temporary; safe to remove later) ----------//
// Emits structural facts about a failed provider response to server stdout.
// NEVER logs: request headers, image payload, full response, or secrets.
// Behavior of the normal path is unchanged.

function diag(kind, entry) {
  if (typeof console !== "undefined" && typeof console.log === "function") {
    console.log("[fa-vision-diag]", kind, JSON.stringify(entry));
  }
}

function pickUsage(data) {
  if (!data || typeof data !== "object" || !data.usage || typeof data.usage !== "object") return null;
  const u = data.usage;
  return {
    promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
    completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
  };
}

function safeSnippet(s, max, tail = false) {
  if (typeof s !== "string") return null;
  const masked = s.replace(/[A-Za-z0-9_\-]{40,}/g, "[LONGTOKEN]");
  const c = masked.replace(/\s+/g, " ").trim();
  if (c.length <= max) return c;
  return tail ? "…" + c.slice(-max) : c.slice(0, max) + "…";
}

// P2.6 — locate the exact JSON syntax defect. Pure function, offline:
// computes position / line / column and a ±100 char context with carets.
function locateSyntaxDefect(text, err) {
  let pos = -1;
  if (err && typeof err.message === "string") {
    const m = err.message.match(/position\s+(\d+)/i) || err.message.match(/at position (\d+)/i);
    if (m) pos = Number(m[1]);
  }
  if (pos < 0) pos = (err && typeof err.offset === "number") ? err.offset : -1;
  if (pos < 0) pos = 0; // fall back to start when the engine gives no offset

  // V8 reports the error one char PAST the offending token in some cases; keep
  // the raw engine position and annotate (we do not second-guess the engine).
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n");

  const start = Math.max(0, pos - 100);
  const end = Math.min(text.length, pos + 100);
  const ctx = text.slice(start, end);
  const ctxLine = ctx.split("\n")[0];
  const caretOffset = Math.min(pos - start, ctxLine.length);

  return {
    position: pos,
    line,
    column: col,
    context: ctx.replace(/[^\x20-\x7E\u4e00-\u9fff]/g, "?"),
    carets: " ".repeat(caretOffset) + "^",
  };
}

// ---- P2.7.1 duplicate-object DETECTOR (classification only, never recovery) -//
// Pure function, no I/O. A response of the shape `{...}{...}` is a MALFORMED
// answer: the provider was asked for a SINGLE object. An earlier revision merged
// the two fragments into a success (`{...first, ...second}`), which fabricated
// fields the model never returned; that merge was removed. This function now
// only CLASSIFIES the defect so the diagnostic log can name it. It never returns
// the parsed fragments and never becomes a `raw` value: the caller always fails
// closed with `invalid-json`.
export function detectDuplicatedJsonObject(content) {
  const no = { duplicated: false };
  if (typeof content !== "string") return no;
  const text = content.trim();
  if (!text || text[0] !== "{") return no;

  // Scan the first complete JSON value, honoring string literals (escapes,
  // and braces inside strings do not count toward depth).
  let depth = 0;
  let inString = false;
  let endIndex = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") { i += 1; continue; } // skip the escaped char
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { endIndex = i; break; }
      if (depth < 0) return no;
    }
  }
  if (inString || depth !== 0 || endIndex < 0) return no;

  const firstFragment = text.slice(0, endIndex + 1);
  const remainingFragment = text.slice(endIndex + 1).trim();
  if (!remainingFragment) return no;

  let first;
  let second;
  try {
    first = JSON.parse(firstFragment);
    second = JSON.parse(remainingFragment);
  } catch {
    return no;
  }
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(first) || !isObject(second)) return no;

  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  return {
    duplicated: true,
    reason: "duplicated-json-object",
    firstKeys: firstKeys.length,
    secondKeys: secondKeys.length,
    conflicts: firstKeys.filter((k) => k in second).length,
  };
}

async function fileLikeToBase64(fileLike) {
  const buf = new Uint8Array(await fileLike.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}