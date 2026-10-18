// Visual profile — local, append-only behavior log for YOUR EYE.
// Stored in localStorage. No account, no server, no personality labels.
// Event types: viewedArtwork | savedArtwork | selectedEmotion |
// selectedAtmosphere | selectedTradition | selectedVisualDNA |
// creatorUsage | shootUsage

import { artworks } from "../data/artworks.js";

const STORAGE_KEY = "va-profile-v1";
const MAX_EVENTS = 300;

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { events: [] };
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.events) ? parsed : { events: [] };
  } catch {
    return { events: [] };
  }
}

function save(profile) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage full or blocked — profile is best-effort only.
  }
}

export function track(type, value) {
  if (!type || value === undefined || value === null) return;
  const profile = load();
  profile.events.push({ type, value: String(value), ts: Date.now() });
  if (profile.events.length > MAX_EVENTS) {
    profile.events = profile.events.slice(profile.events.length - MAX_EVENTS);
  }
  save(profile);
}

function countBy(events, type) {
  const counts = new Map();
  for (const event of events) {
    if (event.type !== type) continue;
    counts.set(event.value, (counts.get(event.value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Composition / lighting keyword lexicon: scans the viewed artworks'
// analysis text to summarize formal tendencies without labeling the user.
const FORM_LEXICON = {
  composition: [
    "留白", "空旷", "对称", "中心", "对角线", "三角", "框架", "三分",
    "一角", "半边", "平远", "高远", "深远", "散点", "水平", "垂直", "曲线",
  ],
  lighting: [
    "侧光", "逆光", "顶光", "柔光", "硬光", "明暗对比", "单侧光",
    "自然光", "人工光", "夜光", "烛光", "晨光", "暮光", "漫射",
  ],
};

function countFormKeywords(viewedArtworks, field) {
  const counts = new Map();
  for (const artwork of viewedArtworks) {
    const text = [artwork.composition, artwork.lighting, artwork.spatialStructure, artwork.visualDNA.join(" ")].join(" ");
    for (const keyword of FORM_LEXICON[field]) {
      if (text.includes(keyword)) counts.set(keyword, (counts.get(keyword) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function getProfile() {
  const { events } = load();
  const viewedIds = [...new Set(events.filter((e) => e.type === "viewedArtwork").map((e) => e.value))];
  const viewedArtworks = viewedIds.map((id) => artworks.find((a) => a.id === id)).filter(Boolean);

  // Derive emotion / atmosphere / tradition tendencies from what the user
  // actually viewed and explicitly selected.
  const derivedEmotions = new Map(countBy(events, "selectedEmotion"));
  const derivedAtmospheres = new Map(countBy(events, "selectedAtmosphere"));
  const derivedTraditions = new Map(countBy(events, "selectedTradition"));
  for (const artwork of viewedArtworks) {
    for (const emotion of artwork.emotion) derivedEmotions.set(emotion, (derivedEmotions.get(emotion) || 0) + 1);
    for (const atmosphere of artwork.atmosphere) derivedAtmospheres.set(atmosphere, (derivedAtmospheres.get(atmosphere) || 0) + 1);
    for (const tradition of artwork.traditions) derivedTraditions.set(tradition, (derivedTraditions.get(tradition) || 0) + 1);
  }
  const sort = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

  const visualDNACounts = new Map();
  for (const artwork of viewedArtworks) {
    for (const tag of artwork.visualDNA) visualDNACounts.set(tag, (visualDNACounts.get(tag) || 0) + 1);
  }

  return {
    eventCount: events.length,
    viewedCount: viewedArtworks.length,
    savedIds: countBy(events, "savedArtwork").map(([id]) => id),
    topEmotions: sort(derivedEmotions).slice(0, 6),
    topAtmospheres: sort(derivedAtmospheres).slice(0, 6),
    topTraditions: sort(derivedTraditions).slice(0, 6),
    topVisualDNA: sort(visualDNACounts).slice(0, 8),
    topComposition: countFormKeywords(viewedArtworks, "composition").slice(0, 5),
    topLighting: countFormKeywords(viewedArtworks, "lighting").slice(0, 5),
    creatorUsage: countBy(events, "creatorUsage").reduce((sum, [, n]) => sum + n, 0),
    shootUsage: countBy(events, "shootUsage").reduce((sum, [, n]) => sum + n, 0),
    viewedArtworks,
  };
}

// Aesthetic-cognition layer: translate recurring formal elements into the
// perceptual effects they usually produce. No personality labels.
const EFFECT_TABLE = [
  { match: ["留白", "空旷", "一角", "半边"], element: "环境占比高、主体较小、大面积留白", effect: "距离、观察和克制感" },
  { match: ["对称", "中心"], element: "中心对称的静态构图", effect: "仪式感、秩序和被注视感" },
  { match: ["对角线", "三角"], element: "对角线与斜向动势", effect: "紧张、冲突和运动在即感" },
  { match: ["框架"], element: "画中画的框架结构", effect: "窥视感和叙事层次" },
  { match: ["平远", "散点"], element: "平远与散点空间", effect: "漫游式观看和时间延展感" },
  { match: ["高远", "深远"], element: "高远深远的纵向空间", effect: "崇高感和人的渺小感" },
  { match: ["明暗对比", "单侧光", "侧光"], element: "强明暗与单侧光", effect: "戏剧性、心理压力和雕塑感" },
  { match: ["逆光"], element: "逆光与剪影", effect: "匿名性、记忆感和情绪余韵" },
  { match: ["柔光", "漫射"], element: "低反差柔光", effect: "亲密、日常和安静的氛围" },
  { match: ["夜光", "人工光", "烛光"], element: "夜间人工光源", effect: "孤独、都市感和内心独白感" },
  { match: ["晨光", "暮光"], element: "晨暮过渡光", effect: "时间流逝和 transient 的情绪" },
];

export function getAestheticReading(profile) {
  const keywords = [
    ...profile.topComposition.map(([k]) => k),
    ...profile.topLighting.map(([k]) => k),
  ];
  const readings = [];
  for (const row of EFFECT_TABLE) {
    if (row.match.some((keyword) => keywords.includes(keyword))) readings.push(row);
  }
  return readings.slice(0, 3);
}

// Continuation recommendations keyed by what the user already looks at.
// Points to artists / traditions / films — never to a "type of person".
const RECOMMENDATION_TABLE = [
  { match: ["留白", "空旷", "平远"], recommend: ["Edward Hopper", "倪瓒", "小津安二郎（电影）"] },
  { match: ["明暗对比", "单侧光", "夜光"], recommend: ["Caravaggio", "Rembrandt", "王家卫（电影）"] },
  { match: ["对角线", "三角"], recommend: ["Goya", "葛饰北斋", "黑泽明（电影）"] },
  { match: ["柔光", "漫射"], recommend: ["Vermeer", "Vilhelm Hammershøi", "是枝裕和（电影）"] },
  { match: ["高远", "深远"], recommend: ["范宽", "Caspar David Friedrich", "Andrei Tarkovsky（电影）"] },
  { match: ["对称", "中心"], recommend: ["宋徽宗（院体工笔）", "Wes Anderson（电影）"] },
  { match: ["散点", "框架"], recommend: ["黄公望", "Pieter Bruegel", "侯孝贤（电影）"] },
  { match: ["逆光"], recommend: ["J.M.W. Turner", "川濑巴水", "Terrence Malick（电影）"] },
];

export function getRecommendations(profile) {
  const keywords = [
    ...profile.topComposition.map(([k]) => k),
    ...profile.topLighting.map(([k]) => k),
    ...profile.topAtmospheres.map(([k]) => k),
  ];
  const seen = new Set();
  const output = [];
  for (const row of RECOMMENDATION_TABLE) {
    if (!row.match.some((keyword) => keywords.includes(keyword))) continue;
    for (const item of row.recommend) {
      if (seen.has(item)) continue;
      seen.add(item);
      output.push(item);
    }
  }
  return output.slice(0, 6);
}
