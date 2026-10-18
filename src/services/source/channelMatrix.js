// channelMatrix.js — 每个渠道的实测能力矩阵。
//
// 全部字段来自 work/p6.4-release/channel-capability-probe.json 与
// channel-q1q2q3-probe.json / commons-film-discovery-probe.json 的真实响应，
// 不是从文档抄的、也不是推测的。任何字段若未经实测，写 null 并在 note 说明。
//
// 最重要的一列是 supportsFilmStills。四家博物馆 API 中没有一家收藏
// "电影画面帧"作为可下载的图像资产 —— 这是实测结论，不是判断：
//   · Met  "film" 命中 7904 条，逐条查详情后全是 Negatives / Photographs /
//     图书条目，isPublicDomain=false 且 hasImage=false（无图像可取）。
//   · AIC  "Film, Video, New Media" 是**当代视频装置作品**（Super 8 /
//     video loop / 35mm 循环），medium 自述为作品媒介，不是从某部影片取的帧；
//     且几乎全部 is_public_domain=false（版权在艺术家/基金会上）。
//   · Cleveland "film" 命中 385 条，type 全是 Painting / Photograph / Mixed Media。
//   · Rijks 是绘画与装饰艺术收藏，无影片帧类型。
// 所以电影画面的发现渠道只能是 Commons，且 Commons 在本项目中此前只作为
// **静态图片来源**（数据文件里的 URL 字段），没有任何发现适配器。

export const CHANNEL_MATRIX = {
  met: {
    id: "met",
    name: "Metropolitan Museum of Art",
    adapter: "src/services/adapters/metAdapter.js",
    alsoIn: "src/services/source/artSourceAdapter.js#metSource",
    discovery: true,
    supportsFilmStills: false,
    filmEvidence:
      "q=film 命中 7904 条；抽样 4 条详情全部 isPublicDomain=false 且 hasImage=false，"
      + "类型为 Negatives / Photographs / 图书。无任何可下载的影片帧。",
    search: {
      endpoint: "/public/collection/v1.1/search",
      note: "v1 search 已于 2026-10-01 退役并指向 v1.1（Elastic-backed）；详情仍在 v1/objects/{id}",
      params: ["q", "hasImages", "isPublicDomain", "limit", "offset"],
      totalReported: true,
      measuredTotal: 34609,
      qParamWorks: true,
      qEvidence: "无意义词 zzzzqqqxxnonexistentterm → total=0；landscape → 34609",
    },
    image: {
      thumb: "primaryImageSmall（无独立 480 档）",
      preview: "primaryImageSmall",
      detail: "primaryImage（原始可能 10–100MB）",
      note: "API 不提供 480 档，thumb 与 preview 必须共用同一 URL",
    },
    license: {
      field: "isPublicDomain (boolean)",
      openAccess: "The Met Open Access",
      measured: true,
    },
    cache: "artService localStorage va-remote-cache-v1，24h TTL",
    rateLimit: "无官方硬限制；现 adapter 每件间隔 140ms",
    failure: "getJSON 重试 4 次（429/5xx 指数退避），仍失败返回 {error}；artService 置 remoteUnavailable=true",
  },

  aic: {
    id: "aic",
    name: "Art Institute of Chicago",
    adapter: "src/services/adapters/aicAdapter.js",
    alsoIn: "src/services/source/artSourceAdapter.js#aicSource",
    discovery: true,
    supportsFilmStills: false,
    filmEvidence:
      "类型 'Film, Video, New Media' 存在，但条目 medium 自述为作品媒介"
      + "（Super 8 black-and-white and color film, 10:50 min / Color video, sound / 35mm color film silent）"
      + "，即视频装置作品本体，不是影片的一帧；抽样 5 条中 4 条 is_public_domain=false。",
    search: {
      endpoint: "/api/v1/artworks/search",
      params: ["q", "limit", "offset", "fields"],
      totalReported: true,
      measuredTotal: 133165,
      qParamWorks: false,
      qEvidence:
        "landscape / zzzzzqqqxxnonexistentterm / Rembrandt 三个截然不同的词"
        + "全部返回 total=133165，且返回标题（Three Oriental Figures、Old Man with a Gold Chain）"
        + "与查询词无关 → 当前 endpoints 形状下 q= 不生效，此渠道的关键词检索实际不可用。",
    },
    image: {
      iiif: "/iiif/2/{image_id}/full/{w},/0/default.jpg",
      thumb: "480",
      preview: "843",
      detail: "1920",
      note: "IIIF 任意宽度按需返回，三档最完整",
    },
    license: {
      field: "is_public_domain (boolean) + copyright_notice（PD 为 null）",
      openAccess: "AIC Open Access",
      measured: true,
    },
    cache: "同上",
    rateLimit: "无硬限制；Elastic-backed",
    failure: "同 met",
  },

  cleveland: {
    id: "cleveland",
    name: "The Cleveland Museum of Art",
    adapter: "src/services/adapters/clevelandAdapter.js",
    alsoIn: null,
    discovery: true,
    supportsFilmStills: false,
    filmEvidence:
      "q=film 命中 385 条；抽样 5 条 type 全为 Mixed Media / Photograph / Painting。"
      + "Cleveland 不设影片帧类型。",
    search: {
      endpoint: "openaccess-api.clevelandart.org/api/artworks/",
      params: ["search", "limit", "offset", "select"],
      totalReported: true,
      measuredTotal: 2662,
      qParamWorks: null,
      qEvidence: "未单独验证 q 参数（该渠道在 artService 中 enabled，非主用）",
    },
    image: {
      web: "≈723px（Cleveland 自有 CDN，非 IIIF）",
      print: "≈2732px",
      thumb: "web",
      preview: "web",
      detail: "print",
      note: "images 字段实测含 annotation / web / print / full 四种",
    },
    license: {
      field: "share_license_status（=== 'CC0' 判为 publicDomain）",
      openAccess: "CC0",
      measured: true,
    },
    cache: "同上",
    rateLimit: "未实测到硬限制",
    failure: "adapter 直接 fetch，无重试；异常抛给 artService 的 withTimeout（20s）",
  },

  rijks: {
    id: "rijks",
    name: "Rijksmuseum",
    adapter: "src/services/adapters/rijksAdapter.js",
    alsoIn: "src/services/source/artSourceAdapter.js#rijksSource",
    discovery: true,
    supportsFilmStills: false,
    filmEvidence:
      "collection 为绘画与装饰艺术；抽样 2 条 dcType 为 hanging scroll（挂轴）。无影片帧类型。",
    search: {
      endpoint: "data.rijksmuseum.nl/search/collection（Linked Art Search）",
      params: ["imageAvailable", "description", "title", "creator"],
      totalReported: false,
      measuredTotal: null,
      qParamWorks: false,
      qEvidence:
        "参数名是类型化的，不是自由文本 q。实测：description=landscape → 100 条可用；"
        + "creator=Rembrandt → 100 条；subject=landscape → HTTP 400 被直接拒绝（0 条）。"
        + "旧 adapter 同时传 creator+description，会互相收窄结果。",
      totalNote: "该端点不返回 total，只给 orderedItems + next 链接",
    },
    image: {
      iiif: "isShownBy.id 是完整可用的 IIIF URL；只改写 /full/max/ 的尺寸段",
      thumb: "480",
      preview: "960",
      detail: "1920",
      note:
        "实测 isShownBy = https://iiif.micr.io/tvgDM/full/max/0/default.jpg。"
        + "按裸编号拼 iiif.micr.io/<n>/full/{w},/0/default.jpg 会 404 —— 旧 adapter 的写法已废弃。",
    },
    license: {
      field: "从 EDM 全文正则提取 creativecommons.org/publicdomain|licenses/…",
      openAccess: "Public Domain Mark",
      measured: true,
      measuredValue: "creativecommons.org/publicdomain/mark/1.0/",
    },
    cache: "同上",
    rateLimit: "现 adapter 每页间隔 150ms",
    failure: "同 met；另有记录在案的 resolve 失败跳过（console.warn）",
  },

  commons: {
    id: "commons",
    name: "Wikimedia Commons",
    adapter: null,
    alsoIn: null,
    discovery: false,
    supportsFilmStills: true,
    filmEvidence:
      "唯一实测能返回真实影片帧的渠道。Category:Film stills 经 categorymembers 取到 49 个文件成员，"
      + "其中含 'Guillaume Tell (1903) screenshot 2.jpg'（pd / copyrighted=False / 626x360）"
      + "'Raoul Paoli-Cinéma - Safety in numbers - 1930.jpg'（pd / 2967x2367）等真实帧；"
      + "以 gsrsearch='film still crowd scene' 等意图词搜索可返回 PD 帧"
      + "（如 'Film still of Casey (DeWolf Hopper) in his Mudville uniform, 1916.jpeg' pd）。",
    search: {
      endpoint: "commons.wikimedia.org/w/api.php",
      params: [
        "action=query",
        "generator=search + gsrsearch（ns=6 File）+ gsrnamespace",
        "generator=categorymembers + gcmtitle + gcmtype",
        "prop=imageinfo + iiprop=url|extmetadata|size|mime + iiurlwidth",
      ],
      totalReported: true,
      measuredTotal: 49,
      qParamWorks: true,
      qEvidence:
        "关键词检索生效。但混合严重：'movie still group of people' 命中 6 条中 3 条是"
        + "The New Movie Magazine 1930-xx.pdf（扫描杂志，非画面）；"
        + "'film still night street' 命中含 Night in Luna Park（1910 照片，非影片帧）。"
        + "→ 必须按 mime + 许可 + 分类逐条过滤，不能把搜索结果直接当电影画面。",
      mimeNote: "结果含 application/pdf、image/tiff、application/ogg —— 均为非画面资产",
    },
    image: {
      iiif: "upload.wikimedia.org 原始 URL",
      thumb: "iiurlwidth 参数实测可用：请求 w=320 返回 330px thumburl（带 utm 参数）",
      preview: "iiurlwidth=960 → 960px thumburl",
      detail: "原始 width/height 来自 imageinfo",
      note: "三档可复用；thumb 服务实测返回真实 thumburl，不是拼 URL 猜测",
    },
    license: {
      field: "extmetadata: License / LicenseShortName / Copyrighted / AttributionRequired / Categories",
      openAccess: "逐张判定，不按年代推定",
      measured: true,
      measuredValue:
        "Category:Film stills 的 49 个成员中混有 cc-by-sa-4.0 / copyrighted=True 的条目，"
        + "也有 application/pdf —— 许可与格式都必须逐条判，不能整类放行。",
    },
    cache: "本轮新增（见 remoteDiscovery.js 的 CHANNEL_CACHE）",
    rateLimit: "未实测到硬限制；本实现以串行 + 间隔调用",
    failure: "沿用 artSourceAdapter.getJSON 的重试与退避形状，失败返回 {error}",
  },
};

// 已实测的关键结论，供代码与报告共同引用（避免各处复述走样）。
export const CHANNEL_FACTS = {
  metSearchEndpointMoved:
    "MET /public/collection/v1/search 已退役，必须用 /v1.1/search；详情仍在 v1/objects/{id}",
  aicQueryParamBroken:
    "AIC /artworks/search 在当前参数形状下 q= 不生效（三个不同词返回同一 total 与无关标题）",
  rijksSubjectRejected:
    "Rijks subject= 参数被 HTTP 400 拒绝；必须用 description= / title= / creator=",
  rijksShownByIsFullUrl:
    "Rijks isShownBy.id 已是完整 IIIF URL，只改写尺寸段；按裸编号拼 URL 会 404",
  noMuseumHasFilmStills:
    "Met / AIC / Cleveland / Rijksmuseum 均不提供可下载的影片帧；电影画面只能来自 Commons",
  commonsNeedsHardFilter:
    "Commons 搜索结果混杂 PDF / TIFF / 非影片资产与 CC-BY-SA 条目，必须按 mime + 许可 + 分类逐条过滤",
};