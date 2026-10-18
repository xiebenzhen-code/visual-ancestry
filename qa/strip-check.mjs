import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

const t = await readFile("src/services/vision/visionService.js", "utf8");
const stripped = t.replace(/\/\*__QA_SEAM_START__\*\/[\s\S]*?\/\*__QA_SEAM_END__\*\//g, "");
const leaks = ["__FA_TEST_VISION", "__FA_TEST", "MOCK", "iVBORw0KGgo", "qa/fixtures", "VISION_API", "VA_VISION", "Authorization", "Bearer", "apiKey", "providerUrl", "env.js"].filter((tok) => stripped.includes(tok));
console.log("STRIPPED_RESIDUAL_LEAKS=" + JSON.stringify(leaks));
await writeFile("work/strip-check.js", stripped);
execSync(process.execPath + " --check work/strip-check.js", { stdio: "inherit" });
console.log("STRIPPED_SYNTAX_OK");