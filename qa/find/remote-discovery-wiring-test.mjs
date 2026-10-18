// 远程发现接入 FIND 的定向验收。
//
// 为什么是 node 执行而不是浏览器：本次运行的 agent-browser 守护进程无法在
// 非交互环境持久化（反复 SIGTERM，pid 写出后即死）。浏览器层验收因此未完成，
// 不能声称通过。这个文件覆盖的是**能在本环境真实执行**的那部分：接线契约、
// 证据语义分离、降级行为、以及最重要的「本地检索不回归」。
//
// 不新增外部 API 调用：远程函数全部注入 stub，测的是我们自己的接线逻辑，
// 不是网络。真实渠道行为由remoteDiscovery.js 自身的实测记录负责。

import { retrieveByText, retrieveByArtwork } from "../../src/services/retrieval/retrievalService.js";
import { artworks } from "../../src/data/artworks.js";
import {
  matchChannelMetadata,
  queryToChannelTerm,
  discoverPaintingReferences,
  discoverCommonsFilmStills,
  clearDiscoveryCache,
} from "../../src/services/source/remoteDiscovery.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n== A. 本地检索不回归（最高优先级）==");

// A1: 本地文本检索仍返回真实本地结果。
// 查询词必须是解析器认的受控词汇——「战争」这类词解析不出任何受控字段，
// 本地池返回 0 件是既有正确行为（记忆中已记载「深空间」解析出全空），
// 不是回归，所以不放进「必须有结果」的这组断言。
const localRuns = ["一个人站在很大的空间里，感觉很远，但不是悲伤。", "雾 空旷", "夜晚 冷色", "空旷 自然"];
let localOk = 0;
for (const q of localRuns) {
  const { results } = retrieveByText(q, { limit: 6 });
  if (results.length > 0 && results.every((r) => !r.artwork.key?.startsWith("remote:"))) localOk++;
}
check("A1 四条查询均返回非空本地结果且不含远程件", localOk === localRuns.length, `${localOk}/${localRuns.length}`);

// A1b: 无法解析成受控字段的查询返回 0 件而非崩溃或返回远程件
const unparsable = retrieveByText("战争", { limit: 6 });
check(
  "A1b 无法解析的查询返回 0 件本地结果（既有行为，非回归）",
  unparsable.results.length === 0 && unparsable.results.every((r) => !r.artwork.key?.startsWith("remote:")),
  `${unparsable.results.length}`
);

// A2: 本地结果全部是本地池成员
const { results: sample } = retrieveByText("雾 空旷", { limit: 6 });
const localKeys = new Set(artworks.map((a) => a.key));
// 2026-10-17：电影画面记录（filmStills）自 R5 STEP 3 起也是本地检索池成员，会被
// retrieveByText 直接命中（那正是该轮交付的能力）。原断言只看 artworks 池，于是
// 把合法的电影命中报成「不在本地池」——过时的是断言前提，不是检索引擎。
const { filmStills } = await import("../../src/data/filmStills.js");
const filmKeys = new Set(filmStills.map((f) => f.id));
check(
  "A2 本地结果的 key 全部存在于本地池（artworks 或已核验电影画面）",
  sample.every((r) => localKeys.has(r.artwork.key) || filmKeys.has(r.artwork.key)),
  sample.map((r) => r.artwork.key).join(",")
);

// A3: 以已有作品为起点的检索仍工作（RC-2 路径）
const seed = artworks.find((a) => a.image && !a.imageUnavailable);
const byArtwork = retrieveByArtwork(seed, { limit: 6 });
check("A3 retrieveByArtwork 仍返回数组", Array.isArray(byArtwork), typeof byArtwork);

// A4: 媒介筛选仍生效
const onlyArt = retrieveByText("雾 空旷", { limit: 6, media: "artwork" });
const onlyFilm = retrieveByText("雾 空旷", { limit: 6, media: "film" });
check(
  "A4 媒介筛选生效（artwork 全为绘画 / film 全为电影）",
  onlyArt.results.every((r) => r.medium !== "film") && onlyFilm.results.every((r) => r.medium === "film"),
  `art=${onlyArt.results.length} film=${onlyFilm.results.length}`
);

// A5: 本地 intent 非空（评分器仍在工作，没有被远程旁路掏空）
check("A5 本地查询产出非空 intent", Object.values(onlyArt.intent || {}).some((v) => v && v.length), "");

console.log("\n== B. 渠道元数据证据语义 ==");

// B1: 无渠道文本 → score 0，且 provenance 仍如实标注
const empty = matchChannelMetadata({ title: "", medium: "", classification: "" });
check("B1 无渠道文本时 score=0", empty.score === 0, String(empty.score));
check("B2 无渠道文本时 provenance 仍为 channel-metadata-text", empty.provenance === "channel-metadata-text", empty.provenance);

// B3: 馆方分类命中风景 → 有匹配分且理由标注**字段名**
const landscape = matchChannelMetadata(
  { title: "View of the Sea", medium: "Oil on canvas", classification: "Landscapes" },
  "landscape"
);
check("B3 风景分类命中得到非零匹配分", landscape.score > 0, String(landscape.score));
check(
  "B4 匹配理由显式标注来自哪个字段",
  (landscape.reasons || []).some((r) => r.includes("馆方分类")),
  JSON.stringify(landscape.reasons)
);

// B5 ★ 核心修复：渠道文本绝不能产出 intentPatch（景深/机位/光位/情绪）
check(
  "B5 渠道元数据不产出 intentPatch（不伪造视觉参数）",
  landscape.intentPatch === null,
  JSON.stringify(landscape.intentPatch)
);
// 逐项验证曾经被伪造的字段
const war = matchChannelMetadata({ title: "Battle Scene", classification: "Military" }, "war");
check("B6 战争题材不再推出 emotion", !JSON.stringify(war.tags || []).includes("紧张"), JSON.stringify(war.tags));
check("B7 战争题材不产出任何视觉参数", !war.intentPatch, JSON.stringify(war.intentPatch));
const night = matchChannelMetadata({ title: "Nocturne", classification: "Nocturnes" }, "night");
check("B8 夜景不产出任何视觉参数", !night.intentPatch, JSON.stringify(night.intentPatch));

check("B9 provenance 永远是 channel-metadata-text", landscape.provenance === "channel-metadata-text", landscape.provenance);
check("B10 note 声明非视觉分析", String(landscape.note).includes("非模型视觉分析"), landscape.note);

// B11 ★ 与查询无关的候选不得获得查询相关性分
const unrelated = matchChannelMetadata(
  { title: "Still Life with Apples", classification: "Still lifes" },
  "landscape"
);
// queryRelated 只在有分数时才出现；完全没有相关线索时该字段为 undefined，
// 语义同样是「不相关」。两种形态都必须为假。
check(
  "B11 与查询无关的候选不获得查询相关性分",
  !unrelated.queryRelated,
  `queryRelated=${unrelated.queryRelated} score=${unrelated.score}`
);
// B12：无关候选不得获得相关性分，也不得因为贴了个题材标签就看起来相关。
// MEASURED（设计变更后）：score=0 时 tags 为空数组——不再给与查询无关的
// 候选挂题材标签，因为那会让用户误以为它"相关只是分低"。
check(
  "B12 无关候选既无相关性分也不挂题材标签",
  unrelated.score === 0 && (unrelated.tags || []).length === 0,
  `score=${unrelated.score} tags=${JSON.stringify(unrelated.tags)}`
);

// B13★ 逐字段匹配：标题命中应能标记为标题来源
const titleHit = matchChannelMetadata({ title: "Winter Landscape", classification: "" }, "winter landscape");
check(
  "B13 标题命中的理由标注为标题/元数据",
  titleHit.queryRelated === true && titleHit.reasons[0].includes("查询词"),
  JSON.stringify(titleHit.reasons)
);

console.log("\n== C. 渠道不可用时的降级（不静默返回空）==");

clearDiscoveryCache();

// C1: searchRemote 抛错 → 返回 degraded + 说明，而非空数组
const thrown = await discoverPaintingReferences("任意查询", {
  searchRemote: async () => {
    throw new Error("channel down");
  },
});
check("C1 渠道抛错时标记 degraded", thrown.degraded === true, JSON.stringify(Object.keys(thrown)));
check("C2 渠道抛错时给出人话说明", typeof thrown.note === "string" && thrown.note.length > 0, thrown.note);
check("C3 渠道抛错时 references 为空数组而非 undefined", Array.isArray(thrown.references), "");

// C4: 缺少 searchRemote 函数 → 明确报错，不崩
const noFn = await discoverPaintingReferences("查询", {});
check("C4 未提供 searchRemote 时返回错误标记", Boolean(noFn.error), noFn.error);

// C5: 降级不影响本地检索（同一进程内再查一次本地）
const afterOutage = retrieveByText("雾 空旷", { limit: 6 });
check("C5 渠道故障后本地检索仍正常", afterOutage.results.length > 0, `${afterOutage.results.length}`);

console.log("\n== D. showable 闸门（版权/图片缺失者不得成为参考）==");

// D1: 非公有领域 → showable=false，不得进入 FIND 结果
const nonPd = await discoverPaintingReferences("风景", {
  searchRemote: async () => [
    {
      key: "met:123",
      sourceId: "123",
      title: "In Copyright",
      artist: "Someone",
      year: "2020",
      image: { url: "https://example.org/x.jpg" },
      publicDomain: false,
      analysisLevel: 0,
    },
  ],
});
check("D1 非公有领域件 showable=false", nonPd.references[0]?.showable === false, JSON.stringify(nonPd.references[0]?.showable));

// D2: 公有领域但无图片 → showable=false
const noImage = await discoverPaintingReferences("风景", {
  searchRemote: async () => [
    {
      key: "met:456",
      sourceId: "456",
      title: "No Image",
      image: null,
      publicDomain: true,
      analysisLevel: 0,
    },
  ],
});
check("D2 公有领域但无图片时 showable=false", noImage.references[0]?.showable === false, "");

// D3: 公有领域且有图片 → showable=true
const good = await discoverPaintingReferences("风景", {
  searchRemote: async () => [
    {
      key: "met:789",
      sourceId: "789",
      title: "Public Domain Landscape",
      artist: "A Painter",
      year: "1880",
      image: { url: "https://example.org/ok.jpg" },
      publicDomain: true,
      source: { name: "The Met", url: "https://met.example/789", rightsStatus: "Public Domain" },
      analysisLevel: 0,
    },
  ],
});
check("D3 公有领域且有图片时 showable=true", good.references[0]?.showable === true, "");
check("D4 渠道机构名从 source.name 正确读取", good.references[0]?.channelName === "The Met", good.references[0]?.channelName);
check("D5 渠道 id 从 key 前缀正确解析", good.references[0]?.channel === "met", good.references[0]?.channel);
check("D6 sourceUrl 从 source.url 正确读取", good.references[0]?.sourceUrl === "https://met.example/789", good.references[0]?.sourceUrl);
check("D7 许可文本从 source.rightsStatus 读取", /Public Domain/.test(good.references[0]?.rights?.text || ""), JSON.stringify(good.references[0]?.rights));

// D8: 远程件 analysisLevel 固定为 0（绝不伪造视觉分析层级）
check("D8 远程件 analysisLevel=0", good.references[0]?.analysisLevel === 0, String(good.references[0]?.analysisLevel));

console.log("\n== E. 中文查询转换（有界映射，不谎报无素材）==");

// E1: 中文视觉描述转成英文受控词
check("E1 「雾 空旷」转成 landscape", queryToChannelTerm("雾 空旷") === "landscape", String(queryToChannelTerm("雾 空旷")));
check("E2 「风景」转成 landscape", queryToChannelTerm("风景") === "landscape", String(queryToChannelTerm("风景")));
check("E3 「夜晚」转成 night", queryToChannelTerm("夜晚") === "night", String(queryToChannelTerm("夜晚")));
// E4: 英文片名原样透传（不翻译，Commons 用英文文件名）
check("E4 「Intolerance」原样透传", queryToChannelTerm("Intolerance") === "Intolerance", String(queryToChannelTerm("Intolerance")));
// E5: 无有界映射时返回 null——调用方据此说明「渠道不支持」，不谎报零结果
check("E5 无映射的中文查询返回 null", queryToChannelTerm("量子纠缠与孤独") === null, String(queryToChannelTerm("量子纠缠与孤独")));
// E6: 空查询返回 null
check("E6 空查询返回 null", queryToChannelTerm("") === null, "");

// E7: 无法映射的中文查询，Commons 渠道必须返回 unsupported 而不是零结果
const unsupported = await discoverCommonsFilmStills("量子纠缠与孤独", { limit: 5 });
check("E7 无法映射时标记 unsupported", unsupported.unsupported === true, JSON.stringify({ u: unsupported.unsupported }));
check("E8 unsupported 时给出可读说明", String(unsupported.note || "").length > 0, unsupported.note);
check("E9 unsupported 时不发伪造结果", (unsupported.references || []).length === 0, String((unsupported.references || []).length));

console.log(`\nremote-discovery-wiring-test: ${pass}/${pass + fail} PASS\n`);
process.exit(fail > 0 ? 1 : 0);