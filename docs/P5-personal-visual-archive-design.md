# P5.0 — Personal Visual Archive · Design

Date: 2026-09-30 · Status: **P5.0 DESIGN READY** · Read-only audit + architecture design · Core V1 untouched

---

## 1. Core Reuse Analysis（STEP 1）

### 1.1 可直接复用（冻结组件原样调用）

| 组件 | 位置 | 复用方式 |
|------|------|----------|
| **VisualIntent schema** | `src/services/retrieval/visualIntent.js` | 统一视觉语言。`emptyVisualIntent()` / `mergeIntent()` 可被个人层直接 import（纯函数） |
| **image → intent pipeline** | `/api/vision` bridge → `normalizeVisionIntent` | 完整链路已为任意图像工作（P2.8/P3.2 校准 49 张画作、P4 harness 面向电影截图）。用户上传图走同一 bridge：`POST /api/vision {imageBase64, mimeType}` → `{ok, intent, latencyMs}`；`normalizeVisionIntent` 为 Node 可 import 的纯函数 |
| **Vision bridge** | `scripts/server.mjs` `handleVision` | 6MB cap / mime 白名单 / base64 校验 / 503 诚实分层——**无状态、不持久化**，天然适合个人上传（每次调用只返回 intent，不落库） |
| **normalizeVisionIntent** | `src/services/vision/normalizeVisionIntent.js` | 严格枚举白名单，未知字段丢弃，partial 保持 partial。个人层保存的就是它的输出 |
| **retrieveByIntent** | `src/services/retrieval/retrievalService.js` | 对 **artwork 池**的原生检索（见 1.3 限制） |
| **scoreIntent / sharedReasons** | `src/services/retrieval/scoring.js` / `artworkIntent.js` | **两者均为公共导出纯函数** → 个人层可在不触碰 Core 内部的前提下直接组合（见 STEP 5） |
| **evaluation harness** | `qa/retrieval-quality/*` + `qa/film-still-matching/*` | 同一套结果契约（provider/status/matches/matchedFields/intentSource）可扩展为个人资产评测 |
| **secret boundary** | `prod-audit` + build leak scan | 个人层新增的 server 代码继续遵守「凭据只留 server env、dist 零 secret」 |

### 1.2 保持冻结（不得修改）

- VisualIntent schema
- provider architecture（bridge + server-side adapter）
- prompt（structured-output 契约）
- JSON recovery（P2.7）
- Core retrieval logic（`retrieveByIntent` 内部）
- scoring weights
- production UI

### 1.3 关键限制（设计必须正视）

`retrieveByIntent` 的候选池是 **hardcode**：
```js
function curatedPool() {
  return artworks.filter((artwork) => artwork.image && !artwork.imageUnavailable);
}
```
→ Core 检索只扫描 51 件 curated 作品。**个人视觉资产无法直接进入这个池子**——除非修改 Core（禁止）。因此个人层检索必须通过 **repository abstraction + 已导出的 scoreIntent/sharedReasons** 实现（STEP 5），而不是「把个人条目塞进 artworks.js」。

---

## 2. VisualMemory 数据模型（STEP 2）

### 2.1 统一模型

```jsonc
{
  "id": "vm-001",                        // 必填：唯一 id（UUID 或时间戳+序号）
  "source": "user-upload",                // 必填：来源类型（见 2.2）
  "image": "memories/vm-001.webp",        // 必填：本地存储路径/URL
  "metadata": {                            // 可选：事实信息（不参与检索）
    "title": "",
    "origin": "",                          // 来自哪里：film/painting/photo/ai-gen/screenshot
    "film": null, "year": null, "artist": null, "museum": null,
    "tags": [],                            // 用户自定义标签（仅供人工筛选，不进 VisualIntent 检索）
    "addedAt": "2026-09-30T08:00:00Z"
  },
  "visualIntent": { ... },                // 必填：normalizeVisionIntent 输出（冻结 schema 全字段）
  "userData": {                            // 可选：用户私有注解（草稿/收藏/评分…）
    "note": "",
    "collections": [],                     // 个人收藏分组 id
    "rating": null
  }
}
```

### 2.2 必填 / 可选 / 不参与检索

| 字段 | 必填 | 参与检索 | 说明 |
|------|------|----------|------|
| `id` | ✅ | 否 | 唯一标识 |
| `source` | ✅ | 否（可作过滤） | `user-upload` / `film-still` / `artwork-reference` / `ai-generated` / `photo` |
| `image` | ✅ | 否 | 本地资产路径（6MB cap 内原件或缩略） |
| `visualIntent` | ✅ | **是（唯一检索依据）** | 冻结 schema；个人层永远只保存 normalize 后的输出，不保存原始 provider JSON |
| `metadata` | ❌ | **否** | 事实信息；不得进入 retrieval/scoring（延续 P4 纪律：film/year/title 仅人工参考） |
| `userData` | ❌ | 否 | 用户私有注解，纯人工 |

> 规则：**视觉检索只发生在 visualIntent 空间**。metadata 的任何字段（包括 tags）不得被注入 query 或 candidate——与 P4 的「film/year/note 不进 scoring」完全一致。

---

## 3. Personal Layer Architecture（STEP 3）

```
User Upload (image + optional note)
        │
        ▼
┌─────────────────────────────┐
│ Personal Visual Layer (NEW) │  ← 新增模块（见下）
└─────────────────────────────┘
        │  {imageBase64, mimeType}（复用现有契约）
        ▼
┌─────────────────────────────┐
│ Existing Vision Pipeline    │  ← 冻结：POST /api/vision + normalizeVisionIntent
└─────────────────────────────┘
        │  VisualIntent
        ▼
┌─────────────────────────────┐
│ VisualMemory Storage        │  ← 新增 repository（STEP 4 存储策略）
└─────────────────────────────┘
        │  query intent
        ▼
┌─────────────────────────────┐
│ Existing Retrieval          │  ← 冻结：scoreIntent + sharedReasons 组合
│ (via repository abstraction│     （不触碰 retrieveByIntent 内部）
│  + shared pure functions)   │
└─────────────────────────────┘
```

### 新增模块（全部独立于 Core）

| 模块 | 职责 | 复用 | 新增 |
|------|------|------|------|
| `uploadService` | 接收上传（mime/size 校验）→ 调现有 bridge → 返回并持久化 intent | bridge / normalizeVisionIntent | 上传编排 + 校验 |
| `memoryRepository` | VisualMemory 条目 CRUD（add/get/list/delete；见 STEP 4 存储后端） | — | 全部新增 |
| `personalCollection` | 用户分组/收藏视图（collections、tags） | — | 全部新增（薄层，基于 repository） |
| `indexLayer` | 构建可检索的 intent 索引（内存 Map / SQLite 表 / JSON 数组） | — | 全部新增（数据组织，非检索逻辑） |
| `retrieveVisualMemory` | 个人资产检索：query intent → 池内 score+rank | **scoreIntent / sharedReasons（已导出冻结函数）** | 薄组合层（见 STEP 5） |

### 明确不新增

- 第二套 retrieval system（禁止）
- film-specific schema / prompt / heuristic（禁止）
- 任何 Core 内部代码修改（禁止）

---

## 4. Storage Strategy（STEP 4，只分析不实现）

| 方案 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| **Local JSON** | 零依赖、与现有 repo 模式一致（artworks.js / visual-intents/artworks.json 先例）、git 可追踪、读写即对象 | 扩展性低、无并发、无索引查询、全量载入 | **Demo / 单机测试 / P5.1 MVP** |
| **SQLite** | 单文件、结构化查询、事务、支持增量/索引、Node 侧成熟（better-sqlite3 零配置） | 需引入依赖与 schema 迁移；非 git 友好（二进制） | **个人视觉库 / 本地应用（P5.2 起）** |
| **PostgreSQL** | 云托管、多设备同步、全文/向量扩展（pgvector） | 需要 server 服务、部署与鉴权成本 | **云端 / 多设备（仅当需求出现）** |

**Storage Recommendation**：
- **P5.1（MVP）→ Local JSON**：单个 `src/data/visual-memory/memories.json`（或 `server/data/` 私有目录），与现有 `visual-intents/artworks.json` 同构。零新依赖、可审计、幂等可重跑。
- **P5.2（规模/筛选需求）→ SQLite**：`better-sqlite3` 表 `memories(id, source, image, metadata_json, intent_json, user_data_json)` + `intent` 字段列（供结构化筛选）；迁移自 JSON 一次性导入。
- **P5.3 之后（多设备/云端）→ PostgreSQL**：仅在用户多端同步需求确认后引入；`pgvector` 可作为 intent 向量检索的远期选项（**非本期**）。
- 决策依据：数据量（MVP 几十~数百条目 JSON 完全够）、并发（单用户本地无并发）、部署形态（个人工具 → 本地优先 → 云端按需）。

---

## 5. Retrieval Extension Design（STEP 5）

### 三个问题的答案

1. **是否需要修改 retrieval core？** **否。** `retrieveByIntent` 内部（池子 hardcode + map/score/sort/slice）保持冻结。
2. **是否需要 adapter？** **需要，且是唯一新增的检索层。** 一个薄组合函数，不复制逻辑、只调用已导出冻结函数：

```js
// 个人层（如 src/services/memory/retrieveVisualMemory.mjs）— 示意
import { scoreIntent } from "../retrieval/scoring.js";        // 冻结导出
import { sharedReasons } from "../retrieval/artworkIntent.js"; // 冻结导出

export function retrieveVisualMemory(queryIntent, memories, { limit = 8 } = {}) {
  return memories
    .map((m) => {
      const scored = scoreIntent(queryIntent, m.visualIntent);   // 同一打分函数
      return {
        memory: m,
        retrievalScore: scored.score,
        reasons: sharedReasons(queryIntent, m.visualIntent, 4),  // 同一理由生成
      };
    })
    .filter((item) => item.retrievalScore > 0 && item.reasons.length)
    .sort((a, b) => b.retrievalScore - a.retrievalScore)
    .slice(0, limit);
}
```
   ——打分与理由生成**逐字节复用 Core 的导出函数**；排序/filter/slice 是仓库层的平凡组装（非检索算法本身）。
3. **是否需要 repository abstraction？** **需要。** 它是「个人池」与「冻结检索核心」之间的唯一接缝：`memoryRepository.list() → intent 数组 → retrieveVisualMemory`。Core 的 artwork 池与个人池从此**平行存在**，互不干扰；未来若两者需要混合检索，可在个人层做池合并（仍只调用导出函数）。

### 设计保证

- `retrieveByIntent()` 核心逻辑稳定、零改动
- 个人层不复制 scoring/reasons 逻辑（直接调用）
- 检索行为与 Core 语义完全一致（同分同理由），只是池子不同

---

## 6. External API Strategy（STEP 6，只设计不接入）

| 数据源 | 用途 | 接入时机 |
|--------|------|----------|
| **Museum API**（AIC/Met/Cleveland/Rijks — 已在 `src/services/adapters/`） | **external reference expansion**：检索个人资产时可附带「关联馆藏作品」参考（仅推荐，非核心数据） | **已有**；P5.3 在个人层做参考合并（不进 Core 数据） |
| **IIIF**（馆藏图像协议） | 取图规范；参考缩略图 | 已有部分使用；P5.3 参考层按需 |
| **Europeana** | 泛欧洲聚合索引，可作扩展检索源 | P5.3 可选（需评估字段质量） |
| **Film metadata**（TMDB/IMDb 等） | **metadata enrichment**：仅给电影截图条目补 film/title/year 等 metadata | **不接**（P4 纪律：metadata 不参与视觉检索；仅用户可选人工标注） |

**External Data Strategy**：
- 外部数据永远定位为**个人资产的参考扩展**，不进入 VisualIntent 检索打分、不进入 Core 数据。
- P5.1 / P5.2 **不引入任何新外部 API**（现有博物馆适配器已冻结，只读）。
- 若 P5.3 需要参考扩展：在个人层新增 `referenceService`（只读调用既有 adapters / 可选 Europeana），输出附加到检索结果尾部并标注 `source: external-reference`，**不混入 score**。

---

## 7. Product Boundary（STEP 7）

```
Input:   用户上传的任意视觉素材（电影截图 / 绘画 / 摄影 / AI 生成图 / 灵感图）
        + 可选文本注解（不参与视觉检索）

Output:  每个素材 → VisualIntent（统一视觉语言）
        + 个人视觉资产库（可浏览/分组/注解）
        + 基于视觉特征的检索结果（top-N + matched-field evidence）

Core Value: 把「任意视觉素材」统一为「可检索的视觉语言」，构建创作者的个人视觉
            知识库与资产管理工具——跨来源（截图/画作/照片）按构图、光线、色彩、
            氛围等视觉语言检索与调用。

Non-goal:
  - 全球艺术数据库（馆藏是参考扩展，不是核心数据）
  - 通用图片搜索引擎（不做反向图片检索/内容识别）
  - 内容托管/分享平台（不处理版权存储分发）
  - 语义标签准确率评测（P4 起一贯：验证视觉关系质量）
```

---

## 8. Implementation Roadmap（STEP 8，三个阶段以内）

### P5.1 — Personal Storage MVP
- **目标**：上传 + 保存 VisualIntent（Local JSON repository）
- **文件范围**（全部新增，Core 冻结）：
  - `src/services/memory/uploadService.mjs`（调现有 bridge + normalize）
  - `src/services/memory/memoryRepository.mjs`（Local JSON CRUD）
  - `src/data/visual-memory/memories.json`（初始空/示例）
  - `qa/memory/` 离线测试（validator + 契约检查，零 provider）
  - 可选 server 端 `POST /api/memory`（复用 handleVision 内部；**新增路由不修改既有路由**）
- **验收**：上传 N 张 → 生成 N 个 visualIntent 落盘；metadata 不进 intent；冻结文件 mtime diff 空；build/回归不退化

### P5.2 — Personal Retrieval
- **目标**：搜索个人视觉资产
- **文件范围**：
  - `src/services/memory/retrieveVisualMemory.mjs`（薄组合层，调用冻结 scoreIntent/sharedReasons）
  - `indexLayer`（内存索引 / 或 SQLite 迁移）
  - `qa/memory/retrieval-*.mjs` + results/report（复用 P3/P4 结果契约）
- **验收**：个人资产 top-N 检索带 matchedFields + intentSource；与 Core 检索语义一致（同分函数）；混合池可选

### P5.3 — External Reference Layer
- **目标**：连接公共视觉资源作为扩展
- **文件范围**：`referenceService.mjs`（只读调用既有 museum adapters，可选 Europeana）+ 检索结果尾部扩展标注
- **验收**：参考扩展不混入 score、不进 Core 数据；UI 若展示需单独确认（**默认不动 UI**）

> 注：P5.1/P5.2 是否需要 UI 由用户单独决策；本设计默认 Personal Layer 先以 QA/harness 形态交付，UI 是独立后续项。

---

## 9. 五个核心问题的回答

1. **Core V1 是否可保留？** ✅ **可完整保留。** 个人层 100% 构建在冻结组件之上（bridge / normalize / scoreIntent / sharedReasons），唯一新增接缝是 repository abstraction。
2. **Personal Layer 是否可以独立增加？** ✅ **可以。** 全部新模块在 `src/services/memory/` + `src/data/visual-memory/` + `qa/memory/`，与 Core 平行，互不依赖改动。
3. **Retrieval 是否需要重构？** ❌ **不需要。** `retrieveByIntent` 保持冻结；个人检索用已导出的 `scoreIntent` + `sharedReasons` 组合（同一打分语义，不同池子）。
4. **API 是否应该现在引入？** ❌ **不应该。** P5.1/P5.2 零新 API；博物馆适配器已冻结可用；外部数据只在 P5.3 作为 reference 扩展，且不进检索打分。
5. **最小 MVP 路径是什么？** ✅ **P5.1（Local JSON 存储）→ P5.2（薄检索层）**：上传 → bridge → normalize → 存 JSON → retrieveVisualMemory（复用冻结函数）→ top-N 证据。全程不打开 Core V1。

---

## 10. 限制条件遵守声明

本阶段执行期间：未修改 `src/`、`server/`、schema、provider、prompt、scoring、UI；未调用 Vision API；未新增数据库。仅新增本设计文档 + DEV_STATE 记录。
