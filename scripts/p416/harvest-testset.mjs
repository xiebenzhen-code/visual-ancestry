// v0.4 视觉质量实验 · 跨媒介测试集采集
//
// 目标：为四条跨媒介方向各建一组「起点 + 候选」参考，覆盖
//   cel        赛璐璐 / cel-shaded
//   cinematic  电影化光影
//   handdrawn  手工动画
//   composition 绘画构图
//
// 授权要求（硬性）：只保留 Public domain / CC0 / CC BY / CC BY-SA / PDM。
// BY-NC / BY-ND 一律不收——它们限制商用与改作，与产品「可商用素材」的
// 定位冲突。每件都逐条核验 Commons 文件页的 extmetadata，不看分类页推断。
//
// 产物：.rc1-audit/p416/testset.json（清单）+ .rc1-audit/p416/testset/<dir>/*.jpg
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(process.argv[2] || ".");
const OUT_DIR = path.join(REPO, ".rc1-audit", "p416", "testset");
const API = "https://commons.wikimedia.org/w/api.php";
const UA = "FrameAtlas-v0.4-eval/1.0 (cross-media test set; licence verified per file page)";

// 允许的许可关键词（小写匹配 LicenseShortName / UsageTerms）
const ALLOWED = [
  "public domain", "cc0", "pd-", "cc by", "cc-by", "attribution", "publicdomain",
];
const DENIED = ["nc", "nd", "noncommercial", "no derivative"];

function licenceOk(short, usage) {
  const s = `${short || ""} ${usage || ""}`.toLowerCase();
  if (DENIED.some((d) => s.includes(d))) return false;
  return ALLOWED.some((a) => s.includes(a));
}

const SPEC = [
  {
    dir: "cel",
    label: "赛璐璐 / cel-shaded",
    queries: ["cel shading animation", "cel-shaded illustration", "anime cel style fan art"],
    categories: ["Cel shading", "Cel-shaded"],
    target: "cel",
  },
  {
    dir: "cinematic",
    label: "电影化光影",
    queries: ["Tears of Steel frame", "Metropolis 1927 film still", "cinematic night street photograph"],
    categories: ["Tears of Steel", "Metropolis (1927 film)"],
    target: "cinematic",
  },
  {
    dir: "handdrawn",
    label: "手工动画",
    queries: ["hand drawn animation frame", "traditional animation cel", "Lotte Reiniger silhouette film"],
    categories: ["Out of the Inkwell Films", "Winsor McCay films", "Traditional animation"],
    target: "handdrawn",
  },
  {
    dir: "composition",
    label: "绘画构图",
    queries: ["painting composition rule of thirds", "Dutch Golden Age landscape painting", "portrait painting composition"],
    categories: ["Composition (visual arts)"],
    target: "composition",
  },
];

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) { for (let w = 0; w < 8; w++) { await new Promise((r) => setTimeout(r, 10000 * (w + 1))); const again = await fetch(url, { headers: { "User-Agent": UA } }); if (again.ok) return again.json(); } throw new Error("HTTP 429 after retries"); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const PER_QUERY = Number(process.env.P416_PER_QUERY || 6);
const manifest = { at: new Date().toISOString(), note: "逐件核验 Commons 文件页 extmetadata；只收可商用条款。", directions: [] };

for (const spec of SPEC) {
  const dir = path.join(OUT_DIR, spec.dir);
  fs.mkdirSync(dir, { recursive: true });
  const items = [];
  const seen = new Set();

  // 候选来源：关键词检索 + 分类成员。分类成员用于「素材本身就成体系」的方向
  // （手绘动画的 Out of the Inkwell / Winsor McCay、赛璐璐的 Cel shading 等），
  // 这些分类里的作品风格一致，比关键词命中更可用。
  const titleSets = [];
  for (const q of spec.queries || []) {
    try {
      const s = await api({ action: "query", list: "search", srsearch: `${q} filetype:bitmap`, srnamespace: "6", srlimit: String(PER_QUERY * 3) });
      for (const h of s?.query?.search || []) titleSets.push({ title: h.title, via: `search:${q}` });
    } catch (e) {
      console.warn(`[testset] search failed "${q}": ${e.message}`);
    }
  }
  for (const c of spec.categories || []) {
    try {
      const s = await api({ action: "query", list: "categorymembers", cmtitle: `Category:${c}`, cmnamespace: "6", cmlimit: String(PER_QUERY * 3) });
      for (const h of s?.query?.categorymembers || []) titleSets.push({ title: h.title, via: `category:${c}` });
    } catch (e) {
      console.warn(`[testset] category failed "${c}": ${e.message}`);
    }
  }

  let kept = 0;
  for (const { title, via } of titleSets) {
    if (kept >= PER_QUERY * 2) break;
    if (seen.has(title)) continue;
      let info;
      try {
        info = await api({ action: "query", titles: title, prop: "imageinfo", iiprop: "url|extmetadata|size|mime|thumburl" });
      } catch (e) { console.warn(`   [info-fail] ${title.slice(5, 50)}: ${String(e.message).slice(0, 60)}`); continue; }
      const page = Object.values(info?.query?.pages || {})[0];
      const ii = page?.imageinfo?.[0];
      if (!ii) { console.warn(`   [no-imageinfo] ${title.slice(5, 50)}`); continue; }
      const em = ii.extmetadata || {};
      const v = (k) => (em[k]?.value ? String(em[k].value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");
      const short = v("LicenseShortName");
      const usage = v("UsageTerms");
      if (!licenceOk(short, usage)) {
        console.log(`   [skip] ${title.slice(5, 60)} licence=${short || usage || "?"}`);
        continue;
      }
      // 画面来源：位图用原图；视频类条目只能取 poster（缩略图）——
      // poster 不是影片画面本身，清单里必须标出来，不能混作真实帧。
      const isVideo = /video|ogg|webm/i.test(ii.mime || "");
      const isBitmap = /jpeg|png|webp/i.test(ii.mime || "");
      if (!isBitmap && !(isVideo && ii.thumburl)) { console.log(`   [skip-mime] ${title.slice(5, 50)} ${ii.mime}`); continue; }
      if (ii.width != null && ii.width < 320 && !(isVideo && ii.thumburl)) { console.log(`   [skip-small] ${title.slice(5, 50)} w=${ii.width}`); continue; }
      const file = path.join(dir, `${String(items.length).padStart(2, "0")}-${page.pageid}.jpg`);
      const downloadUrl = isBitmap ? ii.url : ii.thumburl;
      try {
        const img = await fetch(downloadUrl, { headers: { "User-Agent": UA } });
        if (!img.ok) continue;
        fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()));
      } catch { continue; }
      seen.add(title);
      items.push({
        id: `${spec.dir}-${String(items.length).padStart(2, "0")}`,
        dir: spec.dir,
        direction: spec.label,
        title: page.title.replace(/^File:/, ""),
        file: path.relative(REPO, file).replace(/\\/g, "/"),
        sourceUrl: ii.descriptionurl,
        licence: short,
        usageTerms: usage,
        artist: v("Artist").slice(0, 120),
        credit: v("Credit").slice(0, 120),
        dateOriginal: v("DateTimeOriginal").slice(0, 40),
        width: ii.width,
        height: ii.height,
        via,
        visualKind: isVideo ? "poster" : "frame",
        mime: ii.mime || "",
      });
      kept++;
      await new Promise((r) => setTimeout(r, 1200));
  }
  manifest.directions.push({ ...spec, count: items.length, items });
  console.log(`[testset] ${spec.dir}: ${items.length} items kept`);
}

fs.writeFileSync(path.join(OUT_DIR, "testset.json"), JSON.stringify(manifest, null, 1));
console.log("[testset] wrote", path.join(OUT_DIR, "testset.json"));
