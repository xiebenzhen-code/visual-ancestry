// P2.7 STEP 4 — zero-cost contract evidence.
//  Part A: VisualIntent V1 validator still enforces every field / enum / format
//          rule (unchanged file, so this proves the frozen contract is intact
//          independently of the blocked provider edit).
//  Part B: duplicated-JSON recovery and the truncated / illegal response paths.
//  Part C: FIND core retrieval regression (no network, no provider).
// No provider call, no budget ledger entry.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { validateVisualIntent, CONTRACT } = await import(
  pathToFileURL(path.join(ROOT, "server", "vision", "visualIntentValidator.mjs")).href
);
const { detectDuplicatedJsonObject } = await import(
  pathToFileURL(path.join(ROOT, "server", "vision", "openaiProvider.mjs")).href
);

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? " \u00b7 " + detail : ""}`);
    console.log(`  \u2717 ${label}${detail ? " \u00b7 " + detail : ""}`);
  }
};

// A syntactically perfect VisualIntent V1 (all 22 keys, legal values).
function validIntent() {
  const o = {};
  for (const [f, allowed] of Object.entries(CONTRACT.ENUM_FIELDS)) o[f] = allowed[0];
  o.emotion = ["平静"];
  o.atmosphere = ["寂静"];
  return o;
}

console.log("Part A \u2014 VisualIntent V1 validator (field / enum / format rules)");
{
  const good = validIntent();
  check("single complete JSON object accepted", validateVisualIntent(good).ok === true);
  check("required key count is 22", CONTRACT.REQUIRED_KEYS.length === 22, `got ${CONTRACT.REQUIRED_KEYS.length}`);

  const missing = validIntent();
  delete missing.melancholy;
  const rMissing = validateVisualIntent(missing);
  check("missing field rejected", rMissing.ok === false && rMissing.code === "intent-missing-fields", rMissing.code);

  const extra = validIntent();
  extra.composition = "center";
  const rExtra = validateVisualIntent(extra);
  check("illegal extra field rejected", rExtra.ok === false && rExtra.code === "intent-unexpected-fields", rExtra.code);

  const badEnum = validIntent();
  badEnum.subject = "landscape";
  const rEnum = validateVisualIntent(badEnum);
  check("illegal enum rejected", rEnum.ok === false && rEnum.code === "intent-invalid-enum", rEnum.code);

  const badType = validIntent();
  badType.contrast = 3;
  const rType = validateVisualIntent(badType);
  check("illegal type rejected", rType.ok === false && rType.code === "intent-invalid-type", rType.code);

  const badToken = validIntent();
  badToken.emotion = ["狂喜"];
  const rToken = validateVisualIntent(badToken);
  check("illegal list token rejected", rToken.ok === false && rToken.code === "intent-invalid-token", rToken.code);

  const tooMany = validIntent();
  tooMany.atmosphere = ["空旷", "寂静", "夜晚", "雾"];
  const rMany = validateVisualIntent(tooMany);
  check("over-length list rejected", rMany.ok === false, rMany.code);

  check("array rejected as non-object", validateVisualIntent([]).code === "intent-not-an-object");
  check("null rejected", validateVisualIntent(null).code === "intent-not-an-object");

  const nulled = validIntent();
  for (const f of Object.keys(CONTRACT.ENUM_FIELDS)) nulled[f] = null;
  nulled.emotion = [];
  nulled.atmosphere = [];
  check("all-null intent is legal (no fabrication needed)", validateVisualIntent(nulled).ok === true);

  // Field names must never be invented to make a bad answer pass.
  check("validator never fills defaults (still rejects on missing)", validateVisualIntent(missing).ok === false);
}

console.log("Part B \u2014 duplicated / truncated upstream payloads (fail closed)");
{
  const frag = JSON.stringify(validIntent());
  check("duplicated JSON object detected (classification only)", detectDuplicatedJsonObject(frag + frag).duplicated === true);
  check("detector returns no mergeable value", !("first" in detectDuplicatedJsonObject(frag + frag)) && !("second" in detectDuplicatedJsonObject(frag + frag)));
  check("duplicate detector never merges to an intent", (() => {
    const d = detectDuplicatedJsonObject(frag + frag);
    // There is no object to validate: the merge path is gone by construction.
    return d.duplicated === true && d.first === undefined && d.second === undefined;
  })());
  check("single object is NOT reported as duplicated", detectDuplicatedJsonObject(frag).duplicated === false);
  check("truncated JSON is not recovered", detectDuplicatedJsonObject(frag.slice(0, frag.length - 12)).duplicated === false);
  check("truncated JSON fails JSON.parse", (() => { try { JSON.parse(frag.slice(0, frag.length - 12)); return false; } catch { return true; } })());
  check("prose-wrapped payload not flagged as duplicate", detectDuplicatedJsonObject("Here is the JSON:\n" + frag).duplicated === false);
}

console.log("Part C \u2014 FIND core retrieval regression (no network, no provider)");
{
  const { retrieveByText } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "retrieval", "retrievalService.js")).href
  );

  const r1 = retrieveByText("孤独 夜晚");
  check("text query returns results", Array.isArray(r1.results) && r1.results.length > 0, `got ${r1.results ? r1.results.length : "undefined"}`);

  const r2 = retrieveByText("夜晚 冷色调");
  const top1 = r2.results && r2.results[0];
  check("canonical probe 「夜晚 冷色调」 ranks a result", !!top1, `got ${r2.results ? r2.results.length : "undefined"}`);
  check("canonical probe top-1 is the starry-night artwork", !!top1 && top1.artwork && top1.artwork.id === "starry", top1 && top1.artwork ? top1.artwork.id : "none");
  check("query provenance is text-parse", r2.queryProvenance === "text-parse", String(r2.queryProvenance));

  const r3 = retrieveByText("雾 空旷");
  check("atmosphere query returns results (film-still path intact)", Array.isArray(r3.results) && r3.results.length > 0, `got ${r3.results ? r3.results.length : "undefined"}`);
  check("every hit carries a score and reasons", (r3.results || []).every((h) => typeof h.retrievalScore === "number" && Array.isArray(h.reasons) && h.reasons.length > 0));

  const { intentForArtwork } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "retrieval", "retrievalService.js")).href
  );
  const anyArt = r1.results && r1.results[0] && r1.results[0].artwork;
  const intent = anyArt ? intentForArtwork(anyArt) : null;
  check("artwork intent resolves (cache or rule fallback)", !!intent && typeof intent === "object");
}

console.log(`\ncontract + FIND regression: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("--- failures ---");
  for (const f of failures) console.log("  " + f);
}
process.exit(fail === 0 ? 0 : 1);
