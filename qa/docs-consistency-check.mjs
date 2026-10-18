// v0.1.1 STEP 3 — 四份文档的一致性核对（只核对，不改文案、不变更许可事实）。
//
// 核对三类声明是否互相矛盾：
//   1) 商业使用（代码 MIT 可商用；资产逐件；MIT 不覆盖作品著作权）
//   2) 运行时馆藏（运行时从博物馆/Commons 取回的内容不属本仓库许可）
//   3) 产品输出（Prompt / 方案不属 MIT 授权范围）
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const read = async (p) => readFile(path.join(ROOT, p), "utf8");
const [zh, en, lic, assets] = await Promise.all([
  read("README.md"),
  read("README.en.md"),
  read("LICENSE"),
  read("LICENSE-ASSETS.md"),
]);

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? " · " + detail : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const has = (text, re) => re.test(text);

console.log("=== 1. 商业使用 ===");
// 四份都须承认「代码可商用」且「MIT 不覆盖作品著作权」
check("LICENSE 声明范围为软件（software only）", has(lic, /SCOPE OF THIS LICEN[CS]E|software only/i), "LICENSE 有 scope 段");
check("LICENSE 明确 MIT 不使藏品可商用", has(lic, /does not make any museum collection commercially/i) || has(lic, /not[\s\S]{0,40}museum/i), "");
check("LICENSE 指向 LICENSE-ASSETS", has(lic, /LICENSE-ASSETS/i));
check("LICENSE-ASSETS 有商业使用表", has(assets, /商业使用|Commercial use/i));
check("LICENSE-ASSETS 称源代码 MIT 可商用", has(assets, /MIT[\s\S]{0,80}可以|MIT[\s\S]{0,40}\*\*可以\*\*/i) || has(assets, /可以\*\*/));
check("LICENSE-ASSETS 说明 MIT 不覆盖作品著作权", has(assets, /MIT 不覆盖作品著作权|MIT does not cover/i));
check("中文 README 有商业使用章节", has(zh, /商业使用/));
check("英文 README 有 Commercial use 章节", has(en, /Commercial use/i));
check("中文 README 声明 MIT 不覆盖作品著作权", has(zh, /MIT 不覆盖作品著作权|不覆盖作品/));
check("英文 README 声明 MIT 不覆盖 artwork copyright", has(en, /MIT does not cover artwork copyright/i));

console.log("\n=== 2. 运行时馆藏 ===");
check("LICENSE-ASSETS：在线检索结果不适用本仓库许可", has(assets, /在线检索结果[\s\S]{0,120}不适用本仓库许可/));
check("LICENSE-ASSETS：不转存、不镜像", has(assets, /不转存|不镜像/));
check("中文 README 区分本地档案与开放馆藏运行时获取", has(zh, /开放馆藏[\s\S]{0,80}公开接口|公开接口（免密钥）/));
check("英文 README 说明 via their public keyless APIs", has(en, /public keyless APIs/i));
check("英文 README：runtime retrieval 不在本仓库许可内", has(en, /Live retrieval results[\s\S]{0,120}Not covered by this repo's licence/i));
check("中文 README：运行时检索结果不属本仓库许可", has(zh, /在线检索结果[\s\S]{0,150}不适用本仓库许可|不属[\s\S]{0,20}MIT/));

console.log("\n=== 3. 产品输出 ===");
check("LICENSE-ASSETS：产品输出不属 MIT 授权范围", has(assets, /产品输出的产物[\s\S]{0,150}不属于 MIT 授权范围/));
check("LICENSE-ASSETS：产品输出可自由使用但非法律意见", has(assets, /不构成法律意见/));
check("英文 README：Generated prompts 不属 MIT 授权范围", has(en, /Generated prompts[\s\S]{0,140}Not covered by the MIT licence/i));
check("英文 README：product output 非法律意见", has(en, /not legal advice/i));
check("中文 README 提及产品输出与参考属性", has(zh, /不构成法律意见|参考建议/));

console.log("\n=== 4. 许可事实一致性（不重写、不改数） ===");
// 画作 46 件：须为 PD 44 + CC0 2（Commons 实测：dance-class 与 radha-krishna-grove 均为 cc0）
check("LICENSE-ASSETS 画作总数为 46", /46\s*件/.test(assets) || /共 \*\*61 张\*\*/.test(assets));
check("LICENSE-ASSETS 给出 PD/CC0 构成", /Public domain 44 件 \+ CC0 2 件/.test(assets), "PD 44 + CC0 2");
check("LICENSE-ASSETS 列出 dance-class 的 CC0", /\|\s*dance-class\s*\|\s*CC0/.test(assets));
check("LICENSE-ASSETS 列出 radha-krishna-grove 的 CC0", /\|\s*radha-krishna-grove\s*\|\s*CC0/.test(assets));
check("LICENSE-ASSETS 说明 CC0 件 Copyrighted=True 的口径", /Copyrighted`? 字段为 `True`|该字段对 CC0/.test(assets));
check("LICENSE-ASSETS 电影 15 件 / 45 webp", /15\s*件源图像\s*\/\s*45\s*个 webp/.test(assets), "15 件源图像 / 45 个 webp");
check("LICENSE-ASSETS 声明 183 个 webp 衍生文件", /183/.test(assets));
check("LICENSE-ASSETS 声明动画素材 0", /动画素材[\s\S]{0,40}0|gif\/webm\/mp4\/apng[\s\S]{0,20}0/.test(assets));

console.log("\n=== 5. 计数口径与实际文件一致 ===");
const { execFileSync } = await import("node:child_process");
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").filter(Boolean);
const artWebp = tracked.filter((f) => /^public\/assets\/artworks\/.*\.webp$/.test(f)).length;
const filmWebp = tracked.filter((f) => /^public\/assets\/film\/.*\.webp$/.test(f)).length;
const artDirs = new Set(tracked.filter((f) => /^public\/assets\/artworks\/.+\.webp$/.test(f)).map((f) => f.split("/")[3]));
const filmDirs = new Set(tracked.filter((f) => /^public\/assets\/film\/.+\.webp$/.test(f)).map((f) => f.split("/")[3]));
check("画作 webp 实测 138", artWebp === 138, `实际=${artWebp}`);
check("电影 webp 实测 45", filmWebp === 45, `实际=${filmWebp}`);
check("画作源图像 46", artDirs.size === 46, `实际=${artDirs.size}`);
check("电影源图像 15", filmDirs.size === 15, `实际=${filmDirs.size}`);
check("webp 合计 183", artWebp + filmWebp === 183, `实际=${artWebp + filmWebp}`);

console.log(`\n=== 文档一致性: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (failures.length) {
  console.log("失败项:");
  for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
