// RC1 PART B — artwork licence adjudication.
// The repo marks 46 bundled images publicDomain:true via a DEFAULT
// (`seed.publicDomain !== false`), not per-asset evidence. This asks the
// upstream Wikimedia Commons API for the actual licence of each bundled file,
// so the claim is checked against a source rather than trusted.
//
// Committed with the repo: after a fresh clone, run from the repo root:
//   node qa/licence-audit/rc1-artwork-licence-audit.mjs
// It re-verifies every bundled artwork against its Commons FILE page and
// rewrites qa/licence-audit/rc1-artwork-licence-audit.json.
//
// Read-only, keyless, free. No upload, no Vision provider.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const UA = "VisualArchive-RC1-audit/1.0 (licence verification)";
const API = "https://commons.wikimedia.org/w/api.php";

const { artworks } = await import(pathToFileURL(path.join(ROOT, "src", "data", "artworks.js")).href);
const bundled = artworks.filter((a) => a.image && a.image.type === "local-tiered");
console.log(`bundled artwork images: ${bundled.length}`);

async function commonsInfo(fileName, tries = 6) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "imageinfo",
    iiprop: "extmetadata|url|size",
    titles: `File:${fileName}`,
    origin: "*",
  });
  const url = `${API}?${params}`;
  let last = "";
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      last = `transport:${String(e?.message || e).slice(0, 40)}`;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      continue;
    }
    if (res.status === 429) {
      // Respect rate limiting with real backoff; never treat 429 as a verdict.
      last = "HTTP 429";
      await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
      continue;
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = await res.json();
    const pages = j?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return { error: "missing-on-commons" };
    const ii = (page.imageinfo || [])[0];
    if (!ii) return { error: "no-imageinfo" };
    const em = ii.extmetadata || {};
    const val = (k) => (em[k] && em[k].value ? String(em[k].value).replace(/<[^>]*>/g, "").trim() : null);
    return {
      license: val("LicenseShortName") || val("License"),
      licenseUrl: val("LicenseUrl"),
      copyrighted: val("Copyrighted"),
      artist: (val("Artist") || "").slice(0, 60),
      credit: (val("Credit") || "").slice(0, 60),
      restrictions: val("Restrictions"),
      usageTerms: (val("UsageTerms") || "").slice(0, 80),
      descriptionUrl: ii.descriptionurl,
    };
  }
  return { error: last || "exhausted" };
}

const rows = [];
let ok = 0;
let bad = 0;
for (const a of bundled) {
  const file = a.image?.fileName;
  if (!file) {
    rows.push({ id: a.id, file: null, error: "no-filename", pdClaim: a.publicDomain });
    bad++;
    continue;
  }
  let info;
  try {
    info = await commonsInfo(file);
  } catch (e) {
    info = { error: String(e?.message || e).slice(0, 60) };
  }
  const pdLike = /^(public domain|pd|cc0|cc-zero)/i.test(info.license || "") || info.copyrighted === "False";
  const row = {
    id: a.id,
    file,
    pdClaim: a.publicDomain,
    rightsClaim: a.rightsStatus,
    source: a.source?.name || "",
    sourceUrl: a.source?.url || null,
    commons: info,
    verdict: info.error ? "UNVERIFIED" : pdLike ? "PD-CONFIRMED" : "LICENCE-ATTENTION",
  };
  if (row.verdict === "PD-CONFIRMED") ok++;
  else bad++;
  rows.push(row);
  console.log(`  ${a.id.padEnd(24)} ${row.verdict.padEnd(17)} ${String(info.license || info.error || "?").slice(0, 34)}`);
  await new Promise((r) => setTimeout(r, 1500));
}

const summary = {
  total: bundled.length,
  pdConfirmed: rows.filter((r) => r.verdict === "PD-CONFIRMED").length,
  attention: rows.filter((r) => r.verdict === "LICENCE-ATTENTION").length,
  unverified: rows.filter((r) => r.verdict === "UNVERIFIED").length,
};
console.log(`\nSUMMARY: ${JSON.stringify(summary)}`);
console.log("\n--- non-confirmed entries ---");
for (const r of rows.filter((x) => x.verdict !== "PD-CONFIRMED")) {
  console.log(`  ${r.id}: ${r.verdict}`);
  console.log(`    file   : ${r.file}`);
  console.log(`    commons: ${JSON.stringify(r.commons).slice(0, 200)}`);
}

await writeFile(path.join(ROOT, "qa", "licence-audit", "rc1-artwork-licence-audit.json"), JSON.stringify({ summary, rows }, null, 2));
console.log("written -> qa/licence-audit/rc1-artwork-licence-audit.json");
