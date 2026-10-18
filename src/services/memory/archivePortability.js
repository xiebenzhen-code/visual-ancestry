// P5.8.1 — archivePortability: Personal Archive export / import / restore.
//
// The ONLY backup format (Contract V1, docs/P5.8.1-archive-contract-v1.md):
//   { format:"visual-archive", version:1, exportedAt, memoryCount, memories[] }
// Zero transformation on entries — restore is a verbatim upsert by id.
//
// Boundary (audit §F): this module touches ONLY the personal-memory store
// (visual-memory:v1 / MEMORY_STORE_DIR memories.json) via memoryRepository.
// Artwork cache, #eye browsing profile, artService search cache and QA
// fixtures are never read, written, or cleared.
//
// Image reality (audit §C): the archive carries userData.thumbnail (420px
// JPEG data URL or remote URL) — original file bytes were never persisted.
// UI must tell users: "导出含缩略图，不含原图".
import { listMemories, addMemory, clearPersonalMemory } from "./memoryRepository.js";

export const ARCHIVE_FORMAT = "visual-archive";
export const ARCHIVE_VERSION = 1;

// ---- build / export ---------------------------------------------------------

export function buildArchive(memories, { exportedAt = new Date().toISOString() } = {}) {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt,
    memoryCount: Array.isArray(memories) ? memories.length : 0,
    memories: Array.isArray(memories) ? [...memories] : [],
  };
}

export async function exportPersonalArchive() {
  const memories = await listMemories();
  return buildArchive(memories);
}

// ---- validate ----------------------------------------------------------------

export function validateArchive(archive) {
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
    return { ok: false, reason: "档案内容不是有效的 JSON 对象。" };
  }
  if (archive.format !== ARCHIVE_FORMAT) {
    return { ok: false, reason: `format 不匹配（期望 "${ARCHIVE_FORMAT}"）。` };
  }
  if (archive.version !== ARCHIVE_VERSION) {
    return { ok: false, reason: `archive version 不支持（期望 ${ARCHIVE_VERSION}）。` };
  }
  if (!Array.isArray(archive.memories)) {
    return { ok: false, reason: "memories 字段缺失或不是数组。" };
  }
  if (archive.memoryCount !== archive.memories.length) {
    return { ok: false, reason: `memoryCount (${archive.memoryCount}) 与实际条目数 (${archive.memories.length}) 不符，档案可能已损坏。` };
  }
  return { ok: true };
}

function validEntry(m) {
  return !!(
    m &&
    typeof m === "object" &&
    !Array.isArray(m) &&
    typeof m.id === "string" &&
    m.id &&
    m.visualIntent &&
    typeof m.visualIntent === "object"
  );
}

// ---- import / restore --------------------------------------------------------

// mode "merge" (default): upsert by id — existing ids are overwritten by the
// archive copy (restore semantics); other stores untouched.
// mode "replace": clearPersonalMemory() first (audit §F boundary), then import.
export async function importPersonalArchive(archive, { mode = "merge" } = {}) {
  const v = validateArchive(archive);
  if (!v.ok) return { ok: false, reason: v.reason, restored: 0, skipped: [] };
  if (mode !== "merge" && mode !== "replace") {
    return { ok: false, reason: `未知导入模式 "${mode}"（支持 merge / replace）。`, restored: 0, skipped: [] };
  }

  if (mode === "replace") await clearPersonalMemory();

  let restored = 0;
  const skipped = [];
  for (const m of archive.memories) {
    if (!validEntry(m)) {
      skipped.push({ id: (m && m.id) || "(no id)", reason: "条目结构无效（缺 id 或 visualIntent）" });
      continue;
    }
    await addMemory(m);
    restored += 1;
  }
  return { ok: true, mode, restored, skipped };
}
