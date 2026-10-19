// 用最小的独立静态服务器伺候盲评目录（不改仓库 server.mjs）
// 只监听 127.0.0.1，只允许 .rc1-audit/p411 下的白名单扩展名
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// 盲评环境在 qa/p411（git 跟踪）。用 `node scripts/p411/build-p411-sample.mjs` 重建。
const ROOT = path.join(process.cwd(), "qa", "p411");
const PORT = Number(process.argv[2] || 4601);
const MIME = { ".html":"text/html; charset=utf-8", ".webp":"image/webp", ".json":"application/json", ".css":"text/css", ".js":"text/javascript" };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const rel = url === "/" ? "blind-review.html" : url.replace(/^\/+/, "");
  const full = path.normalize(path.join(ROOT, rel));
  // 防止路径穿越
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); res.end("not found"); return; }
  const ext = path.extname(full).toLowerCase();
  if (!MIME[ext]) { res.writeHead(403); res.end("type not allowed"); return; }
  res.writeHead(200, { "Content-Type": MIME[ext], "Cache-Control": "no-store" });
  fs.createReadStream(full).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log("blind-review server on http://127.0.0.1:" + PORT));
