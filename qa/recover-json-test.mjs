// P2.7.1 — offline unit tests for the duplicate-JSON REJECTION rule.
// NO provider call (fetch is stubbed). The former P2.7 recovery layer MERGED a
// `{...}{...}` answer into a success; that fabricated fields the model never
// returned, so it was removed. This file now proves the fail-closed behaviour:
//
//   (a) detectDuplicatedJsonObject() CLASSIFIES `{...}{...}` (and only that) —
//       it returns no parsed fragments and no value;
//   (b) callVisionProvider with a fetch stub REJECTS a duplicated answer with
//       `invalid-json` (no merge, no fabricated `raw`);
//   (c) the normal single-object path (plain and fenced) is untouched.
import { detectDuplicatedJsonObject, callVisionProvider } from "../server/vision/openaiProvider.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log("PASS", name); }
  else { fail += 1; failures.push(name); console.log("FAIL", name, "→", detail); }
}

const cfg = { endpoint: "http://fake.local", credential: "k", model: "m-test" };
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

function stub(content) {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: {} }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---- 1: the detector classifies, and returns no value ----------------------//
{
  const d = detectDuplicatedJsonObject('{"a":1}\n{"b":2}');
  check("dup detected", d.duplicated === true, JSON.stringify(d));
  check("dup reason", d.reason === "duplicated-json-object", d.reason);
  check("detector carries no parsed fragments", !("first" in d) && !("second" in d), JSON.stringify(d));
  check("single object not flagged", detectDuplicatedJsonObject('{"a":1}').duplicated === false);
  check("nested object flagged", detectDuplicatedJsonObject('{"a":{"b":1}}\n{"c":2}').duplicated === true);
  check("braces in strings handled", detectDuplicatedJsonObject('{"text":"{hello}"}\n{"a":1}').duplicated === true);
  check("escaped quotes handled", detectDuplicatedJsonObject('{"text":"say \\"hi\\" {x}"}{"a":1}').duplicated === true);
  check("trailing prose not flagged", detectDuplicatedJsonObject('{"a":1}hello').duplicated === false);
  check("trailing CJK not flagged", detectDuplicatedJsonObject('{"a":1}。以上为结果').duplicated === false);
  check("fence tail not flagged", detectDuplicatedJsonObject('{"a":1}```json').duplicated === false);
}

// ---- 2: full chain — duplicated content is REJECTED (never merged) ----------//
{
  stub('{"subject":"single-figure","motion":"still"}{"atmosphere":["雾"]}');
  const r = await callVisionProvider(blob, cfg, { timeoutMs: 5000 });
  check("duplicated chain rejected", r.ok === false, JSON.stringify(r));
  check("rejected as invalid-json", r.reason === "invalid-json", JSON.stringify(r));
  check("no merged raw is produced", r.raw === undefined, JSON.stringify(r.raw));
}

// ---- 3: normal single-object answer still parses ----------------------------//
{
  stub('{"subject":"place"}');
  const r = await callVisionProvider(blob, cfg, { timeoutMs: 5000 });
  check("single object accepted", r.ok === true && r.raw && r.raw.subject === "place", JSON.stringify(r));
}

// ---- 4: fenced single object still parses (unchanged behaviour) -------------//
{
  stub('```json\n{"subject":"place"}\n```');
  const r = await callVisionProvider(blob, cfg, { timeoutMs: 5000 });
  check("fenced single object accepted", r.ok === true && r.raw && r.raw.subject === "place", JSON.stringify(r));
}

console.log(`\nDUPLICATE-JSON-REJECT-TEST ${pass} passed / ${fail} failed`);
if (fail > 0) {
  console.log("FAILED:", failures.join(", "));
  process.exit(1);
}
process.exit(0);
