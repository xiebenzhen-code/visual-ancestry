// filmCorrections.js — STEP 4：用户对动态电影候选的纠正与排除。
//
// 四件事，缺一不可：
//   1. 标记电影身份有误（identity）
//   2. 标记图像性质有误（nature）
//   3. 排除无法核实的件（exclude）
//   4. 标记许可状态有疑问（licence）
//
// 三条不可越过的边界：
//   · **本模块没有任何写回事实字段的接口。** 导演、年份、片名只来自 Commons 与
//     Wikidata 的具名陈述；用户可以「标记这条声称有误 + 附证据」，但产品不会
//     把猜测写进事实字段。上一轮明信片冒充剧照的问题正是靠「按证据纠正」解决的，
//     而不是靠模型改数据。
//   · 纠正必须带证据（evidence 必填）。空理由的纠正不入库——没有依据的标记
//     只会变成另一种噪音。
//   · 只进 sessionStorage：不写任何源码文件、不跨会话、不静默持久化。
//     动态发现的候选是运行时数据，纠正也是。

const KEY = "va-film-corrections-v1";

export const CORRECTION_AXES = {
  identity: "电影身份",
  nature: "图像性质",
  licence: "版权依据",
};

const readAll = () => {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

const writeAll = (list) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(list.slice(-200)));
    return true;
  } catch {
    return false;
  }
};

export function listCorrections() {
  return readAll();
}

/**
 * 记录一条纠正。
 * @param {object} entry
 * @param {string} entry.sourceId   Commons 文件标题（唯一键）
 * @param {"identity"|"nature"|"licence"} entry.axis
 * @param {"wrong"|"unverifiable"|"confusing"} entry.verdict
 * @param {string} entry.evidence   必填：为什么这么判（引文、链接、说明）
 */
export function recordCorrection({ sourceId, axis, verdict, evidence, claimedFrom = "" }) {
  const id = String(sourceId || "").trim();
  if (!id) return { ok: false, reason: "missing-source-id" };
  if (!CORRECTION_AXES[axis]) return { ok: false, reason: "unknown-axis" };
  const note = String(evidence || "").trim();
  if (note.length < 4) return { ok: false, reason: "evidence-required" };

  const entry = {
    sourceId: id,
    axis,
    verdict: verdict || "unverifiable",
    evidence: note.slice(0, 240),
    // 记录它声称有误的是哪一句话，方便复核：
    // claimedFrom 是渠道侧的原文（身份/性质/许可各自的 evidence）。
    claimedFrom: String(claimedFrom || "").slice(0, 200),
    at: new Date().toISOString(),
  };
  const list = readAll().filter((x) => !(x.sourceId === id && x.axis === axis));
  list.push(entry);
  const saved = writeAll(list);
  return { ok: saved, entry, reason: saved ? null : "storage-unavailable" };
}

export function clearCorrection(sourceId, axis) {
  const id = String(sourceId || "").trim();
  const list = readAll().filter((x) => !(x.sourceId === id && (!axis || x.axis === axis)));
  return { ok: writeAll(list) };
}

/** 某条候选当前的纠正集合。 */
export function correctionsFor(sourceId) {
  const id = String(sourceId || "").trim();
  return readAll().filter((x) => x.sourceId === id);
}

/**
 * 把纠正应用到候选列表：
 *   · 被标记 wrong/unverifiable 的候选仍在列表里（用户要看到自己标记过的东西），
 *     但带 correction 标记，界面必须显示标记内容与证据；
 *   · 被「排除」的件（excludeVerdict）直接从列表里移除，并计数上报。
 */
export function applyCorrections(references, { excludeVerdict = "unverifiable" } = {}) {
  const all = readAll();
  const excluded = [];
  const kept = [];
  for (const ref of references) {
    const mine = all.filter((x) => x.sourceId === ref.sourceId);
    if (mine.some((x) => x.axis === "exclude" || x.verdict === `exclude:${excludeVerdict}`)) {
      excluded.push({ sourceId: ref.sourceId, why: mine.map((m) => `${CORRECTION_AXES[m.axis] || m.axis}: ${m.verdict}`).join("；") });
      continue;
    }
    kept.push({ ...ref, corrections: mine });
  }
  return { references: kept, excluded, correctionCount: all.length };
}

/** 一句话说明用户标记了什么（给界面用）。 */
export function summarizeCorrections(corrections = []) {
  if (!corrections.length) return "";
  return corrections
    .map((c) => `${CORRECTION_AXES[c.axis] || c.axis}${c.verdict === "wrong" ? "有误" : "无法核实"}：${c.evidence}`)
    .join("；");
}