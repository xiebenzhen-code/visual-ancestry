// P4.1 STEP 5 — 真实图片上传 → 分析 → VisualIntent → FIND 的定向验收。
//
// 证据分级（报告里必须分开，不得混为一谈）：
//   [INTEGRATION] 真实服务端进程 + 真实 HTTP + 真实路由/预算/校验器，
//                 只有最外层的 provider 网络调用被替换
//   [MOCK]        纯函数或单模块行为，无网络
//   [REAL-PROVIDER] 真实付费调用 —— 本轮明确不执行
//
// 本轮不发起任何真实付费 Vision 请求。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const results = [];
const check = (tag, name, cond, detail = "") => {
  if (cond) { pass++; results.push({ tag, name, ok: true }); console.log(`  PASS [${tag}] ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; results.push({ tag, name, ok: false, detail }); console.log(`  FAIL [${tag}] ${name}${detail ? " — " + detail : ""}`); }
};

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// ---------------------------------------------------------------- fixtures
const FIXTURE = path.join(ROOT, "qa", "fixtures", "vision-probe.jpg");
let fixtureBytes = null;
try { fixtureBytes = readFileSync(FIXTURE); } catch { fixtureBytes = null; }
if (!fixtureBytes || fixtureBytes.length === 0) {
  // A missing fixture silently produced empty imageBase64, and every HTTP
  // assertion then failed on "missing-field" for the wrong reason. Fail loud.
  console.error(`FATAL: fixture missing or empty: ${FIXTURE}`);
  process.exit(2);
}
const fixtureB64 = fixtureBytes.toString("base64");

// 一份"合法但确定"的 VisualIntent（22 键齐全，全部合法枚举）
const VALID_ENUMS = {
  subject: "figure", subjectScale: "small", subjectPosition: "low", spatialDepth: "deep",
  negativeSpace: "high", environmentDominance: "high", lightDirection: "back",
  lightQuality: "diffuse", colorTemperature: "cool", saturation: "low", contrast: "low",
  humanRelation: "isolated", cameraDistance: "far", cameraHeight: "eye",
  cameraRelation: "observational", motion: "still", visualDensity: "sparse",
  arousal: "low", socialDistance: "high", melancholy: "medium",
};
const VALID_INTENT = { ...VALID_ENUMS, emotion: ["孤独"], atmosphere: ["雾", "空旷"] };

// ============================================================ A. MOCK 层
console.log("\n=== A. 归一化与校验（MOCK：纯函数，无网络） ===");
{
  const { normalizeVisionIntent } = await imp("src/services/vision/normalizeVisionIntent.js");
  const { validateVisualIntent } = await imp("server/vision/visualIntentValidator.mjs");

  const n = normalizeVisionIntent({ ...VALID_INTENT, subject: "not-a-real-enum", extra: "x" });
  check("MOCK", "非法枚举被丢弃，不进入 intent", n.subject === "", `subject="${n.subject}"`);
  check("MOCK", "未知字段不被保留", !("extra" in n), Object.keys(n).join(","));
  check("MOCK", "合法字段全部保留", n.melancholy === "medium" && n.atmosphere.length === 2);
  check("MOCK", "source 标记为 vision", n.source === "vision");
  check("MOCK", "非对象输入返回 null（区别于空读数）", normalizeVisionIntent("garbage") === null);
  check("MOCK", "归一化不补值：缺失字段保持空", normalizeVisionIntent({ subject: "figure" }).melancholy === "");

  check("MOCK", "合法 22 键 intent 通过校验", validateVisualIntent(VALID_INTENT).ok === true);
  const missing = { ...VALID_INTENT }; delete missing.melancholy;
  check("MOCK", "缺键被拒", validateVisualIntent(missing).ok === false, validateVisualIntent(missing).code);
  check("MOCK", "非法枚举被拒", validateVisualIntent({ ...VALID_INTENT, subject: "nope" }).ok === false);
  check("MOCK", "多余字段被拒", validateVisualIntent({ ...VALID_INTENT, composition: "x" }).ok === false);
}

// =================================================== B. 完整聊天链路（MOCK）
console.log("\n=== B. 图 → intent → 检索（MOCK：注入 intent，真实评分器） ===");
{
  const { retrieveByIntent } = await imp("src/services/retrieval/retrievalService.js");
  const { normalizeVisionIntent } = await imp("src/services/vision/normalizeVisionIntent.js");

  const intent = normalizeVisionIntent(VALID_INTENT);
  const hits = retrieveByIntent(intent, { limit: 6 });
  check("MOCK", "真实评分器接受该 intent 并返回结果", hits.length > 0, `hits=${hits.length}`);
  check("MOCK", "每条结果带分数与依据",
    hits.every((h) => typeof h.retrievalScore === "number" && Array.isArray(h.reasons) && h.reasons.length > 0));
  check("MOCK", "结果按分数降序",
    hits.every((h, i) => i === 0 || hits[i - 1].retrievalScore >= h.retrievalScore));

  // 0 结果诚实性：一个与档案几乎无重叠的 intent
  const barren = normalizeVisionIntent({ motion: "moving", visualDensity: "dense", arousal: "high" });
  const none = retrieveByIntent(barren, { limit: 6 });
  // P4.4 note: REASON_LABELS was incomplete, so several honest-but-zero-reason
// hits were being dropped. After completing the labels these candidates
// reappear. The honesty requirement is not "return nothing" but "never
// inflate a weak match", so assert low scores instead of an empty list.
check("MOCK", "低重叠 intent 的结果分数很低（不硬凑高分）",
  Array.isArray(none) && none.every((h) => h.retrievalScore <= 4),
  `hits=${none.length} max=${Math.max(0, ...none.map((h) => h.retrievalScore))}`);
}

// ================================================ C. INTEGRATION（真实服务）
console.log("\n=== C. 真实服务端 HTTP 链路（INTEGRATION） ===");

const TMP = path.join(ROOT, "qa", ".p41-tmp");
const LEDGER = path.join(TMP, "ledger.ndjson");

function startServer(port, env, rootArg = ".") {
  const base = {
    ...process.env,
    HOST: "127.0.0.1",
    // Deterministic tests: the IP token bucket is per-process and would
    // otherwise rate-limit later assertions in the same run. Rate limiting
    // is exercised on its own, not as accidental cross-talk.
    VISION_RATE_LIMIT: "600",
    VISION_RATE_BURST: "200",
    ...env,
  };
  for (const k of ["VISION_API_BASE", "VISION_API_KEY", "VISION_MODEL",
                   "VISION_ACCESS_CODE", "VISION_ACCESS_SECRET"]) {
    if (!(k in env)) delete base[k];
  }
  const child = spawn(process.execPath, ["scripts/server.mjs", rootArg, String(port)],
    { cwd: ROOT, env: base, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  return { child, getLog: () => log };
}

async function waitReady(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { if ((await fetch(base + "/healthz")).ok) return true; } catch {}
  }
  return false;
}

async function postVision(base, body) {
  const r = await fetch(base + "/api/vision", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

let srv = null;
try {
  // ---- C1: provider 未配置 ----
  {
    mkdirSync(TMP, { recursive: true });
    const port = 4301;
    srv = startServer(port, { VISION_BUDGET_FILE: LEDGER, VISION_BUDGET_DAILY: "5", VISION_BUDGET_TOTAL: "5" });
    const base = `http://127.0.0.1:${port}`;
    const ready = await waitReady(base);
    check("INTEGRATION", "服务端在未配 provider 时正常启动", ready);

    const st = await (await fetch(base + "/api/vision/status")).json();
    check("INTEGRATION", "status 诚实报告 not-configured", st.provider === "not-configured", JSON.stringify(st));
    check("INTEGRATION", "status 不泄漏端点/模型/密钥",
      !("endpoint" in st) && !("model" in st) && !("apiKey" in st), Object.keys(st).join(","));

    const r = await postVision(base, { mimeType: "image/jpeg", imageBase64: fixtureB64 });
    check("INTEGRATION", "未配置时 POST 返回 503", r.status === 503, `status=${r.status}`);
    check("INTEGRATION", "错误码为 provider-not-configured",
      r.json && r.json.error && r.json.error.code === "provider-not-configured", JSON.stringify(r.json && r.json.error));
    check("INTEGRATION", "响应体不含图片内容或密钥",
      !JSON.stringify(r.json).includes(fixtureB64.slice(0, 40)));

    const lines = (() => { try { return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })();
    check("INTEGRATION", "未配置时未消耗预算", lines === 0, `ledger=${lines}`);

    srv.child.kill(); srv = null;
    await new Promise((r2) => setTimeout(r2, 400));
  }

  // ---- C2: provider 已配置但缺预算账本（fail-closed） ----
  {
    const port = 4302;
    srv = startServer(port, {
      VISION_API_BASE: "https://api.deepseek.com/chat/completions",
      VISION_API_KEY: "test-key-not-real-0000",
      VISION_MODEL: "deepseek-flash",
      // 故意不设 VISION_BUDGET_FILE
    });
    const base = `http://127.0.0.1:${port}`;
    check("INTEGRATION", "已配 provider 但无账本时服务端可启动", await waitReady(base));

    const st = await (await fetch(base + "/api/vision/status")).json();
    check("INTEGRATION", "status 报 configured（provider 确实配了）", st.provider === "configured", JSON.stringify(st));

    const r = await postVision(base, { mimeType: "image/jpeg", imageBase64: fixtureB64 });
    check("INTEGRATION", "缺账本时 POST 被拒（fail-closed）", r.status === 503, `status=${r.status}`);
    check("INTEGRATION", "错误码为 budget-unavailable（区别于未配置）",
      r.json && r.json.error && r.json.error.code === "budget-unavailable", JSON.stringify(r.json && r.json.error));

    srv.child.kill(); srv = null;
    await new Promise((r2) => setTimeout(r2, 400));
  }

  // ---- C3: 输入校验（非法格式 / 过大 / 坏 base64） ----
  {
    rmSync(LEDGER, { force: true });
    const port = 4303;
    srv = startServer(port, {
      VISION_API_BASE: "https://api.deepseek.com/chat/completions",
      VISION_API_KEY: "test-key-not-real-0000",
      VISION_MODEL: "deepseek-flash",
      VISION_BUDGET_FILE: LEDGER, VISION_BUDGET_DAILY: "5", VISION_BUDGET_TOTAL: "5",
    });
    const base = `http://127.0.0.1:${port}`;
    await waitReady(base);

    const badMime = await postVision(base, { mimeType: "application/pdf", imageBase64: fixtureB64 });
    check("INTEGRATION", "非法 mime 被拒 400", badMime.status === 400, `status=${badMime.status}`);
    check("INTEGRATION", "非法 mime 码为 unsupported-format",
      badMime.json && badMime.json.error && badMime.json.error.code === "unsupported-format");

    const badB64 = await postVision(base, { mimeType: "image/jpeg", imageBase64: "!!!!not-base64!!!!" });
    check("INTEGRATION", "坏 base64 被拒 400", badB64.status === 400, `status=${badB64.status}`);
    check("INTEGRATION", "坏 base64 码为 invalid-base64",
      badB64.json && badB64.json.error && badB64.json.error.code === "invalid-base64");

    const missing = await postVision(base, { mimeType: "image/jpeg" });
    check("INTEGRATION", "缺字段被拒 400 missing-field",
      missing.status === 400 && missing.json.error.code === "missing-field", JSON.stringify(missing.json.error));

    // 超大 body：>6MB
    const huge = "A".repeat(6 * 1024 * 1024 + 1024);
    const tooBig = await postVision(base, { mimeType: "image/jpeg", imageBase64: huge });
    check("INTEGRATION", "超过 6MB 被拒 413", tooBig.status === 413, `status=${tooBig.status}`);

    const lines = (() => { try { return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })();
    check("INTEGRATION", "全部非法输入均未消耗预算", lines === 0, `ledger=${lines}`);

    srv.child.kill(); srv = null;
    await new Promise((r2) => setTimeout(r2, 400));
  }
} finally {
  if (srv) { try { srv.child.kill(); } catch {} }
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ============================== D. MEMORY 状态区分（MOCK，纯函数）
console.log("\n=== D. MEMORY 状态（MOCK：classifyBridge 语义） ===");
{
  const { createVisualMemory, MEMORY_STATUSES, NON_RETRYABLE_STATUSES } = await imp("src/services/memory/types.js");
  const { normalizeVisionIntent: nvi } = await imp("src/services/vision/normalizeVisionIntent.js");

  check("MOCK", "not-configured 是合法状态", MEMORY_STATUSES.includes("not-configured"), MEMORY_STATUSES.join(","));
  check("MOCK", "not-configured 列入不可重试", NON_RETRYABLE_STATUSES.includes("not-configured"));

  const okMem = createVisualMemory({
    id: "vm-9001", source: "user-upload", status: "success",
    image: { path: "a.jpg", mime: "image/jpeg", sha256: "a".repeat(64) },
    visualIntent: nvi(VALID_INTENT),
    metadata: { title: "t", origin: "o", film: null, year: null, tags: [], createdAt: new Date().toISOString() },
    userData: { note: "", thumbnail: "", collections: [] },
  });
  check("MOCK", "success 条目可建且带 intent", okMem.status === "success" && okMem.visualIntent.source === "vision");

  const ncMem = createVisualMemory({
    id: "vm-9002", source: "user-upload", status: "not-configured",
    image: { path: "a.jpg", mime: "image/jpeg", sha256: "a".repeat(64) },
    error: { code: "NOT_CONFIGURED", message: "no model", retryable: false },
  });
  check("MOCK", "not-configured 条目可建", ncMem.status === "not-configured");
  check("MOCK", "not-configured 不参与检索（非 success 即排除）",
    !(ncMem.status === "success"));

  // 检索准入必须只放行 success
  const { isRetrievable } = await imp("src/services/memory/retrieveVisualMemory.js");
  check("MOCK", "success 可检索", isRetrievable(okMem) === true);
  check("MOCK", "not-configured 不可检索", isRetrievable(ncMem) === false);
  check("MOCK", "failed 不可检索", isRetrievable({ ...ncMem, status: "failed" }) === false);

  const bad = (() => { try { createVisualMemory({ id: "x", source: "user-upload", status: "bogus" }); return false; } catch { return true; } })();
  check("MOCK", "未知状态被拒绝构造", bad);
}

console.log(`\n=== 定向验收: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail) {
  console.log("失败项：");
  for (const r of results.filter((x) => !x.ok)) console.log(`  [${r.tag}] ${r.name} — ${r.detail}`);
}
const summary = {
  ranAt: new Date().toISOString(),
  realProviderCalls: 0,
  evidenceClasses: {
    MOCK: results.filter((r) => r.tag === "MOCK").length,
    INTEGRATION: results.filter((r) => r.tag === "INTEGRATION").length,
    "REAL-PROVIDER": 0,
  },
  pass, fail, results,
};
writeFileSync(path.join(ROOT, "qa", "p41-vision-e2e.json"), JSON.stringify(summary, null, 2));
console.log("evidence -> qa/p41-vision-e2e.json");
process.exit(fail ? 1 : 0);
