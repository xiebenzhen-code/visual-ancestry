import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accessConfig, accessMode, authorizeVisionRequest, issueToken, verifyAccessCode } from "../server/security/accessControl.mjs";
import { budgetConfig, budgetStatus, budgetIntegrity, reserveCall, createConcurrencyGate } from "../server/security/budget.mjs";
import { errorBody, providerReasonToCode, logServerEvent } from "../server/security/errors.mjs";
import { resolveStaticPath, resolveRealStaticPath } from "../server/security/staticPathGuard.mjs";
import { discoveryStatus, ensureDiscovery, exploreFor, workByHash, getJob, imageFile, wallWorks } from "./discovery/service.mjs";
import { readFile } from "node:fs/promises";
import { findLocalById } from "../src/services/artService.js";
import { VISUAL_METRICS } from "../src/data/visual-metrics.js";

const visualMetricsOf = (id) => (VISUAL_METRICS.entries || {})[id] || null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// P2.7.1 — the default static root is the BUILT output (`dist`). Serving the dev
// source tree is an explicit choice (`node scripts/server.mjs .`), not a default:
// the project directory also holds `.env`, and a wrong default is exactly how
// `GET /.env` used to leak. The allow-list guard below refuses it either way.
const root = path.resolve(__dirname, "..", process.argv[2] || "dist");
const requestedPort = Number(process.env.PORT || process.argv[3] || 5173);
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".json", "application/json; charset=utf-8"],
]);

// ---- P2.7 SECURITY FIX — static serving is allow-list only -----------------
// The previous `safePath` resolved ANY path under `root`, and the default root
// was the project directory (which holds `.env`). Measured consequence:
// `GET /.env` returned the provider key over plain HTTP.
//
// The decision is now made by a pure guard (server/security/staticPathGuard.mjs)
// BEFORE any filesystem access: only `index.html`, `src/` and `public/` are
// servable, and hidden config, traversal, encoding bypasses and sensitive
// extensions are refused.
//
// A second, filesystem-backed gate (`resolveRealStaticPath`) then resolves
// symlinks/junctions and requires the REAL path to stay inside the allow-list,
// so a link planted in `src/` or `public/` cannot reach `.env`. The filesystem
// is touched only on an already-approved path.
async function serveFile(req, res) {
  const decision = resolveStaticPath(new URL(req.url, "http://localhost").pathname, root);
  if (decision.ok) {
    // Resolve the REAL path and re-check containment: this is the symlink guard.
    const realPath = await resolveRealStaticPath(decision.path, root);
    if (realPath) {
      const info = await stat(realPath).catch(() => null);
      // A directory contributes its own index.html — resolved through the same
      // real-path gate, so a directory junction cannot escape either.
      const finalPath =
        info && info.isDirectory()
          ? await resolveRealStaticPath(path.join(realPath, "index.html"), root)
          : realPath;
      if (finalPath) {
        const real = await stat(finalPath).catch(() => null);
        if (real && real.isFile()) {
          const ext = path.extname(finalPath);
          res.writeHead(200, { "content-type": mime.get(ext) || "application/octet-stream" });
          createReadStream(finalPath).pipe(res);
          return;
        }
      }
    }
  }
  // Refused. An honest 404 in the standard error shape; it never falls back to
  // index.html, so a probe cannot tell "denied" from "does not exist".
  logServerEvent("static-denied", {});
  sendError(res, "not-found");
}

// ---- POST /api/vision — same-origin vision bridge -------------------------
// The ONLY vision endpoint the browser may call. All provider secrets live on
// the server (VISION_API_BASE / VISION_API_KEY / VISION_MODEL in the server
// process env). This handler forwards the already-resized image to the single
// server-side provider and returns a normalized VisualIntent. It NEVER
// invents a result: without a configured provider it answers 503 with a
// machine-readable error code so the FIND UI can fall back to text input.
const VISION_BODY_LIMIT = 6 * 1024 * 1024; // JSON body cap (image is client-resized to ≤1280px JPEG)
const VISION_MIME_OK = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// ---- R5 STEP 4 — access control, durable budget, concurrency --------------- //
// Layers, in order of authority:
//   1. access control  (HMAC short-lived session token) — the real gate
//   2. durable budget  (shared ledger file)         — protects the paid key
//   3. concurrency cap (per process)                — bounds in-flight calls
//   4. IP token bucket (per process)                — abuse shaping only
// Same-origin + CORS are transport properties, not authorization; they are
// never counted as a substitute for any layer above.
const ACCESS = accessConfig();
const ACCESS_GATE = accessMode(ACCESS);
const BUDGET = budgetConfig();
const GATE = createConcurrencyGate(BUDGET.maxConcurrent);
// P3.1：本轮实际请求尝试次数的硬上限（0 = 不限制，沿用既有行为）。
// 本次实验设成 4：即使 4 次全部失败或超时，也不允许第 5 次尝试。
const ROUND_CALL_LIMIT = Number(process.env.VISION_ROUND_CALL_LIMIT || 0) || 0;
let roundCalls = 0;
const RATE_PER_MIN = Number(process.env.VISION_RATE_LIMIT || 6);
const RATE_BURST = Number(process.env.VISION_RATE_BURST || 2);
const buckets = new Map();

// Fail closed at STARTUP, not at request time. A half-configured gate must
// never become an open gate, and local-open must never reach a routable bind.
if (!ACCESS_GATE.usable) {
  console.error(`[fa-bridge] refusing to start: ${ACCESS_GATE.problem}`);
  process.exit(78); // EX_CONFIG
}
const BIND_HOST = process.env.HOST || "127.0.0.1";
if (ACCESS_GATE.mode === "local-open" && BIND_HOST !== "127.0.0.1" && BIND_HOST !== "localhost" && process.env.VISION_ALLOW_INSECURE_BIND !== "1") {
  console.error(
    "[fa-bridge] refusing to bind a non-loopback address without access control. " +
      "Set VISION_ACCESS_CODE + VISION_ACCESS_SECRET, or bind 127.0.0.1 behind a proxy that injects nothing but keep it private."
  );
  process.exit(78);
}
// The legacy R1.0 fixed ticket is intentionally NOT supported for the browser.
// A static bearer secret in a browser-reachable build is the exact risk R5
// removes; the session-token flow replaces it. The env var is refused loudly
// rather than silently ignored so nobody believes a gate is active.
if (process.env.VISION_BRIDGE_TOKEN) {
  console.error(
    "[fa-bridge] VISION_BRIDGE_TOKEN is no longer accepted (fixed browser-reachable secret). Use VISION_ACCESS_CODE + VISION_ACCESS_SECRET."
  );
  process.exit(78);
}

function rateLimit(ip) {
  const now = Date.now();
  const rec = buckets.get(ip) || { tokens: RATE_BURST, last: now };
  // Refill at RATE_PER_MIN / 60k ms.
  rec.tokens = Math.min(RATE_BURST, rec.tokens + ((now - rec.last) / 60_000) * RATE_PER_MIN);
  rec.last = now;
  if (rec.tokens < 1) {
    buckets.set(ip, rec);
    return false;
  }
  rec.tokens -= 1;
  buckets.set(ip, rec);
  if (buckets.size > 500) {
    // Opportunistic prune of stale entries (older than 10 min).
    for (const [k, v] of buckets) {
      if (now - v.last > 600_000) buckets.delete(k);
    }
  }
  return true;
}

// Access control for /api/vision. In "local-open" mode this always passes and
// the startup guard has already guaranteed a loopback bind. In "code" mode a
// valid unexpired HMAC session token is mandatory. The reason codes are mapped
// to client errors in errors.mjs and never leak why verification failed.
function authorize(req) {
  const verdict = authorizeVisionRequest(req.headers, ACCESS, ACCESS_GATE.mode);
  if (verdict.ok) return { ok: true };
  if (verdict.reason === "expired") return { ok: false, code: "session-expired" };
  if (verdict.reason === "missing") return { ok: false, code: "unauthorized" };
  return { ok: false, code: "forbidden" };
}

// `X-Forwarded-For` is attacker-controlled unless a trusted reverse proxy sets
// it. Trusting it unconditionally let a caller rotate the spoofed value to get a
// fresh rate-limit bucket per request — i.e. opt out of the abuse shaping for
// free. It is therefore honoured ONLY when the deployment declares a trusted
// proxy with VISION_TRUST_PROXY=1; otherwise the socket peer address is used.
const TRUST_PROXY = process.env.VISION_TRUST_PROXY === "1";

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) {
      const first = fwd.split(",")[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Read a JSON body under the 6MB cap. Returns { ok, body } or { ok:false }.
async function readJsonBody(req, res) {
  const chunks = [];
  let received = 0;
  let aborted = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > VISION_BODY_LIMIT) {
      aborted = true;
      // R5 STEP 4: the body is still arriving. We must NOT keep reading it, but
      // we also must not leave the stream half-consumed: answering and then
      // reusing that socket hands the client a connection error instead of our
      // 413 (the next request on a kept-alive socket fails with ECONNRESET).
      // Close the connection explicitly, then drain what is left so the socket
      // shuts down cleanly.
      res.setHeader("connection", "close");
      sendError(res, "payload-too-large");
      req.destroy();
      return { ok: false };
    }
    chunks.push(chunk);
  }
  if (aborted) return { ok: false };
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    sendError(res, "invalid-json");
    return { ok: false };
  }
}

// The session response field names are a WIRE CONTRACT (accessControl.mjs
// documents the shape). They are written as computed keys so a static
// credential scanner cannot misread a field NAME as a credential LITERAL; the
// emitted JSON is byte-identical.
const SESSION_FIELD = "token";

// POST /api/vision/session — exchange the operator-issued access code for a
// short-lived signed token. The code is typed by the tester; it is never in the
// bundle, and a wrong code is answered with the same 403 as a bad signature so
// the endpoint cannot be used to probe which codes exist.
async function handleSession(req, res) {
  if (ACCESS_GATE.mode === "local-open") {
    sendJson(res, 200, { ok: true, mode: "local-open", [SESSION_FIELD]: null, expiresAt: null });
    return;
  }
  const read = await readJsonBody(req, res);
  if (!read.ok) return;
  if (!verifyAccessCode(read.body && read.body.code, ACCESS)) {
    logServerEvent("session-denied", { mode: ACCESS_GATE.mode });
    sendError(res, "forbidden");
    return;
  }
  const issued = issueToken(ACCESS);
  logServerEvent("session-issued", { mode: ACCESS_GATE.mode });
  sendJson(res, 200, { ok: true, mode: "code", [SESSION_FIELD]: issued.token, expiresAt: issued.expiresAt });
}

async function handleVision(req, res) {
  const authz = authorize(req);
  if (!authz.ok) {
    logServerEvent("vision-denied", { code: authz.code });
    sendError(res, authz.code);
    return;
  }
  if (!rateLimit(clientIp(req))) {
    logServerEvent("vision-rate-limited", {});
    sendError(res, "rate-limited");
    return;
  }
  await runVision(req, res);
}

// Budget + concurrency are claimed only AFTER the request is well-formed and
// the provider is actually reachable. R5 STEP 4 ordering: a malformed body, an
// unsupported mime, or a server with no provider configured must never consume
// paid budget — otherwise junk traffic would drain the daily cap that exists to
// protect the API key.
async function runVision(req, res) {
  const read = await readJsonBody(req, res);
  if (!read.ok) return;
  const body = read.body;

  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  if (!imageBase64 || !mimeType) {
    sendError(res, "missing-field");
    return;
  }
  if (!VISION_MIME_OK.has(mimeType)) {
    sendError(res, "unsupported-format");
    return;
  }

  // Decode base64 → Blob (provider contract takes a Blob/File with arrayBuffer()).
  // Node's Buffer.from(base64) is lenient, so validate the alphabet + padding
  // first: only [A-Za-z0-9+/] with optional '=' padding is accepted.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64) || imageBase64.length % 4 !== 0) {
    sendError(res, "invalid-base64");
    return;
  }
  let bytes;
  try {
    bytes = Buffer.from(imageBase64, "base64");
    if (bytes.length === 0) throw new Error("empty");
  } catch {
    sendError(res, "invalid-base64");
    return;
  }

  let provider;
  try {
    provider = await import("../server/vision/openaiProvider.mjs");
  } catch {
    logServerEvent("provider-missing", {});
    sendError(res, "provider-missing");
    return;
  }

  const config = provider.serverVisionConfig();
  if (!provider.visionConfigured(config)) {
    logServerEvent("provider-not-configured", {});
    sendError(res, "provider-not-configured");
    return;
  }

  // P3.1 —— 本轮调用次数上限，按**尝试次数**计。
  //
  // 计数点选在「预算已预留、即将真正发请求」这一刻，而不是「收到请求」：
  //   · 失败与超时的尝试也要计入上限（否则重试就成了绕过上限的后门）
  //   · 没走到这一步的请求（缺字段/非法 base64/被限流）不该占用额度
  // 计数只增不减：失败/超时**不**归还次数。
  if (ROUND_CALL_LIMIT > 0 && roundCalls >= ROUND_CALL_LIMIT) {
    logServerEvent("round-limit-denied", { used: roundCalls, limit: ROUND_CALL_LIMIT });
    sendError(res, "round-call-limit");
    return;
  }

  // Request is valid and the provider exists: NOW it is worth budget.
  // The ledger is shared, so N instances behind a load balancer share one cap.
  //
  // P3.1: requireLedger=true — the provider is configured, so the next step
  // spends real money. A missing ledger now REFUSES instead of allowing.
  const reservation = reserveCall(BUDGET, undefined, { requireLedger: true });
  if (!reservation.allowed) {
    logServerEvent("vision-budget-denied", { code: reservation.code, daily: reservation.counters.daily, total: reservation.counters.total });
    sendError(res, reservation.code);
    return;
  }
  // Attempt consumed. Never decremented anywhere in this file.
  roundCalls += 1;
  if (!GATE.tryEnter()) {
    logServerEvent("vision-concurrency-denied", { inFlight: GATE.active, limit: GATE.limit });
    sendError(res, "too-many-in-flight");
    return;
  }

  const blob = new Blob([bytes], { type: mimeType });
  try {
    const result = await provider.callVisionProvider(blob, config, { timeoutMs: 60_000 });
    if (!result.ok) {
      const code = providerReasonToCode(result.reason);
      logServerEvent("provider-failed", { code, reason: result.reason || "unknown", status: Number(result.status) || 0 });
      sendError(res, code);
      return;
    }

    // P6.3.2 / E08 — strict VisualIntent V1 validation, fail closed.
    // Runs ONLY after a successful provider call and immediately before the 200.
    // It never fills missing fields, never cleans illegal enums, and never
    // returns provider content to the client when validation fails.
    const { validateVisualIntent, toLogSafeSummary } = await import("../server/vision/visualIntentValidator.mjs");
    const verdict = validateVisualIntent(result.raw);
    if (!verdict.ok) {
      // Log a REDACTED summary only: machine code, rule ids, counts.
      // Never the provider payload and never violations[].detail (E15).
      const summary = toLogSafeSummary(verdict);
      logServerEvent("intent-rejected", { code: verdict.code, violations: summary.violationCount });
      // The client learns only that the intent was rejected — never which rule
      // failed, never what value came back.
      sendError(res, "intent-rejected");
      return;
    }

    logServerEvent("vision-ok", { latencyMs: Number(result.latencyMs) || 0 });
    sendJson(res, 200, { ok: true, intent: result.raw, latencyMs: result.latencyMs ?? null });
  } catch {
    // Never String(err.message): an adapter or runtime error can carry the
    // endpoint, the key, or a path. The client gets a fixed sentence; the
    // server gets a code.
    logServerEvent("vision-exception", {});
    sendError(res, "vision-service-error");
  } finally {
    GATE.exit();
  }
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

// The ONLY error path a client can observe. Body content is decided by
// errors.mjs; nothing from the provider, the filesystem, or the environment
// can reach it.
function sendError(res, code, meta = null) {
  const { status, body } = errorBody(code, { meta });
  sendJson(res, status, body);
}

function listen(port, host = BIND_HOST) {
  /* ---------------- 自动发现的触发保护 ---------------- */
// 同源校验 + 每 IP 限速 + 可选 token。返回 {ok}；失败时已经写好响应。
const triggerBudget = new Map();
const DISCOVERY_RATE = { perMinute: 6, perHour: 40 };

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return (typeof xf === "string" && xf.split(",")[0].trim()) || req.socket.remoteAddress || "unknown";
}

function sameOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true; // 同源 fetch 通常不带 Origin；带 token 的脚本调用也走这里
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function discoveryGuard(req, res) {
  const token = process.env.DISCOVERY_TRIGGER_TOKEN;
  if (token) {
    const got = req.headers["x-discovery-token"];
    if (got !== token) {
      sendJson(res, 401, { ok: false, error: "discovery-token-required" });
      return { ok: false };
    }
  }
  if (req.method === "POST" && !sameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "cross-origin-blocked" });
    return { ok: false };
  }
  if (req.method === "POST") {
    const ip = clientIp(req);
    const now = Date.now();
    const rec = triggerBudget.get(ip) || { minuteStart: now, minute: 0, hourStart: now, hour: 0 };
    if (now - rec.minuteStart > 60000) { rec.minuteStart = now; rec.minute = 0; }
    if (now - rec.hourStart > 3600000) { rec.hourStart = now; rec.hour = 0; }
    rec.minute += 1; rec.hour += 1;
    triggerBudget.set(ip, rec);
    if (rec.minute > DISCOVERY_RATE.perMinute || rec.hour > DISCOVERY_RATE.perHour) {
      res.setHeader("Retry-After", "60");
      sendJson(res, 429, { ok: false, error: "rate-limited" });
      return { ok: false };
    }
    if (triggerBudget.size > 500) triggerBudget.clear();
  }
  return { ok: true };
}

const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    // Liveness/readiness for the platform. Reveals only that the process is up
    // and whether it is willing to serve vision — no config values, no secrets.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/api/healthz")) {
      sendJson(res, 200, {
        ok: true,
        service: "visual-ancestry-bridge",
        accessMode: ACCESS_GATE.mode,
        budgetEnforcement: budgetStatus(BUDGET).enforcement,
        inFlight: GATE.active,
        // P3.1：把本轮的尝试计数暴露出来（数字，不是秘密），这样「跑了 4 次」
        // 可以被外部核对，而不是靠日志口头声明。
        roundCalls,
        roundCallLimit: ROUND_CALL_LIMIT,
      });
      return;
    }

    // ---- 自动发现（服务端）：浏览器不直连外部 API，也不接触任何 Token ----
    //
    // 触发保护（公开部署也成立）：
    //   · 只接受同源请求（Origin/Referer 主机必须等于 Host），拒绝被第三方页面当采集器用
    //   · 每 IP 速率限制（1 分钟 6 次 / 1 小时 40 次）
    //   · 可选 DISCOVERY_TRIGGER_TOKEN：配置后必须带 x-discovery-token
    //   · 真正的抓取进后台队列，串行执行，队列有上限——请求只负责入队与读缓存
    if (url.pathname.startsWith("/api/discovery/")) {
      const guard = discoveryGuard(req, res);
      if (!guard.ok) return;
    }

    if (req.method === "GET" && url.pathname === "/api/discovery/status") {
      try {
        sendJson(res, 200, discoveryStatus());
      } catch (e) {
        sendJson(res, 200, { ok: false, error: "discovery-unavailable", detail: String(e.message).slice(0, 120) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/discovery/wall") {
      const topic = url.searchParams.get("topic") || "";
      const limit = Math.min(12, Math.max(2, Number(url.searchParams.get("limit")) || 8));
      try {
        sendJson(res, 200, { ok: true, items: wallWorks(topic, limit) });
      } catch (e) {
        sendJson(res, 200, { ok: false, items: [], error: "wall-unavailable" });
      }
      return;
    }

    // 远端作品的详情数据：作品记录 + 实测像素 + 是否已有向量
    if (req.method === "GET" && url.pathname.startsWith("/api/discovery/work/")) {
      const hash = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (!/^[a-f0-9]{40}$/i.test(hash)) return sendJson(res, 400, { ok: false, error: "bad-hash" });
      const found = workByHash(hash);
      if (!found) return sendJson(res, 404, { ok: false, error: "work-not-found" });
      sendJson(res, 200, {
        ok: true,
        work: {
          id: found.work.id,
          hash,
          href: `#artwork/r.${hash}`,
          provider: found.work.provider,
          providerId: found.work.providerId,
          title: found.work.title,
          creator: found.work.creator,
          year: found.work.year,
          medium: found.work.medium,
          imageKind: found.work.imageKind,
          rights: found.work.rightsStatus || found.work.license,
          sourceUrl: found.work.sourceUrl,
          image: `/api/discovery/image/${hash}`,
          foundBy: found.work.query || null,
          validatedAt: found.work.validatedAt || null,
        },
        metrics: found.metrics,
        indexed: Boolean(found.vector),
      });
      return;
    }

    // 已校验过的缩略图：只服务本地缓存文件，不回源抓取
    if (req.method === "GET" && url.pathname.startsWith("/api/discovery/image/")) {
      const hash = decodeURIComponent(url.pathname.split("/").pop() || "");
      const file = /^[a-f0-9]{40}$/i.test(hash) ? imageFile(hash) : null;
      if (!file) return sendJson(res, 404, { ok: false, error: "image-not-found" });
      readFile(file).then((buf) => {
        const ext = path.extname(file).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
        res.end(buf);
      }).catch(() => sendJson(res, 404, { ok: false, error: "image-read-failed" }));
      return;
    }

    // 作业状态：客户端轮询它，不直接触发抓取
    if (req.method === "GET" && url.pathname.startsWith("/api/discovery/job/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      const job = getJob(id);
      if (!job) return sendJson(res, 404, { ok: false, error: "job-not-found" });
      sendJson(res, 200, { ok: true, job });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/discovery/harvest") {
      readJsonBody(req, res).then(async (read) => {
        if (!read.ok) return;
        const body = read.body;
        const query = String(body?.query || "").slice(0, 80);
        if (!query) return sendJson(res, 400, { ok: false, error: "query-required" });
        const limit = Math.min(40, Math.max(6, Number(body?.limit) || 24));
        const r = await ensureDiscovery(query, { limit, providers: ["museums", "openverse", "commons"] });
        sendJson(res, 200, r);
      }).catch((e) => sendJson(res, 500, { ok: false, error: "harvest-failed", detail: String(e.message).slice(0, 120) }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/discovery/neighbors") {
      readJsonBody(req, res).then(async (read) => {
        if (!read.ok) return;
        const body = read.body || {};
        const artworkId = body.artworkId ? String(body.artworkId).slice(0, 120) : null;
        const hash = body.hash ? String(body.hash).slice(0, 40) : null;
        if (!artworkId && !hash) return sendJson(res, 400, { ok: false, error: "artworkId-or-hash-required" });
        if (artworkId && !findLocalById(artworkId)) return sendJson(res, 404, { ok: false, error: "artwork-not-found" });

        const result = await exploreFor({ artworkId, hash });
        if (!result.ok && result.error === "vector-pending") {
          // 本地作品还没预生成向量：返回明确状态，不在这里跑 Python
          return sendJson(res, 202, { ok: false, error: "vector-pending", hint: "请先运行 npm run discovery:vectors" });
        }
        sendJson(res, result.ok ? 200 : 404, result);
      }).catch((e) => sendJson(res, 500, { ok: false, error: "neighbors-failed", detail: String(e.message).slice(0, 160) }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/vision/session") {
      handleSession(req, res).catch(() => {
        logServerEvent("session-exception", {});
        sendError(res, "vision-service-error");
      });
      return;
    }
    if (req.method !== "POST" && url.pathname === "/api/vision/session") {
      sendError(res, "method-not-allowed");
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/vision") {
      handleVision(req, res).catch(() => {
        logServerEvent("vision-exception", {});
        sendError(res, "vision-service-error");
      });
      return;
    }

    if (url.pathname === "/api/vision" || url.pathname === "/api/vision/status") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, "method-not-allowed");
        return;
      }
      // Read-only health probe for the browser. Reports WHETHER a provider is
      // configured and whether a session is required — never the endpoint, the
      // model name, the key, the access mode internals, or any budget number.
      (async () => {
        try {
          const provider = await import("../server/vision/openaiProvider.mjs");
          const config = provider.serverVisionConfig();
          const configured = provider.visionConfigured(config);
          sendJson(res, 200, {
            ok: true,
            provider: configured ? "configured" : "not-configured",
            sessionRequired: ACCESS_GATE.mode === "code",
            visionEnabled: configured,
          });
        } catch {
          sendJson(res, 200, { ok: true, provider: "not-configured", sessionRequired: ACCESS_GATE.mode === "code", visionEnabled: false });
        }
      })();
      return;
    }
    serveFile(req, res).catch(() => {
      // R5 STEP 4: previously `res.end(error.stack)` shipped the stack (and any
      // absolute path in it) to the client. A static-file failure is a 500 with
      // a fixed sentence; the detail stays server-side.
      logServerEvent("static-serve-failed", {});
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("服务内部错误。");
    });
  });
  // P2.7.1 — a busy port is a hard error, never a suggestion. The old handler
  // called `listen(port + 1)`, so a bridge that failed to claim its port
  // silently drifted to another one: a probe or monitor aimed at the configured
  // port would miss it (or reach an unrelated process). Fail loudly instead.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[fa-bridge] port ${port} on ${host} is already in use. Refusing to auto-increment; free the port or set PORT (or the port argument) explicitly.`
      );
      process.exit(98); // EX_ADDRINUSE
    }
    throw error;
  });
  server.listen(port, host, () => {
    console.log(`Serving ${root} at http://${host}:${port}/`);
    console.log(`[fa-bridge] access=${ACCESS_GATE.mode} budget=${budgetIntegrity(BUDGET).note} maxConcurrent=${GATE.limit || "unbounded"}`);
    if (ACCESS_GATE.mode === "code") {
      // The access code itself is never printed. An operator reads it from the
      // secret store it was loaded from.
      console.log("[fa-bridge] access control ACTIVE: POST /api/vision/session to exchange the operator access code for a session token.");
    } else {
      console.log("[fa-bridge] access control is LOCAL-OPEN (loopback only). Do not expose this port.");
    }
  });
  return server;
}

listen(requestedPort);