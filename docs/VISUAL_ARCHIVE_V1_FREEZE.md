# Visual Archive V1 — Freeze

Date: 2026-10-01 · **Status: FROZEN — Visual Archive V1** · 首个可展示完整产品闭环

> 这是 Visual Ancestry 项目独立的 **Personal Visual Archive** 子产品的第一个冻结版本。
> 覆盖：Vision（图片→视觉语言）+ Memory（视觉语言→个人资产）+ Retrieval（感觉→找到参考）+ Product Flow（上传→浏览→按感觉找回→为什么匹配）。
> 前置审计：`docs/P5.2.3-freeze-audit.md`（四层均完整、未破坏、已验证）。

---

## 1. Product Definition（固定）

> **Personal Visual Archive 是一个将图片转化为视觉语言，并帮助用户按视觉感觉重新找到个人参考资产的工具。**

它不是搜索引擎、不是 AI 标签墙、不是文件管理器——它把用户"在意的画面"沉淀为**可用同一种视觉语言重新调用的个人资产**。

## 2. Core Value（三个核心，缺一不可）

| # | 价值 | 转换 | 说明 | 冻结模块 |
|---|------|------|------|----------|
| 1 | **Visual Translation** | 图片 → 视觉语言 | 把"感觉"转译成可存储、可比较的结构化语言（光线/构图/色彩/氛围/情绪） | `/api/vision` + `normalizeVisionIntent` + VisualIntent schema |
| 2 | **Personal Memory** | 视觉语言 → 个人资产 | 个人专属存档，失败不丢失，只存浏览器 | `types.js` + `memoryRepository.js` + `uploadService.js` |
| 3 | **Visual Retrieval** | 感觉 → 找到参考 | 用视觉语言找回，且说明"为什么匹配" | `retrieveVisualMemory.js` + 冻结 `scoreIntent`/`sharedReasons` + retrievalCard |

产品定位一句话：**个人视觉记忆系统**（非搜索引擎）。

## 3. Frozen Architecture

```
                Visual Archive V1


        Image
          |
          |
   Vision Bridge   （scripts/server.mjs /api/vision + openaiProvider）
          |
          |
  VisualIntent     （visualIntent.js schema + normalizeVisionIntent）
          |
          |
 VisualMemory      （types.js + memoryRepository + uploadService）
          |
          |
Personal Retrieval（retrieveVisualMemory + scoreIntent + evidence）
          |
          |
   Product UI      （#memory / upload / search / detail + cards）
```

数据流严格单向：Image → intent → memory → retrieval → UI。**metadata/userData/status/error 永不进入检索与评分**；`visualIntent` 是唯一检索字段。

## 4. Frozen Components

### 4.1 Vision（Core V1 冻结 + V1 复用）
- VisualIntent schema：`src/services/retrieval/visualIntent.js`（`emptyVisualIntent` / `mergeIntent`）
- Vision bridge：`scripts/server.mjs`（`POST /api/vision`，6MB cap + mime + base64 校验 + 诚实错误）
- Provider adapter：`server/vision/openaiProvider.mjs`（server-only 密钥、structured output、P2.7 JSON recovery）
- Normalizer：`src/services/vision/normalizeVisionIntent.js`

### 4.2 Memory
- VisualMemory contract：`src/services/memory/types.js`（`createVisualMemory` + `MEMORY_STATUSES` + `status/error`）
- Repository：`src/services/memory/memoryRepository.js`（双环境 `addMemory/getMemory/listMemories/deleteMemory`）
- Upload workflow：`src/services/memory/uploadService.js`（8 类错误分类 + failed 落库 + retry upsert）

### 4.3 Retrieval
- `src/services/memory/retrieveVisualMemory.js`（薄层：准入过滤 → `scoreIntent` → 排序 → evidence）
- 复用冻结：`scoreIntent`（scoring.js）/ `sharedReasons`（artworkIntent.js）——**无第二套评分**
- evidence 格式：`{ id, score, matchedFields, reasons, memory }`（匹配解释，只解释不评分）

### 4.4 UI Flow（四路由）
- `#memory` Archive 首页
- `#memory/upload` Upload 页
- `#memory/search` Search 页（结构化选择→VisualQuery）
- `#memory/:id` Detail 页
- 组件：`memoryCard.js` / `retrievalCard.js` / `memoryLabels.js`（纯展示）

## 5. 明确非目标（V1 不包含）

```
❌ 全球艺术数据库         ❌ 无限图片搜索
❌ 向量数据库             ❌ embedding
❌ Agent                  ❌ 自动生成导演方案
❌ 多用户系统             ❌ 云同步
❌ 自动审美分析           ❌ 自然语言查询（V1 用结构化选择）
```

**原因**：现状核心问题不是规模，而是「用户是否真的会通过视觉语言再次调用自己的资产」。V1 冻结正是为了守住这个单一价值，防止"边界扩大 → 展示困难 → 核心价值模糊"。

## 6. Freeze 规则

V1 冻结后，下列**任何变更**须先说明：

1. **为什么需要**（对齐哪个 Core Value / 哪个已知缺口）
2. **是否破坏 V1 边界**（是否触碰 §4 冻结组件 / 是否引入 §5 非目标）
3. **是否属于新版本**（V2+ 的变更需显式版本化）

若变更触碰 §4 冻结组件 → 走**显式授权解锁**流程（与 Core V1 / P5.1 个人层既有规则一致）。仅允许不改冻结原语的变化：文档/报告、QA harness、演示数据。

## 7. 变更管理（本阶段）

- 新增：`docs/P5.2.3-freeze-audit.md`、`docs/VISUAL_ARCHIVE_V1_FREEZE.md`、`docs/VISUAL_ARCHIVE_V1_REPORT.md`（STEP 7）
- 修改：`DEV_STATE.md`
- **零代码修改**：本阶段为只读审计 + 文档冻结声明确认；`retrievalService/artworks/scoring/schema/bridge/provider` 全部未触碰