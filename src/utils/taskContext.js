// Task Context — the thinnest cross-page task state (R1.0-R1 Intent
// Continuity Repair, extended by R1.0-R2 Principle Selection). One job
// only: let the VisualIntent produced by FIND, the references the user
// actually picked, and the user's explicit KEEP / REMOVE principle choices
// survive hash navigation into CREATE. Nothing else lives here.
//
// Not a preference model, not an agent layer, no retrieval / vision /
// provider involvement — those modules stay untouched.
//
// Four rules are baked in by design:
//   · New task reset — every new FIND search starts a fresh task: the
//     previous references and principle choices are dropped and the intent
//     is replaced (a search with no results starts an intent-less task, so
//     nothing stale leaks into CREATE).
//   · Real selection — referenceKeys only grows through recordReference(),
//     which pages must call from a genuine user pick. It is never inferred
//     from result lists.
//   · Explicit principle operations — principles carry { field, value,
//     action: keep | remove }. Clearing a choice is NOT a removal: it returns
//     the pair to UNSET. The same field+value can never be keep and remove
//     at once; the latest explicit operation wins.
//   · Stale isolation — a task whose updatedAt is older than STALE_MS
//     reads back as empty, so consumers degrade to their original static
//     behavior instead of acting on yesterday's intent.
//
// Storage: module-level state + sessionStorage mirror (same precedent as
// fa-vision-summary). The mirror only survives refresh within the tab;
// it is never sent anywhere. Schema v1 payloads written before R2 (no
// principles key) stay readable — principles hydrate to an empty list.

const STORAGE_KEY = "fa-task-context";
const SCHEMA_VERSION = 1;
const STALE_MS = 30 * 60 * 1000; // 30 minutes without update = expired task
const MAX_REFERENCES = 12;
const MAX_PRINCIPLES = 24;
const PRINCIPLE_ACTIONS = new Set(["keep", "remove"]);

function emptyState() {
  return { v: SCHEMA_VERSION, taskId: null, intent: null, referenceKeys: [], principles: [], updatedAt: 0 };
}

// Structural guard only (field/value/action shapes). Vocabulary validity —
// whether the field exists and the value is a legal enum — is owned by the
// prompt-translation layer, which is the single writer's validator.
function sanitizePrinciple(entry) {
  if (!entry || typeof entry !== "object") return null;
  const field = typeof entry.field === "string" ? entry.field.trim() : "";
  const value = typeof entry.value === "string" ? entry.value.trim() : "";
  const action = typeof entry.action === "string" ? entry.action.trim() : "";
  if (!field || !value || !PRINCIPLE_ACTIONS.has(action)) return null;
  const out = { field, value, action };
  if (typeof entry.sourceReferenceKey === "string" && entry.sourceReferenceKey.trim()) {
    out.sourceReferenceKey = entry.sourceReferenceKey.trim();
  }
  return out;
}

let state = emptyState();
let seq = 0;

function persist() {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Storage unavailable (private mode, Node test runtime) — memory-only
    // is an acceptable degradation for an in-tab task state.
  }
}

function hydrate() {
  try {
    if (typeof sessionStorage === "undefined") return;
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== SCHEMA_VERSION) return;
    state = {
      v: SCHEMA_VERSION,
      taskId: typeof parsed.taskId === "string" ? parsed.taskId : null,
      intent: parsed.intent && typeof parsed.intent === "object" ? parsed.intent : null,
      referenceKeys: Array.isArray(parsed.referenceKeys)
        ? parsed.referenceKeys.filter((k) => typeof k === "string").slice(0, MAX_REFERENCES)
        : [],
      principles: Array.isArray(parsed.principles)
        ? parsed.principles.map(sanitizePrinciple).filter(Boolean).slice(0, MAX_PRINCIPLES)
        : [],
      updatedAt: Number(parsed.updatedAt) || 0,
    };
    const n = Number(String(state.taskId || "").replace(/\D/g, ""));
    if (Number.isFinite(n)) seq = Math.max(seq, n);
  } catch {
    // Corrupted payload — start clean rather than crash the page.
  }
}

function isFresh(s) {
  return Boolean(s.taskId) && s.updatedAt > 0 && Date.now() - s.updatedAt <= STALE_MS;
}

// New FIND search: reset references AND principle choices, replace intent.
// intent = null means "a search ran but produced no usable intent".
export function beginTask(intent) {
  seq += 1;
  state = {
    v: SCHEMA_VERSION,
    taskId: `t${seq}-${Date.now().toString(36)}`,
    intent: intent && typeof intent === "object" ? intent : null,
    referenceKeys: [],
    principles: [],
    updatedAt: Date.now(),
  };
  persist();
  return getSnapshot();
}

// Drop the whole task (used by tests and by explicit resets).
export function clearTask() {
  state = emptyState();
  persist();
  return getSnapshot();
}

// Only for a real user pick (e.g. clicking a FIND result card).
// Never inferred. No-ops on a stale or absent task.
export function recordReference(key) {
  if (!key || typeof key !== "string") return getSnapshot();
  if (!isFresh(state)) return getSnapshot();
  if (state.referenceKeys.length >= MAX_REFERENCES) return getSnapshot();
  if (!state.referenceKeys.includes(key)) {
    state.referenceKeys = [...state.referenceKeys, key];
  }
  state.updatedAt = Date.now();
  persist();
  return getSnapshot();
}

// One explicit KEEP or REMOVE decision on a (field, value) pair.
//   · structure must be valid (see sanitizePrinciple)
//   · a pair can never be keep and remove at once — the latest explicit
//     call wins and replaces the stored action
//   · no-ops on a stale or absent task (no principles without a task)
// Returns { ok, reason } so the caller can report a rejected choice.
export function setPrinciple(entry) {
  const clean = sanitizePrinciple(entry);
  if (!clean) return { ok: false, reason: "invalid-principle-structure" };
  if (!isFresh(state)) return { ok: false, reason: "no-active-task" };
  const others = state.principles.filter(
    (item) => !(item.field === clean.field && item.value === clean.value)
  );
  if (others.length >= MAX_PRINCIPLES) return { ok: false, reason: "principles-cap-reached" };
  state.principles = [...others, clean];
  state.updatedAt = Date.now();
  persist();
  return { ok: true, reason: null };
}

// Clearing a choice returns the pair to UNSET. It is NOT a removal —
// unchecking a KEEP must never turn into a REMOVE.
export function clearPrinciple(field, value) {
  if (typeof field !== "string" || typeof value !== "string") {
    return { ok: false, reason: "invalid-principle-structure" };
  }
  if (!isFresh(state)) return { ok: false, reason: "no-active-task" };
  state.principles = state.principles.filter(
    (item) => !(item.field === field && item.value === value)
  );
  state.updatedAt = Date.now();
  persist();
  return { ok: true, reason: null };
}

// Read-back view. Stale or absent tasks read as empty so consumers can
// degrade to their original static behavior.
export function getSnapshot() {
  const fresh = isFresh(state);
  return {
    taskId: fresh ? state.taskId : null,
    intent: fresh ? state.intent : null,
    referenceKeys: fresh ? [...state.referenceKeys] : [],
    principles: fresh ? state.principles.map((item) => ({ ...item })) : [],
    fresh,
  };
}

// Test seam — not called by product code.
export function resetForTest() {
  state = emptyState();
  seq = 0;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

hydrate();
