// Run build.mjs and capture its error inline (PowerShell pipe issues workaround).
import { execFileSync } from "node:child_process";
import path from "node:path";
const build = path.resolve(import.meta.dirname, "..", "scripts", "build.mjs");
try {
  execFileSync(process.execPath, [build], { stdio: ["ignore", "pipe", "pipe"] });
  console.log("BUILD-OK");
} catch (error) {
  console.log("BUILD-FAIL");
  console.log("STDOUT:", String(error.stdout || "").slice(0, 2000));
  console.log("STDERR:", String(error.stderr || "").slice(0, 2000));
  process.exit(1);
}