// RC1 — independently verify the bundled film images against Commons.
// The repo asserts license:"pd" per image; this re-asks Commons so the claim is
// checked, not trusted. Read-only, keyless, free.
//
// Committed with the repo: after a fresh clone, run from the repo root:
//   node qa/licence-audit/rc1-film-licence-audit.mjs
// It re-verifies every bundled film image against its Commons FILE page and
// rewrites qa/licence-audit/rc1-film-licence-audit.json.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const UA = "VisualArchive-RC1-audit/1.0 (licence verification)";
const API = "https://commons.wikimedia.org/w/api.php";

const { filmStills } = await import(pathToFileURL(path.join(ROOT, "src", "data", "filmStills.js")).href);
console.log(`film stills bundled: ${filmStills.length}`);

async function info(title, tries = 6) {
  const params = new URLSearchParams({ action: "query", format: "json", prop: "imageinfo", iiprop: "extmetadata", titles: title, origin: "*" });
  for (let i = 0; i < tries; i++) {
    let res;
    try { res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) }); }
    catch { await new Promise((r) => setTimeout(r, 3000 * (i + 1))); continue; }
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 8000 * (i + 1))); continue; }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = await res.json();
    const page = Object.values(j?.query?.pages || {})[0];
    if (!page || page.missing !== undefined) return { error: "missing" };
    const em = page.imageinfo?.[0]?.extmetadata || {};
    const v = (k) => (em[k]?.value ? String(em[k].value).replace(/<[^>]*>/g, "").trim() : null);
    return { license: v("LicenseShortName"), copyrighted: v("Copyrighted"), usageTerms: (v("UsageTerms") || "").slice(0, 60), artist: (v("Artist") || "").slice(0, 50) };
  }
  return { error: "rate-limited" };
}

const rows = [];
for (const s of filmStills) {
  const title = s.source?.file || "";
  const r = await info(title);
  const pd = /public domain/i.test(r.license || "") || r.copyrighted === "False";
  const verdict = r.error ? "UNVERIFIED" : pd ? "PD-CONFIRMED" : "LICENCE-ATTENTION";
  rows.push({ id: s.id, title: s.titleEn || s.titleZh, claimed: s.source?.license, title_commons: title, commons: r, verdict });
  console.log(`  ${String(s.id).padEnd(22)} claimed=${String(s.source?.license).padEnd(4)} commons=${String(r.license || r.error).padEnd(16)} ${verdict}`);
  await new Promise((res2) => setTimeout(res2, 1500));
}

const summary = {
  total: rows.length,
  pdConfirmed: rows.filter((x) => x.verdict === "PD-CONFIRMED").length,
  attention: rows.filter((x) => x.verdict === "LICENCE-ATTENTION").length,
  unverified: rows.filter((x) => x.verdict === "UNVERIFIED").length,
};
console.log(`\nSUMMARY: ${JSON.stringify(summary)}`);
for (const r of rows.filter((x) => x.verdict !== "PD-CONFIRMED")) {
  console.log(`  ${r.id}: ${r.verdict} claimed=${r.claimed} commons=${JSON.stringify(r.commons).slice(0, 140)}`);
}
await writeFile(path.join(ROOT, "qa", "licence-audit", "rc1-film-licence-audit.json"), JSON.stringify({ summary, rows }, null, 2));
console.log("written -> qa/licence-audit/rc1-film-licence-audit.json");
