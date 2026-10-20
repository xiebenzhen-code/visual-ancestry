// repair-media.mjs — 修正历史记录里与实际图片不符的媒介分类
//
// 只做一件确定的事：记录的内容哈希命中已知馆藏/影片时，把 media 改成那张图
// 真实的媒介，并把原值存进 mediaRepair 以便追溯。其余字段一概不动。
//
// 默认 dry-run，加 --apply 才写盘；写盘前先把 records 目录整体备份。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseHashIndex, baseTraditionMap } from "./media-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, ".rc1-user-library/records");
const APPLY = process.argv.includes("--apply");

const index = baseHashIndex(ROOT);
const traditions = await baseTraditionMap();

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
const changes = [];

for (const f of files) {
  const p = path.join(DIR, f);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
  const hit = index.get(rec.hash);
  if (!hit) continue;

  const real =
    hit.kind === "film"
      ? { medium: "film", visualForm: "live-action", tradition: null, imageKind: "frame" }
      : {
          medium: "artwork",
          visualForm: "still-image",
          tradition: traditions.get(hit.id) || null,
          imageKind: "artwork-reproduction",
        };

  const cur = rec.media || {};
  const same =
    cur.medium === real.medium &&
    cur.visualForm === real.visualForm &&
    (cur.tradition || null) === (real.tradition || null);
  if (same) continue;

  changes.push({ file: f, id: rec.id, from: cur, to: real, evidence: `base-image:${hit.id}` });
}

if (!changes.length) {
  console.log("没有需要修正的记录。");
  process.exit(0);
}

console.log(`需要修正 ${changes.length} 条：\n`);
for (const c of changes) {
  console.log(`  ${c.id}  (${c.file})`);
  console.log(`    现在: ${c.from.medium}/${c.from.visualForm}/${c.from.tradition || "-"}`);
  console.log(`    应为: ${c.to.medium}/${c.to.visualForm}/${c.to.tradition || "-"}   ← ${c.evidence}`);
}

if (!APPLY) {
  console.log("\n这是 dry-run。确认无误后加 --apply 写盘。");
  process.exit(0);
}

// 备份：整目录复制一份，带时间戳
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(ROOT, `.rc1-user-library/records.backup-${stamp}`);
fs.cpSync(DIR, backup, { recursive: true });
console.log(`\n已备份到 ${path.relative(ROOT, backup)}`);

for (const c of changes) {
  const p = path.join(DIR, c.file);
  const rec = JSON.parse(fs.readFileSync(p, "utf8"));
  rec.mediaRepair = { at: new Date().toISOString(), from: rec.media, to: c.to, evidence: c.evidence };
  rec.media = c.to;
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
console.log(`已修正 ${changes.length} 条。`);
