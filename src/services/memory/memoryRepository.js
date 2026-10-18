// P5.1.5 — memoryRepository: VisualMemory persistence, dual-environment.
//
// RESPONSIBILITY: storage ONLY. No vision, no retrieval, no scoring.
// The artwork cache (src/data/visual-intents/artworks.json) is never touched —
// VisualMemory is a parallel, personal namespace.
//
// Environment split (product prototype needs the browser to persist):
//   - browser: localStorage key "visual-memory:v1"  (no server, no new API)
//   - node/QA: JSON file at MEMORY_STORE_DIR/memories.json (default
//     src/data/visual-memory/memories.json), auto-initialized, stable shape,
//     idempotent writes.
//
// API is identical in both environments:
//   addMemory(memory) | getMemory(id) | listMemories() | deleteMemory(id)
// Node-only modules are imported dynamically so the browser bundle never
// resolves node:fs.
import { MEMORY_FILENAME } from "./types.js";

const BROWSER_KEY = "visual-memory:v1";
const STORE_VERSION = 1;

const isBrowser =
  typeof window !== "undefined" &&
  typeof window.localStorage !== "undefined";

// ---- browser backend -------------------------------------------------------
function browserStore() {
  try {
    const raw = window.localStorage.getItem(BROWSER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.memories)) return parsed;
  } catch {
    // fall through to fresh store
  }
  const fresh = { version: STORE_VERSION, memories: [] };
  try {
    window.localStorage.setItem(BROWSER_KEY, JSON.stringify(fresh));
  } catch {
    // storage unavailable (private mode etc.) — in-memory fallback below
  }
  return fresh;
}

let browserCache = null;

function browserAdd(memory) {
  const store = browserCache || (browserCache = browserStore());
  const idx = store.memories.findIndex((m) => m.id === memory.id);
  if (idx >= 0) store.memories[idx] = memory;
  else store.memories.push(memory);
  try {
    window.localStorage.setItem(BROWSER_KEY, JSON.stringify(store));
    return { ok: true, id: memory.id };
  } catch {
    // storage write failed (quota / private mode) — roll back the in-memory
    // change so the UI never reports a save that did not persist.
    if (idx >= 0) store.memories.splice(idx, 1);
    else store.memories.pop();
    return { ok: false, id: memory.id, error: "storage-unavailable" };
  }
}

function browserGet(id) {
  const store = browserCache || (browserCache = browserStore());
  return store.memories.find((m) => m.id === id) ?? null;
}

function browserList() {
  const store = browserCache || (browserCache = browserStore());
  return store.memories;
}

function browserDelete(id) {
  const store = browserCache || (browserCache = browserStore());
  const before = store.memories.length;
  store.memories = store.memories.filter((m) => m.id !== id);
  if (store.memories.length === before) return { deleted: false, ok: true };
  try {
    window.localStorage.setItem(BROWSER_KEY, JSON.stringify(store));
    return { deleted: true, ok: true };
  } catch {
    // storage write failed — restore the last persisted truth so in-memory
    // state stays consistent with what actually survives reload.
    try {
      const raw = window.localStorage.getItem(BROWSER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.memories)) browserCache = parsed;
        else browserCache = { version: STORE_VERSION, memories: [] };
      } else {
        browserCache = { version: STORE_VERSION, memories: [] };
      }
    } catch {
      browserCache = { version: STORE_VERSION, memories: [] };
    }
    return { deleted: false, ok: false, error: "storage-unavailable" };
  }
}

// P5.8.1 — browserReplaceAll: atomic whole-store replacement (single setItem).
// Added for archive import/clear (P5.8.1.0 audit §5 授权 B). Existing APIs
// and the notifications flow are unchanged.
function browserReplaceAll(memories) {
  const clean = Array.isArray(memories) ? [...memories] : [];
  browserCache = { version: STORE_VERSION, memories: clean };
  try {
    window.localStorage.setItem(BROWSER_KEY, JSON.stringify(browserCache));
  } catch {
    // keep in-memory copy; page session still works
  }
  return clean;
}

// ---- node backend ----------------------------------------------------------
let nodeState = null; // { loaded, store }

async function nodeStorePath() {
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.MEMORY_STORE_DIR
    ? path.resolve(process.env.MEMORY_STORE_DIR)
    : path.resolve(__dirname, "..", "..", "data", "visual-memory");
  return { dir: dataDir, file: path.join(dataDir, MEMORY_FILENAME) };
}

async function nodeEnsure() {
  if (nodeState && nodeState.loaded) return nodeState.store;
  const { readFile, mkdir, writeFile } = await import("node:fs/promises");
  const { dir, file } = await nodeStorePath();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && Array.isArray(parsed.memories)) {
      nodeState = { loaded: true, store: parsed, dir, file };
      return parsed;
    }
  } catch {
    // fall through to initialize
  }
  const fresh = { version: STORE_VERSION, memories: [] };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(fresh, null, 2) + "\n", "utf8");
  nodeState = { loaded: true, store: fresh, dir, file };
  return fresh;
}

async function nodePersist() {
  const { writeFile } = await import("node:fs/promises");
  const { file } = await nodeStorePath();
  await writeFile(file, JSON.stringify(nodeState.store, null, 2) + "\n", "utf8");
}

async function nodeAdd(memory) {
  const store = await nodeEnsure();
  const idx = store.memories.findIndex((m) => m.id === memory.id);
  if (idx >= 0) store.memories[idx] = memory;
  else store.memories.push(memory);
  await nodePersist();
  return memory;
}

async function nodeGet(id) {
  const store = await nodeEnsure();
  return store.memories.find((m) => m.id === id) ?? null;
}

async function nodeList() {
  const store = await nodeEnsure();
  return store.memories;
}

async function nodeDelete(id) {
  const store = await nodeEnsure();
  const before = store.memories.length;
  store.memories = store.memories.filter((m) => m.id !== id);
  if (store.memories.length === before) return { deleted: false };
  await nodePersist();
  return { deleted: true };
}

// P5.8.1 — nodeReplaceAll: atomic whole-store replacement (single writeFile).
// Added for archive import/clear (P5.8.1.0 audit §5 授权 B).
async function nodeReplaceAll(memories) {
  const store = await nodeEnsure();
  store.memories = Array.isArray(memories) ? [...memories] : [];
  await nodePersist();
  return store.memories;
}

// ---- unified API ------------------------------------------------------------
export async function addMemory(memory) {
  if (isBrowser) return browserAdd(memory);
  return nodeAdd(memory);
}

export async function getMemory(id) {
  if (isBrowser) return browserGet(id);
  return nodeGet(id);
}

export async function listMemories() {
  if (isBrowser) return browserList();
  return nodeList();
}

export async function deleteMemory(id) {
  if (isBrowser) return browserDelete(id);
  return nodeDelete(id);
}

// P5.8.1 — clear the ENTIRE personal library (lifecycle: export→clear→import).
// Boundary (audit §F): ONLY the personal-memory store is deleted — artwork
// cache, #eye browsing profile (utils/profile.js), artService search cache and
// QA fixtures are separate stores and are never touched.
export async function clearPersonalMemory() {
  if (isBrowser) {
    browserCache = { version: STORE_VERSION, memories: [] };
    try {
      window.localStorage.setItem(BROWSER_KEY, JSON.stringify(browserCache));
    } catch {
      // keep in-memory cleared copy
    }
    return { cleared: true };
  }
  await nodeEnsure();
  nodeState.store = { version: STORE_VERSION, memories: [] };
  await nodePersist();
  return { cleared: true };
}

export { BROWSER_KEY, STORE_VERSION };