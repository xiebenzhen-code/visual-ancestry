// 名称匹配 — 只回答一件事：「这段文字是不是这件作品的名称」。
//
// 与 VisualIntent 检索严格分开：本模块不调用也不修改 retrieveByText /
// retrieveByIntent / scoreIntent，不参与任何评分，不排视觉相似度。
//
// 只读作品数据里**已经存在**的名称字段：字段不存在就跳过——不翻译、不拼装、
// 不推断别名（现有数据里没有作品级别名表，aliases.js 是情绪/氛围/流派的语义
// 词表，不是名称表，所以这里不用它，也不为它编造用法）。
import { artworks } from "../data/artworks.js";
import { filmStillPool, MEDIA } from "../services/retrieval/retrievalService.js";
import { normalize } from "./html.js";
import { ART_SEMANTICS } from "../data/art-semantics.js";

// 名称字段。电影画面候选没有 titleEn（数据里就没有这个字段），会自然被过滤掉。
export function nameFields(item) {
  const base = [
    { label: "中文名", value: item.titleZh },
    { label: "英文名", value: item.titleEn },
    { label: "作品名", value: item.title },
  ];
  // P4.5 — 语义层里记录了有来源的中文别名（如「惠斯勒的母亲」「1808年5月3日」），
  // 它们也是这件作品真实存在的名称，因此纳入名称匹配。没有别名的作品不受影响。
  const sem = ART_SEMANTICS[item.id];
  if (sem && Array.isArray(sem.aliasesZh)) {
    for (const alias of sem.aliasesZh) base.push({ label: "中文别名", value: alias });
  }
  return base.filter((entry) => typeof entry.value === "string" && entry.value.trim());
}

// 与 retrievalService 内部 curatedPool() 同构的池子：同样的媒介口径、同样的
// 「有图且未标为不可用」条件。retrievalService 没有导出这个池，这里按同一规则
// 重建（验收脚本会核对数量 46 / 3 / 49，一旦漂移就会被发现）。
export function namePool(media = "all") {
  const paintings = artworks.filter((artwork) => artwork.image && !artwork.imageUnavailable);
  if (media === MEDIA.ARTWORK) return paintings;
  if (media === MEDIA.FILM) return filmStillPool();
  return paintings.concat(filmStillPool());
}

// 严格两档，没有第三档：
//   exact   —— 去掉首尾空白、忽略大小写后**完全相等**
//   partial —— 名称**连续包含**查询（且查询有足够长度，避免单字命中一大片）
//
// 刻意不做：字符重叠/乱序、编辑距离、拼音、翻译、语义联想。
// 「差不多像」不是「就是它」，这里不把前者当后者展示。
// CJK 输入常省略字间空格（「1808年5月3日」vs 数据里的「1808 年 5 月 3 日」）。
// 只在含 CJK 字符时折叠空格，纯英文查询保持原样以免把单词粘在一起。
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;
function foldCjkSpace(v) {
  return CJK_RE.test(v) ? v.replace(/\s+/g, "") : v;
}

export function matchNames(pool, query) {
  const qRaw = normalize(query);
  if (!qRaw) return [];
  const q = foldCjkSpace(qRaw);
  // 纯 ASCII 查询（英文名）要求 ≥3 字符；含中文的查询要求 ≥2 字符。
  const minPartial = /^[\x20-\x7f]+$/.test(q) ? 3 : 2;
  const exact = [];
  const partial = [];
  for (const item of pool) {
    let hit = null;
    for (const { label, value } of nameFields(item)) {
      const vRaw = normalize(value);
      if (!vRaw) continue;
      const v = foldCjkSpace(vRaw);
      if (v === q) {
        hit = { tier: "exact", label, value };
        break;
      }
      if (!hit && q.length >= minPartial && v.includes(q)) {
        hit = { tier: "partial", label, value };
      }
    }
    if (hit) (hit.tier === "exact" ? exact : partial).push({ artwork: item, ...hit });
  }
  return exact.concat(partial);
}
