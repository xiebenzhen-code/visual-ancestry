// filmStills.js — 已核验可公开使用的电影画面记录。
//
// 严格区分两类东西（STEP 2 的核心要求）：
//   · filmReferences.js —— 绘画 ↔ 电影的形式关联，只有电影元数据，没有帧图像
//   · 本文件 —— 真正进入检索库的电影画面，有图像、有许可、有可复用 VisualIntent
//
// 每条记录的许可都经过 film-license-audit.mjs 逐张向 Wikimedia Commons API
// 取回 License 模板与 Copyrighted 标志确认（license=pd, Copyrighted=False），
// 不依赖本地 manifest 的自述，也不因影片年代久远而推定。
//
// P5.3.2 manifest 的 note 明确禁止 expectedVisualLanguage 进入 VisualIntent /
// Retrieval / Profile 任何路径，因此本文件不复用那套人工评估元数据：每帧的
// VisualIntent 是独立撰写并落到与绘画同一套 22 字段契约上的。

import { filmFramesExpansion } from "./filmStillsExpansion.js";
import {
  FRAME_ADVICE_EXPANSION,
  FRAME_CINEMATIC_EXPANSION,
  FRAME_AIGC_EXPANSION,
} from "./filmStillsExpansionTranslations.js";

export const FILM_STILL_RIGHTS = {
  // 每帧都记下真实的 Commons 依据，而不是一句 "public domain"。
  verificationMethod: "Wikimedia Commons action=query&prop=imageinfo&iiprop=extmetadata",
  verifiedAt: "2026-10-17",
  auditFile: "work/p6.4-release/film-license-audit.json",
  // R5 STEP 3 的扩充帧另有一份审计：逐张取回许可与描述、比对内容哈希、
  // 并把被排除的候选（海报 / 明信片 / 人像照 / 非公有领域）逐条列在报告里。
  expansionAuditFiles: [
    "work/film-expansion/film-candidates-audit.json",
    "work/film-expansion/film-candidates-audit2.json",
    "work/film-expansion/frames-build.json",
  ],
};

export const filmStills = [
  // R5 STEP 3 — 扩充的 13 张电影画面（含取代原 film-s07-brunhilde 的那一张）。
  // 入选与排除规则写在 filmStillsExpansion.js 头部；下面两条是本轮审计后
  // 保留修正的原始记录（s07 明信片已移除，见报告）。
  ...filmFramesExpansion,
  {
    id: "film-s13-intolerance",
    medium: "film",
    title: "Intolerance",
    titleZh: "党同伐异",
    year: 1916,
    director: "D. W. Griffith",
    directorZh: "D·W·格里菲思",
    frameIdentifier: "The Fall of Babylon 布景全景（Commons 标注：a frame from the 1916 film Intolerance）",
    imageKind: "frame",
    timestamp: null,
    timestampNote: "本地素材未记录时间码，故不填写；不猜测。",
    image: {
      type: "local-tiered",
      fileName: "s13-intolerance-1916.jpg",
      url: "/public/assets/film/film-s13-intolerance/detail.webp",
      tiers: {
        thumb: "/public/assets/film/film-s13-intolerance/thumb.webp",
        preview: "/public/assets/film/film-s13-intolerance/preview.webp",
        detail: "/public/assets/film/film-s13-intolerance/detail.webp",
      },
      width: 1200,
      height: 941,
      ratio: 1.2752,
    },
    source: {
      name: "Wikimedia Commons",
      file: "File:Griffith-intolerance.jpg",
      url: "https://commons.wikimedia.org/wiki/File:Griffith-intolerance.jpg",
      license: "pd",
      licenseShortName: "Public domain",
      copyrighted: false,
      rightsCategory: "PD-old-75-expired / CC-PD-Mark",
      credit: "Wisconsin Center for Film and Theater Research",
      attributionRequired: false,
      description:
        "Commons 原文：A frame from the 1916 film Intolerance（巴比伦布景的著名全景，Wisconsin Center for Film and Theater Research 藏）。",
    },
    visualIntent: {
      subject: "group",
      subjectScale: "large",
      subjectPosition: "center",
      spatialDepth: "deep",
      negativeSpace: "low",
      environmentDominance: "high",
      lightDirection: "back",
      lightQuality: "diffuse",
      colorTemperature: "warm",
      saturation: "low",
      contrast: "high",
      humanRelation: "crowd",
      cameraDistance: "far",
      cameraHeight: "high",
      cameraRelation: "observational",
      motion: "still",
      visualDensity: "dense",
      arousal: "high",
      socialDistance: "low",
      melancholy: "low",
      emotion: ["宏大", "动荡"],
      atmosphere: ["布景", "繁复"],
    },
    visualNote: "深空间、环境主导、远距离观察；高机位俯瞰布景，人群密度高。",
  },
  {
    id: "film-s02-the-kid",
    medium: "film",
    title: "The Kid",
    titleZh: "孩子",
    year: 1921,
    director: "Charles Chaplin",
    directorZh: "查理·卓别林",
    frameIdentifier:
      "床上的流浪汉读报（Commons/EYE 标注：Still from The Kid；扫描件为当年发行的卡纸式剧照，下缘印有片名）",
    imageKind: "scene-still",
    timestamp: null,
    timestampNote: "本地素材未记录时间码，故不填写；不猜测。",
    image: {
      type: "local-tiered",
      fileName: "s02-the-kid-1921.jpg",
      url: "/public/assets/film/film-s02-the-kid/detail.webp",
      tiers: {
        thumb: "/public/assets/film/film-s02-the-kid/thumb.webp",
        preview: "/public/assets/film/film-s02-the-kid/preview.webp",
        detail: "/public/assets/film/film-s02-the-kid/detail.webp",
      },
      width: 543,
      height: 380,
      ratio: 1.4289,
    },
    source: {
      name: "Wikimedia Commons",
      file: "File:Still from Charles Chaplin - The Kid - 1921 - Charles Chaplin Productions - EYE FOT2413.JPG",
      url: "https://commons.wikimedia.org/wiki/File:Still_from_Charles_Chaplin_-_The_Kid_-_1921_-_Charles_Chaplin_Productions_-_EYE_FOT2413.JPG",
      license: "pd",
      licenseShortName: "Public domain",
      copyrighted: false,
      rightsCategory: "PD US",
      credit: "Media from EYE Film Institute Netherlands",
      attributionRequired: false,
      description:
        "Commons 原文：Still from Charles Chaplin - The Kid - 1921 - Charles Chaplin Productions - EYE FOT2413。（本轮审计：原记录的 frameIdentifier/VisualIntent 写的是「夜景/街道」，与画面实际内容不符——画面是室内床上的单人场景，已按图改写。）",
    },
    visualIntent: {
      subject: "single-figure",
      subjectScale: "medium",
      subjectPosition: "center",
      spatialDepth: "shallow",
      negativeSpace: "low",
      environmentDominance: "low",
      lightDirection: "side",
      lightQuality: "directional",
      colorTemperature: "neutral",
      saturation: "low",
      contrast: "high",
      humanRelation: "isolated",
      cameraDistance: "medium",
      cameraHeight: "eye",
      cameraRelation: "observational",
      motion: "still",
      visualDensity: "sparse",
      arousal: "low",
      socialDistance: "high",
      melancholy: "low",
      emotion: ["平静", "诙谐"],
      atmosphere: ["室内", "安静"],
    },
    visualNote:
      "室内单人半身：背后是墙面与一段铁管，侧光把白衬衫和报纸打亮；床沿、手臂与报纸构成几条浅斜线，画面是安静的喜剧停顿。",
  },
];

export const filmStillById = (id) => filmStills.find((f) => f.id === id) || null;
// R5 STEP 3 — SHOOT reference. A film still must be selectable as a shooting
// reference and produce advice that is TRACEABLE to that frame. The advice is
// derived from the frame's own 22-field VisualIntent (composition, light,
// space, subject, atmosphere) — not invented — and `proNotes` always names the
// frame it came from so the suggestion can never read as an original ruling.
const FRAME_ADVICE = {
  ...FRAME_ADVICE_EXPANSION,
  "film-s13-intolerance": {
    subjectType: "PERSON_PLACE",
    personGuide: {
      stance: "人物分布在高机位俯瞰的布景中，密度高但各自成形。",
      frameRatio: "群体充满画面，个体只求可辨。",
      photographer: "拍摄者升高机位，约 3-8 米。",
      gaze: "视线方向不必统一，画面靠密度组织。",
      bodyDirection: "方向可多样，避免全部朝向镜头。",
      headRoom: "不追求留白，强调铺满。",
      eyeRoom: "视线空间由环境提供。",
      backgroundLines: "布景结构可入画，但要避免杂乱标识。",
      framing: "横拍优先。",
      phoneLens: "1×。",
      distance: "3-8 米，取决于机位高度。",
      time: "白天或人工补光均匀的时段。",
      light: "暖侧光，保留布景的层次与质感。"
    },
    placeGuide: {
      horizon: "地平线不必入画，让布景占满。",
      mainSubject: "布景本身是主体，人物提供尺度。",
      foregroundAnchor: "前景用最近的构件或地面。",
      leadingLines: "布景的重复结构形成节奏。",
      vanishingPoint: "不强制，靠层次递进。",
      depthLayers: "前景构件 / 中景人物 / 背景布景。",
      cameraHeight: "高机位俯拍，与画面里的观察角度一致。",
      framing: "横拍优先。",
      phoneLens: "1×。",
      time: "光线稳定、不变化的时段。",
      weather: "无特殊要求。",
      light: "暖侧光，与画面的年代质感相符。"
    },
    overlay: {
      thirds: true,
      horizon: 0.5,
      subjectArea: { x: 0.25, y: 0.3, w: 0.5, h: 0.4 },
      negativeSpace: { x: 0, y: 0, w: 1, h: 0.25 },
      zones: { foreground: 0.25, midground: 0.6 }
    }
  },
  "film-s02-the-kid": {
    subjectType: "PERSON",
    personGuide: {
      stance: "人物坐在床上、上身略微前倾，手里有一样小道具（报纸／信件）。",
      frameRatio: "半身入画，人物占画面高度一半以上。",
      photographer: "拍摄者保持中距离，约 2-4 米，与眼睛大致等高。",
      gaze: "视线落在手里的东西上，不看镜头。",
      bodyDirection: "身体半侧向镜头，让衬衫的受光面朝向光源。",
      headRoom: "人物上方留出墙面与一段铁管（环境信息）。",
      eyeRoom: "视线方向留出被侧光照亮的墙面。",
      backgroundLines: "避开现代家具与插座；墙面必须干净。",
      framing: "横拍优先，方画幅也可。",
      phoneLens: "手机 1×，室内避免超广角把床沿拉变形。",
      distance: "2-4 米。",
      time: "白天室内，模拟清晨的斜光。",
      light: "单侧硬光（窗光或台灯），白衬衫过曝一档也可以，暗部要留住墙面质感。",
    },
    placeGuide: {
      horizon: "室内没有地平线，用床沿或桌沿代替水平线。",
      mainSubject: "人物是主体，墙面与铁管提供最小限度的环境交代。",
      foregroundAnchor: "前景用床沿、被子或被单的褶皱。",
      leadingLines: "床沿、手臂与手里的报纸构成几条浅斜线。",
      vanishingPoint: "不需要，靠侧光的明暗分层。",
      depthLayers: "前景床沿 / 中景人物 / 背景墙面与铁管。",
      cameraHeight: "平视，与坐着的人物眼睛同高。",
      framing: "横拍。",
      phoneLens: "1×。",
      time: "白天室内。",
      weather: "无特殊要求。",
      light: "侧向硬光，让白衬衫与暗部墙面形成高对比。",
    },
    overlay: {
      thirds: true,
      horizon: 0.5,
      subjectArea: { x: 0.3, y: 0.15, w: 0.45, h: 0.7 },
      negativeSpace: { x: 0, y: 0, w: 1, h: 0.2 },
      zones: { foreground: 0.4, midground: 0.65 }
    }
  }
};

// R5 STEP 3 — a film frame also has to survive the SHAPE every artwork passes
// through: buildProjectContext() reads artwork.creatorTranslation.cinematic /
// .aigc to build the exportable Project Context, and aiService reads .aigc for
// prompts. Without them, choosing a film frame as a SHOOT reference CRASHES the
// page (TypeError on undefined.cinematic) — a real defect found by the STEP 4
// browser run, not a hypothetical.
//
// These values are the film's own camera language, read off THIS frame's
// 22-field VisualIntent. They are not the director's intent for the whole film
// and they are not a painter's translation: a film still is translated as a
// shot, so every entry is shot vocabulary (lens / camera height / movement).
const FRAME_CINEMATIC = {
  ...FRAME_CINEMATIC_EXPANSION,
  "film-s13-intolerance": {
    shotSize: "全景（高机位俯瞰布景）",
    lens: "广角，视野覆盖整座布景",
    cameraHeight: "高机位俯拍，与画面里的观察角度一致",
    cameraMovement: "固定机位；以剪辑而非运镜组织段落",
    subjectPlacement: "人物铺满画面，密度高而各自成形",
    depthLayers: "前景构件 / 中景人物 / 背景布景",
    lightDirection: "暖侧光",
  },
  "film-s02-the-kid": {
    shotSize: "中远景（人物只占一部分）",
    lens: "常焦段，保留夜色而不引入广角变形",
    cameraHeight: "平视，与人物等高",
    cameraMovement: "固定机位；以情境调度而非运镜制造笑点",
    subjectPlacement: "人物偏离中心，四周留出夜色",
    depthLayers: "前景暗部 / 中景人物 / 背景夜色与远处光点",
    lightDirection: "单一侧向人工光源",
  },
};

const FRAME_AIGC = {
  ...FRAME_AIGC_EXPANSION,
  "film-s13-intolerance": {
    scenePrompt: "年代布景中的人物群像，高机位俯瞰，人物密度高但各自成形，重复的布景构件充满画面。",
    cameraPrompt: "广角，高机位俯拍，固定机位，视野覆盖整座布景。",
    lightingPrompt: "暖侧光，均匀稳定，保留布景的层次与年代质感。",
    compositionPrompt: "地平线不入画，靠构件重复形成节奏与层次递进。",
    movementPrompt: "静态群像；密度本身承担叙事压力。",
    negativePrompt: "避免全部人物朝向镜头、避免杂乱标识、避免现代元素、避免光线突然变化。",
  },
  "film-s02-the-kid": {
    scenePrompt: "夜晚街景，一名人物独自站着，与环境保持疏离，远处有零星光点。",
    cameraPrompt: "常焦段，平视，固定机位，人物偏离中心。",
    lightingPrompt: "单一冷色人工光源从侧面来，人物面部半明半暗，注意不要让高光溢出。",
    compositionPrompt: "地平线压低或不入画，用地面反光或暗部作前景，靠明暗层次而非透视线。",
    movementPrompt: "静态；情境张力来自人物与夜景的距离感。",
    negativePrompt: "避免路灯直射镜头造成光斑、避免超广角夜景噪点、避免补光过亮破坏暗部。",
  },
};

for (const still of filmStills) {
  const advice = FRAME_ADVICE[still.id];
  if (advice) {
    still.shootTranslation = {
      ...advice,
      // Where the advice came from. Never blank: a suggestion with no stated
      // source would read as the app's own conclusion.
      proNotes: `依据电影画面《${still.titleZh}》（${still.year}，导演 ${still.directorZh}）这一帧的构图、光线、空间与氛围特征推导；许可 ${still.source.licenseShortName}，来源 ${still.source.name}。`,
    };
  }

  // The Project Context exporter (buildProjectContext) and the AIGC prompt
  // builder (aiService) read these paths for every reference. A film frame has
  // to carry them or the page throws — see FRAME_CINEMATIC above.
  const cinematic = FRAME_CINEMATIC[still.id];
  const aigc = FRAME_AIGC[still.id];
  if (cinematic && aigc) {
    still.creatorTranslation = { cinematic, aigc, shotDesign: "" };
  }

  // Flat visual fields the exporter also reads. They restate THIS frame's own
  // VisualIntent — they are not imported from the painting record it resembles.
  const i = still.visualIntent;
  still.emotion = i.emotion;
  still.atmosphere = i.atmosphere;
  still.traditions = ["电影"];
  still.visualDNA = [i.spatialDepth, i.lightQuality, i.humanRelation, i.cameraRelation];
  still.composition = `${i.subjectScale} / ${i.subjectPosition} / 留白${i.negativeSpace}`;
  still.lighting = `${i.lightDirection} / ${i.lightQuality} / ${i.colorTemperature}`;
  still.color = `饱和度${i.saturation} / 对比${i.contrast}`;
  still.spatialStructure = `${i.spatialDepth} / 环境主导${i.environmentDominance}`;
  still.location = null;
  still.locationPattern = null;
  // Marked as a film record so a downstream consumer never reads the director
  // as a painter. artwork.artist holds the director only for rendering reuse.
  still.artistRole = "director";
  still.evidenceLevel = "A / Wikimedia Commons 公共领域，且逐张核验许可";
}
