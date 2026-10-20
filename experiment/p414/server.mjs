// experiment-server.mjs — P4.14-D 本地实验检索服务
//
// 为什么不改生产 server：`scripts/server.mjs` 有 P2.7 白名单（只服务 index.html/src/public），
// 那是安全设计。实验链路单独起一个进程、只监听 127.0.0.1，不碰生产路由。
//
// 提供：
//   GET  /                    实验页
//   GET  /assets/*            真实图片（只读投影 public/assets）
//   GET  /app.js              浏览器端实验代码（由 src/ 现场转译）
//   POST /api/embed           {imageBase64} → {vector:[512], model, fit}
//   GET  /api/library         图库元信息
//   GET  /healthz

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件在 experiment/p414/，退两级回到仓库根。
const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.argv[2] || 4600);
const HOST = "127.0.0.1";

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

/** 只允许 public/assets 下的文件，防目录穿越。 */
function serveAsset(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/assets\//, ""));
  const abs = path.resolve(ROOT, "public/assets", rel);
  const base = path.resolve(ROOT, "public/assets");
  if (!abs.startsWith(base + path.sep)) return send(res, 403, "forbidden");
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, "not found");
  const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
  fs.createReadStream(abs).pipe(res);
}

function readBody(req, limitBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > limitBytes) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 上传图只在临时目录落盘一次，算完即删；不进仓库、不进产物。 */
function embedBuffer(buf) {
  return new Promise((resolve, reject) => {
    const ext = buf.slice(0, 4).toString("hex") === "89504e47" ? ".png"
      : buf.slice(0, 3).toString("hex") === "ffd8ff" ? ".jpg"
      : ".webp";
    const tmp = path.join(os.tmpdir(), `va-p414-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmp, buf);
    execFile(
      "python",
      ["scripts/p414/embed.py", "--image", tmp, "--fit", "pad"],
      { cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        try { fs.unlinkSync(tmp); } catch {}
        if (err) return reject(err);
        try {
          const j = JSON.parse(stdout);
          const id = Object.keys(j.vectors)[0];
          resolve({ vector: j.vectors[id], model: j.model, fit: j.fit, dim: j.dim });
        } catch (e) { reject(e); }
      }
    );
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return send(res, 200, fs.readFileSync(PAGE), MIME[".html"]);
    }
    if (url.pathname === "/app.js") {
      // 浏览器端直接复用源码模块（相对 import 路径由 /src/ 提供）
      const entry = path.join(__dirname, "app.js");
      return send(res, 200, fs.readFileSync(entry), MIME[".js"]);
    }
    if (url.pathname.startsWith("/src/")) {
      const rel = decodeURIComponent(url.pathname.slice(5));
      const abs = path.resolve(ROOT, "src", rel);
      const base = path.resolve(ROOT, "src");
      if (!abs.startsWith(base + path.sep)) return send(res, 403, "forbidden");
      if (!fs.existsSync(abs)) return send(res, 404, "not found");
      return send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs)] || "text/javascript");
    }
    if (url.pathname.startsWith("/assets/")) return serveAsset(res, url.pathname);

    if (url.pathname === "/api/embed" && req.method === "POST") {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const b64 = String(json.imageBase64 || "").replace(/^data:[^,]+,/, "");
      if (!b64) return send(res, 400, "missing imageBase64");
      const out = await embedBuffer(Buffer.from(b64, "base64"));
      return send(res, 200, JSON.stringify(out), MIME[".json"]);
    }

    if (url.pathname === "/api/library") {
      const emb = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/visual-embeddings.json"), "utf8"));
      return send(res, 200, JSON.stringify({
        model: emb.model, license: emb.license, fit: emb.fit, dim: emb.dim,
        count: Object.keys(emb.vectors || {}).length, generatedAt: emb.generatedAt,
      }), MIME[".json"]);
    }

    return send(res, 404, "not found");
  } catch (e) {
    return send(res, 500, `error: ${String(e.message).slice(0, 200)}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`P4.14 实验检索: http://${HOST}:${PORT}/`);
});
