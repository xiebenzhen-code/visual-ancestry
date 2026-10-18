// Move raw master images out of the public tree (they belong to the build
// pipeline, not the runtime assets). public/assets/artworks/raw -> work/artwork-raw
import { mkdir, rename, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = "C:<local-path>";
const from = path.join(ROOT, "public", "assets", "artworks", "raw");
const to = path.join(ROOT, "work", "artwork-raw");
const log = "C:<local-path>";

import { appendFile } from "node:fs/promises";
const l = (m) => appendFile(log, m + "\n", "utf8").catch(() => {});

try {
  const files = await readdir(from);
  await mkdir(to, { recursive: true });
  let n = 0;
  for (const f of files) {
    await rename(path.join(from, f), path.join(to, f));
    n += 1;
  }
  await l(`MOVED ${n} files`);
} catch (e) {
  await l("MOVE FAIL: " + e.code + " " + e.message);
}
await l("DONE");