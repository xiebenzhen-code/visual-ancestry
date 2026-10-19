// P4.6 — 创作者可直接评价的艺术参考内容样本
//
// 与 art-semantics.js 的分工：
//   art-semantics.js  事实层：genre / material / depicts / collection（Wikidata，逐条溯源）
//   本文件            叙事层：创作背景 / 画面组织 / 创作方法建议
//
// 三类内容必须分开标注，不得混为一谈：
//   FACT        来源机构或权威条目明确陈述的事实
//   INTERPRET   对画面的解释（注明这是解释）
//   SUGGESTION  给创作者的借鉴建议（我方撰写，不是艺术史结论）
//
// 硬规则：
//   · 每条 FACT 必须带 sourceUrl
//   · 没有可靠来源的字段留 null，不生成
//   · INTERPRET 不得伪装成 FACT
//   · SUGGESTION 不得宣称是原作意图

export const EVIDENCE_KIND = { FACT: "fact", INTERPRET: "interpret", SUGGESTION: "suggestion" };

/**
 * 每件作品：
 *   story:      { text, kind, sourceUrl, sourceName }   创作背景
 *   structure:  [{ aspect, observation, kind }]          画面结构（基于 signature 或策展描述）
 *   materialNote: { visualTexture, actualMedium, distinction }  视觉质感 vs 真实媒介
 *   methods:    [{ title, text, kind }]                  可借鉴的创作方法
 */
export const ART_STORIES = {
  "third-of-may": {
    story: {
      kind: EVIDENCE_KIND.FACT,
      text:
        "戈雅于 1814 年完成此画，目的是纪念 1808 年马德里民众对拿破仑军队抵抗时被处决的人。" +
        "画中描绘的是发生在马德里普林西比皮奥山（Príncipe Pío）的枪决场面。",
      sourceUrl: "https://en.wikipedia.org/wiki/The_Third_of_May_1808",
      sourceName: "Wikipedia: The Third of May 1808（转述馆方与艺术史通行记述）",
    },
    structure: [
      { aspect: "构图", observation: "画面分为左右两个阵营：左侧是被处决的平民群像，右侧是背对观者的行刑队。中间由一盏方形灯笼照亮。", kind: EVIDENCE_KIND.FACT },
      { aspect: "视线", observation: "行刑队全部背对观者，没有面孔；被处决者中有人直视观者。这种视线安排让观者站在受难者一侧。", kind: EVIDENCE_KIND.INTERPRET },
      { aspect: "光", observation: "灯笼是画面唯一明确光源，从下往上照，形成强烈的下打光。", kind: EVIDENCE_KIND.FACT },
    ],
    materialNote: {
      visualTexture: "笔触在人物衣物与地面上较为松动，面部刻画更紧；整体呈厚涂（impasto）质感。",
      actualMedium: "布面油画（oil on canvas）",
      distinction: "照片里看到的「肌理」部分是绘画的厚涂笔触，部分是翻拍时的表面反光，不等于媒材本身；真实媒材是布面油画。",
      sourceUrl: "https://www.wikidata.org/wiki/Q1091086",
    },
    methods: [
      { title: "用光源分割阵营", text: "不要靠色彩区分敌我，用一盏明确的实用光源（灯笼）把两组人分到明暗两侧。创作者在夜戏或室内对峙场面可以直接借用。", kind: EVIDENCE_KIND.SUGGESTION },
      { title: "让一方失去面孔", text: "把施暴者画成背影或剪影，观众就自动站到有面孔的一方。这是权力关系的构图手段，不是道德说教。", kind: EVIDENCE_KIND.SUGGESTION },
    ],
  },

  "whistlers-mother": {
    story: {
      kind: EVIDENCE_KIND.FACT,
      text:
        "惠斯勒于 1871 年创作此画，画中人物是他的母亲 Anna McNeill Whistler。" +
        "作品的正式名称是《灰与黑的协奏曲 第一号》，画家刻意用音乐术语命名，" +
        "强调这是一次关于色调关系的安排。画框也是惠斯勒本人设计的。",
      sourceUrl: "https://en.wikipedia.org/wiki/Whistler%27s_Mother",
      sourceName: "Wikipedia: Whistler's Mother",
    },
    structure: [
      { aspect: "构图", observation: "人物侧坐，占据画面右侧；左侧是大面积空墙与一幅挂画。画面被墙脚线与地面横向切成上下两层。", kind: EVIDENCE_KIND.FACT },
      { aspect: "色调", observation: "整体由灰、黑、白三色构成，几乎不出现饱和色。", kind: EVIDENCE_KIND.FACT },
      { aspect: "为何叫协奏曲", observation: "标题把画作比作音乐，暗示画家关心的不是「画一个人」，而是几种灰色之间的比例与节奏。", kind: EVIDENCE_KIND.INTERPRET },
    ],
    materialNote: {
      visualTexture: "画面平整，几乎看不到笔触，接近哑光。",
      actualMedium: "布面油画（oil on canvas）",
      distinction: "「看不到笔触」是画法选择，不是媒介特性。同样是布面油画，戈雅那件就保留了大量厚涂。",
      sourceUrl: "https://www.wikidata.org/wiki/Q687182",
    },
    methods: [
      { title: "先定调，再放人", text: "先把画面定成三到四个灰阶，再决定人物落在哪一级。适合需要克制、安静气质的场景。", kind: EVIDENCE_KIND.SUGGESTION },
      { title: "用空墙承担重量", text: "把大面积留白交给一面没有细节的墙，人物只占一侧。这样画面不会散，观众视线会自然回到人身上。", kind: EVIDENCE_KIND.SUGGESTION },
    ],
  },

  milkmaid: {
    story: {
      kind: EVIDENCE_KIND.FACT,
      text:
        "维米尔此作的确切完成年份不详，通行说法为约 1658–1660 年。" +
        "画中人物通常被称为「挤奶女工」，实际是一位家庭厨房女佣" +
        "（荷兰语别称 De keukenmeid，即「厨房女仆」）。现藏阿姆斯特丹国立博物馆。",
      sourceUrl: "https://en.wikipedia.org/wiki/The_Milkmaid_(Vermeer)",
      sourceName: "Wikipedia: The Milkmaid (Vermeer)",
    },
    structure: [
      { aspect: "构图", observation: "人物居中偏右，身体微微前倾；左侧一扇窗是光源，桌面上摆着面包与陶罐。", kind: EVIDENCE_KIND.FACT },
      { aspect: "光", observation: "光从左侧窗户进入，柔和但不均匀，人物右肩与墙面偏暗。", kind: EVIDENCE_KIND.FACT },
      { aspect: "为什么看起来「安静」", observation: "动作被凝固在倒奶的瞬间，周围没有任何叙事事件，注意力被压到手上。", kind: EVIDENCE_KIND.INTERPRET },
    ],
    materialNote: {
      visualTexture: "面包表面、陶罐与布料质感区分明显，颜料在受光处略厚。",
      actualMedium: "布面油画（oil on canvas）",
      distinction: "画面上的「粗糙感」是颜料堆叠与织物纹理的表现，不是画布本身的肌理被拍出来。",
      sourceUrl: "https://www.wikidata.org/wiki/Q167605",
    },
    methods: [
      { title: "单一窗光 + 一个动作", text: "只给一个光源、只给一个动作，画面自然安静下来。适合拍摄家务、手工艺、准备食物这类题材。", kind: EVIDENCE_KIND.SUGGESTION },
      { title: "黄蓝对位", text: "上身黄色与下身蓝色形成互补，这是低成本获得色彩张力的做法：不需要高饱和，只要互补。", kind: EVIDENCE_KIND.SUGGESTION },
    ],
  },

  calling: {
    story: {
      kind: EVIDENCE_KIND.FACT,
      text:
        "卡拉瓦乔此作为 1599–1600 年受委托绘制，位于罗马圣路易吉·德·弗朗切西教堂的孔塔雷利礼拜堂，" +
        "描绘基督召唤税吏马太跟随他的瞬间。",
      sourceUrl: "https://en.wikipedia.org/wiki/The_Calling_of_Saint_Matthew",
      sourceName: "Wikipedia: The Calling of Saint Matthew",
    },
    structure: [
      { aspect: "光", observation: "一束斜光从右上方切入，照亮桌边数人的脸与手，其余空间几乎全黑。", kind: EVIDENCE_KIND.FACT },
      { aspect: "手势", observation: "基督的手势指向桌边，与桌边某人的手指方向形成呼应。", kind: EVIDENCE_KIND.FACT },
      { aspect: "为什么紧张", observation: "光只照亮一部分人，观众会去猜「他指的是谁」，这个疑问本身就是画面的张力来源。", kind: EVIDENCE_KIND.INTERPRET },
    ],
    materialNote: {
      visualTexture: "暗部极深，亮部集中，对比度很高。",
      actualMedium: "布面油画（oil on canvas）",
      distinction: "这种「黑得干净」是明暗对照法（chiaroscuro）的画法结果，不是拍摄时压暗了曝光。",
      sourceUrl: "https://www.wikidata.org/wiki/Q969377",
    },
    methods: [
      { title: "让光替你做选择", text: "只照亮叙事关键的那几张脸，其他区域压暗。观众会自动把注意力放到被照亮的人身上。", kind: EVIDENCE_KIND.SUGGESTION },
      { title: "留一个指向不明的动作", text: "手势指向模糊时，观众会主动参与解读。想制造悬念可以借鉴，但别过度使用。", kind: EVIDENCE_KIND.SUGGESTION },
    ],
  },
};

/** 该作品是否有可展示的创作故事 */
export function hasStory(artworkId) {
  const s = ART_STORIES[artworkId];
  return Boolean(s && s.story && s.story.text && s.story.sourceUrl);
}

/** 只返回可信内容：FACT 必须有 sourceUrl，否则丢弃 */
export function safeStory(artworkId) {
  const s = ART_STORIES[artworkId];
  if (!s || !s.story) return null;
  if (s.story.kind === EVIDENCE_KIND.FACT && !s.story.sourceUrl) return null;
  return s;
}

export const STORY_COVERAGE = {
  withStory: Object.keys(ART_STORIES).length,
  note: "仅 4 件有可引用的创作背景；其余作品不生成故事",
};
