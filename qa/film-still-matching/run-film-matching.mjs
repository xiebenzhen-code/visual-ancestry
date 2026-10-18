// P4.3 — Film Still Matching harness (THIN chain only).
//
// Film Still is a NEW query asset type, NOT a new retrieval system.
// This harness ONLY CALLS the frozen Core V1 components:
//
//   read image → base64 → POST /api/vision (existing same-origin bridge)
//   → normalizeVisionIntent (frozen, pure function)
//   → retrieveByIntent(intent, { limit: 8 }) (frozen retrieval core;
//     intentSource="auto" consumes the artwork VisualIntent cache and the
//     rule fallback internally)
//
// It NEVER:
//   - copies scoring or retrieval logic
//   - computes similarity by itself
//   - interprets VisualIntent values
//   - adds a film-specific prompt or schema
//   - mocks intents, falls back to text metadata, or uses film titles
//
// Failure contract: a failing film still never aborts the batch; the case is
// kept, provider status/error is recorded honestly, generatedIntent=null,
// matches=[], and the next case runs.
//
// Invocation:
//   node qa/film-still-matching/run-film-matching.mjs
//   node qa/film-still-matching/run-film-matching.mjs --base=http://127.0.0.1:4175
//   node qa/film-still-matching/run-film-matching.mjs --only=fs-01,fs-02
//   node qa/film-still-matching/run-film-matching.mjs --dry   (no provider calls)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const CASES_PATH = path.join(__dirname, "cases.json");
const RESULTS_PATH = path.join(__dirname, "results.json");
const DEFAULT_BASE = "http://127.0.0.1:4175";
const TOP_K = 8;
const REQUEST_TIMEOUT_MS = 60_000;

const MIME_BY_EXT = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : fallback;
}
const BASE = argValue("base", DEFAULT_BASE);
const ONLY = argValue("only", "");
const DRY = process.argv.includes("--dry");

// ---- frozen component loading (offline-resolvable, zero provider calls) ---
export async function loadCore() {
  const retrieval = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "retrieval", "retrievalService.js")).href
  );
  const normalize = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "vision", "normalizeVisionIntent.js")).href
  );
  // The exact same cache file the retrieval core consumes; read here ONLY to
  // label each match's candidate intent source (vision cache vs rule fallback).
  // This is a data read — no logic, no scoring.
  const cacheMod = await import(
    pathToFileURL(path.join(ROOT, "src", "data", "visual-intents", "artworks.json")).href,
    { with: { type: "json" } }
  );
  const cacheIntents = (cacheMod.default && cacheMod.default.intents) || {};
  return {
    retrieveByIntent: retrieval.retrieveByIntent,
    normalizeVisionIntent: normalize.normalizeVisionIntent,
    cache: cacheIntents,
  };
}

// ---- evidence-only helper (NOT scoring) ----------------------------------
// Field-name presence intersection between the query intent and a candidate
// intent. Reports WHICH fields both sides carry a value — no weights, no
// values, no similarity computation. The frozen sharedReasons (value-equality,
// Chinese labels) is recorded separately as reasons[].
const EXCLUDE_FIELDS = new Set(["source"]);
export function sharedFieldNames(queryIntent, candidateIntent) {
  const names = [];
  for (const [field, qv] of Object.entries(queryIntent || {})) {
    if (EXCLUDE_FIELDS.has(field)) continue;
    if (!qv || (Array.isArray(qv) && !qv.length)) continue;
    const cv = candidateIntent && candidateIntent[field];
    if (!cv || (Array.isArray(cv) && !cv.length)) continue;
    names.push(field);
  }
  return names;
}

async function imageMeta(bytes, ext) {
  const mime = MIME_BY_EXT.get(ext) || null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let width = null;
  let height = null;
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(bytes).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch {
    // sharp unavailable or undecodable — metadata stays null (non-blocking)
  }
  return { mime, sha256, sizeBytes: bytes.length, width, height };
}

export async function runCase(caseDef, core, { base = BASE, dry = DRY } = {}) {
  const record = {
    id: caseDef.id,
    image: caseDef.image,
    film: caseDef.film,          // test metadata only — never scored
    year: caseDef.year,          // test metadata only — never scored
    note: caseDef.note,          // test metadata only — never scored
    provider: { status: null, latencyMs: null, error: null },
    generatedIntent: null,
    matches: [],
    evaluation: { structural: null, tonalAtmospheric: null, semanticLeakage: null, relation: null },
    skipped: null,
  };

  const imagePath = path.join(__dirname, caseDef.image);
  let bytes;
  try {
    bytes = await readFile(imagePath);
  } catch {
    record.skipped = "MISSING_IMAGE";
    record.provider = { status: "skipped-missing-image", latencyMs: null, error: "image file not found" };
    return record; // never call the provider without the image
  }

  const meta = await imageMeta(bytes, path.extname(caseDef.image).toLowerCase());
  record.imageSha256 = meta.sha256;
  record.imageSizeBytes = meta.sizeBytes;
  record.imageWidth = meta.width;
  record.imageHeight = meta.height;
  record.imageMime = meta.mime;

  if (!meta.mime) {
    record.provider = {
      status: "unsupported-format",
      latencyMs: null,
      error: `unsupported extension for "${caseDef.image}" (expect .jpg/.jpeg/.png/.webp)`,
    };
    return record;
  }
  if (dry) {
    record.skipped = "DRY_RUN";
    record.provider = { status: "dry-run", latencyMs: null, error: null };
    return record;
  }

  // --- ONE POST to the existing /api/vision bridge (the only entry) --------
  const started = Date.now();
  let res = null;
  let data = null;
  try {
    res = await fetch(`${base}/api/vision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: bytes.toString("base64"), mimeType: meta.mime }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    record.provider = {
      status: "network-error",
      latencyMs: Date.now() - started,
      error: String((err && err.message) || err),
    };
    return record;
  }
  record.provider.attempted = true;
  record.provider.latencyMs =
    data && typeof data.latencyMs === "number" ? data.latencyMs : Date.now() - started;

  if (res.status !== 200 || !data || data.ok !== true || !data.intent || typeof data.intent !== "object") {
    record.provider.status = String(res.status);
    record.provider.error =
      data && data.error ? `${data.error.code}: ${data.error.message}` : `HTTP ${res.status}`;
    return record; // honest failure — no mock, no fallback to film metadata
  }
  record.provider.status = "ok";

  // --- frozen normalize + frozen retrieval ---------------------------------
  const intent = core.normalizeVisionIntent(data.intent);
  if (!intent) {
    record.provider.status = "normalize-failed";
    record.provider.error = "normalizeVisionIntent returned null (malformed intent)";
    return record;
  }
  record.generatedIntent = intent;

  const results = core.retrieveByIntent(intent, { limit: TOP_K });
  record.matches = results.map((item, index) => ({
    rank: index + 1,
    artworkId: item.artwork.id,
    title: item.artwork.title,
    score: item.retrievalScore,
    matchedFields: sharedFieldNames(intent, item.intent),
    reasons: item.reasons, // frozen sharedReasons output (value-equality labels)
    intentSource: core.cache[item.artwork.id] && core.cache[item.artwork.id].source === "vision" ? "vision" : "rule",
  }));
  return record;
}

export async function runAll(cases, core, { base = BASE, dry = DRY } = {}) {
  const targets = ONLY ? cases.filter((c) => ONLY.split(",").includes(c.id)) : cases;
  const records = [];
  for (const caseDef of targets) {
    records.push(await runCase(caseDef, core, { base, dry }));
  }
  const providerCalls = records.filter((r) => r.provider.attempted).length;
  const meta = {
    phase: "P4.3 Film Still Matching harness",
    ranAt: new Date().toISOString(),
    base,
    topK: TOP_K,
    dry,
    providerCalls,
    casesAttempted: targets.length,
    frozenCoreModified: false,
    note: "results are evidence records only — evaluation (structural/tonalAtmospheric/semanticLeakage/relation) stays null for manual/human assessment.",
  };
  return { meta, cases: records };
}

async function main() {
  const cases = (JSON.parse(await readFile(CASES_PATH, "utf8"))).cases || [];
  if (!cases.length) throw new Error("cases.json: no cases found");
  const core = await loadCore();
  const output = await runAll(cases, core, { base: BASE, dry: DRY });
  await writeFile(RESULTS_PATH, JSON.stringify(output, null, 2));
  const missing = output.cases.filter((r) => r.skipped === "MISSING_IMAGE").length;
  console.log(`P4.3 run: ${output.cases.length} case(s) · provider calls: ${output.meta.providerCalls} · MISSING_IMAGE: ${missing} · results → results.json`);
  for (const r of output.cases) {
    if (r.skipped) console.log(`  [${r.id}] skipped=${r.skipped} provider=${r.provider.status}`);
    else console.log(`  [${r.id}] provider=${r.provider.status} matches=${r.matches.length}`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("P4.3 run failed:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
