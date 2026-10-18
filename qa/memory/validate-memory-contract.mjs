// P5.1 — validate-memory-contract.mjs · pure offline contract validator.
//
// Checks every VisualMemory entry (examples.json + memories.json if present):
//   - id non-empty string, unique across the file
//   - source ∈ MEMORY_SOURCES (and "example" only in examples.json)
//   - image { path, mime, sha256 } present (sha256 may be empty for examples)
//   - visualIntent is a non-empty object (retrieval-only field)
//   - metadata NEVER leaks into visualIntent (film/year/title/tags/… absent)
//   - userData fields never leak into visualIntent
//   - metadata does not influence retrieval: no scoring keys are read here
//     (this validator only PROVES non-contamination, it never scores)
//
// Zero provider calls. Exit 0 = contract OK; exit 1 = any violation.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_SOURCES, MEMORY_STATUSES, MEMORY_FILENAME, EXAMPLES_FILENAME } from "../../src/services/memory/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "src", "data", "visual-memory");
const EXAMPLES_PATH = path.join(DATA_DIR, EXAMPLES_FILENAME);
const MEMORIES_PATH = path.join(DATA_DIR, MEMORY_FILENAME);

// Editorial keys that must NEVER appear inside visualIntent.
const FORBIDDEN_IN_INTENT = new Set([
  "title", "origin", "film", "year", "tags", "createdAt", "note", "collections",
]);

async function load(pathStr, required) {
  try {
    const raw = JSON.parse(await readFile(pathStr, "utf8"));
    return Array.isArray(raw) ? raw : raw.memories || [];
  } catch {
    if (required) throw new Error(`missing required file ${pathStr}`);
    return null;
  }
}

export async function validateMemoryContract() {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  const files = [];

  const examples = await load(EXAMPLES_PATH, true);
  files.push([EXAMPLES_PATH, examples, true]);
  const memories = await load(MEMORIES_PATH, false);
  if (memories) files.push([MEMORIES_PATH, memories, false]);

  for (const [file, entries, isExamples] of files) {
    for (const m of entries) {
      const tag = `${path.basename(file)}:${m.id ?? "?"}`;

      if (typeof m.id !== "string" || !m.id.trim()) errors.push(`[${tag}] id missing/empty`);
      if (seenIds.has(m.id)) errors.push(`[${tag}] duplicate id`);
      seenIds.add(m.id);

      if (!MEMORY_SOURCES.includes(m.source)) errors.push(`[${tag}] unknown source "${m.source}"`);
      if (isExamples && m.source !== "example") {
        errors.push(`[${tag}] examples.json entries must have source="example" (got "${m.source}")`);
      }
      if (!isExamples && m.source === "example") {
        errors.push(`[${tag}] memories.json must not contain source="example" (would fake real vision results)`);
      }

      // P5.1.8 upload-state checks: status must be valid; failed needs error;
      // success must NOT carry a placeholder (empty) intent.
      if (!MEMORY_STATUSES.includes(m.status || "success")) {
        errors.push(`[${tag}] unknown status "${m.status}"`);
      }
      const status = m.status || "success";
      if (status === "failed") {
        if (!m.error || !m.error.code || !m.error.message) {
          errors.push(`[${tag}] status=failed but error {code,message} missing`);
        }
      } else if (status === "success") {
        const src = m.visualIntent && m.visualIntent.source;
        if (src === "empty") {
          errors.push(`[${tag}] status=success but visualIntent is an empty placeholder (source="empty") — looks fabricated`);
        }
      } else {
        warnings.push(`[${tag}] transient status "${status}" persisted (pending/processing should live in UI memory only)`);
      }

      if (!m.image || typeof m.image !== "object") errors.push(`[${tag}] image object missing`);
      else {
        if (!m.image.path) errors.push(`[${tag}] image.path missing`);
        if (!m.image.mime) warnings.push(`[${tag}] image.mime empty (ok for pure examples)`);
        if (!m.image.sha256) warnings.push(`[${tag}] image.sha256 empty (ok for pure examples)`);
      }

      if (!m.visualIntent || typeof m.visualIntent !== "object" || Object.keys(m.visualIntent).length === 0) {
        errors.push(`[${tag}] visualIntent missing/empty (must be a normalized VisualIntent)`);
      } else {
        for (const k of Object.keys(m.visualIntent)) {
          if (FORBIDDEN_IN_INTENT.has(k)) {
            errors.push(`[${tag}] metadata key "${k}" leaked into visualIntent`);
          }
        }
        if (m.visualIntent.source === "example") warnings.push(`[${tag}] visualIntent.source="example" (marker for examples only)`);
      }

      if (m.metadata && typeof m.metadata === "object") {
        // metadata keys may carry editorial facts; they are fine HERE (not in intent)
      }
      if (m.userData && typeof m.userData === "object") {
        for (const k of Object.keys(m.userData)) {
          if (m.visualIntent && k in m.visualIntent) {
            errors.push(`[${tag}] userData key "${k}" duplicated in visualIntent`);
          }
        }
      }
    }
  }

  console.log("P5.1 validate-memory-contract");
  console.log(`  files: ${files.map(([f]) => path.basename(f)).join(", ")} · entries: ${[...seenIds].length}`);
  console.log(`  structural errors: ${errors.length}`);
  for (const e of errors) console.log(`    ERROR ${e}`);
  console.log(`  warnings: ${warnings.length}`);
  for (const w of warnings) console.log(`    note ${w}`);
  if (errors.length === 0) {
    console.log("  STATUS: OK — contract valid; metadata/userData do not contaminate visualIntent");
    return 0;
  }
  console.log("  STATUS: FAIL");
  return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  validateMemoryContract().then((code) => process.exit(code));
}