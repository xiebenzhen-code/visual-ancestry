// P5.2.4 STEP 1 — download 6 public-domain film stills from Wikimedia Commons.
// Same discipline as P5.1.7: search Commons API, require LicenseShortName ~
// Public domain, download original. 429 / non-JSON / 404 are skipped honestly
// (no retry fabrication). Files land in work/p5.2.4-usage-validation/materials/film/.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../work/p5.2.4-usage-validation/materials/film");
const API = "https://commons.wikimedia.org/w/api.php";

// target: 6 new stills (we already have ruv-a01..a04)
const TARGETS = [
  { id: "uv-f01", film: "Nosferatu 1922", search: "Nosferatu 1922 film still Murnau" },
  { id: "uv-f02", film: "Cabinet of Dr. Caligari 1920", search: "Cabinet of Dr. Caligari 1920 film still" },
  { id: "uv-f03", film: "Sunrise 1927", search: "Sunrise A Song of Two Humans 1927 film still" },
  { id: "uv-f04", film: "City Lights 1931", search: "City Lights 1931 Chaplin film still" },
  { id: "uv-f05", film: "Battleship Potemkin 1925", search: "Battleship Potemkin 1925 film still" },
  { id: "uv-f06", film: "Modern Times 1936", search: "Modern Times 1936 Chaplin film still" },
];

async function searchFirst(file) {
  const url = `${API}?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(
    file.search + " filetype:bitmap"
  )}&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1200`;
  const res = await fetch(url, { headers: { "User-Agent": "visual-ancestry-qa/1.0 (validation)" } });
  if (!res.ok) return { skip: `http-${res.status}` };
  const text = await res.text();
  if (!text.trim().startsWith("{")) return { skip: "non-json (likely rate limited)" };
  const data = JSON.parse(text);
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  for (const page of pages) {
    const ii = page.imageinfo && page.imageinfo[0];
    if (!ii || !ii.url) continue;
    const lic = (ii.extmetadata?.LicenseShortName?.value || "").trim();
    if (!/public domain/i.test(lic)) continue;
    return { url: ii.url, desc: page.title, lic };
  }
  return { skip: "no-pd-result" };
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  let okCount = 0;
  for (const t of TARGETS) {
    const found = await searchFirst(t);
    if (found.skip) {
      console.log(`[SKIP] ${t.id} ${t.film}: ${found.skip}`);
      continue;
    }
    const ext = path.extname(new URL(found.url).pathname).split("?")[0] || ".jpg";
    const extClean = /\.(jpg|jpeg|png|webp|tif|tiff)$/i.test(ext) ? ext.toLowerCase() : ".jpg";
    const filePath = path.join(OUT_DIR, `${t.id}-${t.film.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}${extClean}`);
    try {
      const imgRes = await fetch(found.url, { headers: { "User-Agent": "visual-ancestry-qa/1.0 (validation)" } });
      if (!imgRes.ok) { console.log(`[SKIP] ${t.id} ${t.film}: download-http-${imgRes.status}`); continue; }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length < 10_000) { console.log(`[SKIP] ${t.id} ${t.film}: tiny file ${buf.length}B`); continue; }
      await writeFile(filePath, buf);
      okCount += 1;
      console.log(`[OK]   ${t.id} ${t.film}: ${path.basename(filePath)} (${(buf.length / 1024).toFixed(0)}KB) · ${found.lic}`);
    } catch (e) {
      console.log(`[SKIP] ${t.id} ${t.film}: ${e.message?.slice(0, 60)}`);
    }
  }
  console.log(`\n下载完成：${okCount}/${TARGETS.length}`);
}

run().catch((e) => { console.error(e); process.exit(1); });