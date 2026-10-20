// mediaTaxonomy.js — P4.14-B2 兼容式四层媒介描述
//
// 为什么是「派生」而不是「迁移」：
//   `medium` 在 8 处被字符串直比（find.js:69/77/1105/1126、monochromePolicy.js:243、
//   artContext.js:154、memoryAssistant.js:27、retrievalService.js:215/245/250）。
//   重命名或扩充它的取值会让 FIND / CREATE / SHOOT / MEMORY 与旧链接一起失效。
//   所以旧枚举**一个字都不改**，新语义加在三个派生层上。
//
// 四层含义：
//   medium      基础媒介：artwork（绘画等静态作品）/ film。旧枚举，只读不改。
//   visualForm  画面形式：live-action / animation / still-image。**真人还是动画**。
//   tradition   有证据的创作传统：anime / ukiyo-e / romanticism ……
//   imageKind   这张图到底是什么：逐帧截图 / 场景剧照 / 宣传照 / 作品复制图 / 海报。
//
// Anime 与 Animation 不是互斥类型：动画是一个 visualForm，anime 是它下面一个有证据的传统。
// 因此 `describeMedia()` 对一部日本动画会返回 { visualForm:"animation", tradition:"anime" }。
//
// 一条硬约束（任务书原文）：**不得仅因画风类似日本动漫，就断言作品属于日本动画。**
// 本模块的 tradition 只能来自数据声明，绝不从像素、标题或相似度推断。

/** 基础媒介。与 retrievalService 的 MEDIA 保持一致；此处重复定义只是为了本模块零依赖。 */
export const MEDIUM = Object.freeze({
  ARTWORK: "artwork",
  FILM: "film",
});

/** 画面形式。注意：这是「真人 / 动画 / 静态作品」的区别，不是题材区别。 */
export const VISUAL_FORM = Object.freeze({
  LIVE_ACTION: "live-action",
  ANIMATION: "animation",
  STILL_IMAGE: "still-image",
  UNKNOWN: "unknown",
});

/**
 * 图像性质。前四个取值沿用 filmStills 既有词汇（filmDetail.js:21-26 的 IMAGE_KIND_LABEL），
 * 不另造同义词；后三个是 P4.14 为跨来源候选补齐的。
 */
export const IMAGE_KIND = Object.freeze({
  FRAME: "frame",
  SCENE_STILL: "scene-still",
  PUBLICITY_STILL: "publicity-still",
  PUBLICITY_PHOTO: "publicity-photo",
  ARTWORK_REPRODUCTION: "artwork-reproduction",
  POSTER: "poster",
  UNKNOWN: "unknown",
});

const IMAGE_KIND_VALUES = new Set(Object.values(IMAGE_KIND));
const VISUAL_FORM_VALUES = new Set(Object.values(VISUAL_FORM));

/** 中文标签。界面用，不参与判定。 */
export const VISUAL_FORM_LABEL = Object.freeze({
  "live-action": "真人拍摄",
  animation: "动画",
  "still-image": "静态作品",
  unknown: "形式未标注",
});

export const IMAGE_KIND_LABEL = Object.freeze({
  frame: "影片画面（逐帧截图）",
  "scene-still": "影片剧照（当年发行／档案的场景照）",
  "publicity-still": "宣传剧照（宣传物料，画面即影片场景）",
  "publicity-photo": "宣传照（宣传物料，画面即影片场景）",
  "artwork-reproduction": "作品复制图（画作／版画等原件翻拍）",
  poster: "海报（宣传物料，不是影片画面）",
  unknown: "性质未标注",
});

/**
 * 本地 15 部影片的画面形式事实。
 *
 * 为什么需要一张表：`visualForm` 不能从 `medium:"film"` 推出——电影既可以是真人，
 * 也可以是动画。而本地这 15 部是有据可查的真人实拍长片（Nibelungen / Broken Blossoms /
 * The General / City Lights ……）。把事实写死比默认推断安全：默认推断会把将来接入的
 * 动画片一律错标成真人。
 *
 * 表里没有的影片 → `unknown`，不是 `live-action`。这是有意的保守。
 */
export const FILM_VISUAL_FORM_FACTS = Object.freeze({
  "film-nibelungen-siegfried": VISUAL_FORM.LIVE_ACTION,
  "film-broken-blossoms": VISUAL_FORM.LIVE_ACTION,
  "film-orphans-storm": VISUAL_FORM.LIVE_ACTION,
  "film-ten-commandments": VISUAL_FORM.LIVE_ACTION,
  "film-sherlock-jr": VISUAL_FORM.LIVE_ACTION,
  "film-the-general": VISUAL_FORM.LIVE_ACTION,
  "film-toll-of-the-sea": VISUAL_FORM.LIVE_ACTION,
  "film-man-movie-camera": VISUAL_FORM.LIVE_ACTION,
  "film-pandoras-box": VISUAL_FORM.LIVE_ACTION,
  "film-diary-lost-girl": VISUAL_FORM.LIVE_ACTION,
  "film-gold-rush": VISUAL_FORM.LIVE_ACTION,
  "film-city-lights": VISUAL_FORM.LIVE_ACTION,
  "film-modern-times": VISUAL_FORM.LIVE_ACTION,
  "film-s13-intolerance": VISUAL_FORM.LIVE_ACTION,
  "film-s02-the-kid": VISUAL_FORM.LIVE_ACTION,
});

/**
 * 不能当作「创作传统」的标签。
 *
 * 实测：本地影片的 `traditions` 字段写的是 `["电影"]`——那是**媒介名**，不是流派。
 * 若原样透传成 tradition，就会得出「这部片属于电影传统」这种同义反复，
 * 并且会污染按 tradition 做的任何分组。
 */
const NON_TRADITION_LABELS = new Set(["电影", "film", "cinema"]);

function pickMedium(entry) {
  const raw = entry && entry.medium;
  if (raw === MEDIUM.FILM) return { value: MEDIUM.FILM, from: "declared" };
  if (raw === MEDIUM.ARTWORK) return { value: MEDIUM.ARTWORK, from: "declared" };
  if (raw === undefined || raw === null || raw === "") {
    // 绘画数据从来没有 `medium` 字段（51/51 为空）。缺省即 artwork，
    // 与 retrievalService.js:245 `artwork.medium || MEDIA.ARTWORK` 完全一致。
    return { value: MEDIUM.ARTWORK, from: "medium-default" };
  }
  // 已知的两个之外出现了别的值：不猜，按 artwork 走，但把来源标清楚。
  return { value: MEDIUM.ARTWORK, from: "unknown-medium-value" };
}

function pickVisualForm(entry, medium) {
  const declared = entry && entry.visualForm;
  if (declared && VISUAL_FORM_VALUES.has(declared)) {
    return { value: declared, from: "declared" };
  }
  if (medium === MEDIUM.FILM) {
    const id = entry && entry.id;
    const fact = id ? FILM_VISUAL_FORM_FACTS[id] : null;
    if (fact) return { value: fact, from: "film-fact" };
    // 没有事实就不推断：接进来的动画片不能被默认当真人。
    return { value: VISUAL_FORM.UNKNOWN, from: "unknown" };
  }
  return { value: VISUAL_FORM.STILL_IMAGE, from: "medium-default" };
}

function pickTradition(entry) {
  if (!entry) return { value: null, from: "none" };

  // 显式声明优先。anime 只能这样出现——绝不从画面风格推断。
  if (entry.tradition) {
    return { value: String(entry.tradition), from: "declared" };
  }

  const list = Array.isArray(entry.traditions) ? entry.traditions : [];
  const usable = list.filter((t) => t && !NON_TRADITION_LABELS.has(String(t)));

  if (usable.includes("anime")) {
    return { value: "anime", from: "declared" };
  }
  if (usable.length > 0) {
    return { value: String(usable[0]), from: "declared" };
  }
  return { value: null, from: "none" };
}

function pickImageKind(entry, medium) {
  const declared = entry && entry.imageKind;
  if (declared && IMAGE_KIND_VALUES.has(declared)) {
    return { value: declared, from: "declared" };
  }
  if (medium === MEDIUM.FILM) {
    // 影片缺 imageKind 时不敢当「实际画面」用——那正是「海报冒充镜头」的入口。
    return { value: IMAGE_KIND.UNKNOWN, from: "unknown" };
  }
  return { value: IMAGE_KIND.ARTWORK_REPRODUCTION, from: "medium-default" };
}

/**
 * 把一条候选（本地作品 / 影片 / 远程件）描述成四层媒介。
 *
 * @param {object} entry
 * @returns {{medium:string, visualForm:string, tradition:string|null, imageKind:string,
 *            evidence:{medium:string, visualForm:string, tradition:string, imageKind:string}}}
 */
export function describeMedia(entry) {
  const medium = pickMedium(entry);
  const visualForm = pickVisualForm(entry, medium.value);
  const tradition = pickTradition(entry);
  const imageKind = pickImageKind(entry, medium.value);

  return {
    medium: medium.value,
    visualForm: visualForm.value,
    tradition: tradition.value,
    imageKind: imageKind.value,
    evidence: {
      medium: medium.from,
      visualForm: visualForm.from,
      tradition: tradition.from,
      imageKind: imageKind.from,
    },
  };
}

/** 是不是动画。只看 visualForm，不看 tradition。 */
export function isAnimation(entry) {
  return describeMedia(entry).visualForm === VISUAL_FORM.ANIMATION;
}

/** 是不是日本动漫。必须同时是动画 + 有 anime 传统证据。 */
export function isAnime(entry) {
  const m = describeMedia(entry);
  return m.visualForm === VISUAL_FORM.ANIMATION && m.tradition === "anime";
}

/**
 * 这张图能不能当作「影片/动画的实际画面」参与视觉比较。
 *
 * 海报、宣传照、性质未标注一律不能——它们是关于作品的物料，不是作品画面本身。
 * 这条与 P4.12 的黑白排除是两件独立的事：先判是不是画面，再判是不是彩色。
 */
export function isActualScreenImage(entry) {
  const { imageKind } = describeMedia(entry);
  return imageKind === IMAGE_KIND.FRAME || imageKind === IMAGE_KIND.SCENE_STILL;
}

/**
 * 兼容护栏：交给既有检索链的 `medium` 只能是旧枚举。
 * 新增层次一律走派生字段，不得塞回 `medium`。
 */
export function assertLegacyMedium(medium) {
  if (medium === MEDIUM.ARTWORK || medium === MEDIUM.FILM) return { ok: true };
  return { ok: false, reason: `medium 只允许 artwork / film，收到 ${String(medium)}` };
}
