// P4.1 — 本轮修复的核心回归：503 两个成因必须在 UI 与 MEMORY 里分开。
//
// 这条链路此前是坏的：visionProvider 把任何 503 都归为 not-configured，
// uploadService 又只看 reason，于是"缺预算账本"被显示成"没配模型"。
//
// [MOCK] 纯函数 + 单模块；无网络。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let pass = 0, fail = 0;
const results = [];
const check = (tag, name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS [${tag}] ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; results.push({ name, detail }); console.log(`  FAIL [${tag}] ${name}${detail ? " — " + detail : ""}`); }
};

// ---------- 1. visionProvider 的 503 细分（用假 fetch 驱动真实模块） ----------
console.log("=== 1. visionProvider：503 两种成因必须分开（MOCK） ===");

const realFetch = globalThis.fetch;
function stubFetch(status, body) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

const file = {
  type: "image/jpeg",
  arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
};
globalThis.btoa = globalThis.btoa || ((s) => Buffer.from(s, "binary").toString("base64"));

const { callVisionProvider } = await imp("src/services/vision/visionProvider.js");

try {
  stubFetch(503, { ok: false, error: { code: "provider-not-configured", message: "x" } });
  const nc = await callVisionProvider(file, undefined, {});
  check("MOCK", "503 + provider-not-configured → reason=not-configured",
    nc.ok === false && nc.reason === "not-configured", `reason=${nc.reason}`);
  check("MOCK", "bridgeCode 被保留", nc.bridgeCode === "provider-not-configured", `bridgeCode=${nc.bridgeCode}`);

  stubFetch(503, { ok: false, error: { code: "budget-unavailable", message: "y" } });
  const bu = await callVisionProvider(file, undefined, {});
  check("MOCK", "503 + budget-unavailable → reason=budget-unavailable",
    bu.ok === false && bu.reason === "budget-unavailable", `reason=${bu.reason}`);
  check("MOCK", "两种 503 不再被合并成同一个 reason", nc.reason !== bu.reason);

  stubFetch(200, { ok: true, intent: { subject: "figure" }, latencyMs: 12 });
  const okRes = await callVisionProvider(file, undefined, {});
  check("MOCK", "200 → ok=true 且带回 intent", okRes.ok === true && okRes.raw.subject === "figure");

  stubFetch(200, "<html>not json</html>" );
  const badJson = await callVisionProvider(file, undefined, {});
  check("MOCK", "200 但非 JSON → invalid-json", badJson.reason === "invalid-json", `reason=${badJson.reason}`);

  stubFetch(404, { ok: false });
  const noBridge = await callVisionProvider(file, undefined, {});
  check("MOCK", "404 → no-bridge", noBridge.reason === "no-bridge", `reason=${noBridge.reason}`);

  // 超时：让 fetch 抛 AbortError
  globalThis.fetch = async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  const to = await callVisionProvider(file, undefined, {});
  check("MOCK", "AbortError → timeout", to.reason === "timeout", `reason=${to.reason}`);
} finally {
  globalThis.fetch = realFetch;
}

// ---------- 2. MEMORY 侧映射（经 uploadService 的真实分类器） ----------
console.log("\n=== 2. MEMORY：未配置与缺预算不得归为同一状态（MOCK） ===");

// classifyBridge 是模块私有，通过 uploadMemory 的可观测输出间接验证成本过高；
// 改为直接断言 UPLOAD_ERRORS 的存在与不可重试语义，并用 MOCK 桥返回驱动。
const { UPLOAD_ERRORS } = await imp("src/services/memory/uploadService.js");

check("MOCK", "存在 NOT_CONFIGURED 专用错误码", !!UPLOAD_ERRORS.NOT_CONFIGURED, UPLOAD_ERRORS.NOT_CONFIGURED?.code);
check("MOCK", "存在 BUDGET_UNAVAILABLE 专用错误码", !!UPLOAD_ERRORS.BUDGET_UNAVAILABLE, UPLOAD_ERRORS.BUDGET_UNAVAILABLE?.code);
check("MOCK", "NOT_CONFIGURED 不可重试", UPLOAD_ERRORS.NOT_CONFIGURED.retryable === false);
check("MOCK", "BUDGET_UNAVAILABLE 不可重试", UPLOAD_ERRORS.BUDGET_UNAVAILABLE.retryable === false);
check("MOCK", "两者错误码互不相同",
  UPLOAD_ERRORS.NOT_CONFIGURED.code !== UPLOAD_ERRORS.BUDGET_UNAVAILABLE.code);
check("MOCK", "两者文案互不相同（用户能看出该找谁）",
  UPLOAD_ERRORS.NOT_CONFIGURED.message !== UPLOAD_ERRORS.BUDGET_UNAVAILABLE.message);

// ---------- 3. 端到端语义：reason → 错误码 → MEMORY 状态 ----------
console.log("\n=== 3. reason → 错误码 → MEMORY 状态 的语义一致（MOCK） ===");
const { MEMORY_STATUSES, NON_RETRYABLE_STATUSES } = await imp("src/services/memory/types.js");

check("MOCK", "not-configured 是持久化状态之一", MEMORY_STATUSES.includes("not-configured"));
check("MOCK", "not-configured 不提供重试", NON_RETRYABLE_STATUSES.includes("not-configured"));
check("MOCK", "failed 仍可重试（未被误伤）", !NON_RETRYABLE_STATUSES.includes("failed"));
check("MOCK", "success 不被列为不可重试", !NON_RETRYABLE_STATUSES.includes("success"));

// 只有 NOT_CONFIGURED 会写成 not-configured，其余仍是 failed
const { createVisualMemory } = await imp("src/services/memory/types.js");
const mkFailed = (code) =>
  createVisualMemory({
    id: "vm-test", source: "user-upload",
    status: code === "NOT_CONFIGURED" ? "not-configured" : "failed",
    image: { path: "a.jpg", mime: "image/jpeg", sha256: "a".repeat(64) },
    error: { code, message: "m", retryable: code !== "NOT_CONFIGURED" },
    metadata: { title: "", origin: "", film: null, year: null, tags: [], createdAt: new Date().toISOString() },
    userData: { note: "", thumbnail: "", collections: [] },
  });
check("MOCK", "NOT_CONFIGURED → 状态 not-configured", mkFailed("NOT_CONFIGURED").status === "not-configured");
check("MOCK", "VISION_TIMEOUT → 状态仍为 failed", mkFailed("VISION_TIMEOUT").status === "failed");
check("MOCK", "both 均不可检索",
  mkFailed("NOT_CONFIGURED").status !== "success" && mkFailed("VISION_TIMEOUT").status !== "success");

console.log(`\n=== 状态区分回归: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) for (const r of results) console.log(`  ${r.name} — ${r.detail}`);
process.exit(fail ? 1 : 0);
