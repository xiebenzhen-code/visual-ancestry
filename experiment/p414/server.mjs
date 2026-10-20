// server.mjs — P4.14-E 本地实验服务（个人参考图库 + 视觉检索）
//
// 边界：只监听 127.0.0.1，只服务本机浏览器。生产 `scripts/server.mjs` 的 P2.7 白名单不受影响。
//
// 安全前提写在这里，不散落在代码里：
//   · Host / Origin 必须匹配本机地址——挡住恶意网页往 127.0.0.1 写入（DNS rebinding 同族）
//   · 上传先看 magic bytes，不信扩展名；SVG 一律拒绝（它能带脚本）
//   · 单文件 ≤ 8 MB，像素 ≤ 4000 万（解码前用文件头判，不先撑爆内存）
//   · 文件名不参与落盘路径，落盘名由内容哈希决定
//   · execFile 传数组参数，不经 shell
//   · 个人图片只在该目录内，按记录查路径，客户端给的任何路径都不采信

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LibraryStore, sniffImage, isSafeName, VECTOR_FINGERPRINT } from "./library-store.mjs";
import { deriveMedia, baseHashIndex } from "./media-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.argv[2] || 4600);
const HOST = "127.0.0.1";

const USER_DIR = path.join(ROOT, ".rc1-user-library");
const STORE = new LibraryStore(USER_DIR);

// 基础图库哈希索引：导入时用来判定「这张图其实是什么」。
// 建一次就够，失败不阻断服务（最多是少一道交验）。
try { baseHashIndex(ROOT); } catch { /* 索引不可用时 deriveMedia 会跳过哈希分支 */ }

const LIMITS = {
  maxFileBytes: 8 * 1024 * 1024,
  maxBodyBytes: 12 * 1024 * 1024,
  maxLibraryItems: 500,
  maxTitleLen: 200,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const PAGE = path.join(__dirname, "index.html");

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), MIME[".json"]);

/** Host / Origin 必须指向本机。拒绝时说明原因，不假装成功。 */
function assertLocal(req) {
  const host = String(req.headers.host || "");
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(host)) return { ok: false, reason: `host ${host} not allowed` };

  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return { ok: true };

  const origin = req.headers.origin;
  if (origin === undefined) return { ok: true }; // 同源 fetch 可能不带 Origin
  const allowedOrigins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  if (!allowedOrigins.includes(String(origin))) return { ok: false, reason: `origin ${origin} not allowed` };
  return { ok: true };
}

function serveFile(res, abs, base, opts = {}) {
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return send(res, 403, "forbidden");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return send(res, 404, "not found");
  const type = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
  // 用户媒体必须 no-store：删掉之后还从缓存里取回一张图，等于删除没生效。
  const cache = opts.noStore ? "no-store" : "public, max-age=3600";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  fs.createReadStream(resolved).pipe(res);
}

function readBody(req, limitBytes = LIMITS.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      total += c.length;
      if (total > limitBytes) {
        done = true;
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

/** 调 Python 算一张图的向量。临时文件用后即删，异常路径也删。 */
function embedFile(absPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "python",
      ["scripts/p414/embed.py", "--image", absPath, "--fit", VECTOR_FINGERPRINT.fit],
      { cwd: ROOT, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(new Error(String(stderr || err.message).slice(0, 300)), { code: "EMBED_FAILED" }));
        try {
          const j = JSON.parse(stdout);
          const id = Object.keys(j.vectors || {})[0];
          if (!id) throw new Error("no vector");
          resolve({
            vector: j.vectors[id],
            model: j.model,
            fit: j.fit,
            dim: j.dim,
            width: j.sizes?.[id]?.width ?? null,
            height: j.sizes?.[id]?.height ?? null,
          });
        } catch (e) {
          reject(Object.assign(new Error("embed output unparsable"), { code: "EMBED_BAD_OUTPUT" }));
        }
      }
    );
  });
}

/** 上传的临时落盘：只用于算向量，算完即删。 */
function withTempFile(buf, ext, fn) {
  const tmp = path.join(os.tmpdir(), `va-p414e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmp, buf);
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => { try { fs.unlinkSync(tmp); } catch {} });
}

function publicItem(rec) {
  return {
    id: rec.id,
    hash: rec.hash,
    width: rec.width,
    height: rec.height,
    media: rec.media,
    originalWork: rec.originalWork,
    source: rec.source,
    vector: rec.vector.values,
    kind: rec.media?.medium === "film" ? "film" : "artwork",
    title: rec.originalWork?.title || rec.originalName,
    creator: rec.originalWork?.creator || "",
    year: rec.originalWork?.year || "",
    personal: true,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const guard = assertLocal(req);
    if (!guard.ok) return send(res, 403, guard.reason);

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = url.pathname;

    if (p === "/healthz") return send(res, 200, "ok");

    if (p === "/" || p === "/index.html") return send(res, 200, fs.readFileSync(PAGE), MIME[".html"]);
    if (p === "/app.js") return send(res, 200, fs.readFileSync(path.join(__dirname, "app.js")), MIME[".js"]);

    if (p.startsWith("/src/")) return serveFile(res, path.join(ROOT, "src", decodeURIComponent(p.slice(5))), path.join(ROOT, "src"));
    if (p.startsWith("/assets/")) return serveFile(res, path.join(ROOT, "public/assets", decodeURIComponent(p.slice(8))), path.join(ROOT, "public/assets"));

    // ---- 个人图库里的图片：只按 id 查，客户端不能给路径
    if (p.startsWith("/api/user-media/")) {
      const id = decodeURIComponent(p.slice("/api/user-media/".length));
      if (!isSafeName(`${id}.json`)) return send(res, 400, "bad id");
      const abs = STORE.imagePathFor(id);
      if (!abs) return send(res, 404, "not found");
      return serveFile(res, abs, STORE.imagesDir, { noStore: true });
    }

    if (p === "/api/library") {
      const emb = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/visual-embeddings.json"), "utf8"));
      return sendJson(res, 200, {
        base: {
          model: emb.model, license: emb.license, fit: emb.fit, dim: emb.dim,
          count: Object.keys(emb.vectors || {}).length, generatedAt: emb.generatedAt,
        },
        personal: STORE.stats(),
      });
    }

    if (p === "/api/library/personal" && req.method === "GET") {
      const stats = STORE.stats();
      const items = STORE.usableItems().map(publicItem);
      return sendJson(res, 200, { stats, items });
    }

    if (p === "/api/library/import" && req.method === "POST") {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString("utf8") || "{}"); }
      catch { return sendJson(res, 400, { ok: false, error: "bad-json" }); }

      const b64 = String(body.imageBase64 || "").replace(/^data:[^,]+,/, "");
      if (!b64) return sendJson(res, 400, { ok: false, error: "missing-image" });

      let buf;
      try { buf = Buffer.from(b64, "base64"); }
      catch { return sendJson(res, 400, { ok: false, error: "bad-base64" }); }

      if (!buf.length) return sendJson(res, 400, { ok: false, error: "empty-file" });
      if (buf.length > LIMITS.maxFileBytes) return sendJson(res, 413, { ok: false, error: "file-too-large", limit: LIMITS.maxFileBytes });

      // 先验证真实类型，再谈别的。扩展名和 Content-Type 都不采信。
      const kind = sniffImage(buf);
      if (!kind) return sendJson(res, 415, { ok: false, error: "not-an-image" });

      if (STORE.stats().total >= LIMITS.maxLibraryItems) {
        return sendJson(res, 409, { ok: false, error: "library-full", limit: LIMITS.maxLibraryItems });
      }

      const ext = kind === "jpeg" ? ".jpg" : `.${kind}`;
      const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
      const clip = (v) => (typeof v === "string" ? v.slice(0, LIMITS.maxTitleLen) : null);

      // P4.15 STEP 1：分类以图片为准，不以用户下拉框为准。
      // 实测事故：与原作 preview 逐字节相同的绘画被标成 film/animation，
      // 于是「动画」筛选里出现了《维纳斯的诞生》。
      const guard = await deriveMedia({ buffer: buf, declared: meta, root: ROOT });
      if (!guard.ok) {
        return sendJson(res, 422, { ok: false, error: guard.error, detail: guard.detail });
      }

      try {
        const result = await withTempFile(buf, ext, (tmp) =>
          STORE.import({
            buffer: buf,
            fileName: clip(body.fileName) || `image${ext}`,
            meta: {
              title: clip(meta.title),
              creator: clip(meta.creator),
              year: clip(meta.year),
              medium: guard.media.medium,
              visualForm: guard.media.visualForm,
              tradition: guard.media.tradition,
              imageKind: guard.media.imageKind,
              sourcePageURL: clip(meta.sourcePageURL),
              sourceNote: clip(meta.sourceNote),
            },
            embed: (abs) => embedFile(abs),
          })
        );
        return sendJson(res, result.deduped ? 200 : 201, {
          ok: true,
          deduped: result.deduped,
          item: publicItem(result.record),
          stats: STORE.stats(),
          mediaEvidence: guard.evidence,
          mediaNote: guard.note,
        });
      } catch (e) {
        const code = e.code === "EMBED_FAILED" ? 422 : 400;
        return sendJson(res, code, { ok: false, error: String(e.message || "import-failed").slice(0, 200) });
      }
    }

    if (p.startsWith("/api/library/personal/") && req.method === "DELETE") {
      const id = decodeURIComponent(p.slice("/api/library/personal/".length));
      if (!isSafeName(`${id}.json`)) return sendJson(res, 400, { ok: false, error: "bad-id" });
      const r = STORE.remove(id);
      return sendJson(res, r.removed ? 200 : 404, { ok: r.removed, stats: STORE.stats() });
    }

    if (p === "/api/embed" && req.method === "POST") {
      const raw = await readBody(req);
      const json = JSON.parse(raw.toString("utf8") || "{}");
      const b64 = String(json.imageBase64 || "").replace(/^data:[^,]+,/, "");
      if (!b64) return sendJson(res, 400, { ok: false, error: "missing-imageBase64" });
      const buf = Buffer.from(b64, "base64");
      if (!buf.length) return sendJson(res, 400, { ok: false, error: "empty-file" });
      if (buf.length > LIMITS.maxFileBytes) return sendJson(res, 413, { ok: false, error: "file-too-large" });
      const kind = sniffImage(buf);
      if (!kind) return sendJson(res, 415, { ok: false, error: "not-an-image" });
      const ext = kind === "jpeg" ? ".jpg" : `.${kind}`;
      const out = await withTempFile(buf, ext, (tmp) => embedFile(tmp));
      return sendJson(res, 200, out);
    }

    return send(res, 404, "not found");
  } catch (e) {
    if (e && e.code === "BODY_TOO_LARGE") return send(res, 413, "body too large");
    return send(res, 500, `error: ${String(e.message).slice(0, 200)}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`P4.14-E 实验服务: http://${HOST}:${PORT}/`);
  console.log(`个人图库目录: ${USER_DIR}`);
  const s = STORE.stats();
  console.log(`图库状态: 共 ${s.total} 条，可用 ${s.usable}，待重建 ${s.stale}，损坏 ${s.broken.length}`);
});
