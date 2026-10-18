// P5.2.1 — retrieval-test.mjs · Personal Retrieval thin layer QA (STEP 6).
//
// Offline, zero-mock, zero-provider: memories are built with the frozen
// normalizeVisionIntent() (real token space) and stored in a TEMP store;
// retrieveVisualMemory() runs its real code (frozen scoreIntent/sharedReasons
// + personal-layer pipeline).
//
// Cases:
//   Case 1 正向匹配 — 寂静/深空间/空旷 query returns the matching memory
//   Case 2 低匹配   — 热闹/高饱和/多人 partial query returns an HONEST low
//                      score (no forced high ranking), matchedFields accurate
//   Case 3 metadata 隔离 — title "sad movie" / 含查询词 does NOT affect rank;
//                      ranking comes from visualIntent only
//   Case 4 failed 过滤  — status=failed never enters results even when its
//                      visualIntent would match
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "p521-retrieval-"));
  process.env.MEMORY_STORE_DIR = tmp; // before first repository import
  const { createVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "types.js")).href
  );
  const { addMemory, listMemories } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
  );
  const { retrieveVisualMemory, isRetrievable, matchedFields } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
  );
  const { normalizeVisionIntent } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "vision", "normalizeVisionIntent.js")).href
  );
  const { emptyVisualIntent } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "retrieval", "visualIntent.js")).href
  );

  const checks = [];
  const ok = (name, cond) => {
    checks.push([name, !!cond]);
    console.log(`  ${cond ? "PASS" : "FAIL"} ${name}`);
  };

  // Frozen normalization builds real VisualIntents from schema tokens.
  const intent = (patch) => normalizeVisionIntent(patch);

  async function seed(memory) {
    await addMemory(memory);
  }

  // ---- pool: 3 success + 1 failed ------------------------------------------
  await seed(
    createVisualMemory({
      id: "qa-q1", source: "user-upload", status: "success",
      image: { path: "q1.jpg", mime: "image/jpeg", sha256: "a" },
      metadata: { title: "寂静 sad movie", origin: "film-still", tags: [], createdAt: "2026-10-01T00:00:00Z" },
      visualIntent: intent({ atmosphere: ["寂静"], spatialDepth: "deep", negativeSpace: "high", colorTemperature: "cool", saturation: "low", humanRelation: "isolated" }),
      userData: {},
    })
  );
  await seed(
    createVisualMemory({
      id: "qa-n1", source: "user-upload", status: "success",
      image: { path: "n1.jpg", mime: "image/jpeg", sha256: "b" },
      metadata: { title: "寂静之雾 sad 车站", origin: "photo", tags: [], createdAt: "2026-10-01T00:00:00Z" },
      visualIntent: intent({ atmosphere: ["雾"], subject: "place", colorTemperature: "neutral", saturation: "medium", spatialDepth: "shallow" }),
      userData: {},
    })
  );
  await seed(
    createVisualMemory({
      id: "qa-c1", source: "user-upload", status: "success",
      image: { path: "c1.jpg", mime: "image/jpeg", sha256: "c" },
      metadata: { title: "游乐场", origin: "photo", tags: [], createdAt: "2026-10-01T00:00:00Z" },
      visualIntent: intent({ atmosphere: ["热闹"], saturation: "medium", humanRelation: "together", motion: "moving" }),
      userData: {},
    })
  );
  // failed entry whose visualIntent WOULD match — must be excluded by status
  await seed(
    createVisualMemory({
      id: "qa-f1", source: "user-upload", status: "failed",
      error: { code: "VISION_INVALID_RESPONSE", message: "AI 分析失败，请重新尝试。" },
      image: { path: "f1.jpg", mime: "image/jpeg", sha256: "d" },
      metadata: { title: "失败项", origin: "photo", tags: [], createdAt: "2026-10-01T00:00:00Z" },
      visualIntent: intent({ atmosphere: ["寂静"], spatialDepth: "deep", negativeSpace: "high" }),
      userData: {},
    })
  );

  // ---- Case 1: positive match ----------------------------------------------
  console.log("\nCase 1 · 正向匹配（寂静 / 深空间 / 空旷）");
  {
    const res = await retrieveVisualMemory(
      intent({ atmosphere: ["寂静"], spatialDepth: "deep", negativeSpace: "high" }),
      { limit: 5 }
    );
    ok("returns at least one result", res.length > 0);
    const top = res[0];
    ok("top-1 is the quiet memory (qa-q1)", top && top.id === "qa-q1");
    ok("score > 0", top && top.score > 0);
    ok("matchedFields includes atmosphere+spatialDepth+negativeSpace",
      top && ["atmosphere", "spatialDepth", "negativeSpace"].every((f) => top.matchedFields.includes(f)));
    ok("reasons include 氛围 · 寂静", top && top.reasons.includes("氛围 · 寂静"));
    ok("reasons include a scalar label (纵深很深/留白很大)",
      top && (top.reasons.includes("纵深很深") || top.reasons.includes("留白很大")));
    ok("evidence carries memory for display", top && !!top.memory && top.memory.id === "qa-q1");
  }

  // ---- Case 2: honest low match --------------------------------------------
  console.log("\nCase 2 · 低匹配（热闹 / 高饱和 / 多人）");
  {
    const res = await retrieveVisualMemory(
      intent({ atmosphere: ["热闹"], saturation: "high", humanRelation: "crowd" }),
      { limit: 5 }
    );
    ok("partial match returns WITHOUT forced high score", res.length > 0 && res.every((r) => r.score <= 1));
    const top = res[0];
    ok("top result is the partial crowd memory", top && top.id === "qa-c1");
    ok("score reflects only the atmosphere hit (≤1)", top && top.score <= 1);
    ok("matchedFields does NOT claim unmatched fields",
      top && !top.matchedFields.includes("saturation") && !top.matchedFields.includes("humanRelation"));
    ok("reasons honestly list only 氛围 · 热闹", top && top.reasons.length === 1 && top.reasons[0] === "氛围 · 热闹");
  }

  // ---- Case 3: metadata isolation ------------------------------------------
  console.log("\nCase 3 · metadata 隔离（title 含查询词/sad 不污染排名）");
  {
    // qa-n1 title literally contains "寂静 sad" but its visualIntent is 雾/中性
    // → it must NOT appear for a 寂静 query; qa-q1 (intent 寂静) ranks first.
    const res = await retrieveVisualMemory(
      intent({ atmosphere: ["寂静"], spatialDepth: "deep", negativeSpace: "high" }),
      { limit: 5 }
    );
    const ids = res.map((r) => r.id);
    ok("metadata title '寂静 sad…' does not admit qa-n1", !ids.includes("qa-n1"));
    ok("ranking comes from visualIntent (qa-q1 first)", ids[0] === "qa-q1");
    ok("no 'sad'/'寂静' string from title appears in evidence reasons",
      res.every((r) => !r.reasons.some((x) => x.includes("sad"))));
  }

  // ---- Case 4: failed filter -----------------------------------------------
  console.log("\nCase 4 · failed 过滤（status=failed 永不进检索）");
  {
    const res = await retrieveVisualMemory(
      intent({ atmosphere: ["寂静"], spatialDepth: "deep", negativeSpace: "high" }),
      { limit: 5 }
    );
    ok("failed entry excluded even though its intent matches", !res.some((r) => r.id === "qa-f1"));
    ok("isRetrievable(failed) = false", isRetrievable(await listMemories().then((l) => l.find((m) => m.id === "qa-f1"))) === false);
    ok("isRetrievable(example-style source) = false",
      isRetrievable({ status: "success", visualIntent: emptyVisualIntent() }) === false);
  }

  // ---- matchedFields pure unit ----------------------------------------------
  console.log("\nmatchedFields（纯相等枚举）");
  {
    const q = intent({ atmosphere: ["寂静"], colorTemperature: "cool", saturation: "low" });
    const c = intent({ atmosphere: ["寂静", "雾"], colorTemperature: "cool", saturation: "medium" });
    const mf = matchedFields(q, c);
    ok("lists intersection + scalar equality", mf.includes("atmosphere") && mf.includes("colorTemperature"));
    ok("scalar mismatch excluded", !mf.includes("saturation"));
  }

  await rm(tmp, { recursive: true, force: true });
  const failed = checks.filter(([, c]) => !c);
  console.log(`\nP5.2.1 retrieval-test: ${checks.length - failed.length}/${checks.length} PASS`);
  return failed.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}