// P2.7 STEP 4 — provider dialect assertions (zero cost, no provider call).
// Asserts the request body the adapter WOULD send: DeepSeek gets json_object
// mode + thinking disabled + an explicit single-object prompt, while every
// other provider keeps the frozen json_schema shape untouched.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const provider = await import(
  pathToFileURL(path.join(ROOT, "server", "vision", "openaiProvider.mjs")).href
);
const { requestBody, serverVisionConfig, visionConfigured, credentialOf } = provider;
const { CONTRACT } = await import(
  pathToFileURL(path.join(ROOT, "server", "vision", "visualIntentValidator.mjs")).href
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

const MIME = "image/jpeg";
const B64 = "AAAA";
const deepseekCfg = { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-flash", credential: "placeholder" };
const otherCfg = { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", credential: "placeholder" };

console.log("A \u2014 DeepSeek dialect (target endpoint)");
{
  const body = requestBody(MIME, B64, deepseekCfg);
  check("response_format is json_object", body.response_format && body.response_format.type === "json_object", JSON.stringify(body.response_format));
  check("no json_schema carried", !body.response_format.json_schema);
  check("thinking explicitly disabled", body.thinking && body.thinking.type === "disabled", JSON.stringify(body.thinking));
  check("max_tokens can carry the object", body.max_tokens >= 2048, String(body.max_tokens));
  check("model is deepseek-flash", body.model === "deepseek-flash", String(body.model));
  check("image travels as a base64 data URL", body.messages[1].content[1].image_url.url.startsWith(`data:${MIME};base64,`));
  check("detail=low preserved", body.messages[1].content[1].image_url.detail === "low");
  check("image is in a user message (system images are a 400)", body.messages[1].role === "user");

  const sys = body.messages[0].content;
  check("system prompt demands a SINGLE complete JSON object", /只输出一个完整的 JSON 对象/.test(sys));
  check("system prompt forbids a second/duplicate object", /第二个对象|重复对象/.test(sys));
  check("system prompt forbids markdown fences", /代码块/.test(sys));
  check("system prompt states the key count (22)", /22 个键/.test(sys));

  const missingFromPrompt = CONTRACT.REQUIRED_KEYS.filter((k) => !sys.includes(k));
  check("prompt enumerates all 22 contract keys", missingFromPrompt.length === 0, missingFromPrompt.join(","));
  check("prompt says uncertain fields must be null (no invention)", /不确定的键填 null/.test(sys));
  check("prompt forbids extra fields", /不得增加任何字段/.test(sys));
  check("prompt keeps the frozen no-inference rules", /严禁推断/.test(sys));
}

console.log("B \u2014 other providers keep the frozen contract");
{
  const body = requestBody(MIME, B64, otherCfg);
  check("response_format stays json_schema", body.response_format && body.response_format.type === "json_schema", JSON.stringify(body.response_format).slice(0, 60));
  check("strict schema preserved", body.response_format.json_schema.strict === true);
  check("schema name preserved", body.response_format.json_schema.name === "visual_intent");
  check("schema object present with additionalProperties:false", body.response_format.json_schema.schema.additionalProperties === false);
  check("schema covers all 22 keys", body.response_format.json_schema.schema.required.length === 22, String(body.response_format.json_schema.schema.required.length));
  check("thinking field NOT injected for other providers", !("thinking" in body));
  check("frozen system prompt unchanged (no key dump)", !/22 个键/.test(body.messages[0].content));
  check("frozen user text unchanged", body.messages[1].content[0].text.includes("严格按 schema"));
}

console.log("C \u2014 config resolution (server env only)");
{
  const fakeEnv = { VISION_API_BASE: "https://api.deepseek.com/chat/completions", VISION_API_KEY: "x".repeat(40), VISION_MODEL: "deepseek-flash" };
  const cfg = serverVisionConfig(fakeEnv);
  check("endpoint read from env", cfg.endpoint === fakeEnv.VISION_API_BASE);
  check("model read from env", cfg.model === "deepseek-flash");
  check("credential slot populated from env", credentialOf(cfg) === fakeEnv.VISION_API_KEY);
  check("credentialOf accepts legacy apiKey shape", credentialOf({ credential: "", apiKey: "legacy" }) === "legacy");
  check("configured = endpoint + credential", visionConfigured(cfg) === true);
  check("unconfigured env is honestly not configured", visionConfigured(serverVisionConfig({})) === false);
  check("endpoint alone is not enough", visionConfigured(serverVisionConfig({ VISION_API_BASE: "https://x.test/" })) === false);
  check("model falls back when absent", serverVisionConfig({ VISION_API_BASE: "https://x.test/", VISION_API_KEY: "k" }).model === "gpt-4o-mini");
  check("no model name is hardcoded for DeepSeek", serverVisionConfig({}).model !== "deepseek-flash");
}

console.log("D \u2014 endpoint classification");
{
  const isDeep = (ep) => requestBody(MIME, B64, { endpoint: ep, model: "m", credential: "c" }).response_format.type === "json_object";
  check("api.deepseek.com -> deepseek dialect", isDeep("https://api.deepseek.com/chat/completions") === true);
  check("bare host -> deepseek dialect", isDeep("https://deepseek.com/chat/completions") === true);
  check("subdomain -> deepseek dialect", isDeep("https://v4.deepseek.com/chat/completions") === true);
  check("openai -> frozen dialect", isDeep("https://api.openai.com/v1/chat/completions") === false);
  check("look-alike host NOT treated as deepseek", isDeep("https://deepseek.com.evil.test/chat/completions") === false);
  check("suffix look-alike NOT treated as deepseek", isDeep("https://notdeepseek.com/chat/completions") === false);
  check("empty endpoint -> frozen dialect (no throw)", isDeep("") === false);
  check("garbage endpoint -> frozen dialect (no throw)", isDeep("not a url") === false);
}

console.log(`\nprovider dialect: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("--- failures ---");
  for (const f of failures) console.log("  " + f);
}
process.exit(fail === 0 ? 0 : 1);
