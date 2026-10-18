// P5.2.1 — retrieveVisualMemory: a THIN retrieval layer over the personal pool.
//
// Pipeline (the ONLY thing this module does):
//   listMemories() 个人池
//     → 准入过滤（status=success && intent.source 非 empty/example）
//     → scoreIntent()（冻结评分，零复制）
//     → 排序（score 降序，score>0 且 reasons 非空）
//     → evidence { id, score, matchedFields, reasons }
//
// Explicitly does NOT do: upload, vision, storage, UI, natural-language
// parsing, weight design, dedup rules. Retrieval core / artwork cache /
// museum adapters are never imported — personal pool stays fully separate
// (P5.2.0 audit §3).
//
// Boundary: imports ONLY frozen pure functions (scoreIntent from scoring.js,
// sharedReasons from artworkIntent.js) + the personal layer (memoryRepository).
// Nothing here reads the frozen WEIGHTS table; matchedFields is a pure
// equality enumeration, NOT a second scoring system (audit §4.3).
import { scoreIntent } from "../retrieval/scoring.js";
import { sharedReasons } from "../retrieval/artworkIntent.js";
import { listMemories } from "./memoryRepository.js";

// ---- matchedFields (pure equality enumeration, no scoring) ----------------
// Returns field names where query and candidate BOTH carry a value and they
// agree (scalar equality / list intersection). Field names only — no weights,
// no labels. This is the audit-confirmed minimal derivation: sharedReasons
// returns Chinese labels but not field names.
export function matchedFields(query, candidate) {
  const fields = [];
  for (const [field, qv] of Object.entries(query || {})) {
    if (field === "source") continue;
    if (qv === undefined || qv === null || qv === "") continue;
    const cv = candidate[field];
    if (cv === undefined || cv === null || cv === "") continue;
    if (Array.isArray(qv)) {
      if (Array.isArray(cv) && qv.some((t) => cv.includes(t))) fields.push(field);
    } else if (qv === cv) {
      fields.push(field);
    }
  }
  return fields;
}

// ---- retrieval admission (P5.1.8 contract + example exclusion) ------------
// Failed assets are NOT visual assets: status=success required; the P5.1.8
// failed placeholder (emptyVisualIntent, source:"empty") and the P5.1 example
// dataset (source:"example") never enter retrieval.
export function isRetrievable(memory) {
  return !!(
    memory &&
    memory.status === "success" &&
    memory.visualIntent &&
    memory.visualIntent.source !== "empty" &&
    memory.visualIntent.source !== "example"
  );
}

// ---- reasons: frozen labels + list-field labels ----------------------------
// sharedReasons() (frozen) covers scalar fields only — its REASON_LABELS has
// no atmosphere/emotion entries. Those list fields DO score (0.8/0.6 each) and
// DO match, so evidence must label them too. This adds labels at the evidence
// layer only; it never touches scoring (scoreIntent stays the single scorer).
const LIST_REASON_PREFIX = { atmosphere: "氛围 · ", emotion: "情绪 · " };

function personalReasons(query, candidate, limit = 4) {
  const reasons = sharedReasons(query, candidate, limit);
  if (reasons.length >= limit) return reasons;
  for (const [field, prefix] of Object.entries(LIST_REASON_PREFIX)) {
    const qList = Array.isArray(query[field]) ? query[field] : [];
    const cList = Array.isArray(candidate[field]) ? candidate[field] : [];
    for (const token of qList) {
      if (!cList.includes(token)) continue;
      if (reasons.includes(`${prefix}${token}`)) continue;
      reasons.push(`${prefix}${token}`);
      if (reasons.length >= limit) return reasons;
    }
  }
  return reasons;
}

// ---- main entry ------------------------------------------------------------
// queryIntent: a VisualIntent subset using the schema's REAL tokens
//   (atmosphere/emotion: Chinese list tokens like "寂静"; scalar fields:
//   enum tokens like colorTemperature:"cool", spatialDepth:"deep").
// Returns top-K entries: { id, score, matchedFields, reasons, memory }.
export async function retrieveVisualMemory(
  queryIntent,
  { limit = 5, excludeId = "" } = {}
) {
  if (!queryIntent || typeof queryIntent !== "object") {
    throw new TypeError("retrieveVisualMemory: queryIntent (VisualIntent subset) required");
  }
  const memories = await listMemories();
  return memories
    .filter((m) => isRetrievable(m) && m.id !== excludeId)
    .map((m) => {
      const intent = m.visualIntent;
      const scored = scoreIntent(queryIntent, intent);
      const reasons = personalReasons(queryIntent, intent, 4);
      if (scored.score <= 0 || reasons.length === 0) return null;
      return {
        id: m.id,
        score: scored.score,
        possible: scored.possible,
        matchedFields: matchedFields(queryIntent, intent),
        reasons,
        memory: m,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
