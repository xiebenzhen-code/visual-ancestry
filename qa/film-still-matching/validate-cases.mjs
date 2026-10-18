// P4.3 — validate-cases.mjs · pure offline validator (no provider, no images needed).
//
// Checks:
//   - id unique
//   - image path legal (relative, starts with "images/", resolves inside images/)
//   - film is a string
//   - year is number | null
//   - expectedVisualTraits is an array
//   - no unknown fields (scoring/metadata whitelist)
//   - image existence → MISSING_IMAGE when absent
//
// Expected current state (no user-supplied stills yet):
//   5 cases · 5 MISSING_IMAGE · 0 provider calls — NORMAL, not a failure.
// Exit 0 when no structural errors; exit 1 on any structural violation.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, "images");
const ALLOWED_FIELDS = new Set([
  "id",
  "image",
  "film",
  "year",
  "note",
  "expectedVisualTraits",
  "imageSha256",
  "imageWidth",
  "imageHeight",
]);
const MIME_OK_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function validate() {
  const raw = JSON.parse(await readFile(path.join(__dirname, "cases.json"), "utf8"));
  const cases = Array.isArray(raw) ? raw : raw.cases || [];
  const errors = [];
  const warnings = [];
  const missing = [];
  const seen = new Set();

  for (const c of cases) {
    const tag = c.id ?? "?";

    if (typeof c.id !== "string" || !c.id.trim()) errors.push(`[${tag}] id must be a non-empty string`);
    if (seen.has(c.id)) errors.push(`[${tag}] duplicate id`);
    seen.add(c.id);

    // image path
    const img = c.image;
    if (typeof img !== "string" || !img.startsWith("images/")) {
      errors.push(`[${tag}] image must be a relative path starting with "images/"`);
    } else {
      const resolved = path.resolve(__dirname, img);
      if (!resolved.startsWith(IMAGES_DIR + path.sep)) {
        errors.push(`[${tag}] image path escapes qa/film-still-matching/images/`);
      }
      if (img.includes("..") || path.isAbsolute(img)) {
        errors.push(`[${tag}] image path must be relative and must not contain ".."`);
      }
      const ext = path.extname(img).toLowerCase();
      if (!MIME_OK_EXT.has(ext)) warnings.push(`[${tag}] unsupported image extension "${ext}" (expect .jpg/.jpeg/.png/.webp)`);
    }

    if (typeof c.film !== "string") errors.push(`[${tag}] film must be a string`);
    if (!(typeof c.year === "number" || c.year === null)) errors.push(`[${tag}] year must be a number or null`);
    if (!Array.isArray(c.expectedVisualTraits)) errors.push(`[${tag}] expectedVisualTraits must be an array`);
    for (const k of Object.keys(c)) {
      if (!ALLOWED_FIELDS.has(k)) errors.push(`[${tag}] unknown field "${k}"`);
    }
    for (const k of ["imageSha256", "imageWidth", "imageHeight"]) {
      const v = c[k];
      if (!(v === null || v === undefined || typeof v === "string" || typeof v === "number")) {
        errors.push(`[${tag}] ${k} must be null|string|number (reproducibility metadata, never scored)`);
      }
    }

    // image existence → MISSING_IMAGE (honest, normal pre-input state)
    let exists = false;
    try {
      await readFile(path.join(__dirname, img));
      exists = true;
    } catch {
      missing.push(c.id);
    }
    if (!exists && typeof img === "string" && img.startsWith("images/")) {
      warnings.push(`[${tag}] MISSING_IMAGE — waiting for user-supplied film still`);
    }
  }

  console.log("P4.3 validate-cases");
  console.log(`  cases: ${cases.length}`);
  console.log(`  MISSING_IMAGE: ${missing.length}${missing.length ? " (" + missing.join(", ") + ")" : ""}`);
  console.log(`  provider calls: 0 (validator is pure offline)`);
  console.log(`  structural errors: ${errors.length}`);
  for (const e of errors) console.log(`    ERROR ${e}`);
  console.log(`  warnings: ${warnings.length}`);
  for (const w of warnings) console.log(`    note ${w}`);
  if (errors.length === 0) {
    console.log("  STATUS: OK — 5 MISSING_IMAGE is the expected pre-input state (WAITING FOR USER-SUPPLIED FILM STILLS)");
    return 0;
  }
  console.log("  STATUS: FAIL — fix structural errors before running the harness");
  return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  validate().then((code) => process.exit(code));
}
export { validate };
