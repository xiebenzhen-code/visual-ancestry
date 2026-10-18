// P5.1 — memory-repository-test.mjs · offline CRUD + idempotency test.
//
// Uses a TEMP store dir (MEMORY_STORE_DIR) — never touches the real
// src/data/visual-memory/memories.json and never calls the provider.
//
// Tests:
//   create → read → list → upsert(idempotent) → delete
//   auto-init on missing file
//   JSON shape stability ({ version, memories: [] })
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createVisualMemory } from "../../src/services/memory/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sampleIntent(over = {}) {
  return {
    emotion: [],
    atmosphere: ["空旷"],
    subject: "place",
    subjectScale: "small",
    subjectPosition: "center",
    spatialDepth: "deep",
    negativeSpace: "high",
    environmentDominance: "high",
    lightDirection: "side",
    lightQuality: "diffuse",
    colorTemperature: "cool",
    saturation: "low",
    contrast: "medium",
    humanRelation: "isolated",
    cameraDistance: "far",
    cameraHeight: "eye",
    cameraRelation: "observational",
    motion: "still",
    visualDensity: "sparse",
    arousal: "low",
    socialDistance: "high",
    melancholy: "low",
    source: "vision",
    ...over,
  };
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "p51-mem-"));
  process.env.MEMORY_STORE_DIR = tmp; // must be set before first import of repository
  const STORE_PATH = path.join(tmp, "memories.json"); // node backend file (MEMORY_STORE_DIR + filename)
  const { addMemory, getMemory, listMemories, deleteMemory } = await import(
    pathToFileURL(path.join(__dirname, "..", "..", "src", "services", "memory", "memoryRepository.js")).href
  );

  const checks = [];
  const ok = (name, cond) => {
    checks.push([name, !!cond]);
    console.log(`  ${cond ? "PASS" : "FAIL"} ${name}`);
  };

  // 0) auto-init: first repository call creates the store file
  await listMemories(); // triggers ensureStore() → persist()
  let raw = await readFile(STORE_PATH, "utf8").catch(() => null);
  ok("auto-init creates store file", raw !== null);
  const init = JSON.parse(raw);
  ok("initial shape {version, memories:[]}", init.version === 1 && Array.isArray(init.memories) && init.memories.length === 0);

  // 1) create
  const m1 = createVisualMemory({
    id: "vm-0001",
    source: "user-upload",
    image: { path: "img/a.jpg", mime: "image/jpeg", sha256: "abc" },
    metadata: { title: "Test", origin: "photo", film: null, year: 2026, tags: ["x"], createdAt: "2026-09-30T00:00:00Z" },
    visualIntent: sampleIntent(),
    userData: { note: "hi", collections: [] },
  });
  await addMemory(m1);
  const got = await getMemory("vm-0001");
  ok("create → get returns same id", got && got.id === "vm-0001");
  ok("visualIntent persisted (retrieval field)", got && got.visualIntent && got.visualIntent.subject === "place");

  // 2) list
  const list = await listMemories();
  ok("list contains created entry", list.length === 1 && list[0].id === "vm-0001");

  // 3) upsert idempotent (same id, same content → no duplication)
  await addMemory(m1);
  const list2 = await listMemories();
  ok("upsert does not duplicate (1 entry)", list2.length === 1);

  // 4) metadata isolation — metadata keys must NOT be inside visualIntent
  const leaked = Object.keys(got.visualIntent).filter((k) => ["title", "origin", "film", "year", "tags", "createdAt", "note"].includes(k));
  ok("metadata not leaked into visualIntent", leaked.length === 0);

  // 5) delete
  const del = await deleteMemory("vm-0001");
  ok("delete returns deleted:true", del.deleted === true);
  const after = await getMemory("vm-0001");
  ok("get after delete → null", after === null);
  const list3 = await listMemories();
  ok("list empty after delete", list3.length === 0);

  // 6) delete non-existent → deleted:false
  const del2 = await deleteMemory("vm-9999");
  ok("delete missing → deleted:false", del2.deleted === false);

  await rm(tmp, { recursive: true, force: true });
  const failed = checks.filter(([, c]) => !c);
  console.log(`\nP5.1 memory-repository-test: ${checks.length - failed.length}/${checks.length} PASS`);
  return failed.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}