// P5.1.5 — browser-store-test.mjs · offline test of the BROWSER branch.
//
// Simulates a browser environment in Node (window.localStorage + WebCrypto),
// then verifies the product prototype's persistence story:
//   add → get → list → "refresh" (new module instance) → still visible.
//
// Zero provider calls; zero real storage touched.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_URL = pathToFileURL(path.join(__dirname, "..", "..", "src", "services", "memory", "memoryRepository.js")).href;

function makeFakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function sampleMemory(id) {
  return {
    id,
    source: "user-upload",
    image: { path: "still.jpg", mime: "image/jpeg", sha256: "abc" },
    metadata: { title: "A still", origin: "film-still", film: null, year: null, tags: [], createdAt: "2026-09-30T00:00:00Z" },
    visualIntent: {
      emotion: [], atmosphere: ["空旷"], subject: "place", subjectScale: "small",
      spatialDepth: "deep", negativeSpace: "high", colorTemperature: "cool",
      saturation: "low", contrast: "medium", source: "vision",
    },
    userData: { note: "", collections: [] },
  };
}

async function run() {
  const storage = makeFakeStorage();
  // Simulate browser BEFORE importing the repository module (isBrowser is
  // evaluated at module load). Repository's browser branch only needs
  // window.localStorage (Node 22 already exposes globalThis.crypto.webcrypto
  // for the upload service, which this test does not exercise).
  globalThis.window = {
    localStorage: storage,
  };

  const checks = [];
  const ok = (name, cond) => {
    checks.push([name, !!cond]);
    console.log(`  ${cond ? "PASS" : "FAIL"} ${name}`);
  };

  // Session A: first page load
  const repoA = await import(REPO_URL);
  await repoA.addMemory(sampleMemory("vm-1001"));
  const listA = await repoA.listMemories();
  ok("add → list contains entry", listA.length === 1 && listA[0].id === "vm-1001");
  const gotA = await repoA.getMemory("vm-1001");
  ok("get returns visualIntent", gotA && gotA.visualIntent && gotA.visualIntent.subject === "place");
  ok("localStorage persisted JSON", storage.getItem("visual-memory:v1") !== null);

  // Session B: "refresh" — a fresh module instance reads the same storage
  // (fresh import URL bypasses the ESM cache → simulates page reload).
  const repoB = await import(`${REPO_URL}?reload=${Date.now()}`);
  const listB = await repoB.listMemories();
  ok("after refresh, collection still visible (1 entry)", listB.length === 1 && listB[0].id === "vm-1001");
  const gotB = await repoB.getMemory("vm-1001");
  ok("after refresh, visualIntent recoverable", gotB && gotB.visualIntent && gotB.visualIntent.atmosphere.includes("空旷"));
  await repoB.deleteMemory("vm-1001");
  const listC = await repoB.listMemories();
  ok("delete works after refresh", listC.length === 0);

  delete globalThis.window;
  const failed = checks.filter(([, c]) => !c);
  console.log(`\nP5.1.5 browser-store-test: ${checks.length - failed.length}/${checks.length} PASS`);
  return failed.length === 0 ? 0 : 1;
}

run().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });