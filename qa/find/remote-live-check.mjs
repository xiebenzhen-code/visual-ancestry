// 真实渠道连通验证（唯一发真实网络请求的验收脚本）。
//
// 目的：证明「Met 新作品可通过 FIND 展示」「Commons 真实电影候选可检索」
// 这两条不是靠stub 假造的。远程函数全部走真实 artService / Commons API。
// 不新增外部渠道：只用已在 remoteDiscovery.js 中登记的四家博物馆 + Commons。

import { searchRemote } from "../../src/services/artService.js";
import { artworks } from "../../src/data/artworks.js";
import {
  discoverPaintingReferences,
  discoverCommonsFilmStills,
  matchChannelMetadata,
  clearDiscoveryCache,
} from "../../src/services/source/remoteDiscovery.js";

clearDiscoveryCache();
const localKeys = new Set(artworks.map((a) => a.key));
const stamp = () => new Date().toISOString().slice(11, 19);

console.log(`\n[${stamp()}] 真实渠道验证开始\n`);

// ---- 1. Met 等博物馆渠道 ----
console.log("== 1. 博物馆渠道（真实请求）==");
const painting = await discoverPaintingReferences("landscape", { limit: 8, searchRemote });

if (painting.error || painting.degraded) {
  console.log(`  渠道降级：${painting.note || painting.error}`);
} else {
  const refs = painting.references || [];
  const showable = refs.filter((r) => r.showable);
  console.log(`  返回 ${refs.length} 件，可展示 ${showable.length} 件`);

  // 必须存在「本地池里没有」的作品 —— 这才是 FIND 真正新增的价值
  const isNew = showable.filter((r) => !localKeys.has(`${r.channel}:${r.sourceId}`));
  console.log(`  其中本地池不存在的（即新增可展示参考）：${isNew.length} 件`);

  for (const r of showable.slice(0, 5)) {
    const m = matchChannelMetadata(r);
    const notLocal = localKeys.has(`${r.channel}:${r.sourceId}`) ? "" : " [新增]";
    console.log(
      `   · ${r.channelName} | ${String(r.title).slice(0, 42)} | ${r.year || "无年份"} | 匹配分 ${m.score}${notLocal}`
    );
    console.log(`     机构: ${r.channelName} | 许可: ${String(r.rights?.text).slice(0, 46)}`);
    console.log(`     图片: ${r.image?.url ? "有" : "无"} | analysisLevel=${r.analysisLevel}`);
    if (m.reasons.length) console.log(`     依据: ${m.reasons.join(" / ")}`);
    console.log(`     provenance: ${m.provenance} | ${m.note}`);
  }

  // 断言：可展示件必须有图、有许可、有来源链接
  const badShowable = showable.filter((r) => !r.image?.url || !r.sourceUrl);
  console.log(`\n  断言1可展示件均有图与来源链接：${badShowable.length === 0 ? "PASS" : `FAIL(${badShowable.length})`}`);
  const leakedLevel = refs.filter((r) => r.analysisLevel > 0);
  console.log(`  断言2 无件伪造 analysisLevel：${leakedLevel.length === 0 ? "PASS" : `FAIL(${leakedLevel.length})`}`);
  const pdOnly = showable.every((r) => r.rights?.publicDomain === true);
  console.log(`  断言3 可展示件全部为公有领域：${pdOnly ? "PASS" : "FAIL"}`);
  console.log(`  断言4 本地池新增参考>0：${isNew.length > 0 ? "PASS" : "FAIL(渠道返回的都是本地已有件)"}`);
}

// ---- 2. Commons 电影画面 ----
console.log(`\n[${stamp()}] == 2. Commons 电影画面（真实请求）==`);
const film = await discoverCommonsFilmStills("intolerance", { limit: 5 });

if (film.error) {
  console.log(`  渠道降级：${film.note || film.error}`);
} else {
  const refs = film.references || [];
  const showable = refs.filter((r) => r.showable);
  const skipped = film.skipped || [];
  console.log(`  扫描 ${film.scanned} 条，收 ${refs.length} 件，可展示 ${showable.length} 件，剔除 ${skipped.length} 件`);
  for (const r of showable.slice(0, 4)) {
    console.log(`   · ${String(r.title).slice(0, 46)} (${r.year || "无年份"})`);
    console.log(`     导演: ${r.director === null ? "null（Commons 不提供，如实留空）" : r.director}`);
    console.log(`     许可: ${r.rights?.licenseShortName || "?"} | 图片: ${r.image?.url ? "有" : "无"}`);
    console.log(`     来源: ${String(r.sourceUrl).slice(0, 70)}`);
  }
  // 剔除理由抽样：证明硬过滤在真实数据上生效
  if (skipped.length) {
    console.log("\n  剔除理由抽样（前 4 条）：");
    for (const s of skipped.slice(0, 4)) {
      console.log(`   ✗ ${String(s.title).replace("File:", "").slice(0, 40)} → ${String(s.why).slice(0, 62)}`);
    }
  }
  const hasReviewReject = skipped.some((s) => String(s.why).includes("需要复查"));
  console.log(`\n  断言5 导演字段保持 null 未被编造：${refs.every((r) => r.director === null) ? "PASS" : "FAIL"}`);
  console.log(`  断言6 可展示件均有图片与来源：${showable.every((r) => r.image?.url && r.sourceUrl) ? "PASS" : "FAIL"}`);
  if (hasReviewReject) console.log(`  断言7 真实数据上「分类需复查」硬过滤生效：PASS（已剔除 ${skipped.filter((s) => String(s.why).includes("需要复查")).length} 件）`);
}

console.log("\n真实渠道验证结束。\n");