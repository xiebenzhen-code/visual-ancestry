// Rebuild dist (child exec pattern, logs to absolute path for reliable capture).
import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const root = "C:<local-path>";
const logPath = root + "/qa/build-final.log";
const log = (m) => appendFile(logPath, m + "\n", "utf8").catch(() => {});
await log("=== build attempt " + new Date().toISOString() + " ===");
try {
  const out = execFileSync(process.execPath, [root + "/scripts/build.mjs"], {
    encoding: "utf8", timeout: 90000, stdio: ["ignore", "pipe", "pipe"],
  });
  await log("stdout: " + out.trim());
  await log("BUILD-OK");
} catch (e) {
  await log("BUILD-FAIL exit=" + e.status + " signal=" + e.signal);
  await log("stdout: " + String(e.stdout || "").slice(0, 800));
  await log("stderr: " + String(e.stderr || "").slice(0, 800));
}