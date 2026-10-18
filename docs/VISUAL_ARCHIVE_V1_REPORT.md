# Visual Archive V1 — Release Report

Date: 2026-10-01 · **Status: VISUAL ARCHIVE V1 RELEASED — FROZEN** · 首个可展示完整产品闭环

> 对应冻结声明：`docs/VISUAL_ARCHIVE_V1_FREEZE.md`；审计：`docs/P5.2.3-freeze-audit.md`。
> V1 回答的问题：**「我的图片能不能成为我的视觉资产？」——能。**

---

## 1. Product Definition

**Personal Visual Archive 是一个将图片转化为视觉语言，并帮助用户按视觉感觉重新找到个人参考资产的工具。**

完整闭环：

```
图片输入 → Vision 分析 → VisualIntent → Personal Memory → Personal Retrieval → 视觉原因解释 → 再次调用
```

用户价值不在"存"，而在"**按感觉找回**"——收藏的图不再是文件夹里的一次性沉淀，而是可用同一种视觉语言重新调用的参考资产。

## 2. Architecture

```
                Visual Archive V1

        Image → Vision Bridge → VisualIntent → VisualMemory → Personal Retrieval → Product UI
```

- **Vision**：`scripts/server.mjs (POST /api/vision)` + `openaiProvider.mjs` + `normalizeVisionIntent` + VisualIntent schema（冻结，Core V1）
- **Memory**：`types.js`（status/error 契约）+ `memoryRepository.js`（双环境 CRUD）+ `uploadService.js`（8 类错误 + failed 落库 + retry）
- **Retrieval**：`retrieveVisualMemory.js`（薄层）+ 冻结 `scoreIntent`/`sharedReasons`（无第二套评分）
- **UI**：`#memory` / `#memory/upload` / `#memory/search` / `#memory/:id` + `memoryCard`/`retrievalCard`

严格单向数据流；`metadata/userData/status/error` 永不进入检索与评分。

## 3. Completed Features

| 能力 | 实现 | 阶段 |
|------|------|------|
| 图片 → 视觉语言 | `/api/vision` 真实 provider + 冻结 normalizer | P5.1 |
| 上传（批量/状态/失败恢复） | 多选 ≤50 + 队列 + 实时进度 + 8 类错误 + failed 落库 + 重新分析 | P5.1.8 |
| Personal Memory（浏览器本地） | 双环境 storage，失败不丢失，刷新可用 | P5.1.5 / P5.1.8 |
| 按视觉感觉找回 | `retrieveVisualMemory` + 结构化选择页 | P5.2.1 / P5.2.2 |
| 匹配原因解释 | evidence（matchedFields + reasons）+ retrievalCard | P5.2.1 / P5.2.2 |

## 4. Validation

### 4.1 测试（全绿，78/78）

| 套件 | 覆盖 | 结果 |
|------|------|------|
| validate-memory-contract | 契约/隔离 | OK |
| memory-repository-test | CRUD/upsert | 11/11 |
| browser-store-test | 浏览器 refresh | 6/6 |
| upload-reliability-test | 上传状态/失败恢复 | 29/29 |
| retrieval-test | 检索匹配/隔离/failed 过滤 | 20/20 |
| product-flow-test | 端到端流程 | 12/12 |

### 4.2 真实链路验证

- **P5.1.7 真实素材 20 张** → 上传可靠性回测（STEP 6）：首传 90% 失败恢复 100%，终态 100%
- **P5.1.7 → P5.2.1 Q3 修复**：二次使用测试从 3/3 失败 → 视觉语言检索可找回
- **STEP 7 三查询产品验证**（20 条真实记忆）：孤独城市空间 / 低饱和夜景 / 空旷自然环境 均召回语义正确资产并带证据
- **P5.2.3 STEP 5 Demo 封装**：四场景（上传→浏览→按感觉寻找→为什么匹配）可复现

### 4.3 构建与安全

- 生产构建 exit 0；leak scan **69 文件 0 违禁 token**
- 服务器密钥仅存 server env；浏览器永不解析 node:fs / 永不含密钥（Core V1 #8 延续）

### 4.4 冻结面

- Core V1 29 文件基线：28/29 mtime 一致（唯一变化 index.html = P5.1.5 UI 导航注册）
- V1 新增（个人层/UI 层）零冻结核心触碰；`scoreIntent`/`sharedReasons`/`normalizeVisionIntent`/`emptyVisualIntent` 冻结导出只读复用

## 5. Limitations（诚实）

1. **无法做真实浏览器 DOM 点击验证**（agent-browser Chromium 在本环境 SIGTERM）：交互由构建产物 + Node 语义 QA 覆盖；建议在具备 Chromium 环境补一次手点回归
2. **查询仅结构化，无自然语言**：用户需理解"氛围/空间/色彩"这类视觉词汇（V1 范围决策）
3. **池内同质化 / 并列分数**：孤立/deep/低饱和高频出现，top 内区分度有限（真实用户收集多样素材可缓解；V2 个人画像也可辅助）
4. **真实用户数据不可达**：产品数据存浏览器 localStorage，本环境无法读取；验证/Demo 用隔离回测池（真实 provider 输出，语义等价）
5. **无跨设备/云同步/多用户**：V1 明确非目标，限定"个人 + 单设备"场景

## 6. Future Direction

### V1（已冻结）
> 我的图片能不能成为我的视觉资产？—— **能。**

### V2 — P5.3 Personal Visual Profile
> 我的视觉资产能不能反映我的审美倾向？

```
Personal Retrieval
        ↓
Personal Visual Profile（个人池 visualIntent 聚合 → 审美画像）
```

进入 V2 前必须：① 遵守 V1 Freeze 规则（说明动机 / 边界影响 / 归属版本）；② 更新视觉模型字段优化等需**显式授权解锁**。

**路线**：Visual Archive V1（本版）→ 作品集包装 → P5.3 Personal Visual Profile →

---

### 变更记录

- 新增：`docs/P5.2.3-freeze-audit.md`、`docs/VISUAL_ARCHIVE_V1_FREEZE.md`、`docs/VISUAL_ARCHIVE_V1_REPORT.md`
- 修改：`DEV_STATE.md`
- **零代码修改**（只读审计 + 文档冻结声明确认）