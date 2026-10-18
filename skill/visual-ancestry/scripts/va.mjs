#!/usr/bin/env node
// va.mjs —— Visual Ancestry Skill 的唯一执行入口（三个能力共用一个 CLI）。
//
// 设计约束（首版硬性要求）：
//   1. **不重写检索**。所有检索、召回、电影识别、许可判定都直接 import
//      `src/services/**` 里 Web 产品已经在跑的那份代码。想在这里「顺手优化」
//      评分或再加一套电影搜索，等于让 Skill 与网页行为分叉 —— 不做。
//   2. **没有 Provider 就明说不可用**。Vision 走 /api/vision，没配就是没配，
//      绝不用本地检索结果或任何 mock 假装「我看过这张图」。
//   3. **没有分析记录就说没有**。绝不为作品编造构图/光线/色彩字段。
//
// 用法：
//   node va.mjs search "孤独 夜晚" [--media all|artwork|film] [--limit 6] [--json]
//   node va.mjs search "孤独 夜晚" --external        # 额外走 Wikimedia Commons 实时检索
//   node va.mjs intent bahram-gur-karg
//   node va.mjs plan --refs bahram-gur-karg,the-kiss [--intent "安静 冷调"] [--out plan.md]
//   node va.mjs vision-status [--base http://127.0.0.1:5173]

import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", ".."); // skill/visual-ancestry/scripts → 仓库根
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const flagValue = (name, fallback = "") => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const out = (obj, asJson) => {
  if (asJson || flags.has("--json")) process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  else if (typeof obj === "string") process.stdout.write(obj + "\n");
  else process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
};

const fail = (code, message, extra = {}) => {
  process.stdout.write(JSON.stringify({ ok: false, code, message, ...extra }, null, 2) + "\n");
  process.exit(1);
};

// ---------------------------------------------------------------- 能力 1：检索
async function search() {
  const query = positional[0];
  if (!query) fail("NO_QUERY", '用法: va.mjs search "<query>" [--media all|artwork|film] [--limit N]');
  const limit = Number(flagValue("--limit", "6"));
  const media = flagValue("--media", "all");

  const { retrieveByText, MEDIA } = await imp("src/services/retrieval/retrievalService.js");
  const { artworks } = await imp("src/data/artworks.js");

  // 本地档案：绘画 + 电影画面走同一个检索管线（Web 产品也是这么调的）
  const local = retrieveByText(query, { limit });
  // 结果形状是 { artwork, medium, retrievalScore, reasons, intent, intentProvenance } ——
  // 作品记录在 .artwork 里，媒介字段叫 medium（不叫 media）。猜错字段会让
  // 每条结果的标题、作者、权利状态全变空字符串 —— 那是最难发现的坏输出。
  let results = local.results || [];
  if (media === "artwork") results = results.filter((r) => r.medium !== "film");
  if (media === "film") results = results.filter((r) => r.medium === "film");

  const payload = {
    ok: true,
    capability: "search",
    query,
    media,
    intent: local.intent,
    provenance: "local-corpus",
    corpus: { artworks: artworks.length, returned: results.length },
    results: results.slice(0, limit).map((r) => {
      const a = r.artwork || {};
      return {
        key: a.key,
        id: a.id,
        title: a.titleZh || a.title || "",
        titleEn: a.titleEn || "",
        creator: a.artistZh || a.artist || a.creator || "",
        medium: r.medium || a.medium || "artwork",
        score: r.retrievalScore,
        reasons: r.reasons || [],
        museum: a.museum || a.source?.name || "",
        year: a.year || "",
        rightsStatus: a.rightsStatus || "",
        sourceUrl: a.source?.url || "",
        hasAnalysis: Boolean(a.hasAnalysis),
        analysisProvenance: r.intentProvenance || "",
      };
    }),
  };

  // --external：额外的 Wikimedia Commons 实时检索（复用同一套 concept 拆分与许可判定）
  if (flags.has("--external")) {
    const { discoverCommonsFilmStills } = await imp("src/services/source/remoteDiscovery.js");
    const { conceptTerms } = await imp("src/services/source/filmConceptTerms.js");
    const concepts = conceptTerms(query);
    try {
      const ext = await discoverCommonsFilmStills(query, { limit: Math.min(limit, 8) });
      const extItems = (ext.results || ext.items || []).slice(0, limit);
      payload.external = {
        // 「请求成功」与「有命中」是两件事。0 条时若还报 ok:true，
        // 调用方会以为拿到了外部参考 —— 这里分开说。
        ok: extItems.length > 0,
        requested: true,
        empty: extItems.length === 0,
        source: "Wikimedia Commons",
        fromCache: Boolean(ext.fromCache),
        cacheNote: "缓存依赖浏览器 localStorage；Node 环境下不生效，每次都是实时请求。",
        concepts,
        results: extItems.map((it) => ({
          key: it.key || it.id,
          title: it.title || "",
          creator: it.creator || "",
          pageUrl: it.pageUrl || it.url || "",
          rights: it.rights?.label || it.rightsStatus || "",
        })),
      };
      if (!extItems.length) {
        payload.external.note =
          `Commons 请求成功但没有命中（概念 ${concepts.terms.map((t) => t.term).join("、") || "无"}）。未映射词：${concepts.unmapped.join("、") || "无"}。本地结果不受影响。`;
      }
    } catch (err) {
      payload.external = { ok: false, source: "Wikimedia Commons", message: String(err.message || err) };
    }
  }

  out(payload);
}

// ------------------------------------------------------------ 能力 2：读分析记录
async function intent() {
  const id = positional[0];
  if (!id) fail("NO_ID", "用法: va.mjs intent <artwork-id>");
  const { findArtwork } = await imp("src/data/artworks.js");
  const artwork = findArtwork(id);
  if (!artwork) fail("NOT_FOUND", `档案里没有 id=${id}`, { hint: "先用 search 拿到 key" });

  const { intentFromArtwork } = await imp("src/services/retrieval/artworkIntent.js");
  const { provenanceForArtwork, INTENT_PROVENANCE_LABELS } = await imp("src/services/retrieval/retrievalService.js");

  const record = intentFromArtwork(artwork);
  const provenance = provenanceForArtwork(artwork);
  const has = Boolean(artwork.hasAnalysis);

  out({
    ok: true,
    capability: "intent",
    artwork: {
      id: artwork.id,
      key: artwork.key,
      title: artwork.titleZh || artwork.title,
      creator: artwork.artistZh || artwork.artist,
      year: artwork.year || "",
      museum: artwork.museum || "",
      rightsStatus: artwork.rightsStatus || "",
      sourceUrl: artwork.source?.url || "",
    },
    hasAnalysis: has,
    provenance,
    provenanceLabel: INTENT_PROVENANCE_LABELS?.[provenance] || provenance,
    // 关键诚实性约束：没有记录就是 null，并给出明确说明，绝不补默认值。
    intent: has ? record : null,
    note: has
      ? "以上字段来自档案里已存在的 VisualIntent 记录。"
      : "这件作品没有分析记录 —— 不生成任何构图/光线/色彩推断。它只能贡献来源信息。",
  });
}

// ------------------------------------------------------- 能力 3：生成并导出方案
async function plan() {
  const refs = flagValue("--refs", "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!refs.length) fail("NO_REFS", '用法: va.mjs plan --refs <id1,id2> [--intent "..."] [--out plan.md]');
  if (refs.length > 4) fail("TOO_MANY_REFS", "CREATE 的契约是最多 4 幅参考。");

  const { findArtwork } = await imp("src/data/artworks.js");
  const { intentFromArtwork } = await imp("src/services/retrieval/artworkIntent.js");
  const { translatePrompt, finalPromptText } = await imp("src/services/promptTranslation.js");
  const { getStructuredPrompt } = await imp("src/services/aiService.js");
  const { buildPromptExport, promptExportToMarkdown, promptExportFileName } = await imp("src/utils/promptExport.js");
  const { parseVisualIntent, intentSummary } = await imp("src/services/retrieval/visualIntentParser.js");

  const chosen = [];
  const missing = [];
  for (const id of refs) {
    const a = findArtwork(id);
    if (!a) { missing.push(id); continue; }
    if (!chosen.some((c) => c.key === a.key)) chosen.push(a); // 去重
  }
  if (missing.length) fail("UNKNOWN_REFERENCE", `档案里没有: ${missing.join(", ")}`);

  const freeText = flagValue("--intent", "");
  const intent = freeText ? parseVisualIntent(freeText) : null;
  const intentFresh = Boolean(freeText);

  // references 的形状必须和 create.js 完全一致：{ artwork, aigc, color }。
  // translatePrompt 内部直接读 ref.aigc.compositionPrompt，形状不对就崩 ——
  // 所以这里刻意不自己拼对象，而是照抄页面那条经过验收的装配方式。
  const references = chosen.map((artwork) => ({
    artwork,
    aigc: getStructuredPrompt(artwork) || {},
    color: artwork.color,
  }));

  const result = translatePrompt({ intent: intentFresh ? intent : null, references, principles: [] });
  const promptText = finalPromptText(result);

  // 导出载荷与 Web 端完全同一个纯函数（promptExport.js），所以 Skill 导出的
  // Markdown 与网页点「导出 Markdown」得到的是同一份结构。
  const payload = buildPromptExport({
    promptText,
    intent: intentFresh ? intent : null,
    intentFresh,
    references: chosen,
    taskReferenceKeys: chosen.map((a) => a.key),
  });
  const markdown = promptExportToMarkdown(payload);

  const result_json = {
    ok: true,
    capability: "plan",
    references: chosen.map((a) => ({
      key: a.key,
      id: a.id,
      title: a.titleZh || a.title,
      creator: a.artistZh || a.artist,
      hasAnalysis: Boolean(a.hasAnalysis),
      rightsStatus: a.rightsStatus || "",
    })),
    missingAnalysis: chosen.filter((a) => !a.hasAnalysis).map((a) => a.titleZh || a.title),
    intentSummary: intentFresh ? intentSummary(intent) : null,
    promptText,
    skipped: result.skipped || [],
    exportFileName: promptExportFileName(payload, "md"),
    markdown,
  };

  const outFile = flagValue("--out", "");
  if (outFile) {
    // 内置模块要从 node:fs 直接 import —— 走 imp() 会把它拼成 <repo>/node:fs。
    writeFileSync(outFile, markdown);
    result_json.writtenTo = path.resolve(outFile);
    result_json.markdown = undefined;
  }
  out(result_json);
}

// ------------------------------------------------------------ Vision 可用性
async function visionStatus() {
  const base = flagValue("--base", process.env.VA_BASE_URL || "http://127.0.0.1:5173");
  let status = { ok: false, provider: "not-configured", message: "没有配置 Vision Provider。" };
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/vision/status`, { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    const provider = body.provider || "not-configured";
    status = {
      ok: provider !== "not-configured" && provider !== "disabled",
      base,
      provider,
      configured: Boolean(body.configured),
      // 三种结局都说清楚，不含糊：
      message:
        provider === "not-configured"
          ? "服务端未配置真实识图模型：上传图片 / 以图搜图不可用。文本检索与分析记录不受影响。"
          : status.ok
            ? "Provider 已配置。"
            : "Provider 不可用（预算或访问控制未通过），识图调用会被拒绝。",
    };
  } catch (err) {
    status = { ok: false, provider: "unreachable", base, message: `连不上 ${base}（${String(err.message || err)}）。没有服务端就没有 Vision 通道。` };
  }
  // 明确不做的事：不用本地检索结果或任何 mock 充当「已识图」。
  status.notASubstitute = "本地检索结果不是视觉模型输出，绝不会以「识图成功」呈现。";
  out(status);
}

const COMMANDS = { search, intent, plan, "vision-status": visionStatus };
if (!COMMANDS[cmd]) {
  fail("UNKNOWN_COMMAND", `未知命令: ${cmd || "(空)"}`, { usage: "search | intent | plan | vision-status" });
}
await COMMANDS[cmd]();
