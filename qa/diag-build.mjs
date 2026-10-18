// Diagnose why build.mjs fails. Logs to an absolute path (ESM-safe).
import { rm, mkdir, cp, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = "C:<local-path>";
const logPath = path.join(root, "qa", "build-diag.log");
const log = async (msg) => {
  try {
    await appendFile(logPath, msg + "\n", "utf8");
  } catch {}
};

await log("=== diag start ===");
try {
  const dist = path.join(root, "dist");
  try {
    await rm(dist, { recursive: true, force: true });
    await log("rm dist OK");
  } catch (e) {
    await log("rm dist FAIL: " + (e.code || "") + " " + e.message);
    throw e;
  }
  await writeFile(path.join(root, "qa", "probe-write.txt"), "ok");
  await log("write probe OK");

  const build = path.join(root, "scripts", "build.mjs");
  try {
    const out = execFileSync(process.execPath, [build], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    await log("build stdout: " + out.slice(0, 500));
    await log("BUILD OK");
  } catch (e) {
    await log("BUILD FAIL exit=" + e.status);
    await log("stdout: " + String(e.stdout || "").slice(0, 1000));
    await log("stderr: " + String(e.stderr || "").slice(0, 2000));
  }
} catch (e) {
  await log("outer fail: " + e.message);
}
await log("=== diag end ===");