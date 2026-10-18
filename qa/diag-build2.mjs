// Minimal children+build probe, all logging to absolute path.
import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const root = "C:<local-path>";
const logPath = path_join(root, "qa", "build-diag2.log");
function path_join(a, b, c) { return a.replace(/\/+$/, "") + "/" + b + (c ? "/" + c : ""); }
const log = (m) => appendFile(logPath, m + "\n", "utf8").catch(() => {});

await log("node " + process.version);
try {
  const out = execFileSync(process.execPath, ["-e", "console.log('CHILD-OK')"], { encoding: "utf8", timeout: 15000 });
  await log("child stdout: " + out.trim());
} catch (e) {
  await log("CHILD FAIL: " + e.message + " status=" + e.status + " signal=" + e.signal);
  process.exit(1);
}

try {
  const stdout = execFileSync(process.execPath, [path_join(root, "scripts", "build.mjs")], {
    encoding: "utf8",
    timeout: 90000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await log("build stdout: " + stdout.trim().slice(0, 500));
  await log("BUILD-OK");
} catch (e) {
  await log("BUILD-FAIL exit=" + e.status + " signal=" + e.signal);
  await log("stdout: " + String(e.stdout || "").slice(0, 800));
  await log("stderr: " + String(e.stderr || "").slice(0, 2000));
  process.exit(1);
}
await log("DONE");