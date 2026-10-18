// P5.1.8 — VisualMemory data contract now carries an upload STATE so failures
// are visible and recoverable (P5.1.7: 50% provider flake made uploads a
// black box). status/error live on the entry itself — they never participate
// in retrieval; visualIntent remains the ONLY retrieval field.

import { emptyVisualIntent } from "../retrieval/visualIntent.js"; // frozen factory, reused as placeholder

export const MEMORY_SOURCES = [
  "user-upload",
  "film-still",
  "photo",
  "ai-generated",
  "artwork-reference",
  "example", // P5.1 example dataset only — never a real vision result
];

// Upload lifecycle (P5.1.8). pending/processing are transient (UI memory);
// success/failed are persisted.
export const MEMORY_STATUSES = ["pending", "processing", "success", "failed"];

export const MEMORY_FILENAME = "memories.json";
export const EXAMPLES_FILENAME = "examples.json";

export function createReadableId(seq) {
  return `vm-${String(seq).padStart(4, "0")}`;
}

/**
 * Build a VisualMemory entry. Pure function — performs NO storage, NO vision.
 * @param {object} input
 * @param {string} input.id        required unique id (e.g. `vm-0001`)
 * @param {string} input.source    one of MEMORY_SOURCES
 * @param {object} input.image     { path, mime, sha256 }
 * @param {object} input.visualIntent  normalized VisualIntent (retrieval-only field).
 *        REQUIRED when status=success; when status!=success and omitted, an
 *        emptyVisualIntent() placeholder (source:"empty") is used so the entry
 *        keeps a full, valid schema (P5.1.8 — failed entries are recoverable).
 * @param {object} [input.metadata]    human/editorial facts (never scored)
 * @param {object} [input.userData]    user annotations (never scored)
 * @param {string} [input.status]      MEMORY_STATUSES, default "success"
 * @param {object} [input.error]       { code, message } — set when status=failed
 */
export function createVisualMemory({
  id = "",
  source = "user-upload",
  image = { path: "", mime: "", sha256: "" },
  visualIntent = null,
  metadata = {},
  userData = {},
  status = "success",
  error = null,
} = {}) {
  if (!id) throw new Error("VisualMemory: id is required");
  if (!MEMORY_SOURCES.includes(source)) throw new Error(`VisualMemory: unknown source "${source}"`);
  if (!MEMORY_STATUSES.includes(status)) throw new Error(`VisualMemory: unknown status "${status}"`);
  if (status === "success" && (!visualIntent || typeof visualIntent !== "object")) {
    throw new Error(`VisualMemory: visualIntent is required when status=success (${id})`);
  }
  const hasIntent = !!visualIntent && typeof visualIntent === "object";
  return {
    id,
    source,
    status,
    error:
      status === "failed" && error
        ? {
            code: String(error.code ?? "UNKNOWN"),
            message: String(error.message ?? ""),
            retryable: error.retryable !== false,
          }
        : null,
    image: {
      path: String(image.path ?? ""),
      mime: String(image.mime ?? ""),
      sha256: String(image.sha256 ?? ""),
    },
    metadata: {
      title: metadata.title ?? "",
      origin: metadata.origin ?? "",
      film: metadata.film ?? null,
      year: metadata.year ?? null,
      tags: Array.isArray(metadata.tags) ? [...metadata.tags] : [],
      createdAt: metadata.createdAt ?? "",
      ...metadata, // allow additional editorial keys; they never participate in retrieval
    },
    // Placeholder intent keeps the schema valid for failed/pending entries.
    visualIntent: hasIntent ? visualIntent : emptyVisualIntent(),
    userData: {
      note: userData.note ?? "",
      collections: Array.isArray(userData.collections) ? [...userData.collections] : [],
      ...userData,
    },
  };
}