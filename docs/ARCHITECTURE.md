# Architecture & data flow

> 本文描述候选版本（Release Candidate 1）的实际结构。所有描述都对照源码写成，
> 不含规划中的组件。

## 1. 整体形态

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (no framework, native ES modules)                  │
│                                                             │
│  index.html  ──►  src/main.js  ──►  src/app/router.js       │
│                                       │                     │
│             ┌─────────────────────────┼──────────────┐      │
│             ▼                         ▼              ▼      │
│        pages/find.js           pages/create.js    pages/…    │
│        (首页 + FIND)            (CREATE)          (shoot /   │
│             │                       │             memory)   │
│             └───────────┬───────────┘                        │
│                         ▼                                    │
│              services/retrieval/  ←── services/source/        │
│              (评分、召回、意图)      (Commons、电影概念、许可) │
│                         │                                    │
│              services/vision/  (契约 + 归一化)                │
│                         │                                    │
│              data/  (artworks / filmStills / visual-intents) │
└─────────────────────────┬───────────────────────────────────┘
                          │  POST /api/vision   （可选通道）
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Node HTTP server  (scripts/server.mjs, zero deps)          │
│    ├── 静态服务 + 路径白名单守卫                              │
│    ├── /api/vision/status    能力如实上报                     │
│    ├── /api/vision/session   访问码 → session token          │
│    ├── /api/vision           上游视觉模型（需 Provider）      │
│    └── server/security/      accessControl / budget / guard  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Agent Skill  skill/visual-ancestry/scripts/va.mjs          │
│    search ─┐                                                 │
│    intent ─┼─► 直接 import src/services/**（同一份实现）      │
│    plan   ─┘                                                 │
└─────────────────────────────────────────────────────────────┘
```

## 2. 关键设计决策

### 2.1 首页复用 FIND 管线

首页 `renderFind(app, { asHome: true })` 直接复用已验证的检索管线，而不是另写一套
「首页精选」逻辑。复制一份会产生第二个行为分叉点 —— 修了首页忘了修 FIND 的 bug
已经发生过一次。

### 2.2 两套皮肤，一个样式表

`src/styles/album.css` 同时包含 A「画册」与 B 存档两套皮肤，由 `<html data-skin>`
切换。默认是 `album`。不开发第三套主题。

### 2.3 图片超时只在进入视口后计时

浏览器对 `loading="lazy"` 的图片在被滚动到视口前**不会发起请求**。如果用
「`src` 设置后 N 秒还没 `complete`」判失败，会把从未开始加载的图片全部误判。
`src/utils/image.js` 用 IntersectionObserver：进入视口才启动计时。
修复前冷启动 20 张里 16 张误显示「图像暂不可用」，修复后 20/20、占位 0。

### 2.4 参考登记只接受字符串 key

`recordReference(key)` 第一行 `if (!key || typeof key !== "string") return`。
传对象会被静默挡下且不报错 —— 页面看起来「点了有反应」，CREATE 却收不到参考。
调用点必须传 `artwork.key`。

### 2.5 CREATE 参考区不被数量上限截断

TaskContext 参考排在参考区**最前**且不受 12 件上限约束；默认候选按 id 去重后补位。
无分析记录的作品照常显示真实作品与来源，标注「无分析记录 · 只贡献来源信息」，
**不生成任何分析字段**。无图作品显示文字卡而不是占位图。

### 2.6 Vision 通道 fail-closed

Provider 已配置但预算账本缺失 → 服务端拒绝调用。凭据只在服务端环境变量；
构建产物不含任何 `VISION_*` 值。未配置时 UI 显示 `not-configured`，
不用任何本地结果冒充识图。

### 2.7 静态根默认指向 dist

`server.mjs` 默认服务 `dist/`，服务源码树必须显式传 `.`。项目目录里有 `.env`，
默认指向错误目录正是历史上 `GET /.env` 泄漏的成因。白名单守卫两种方式都拦。

## 3. 数据流

### 3.1 文本检索

```
文本 → parseVisualIntent() → intent
                         → retrieveByIntent(intent)  （本地档案打分）
                         → discoverCommonsFilmStills()（可选外部来源）
                         → 结果 + retrievalScore + reasons
```

首页「原位搜索」不改变路由（`#index → #index`），只替换图片墙内容。

### 3.2 参考传递（TaskContext）

```
侧栏「使用参考」/「生成 Prompt」
   → beginTask() + recordReference(artwork.key)
   → localStorage（taskContext.js，schema 带版本号）
   → 进入 CREATE：getSnapshot() → syncTaskReferences() → 参考区最前
```

### 3.3 CREATE 生成与导出

```
选中的作品 → getStructuredPrompt(artwork) → aigc 结构
           → translatePrompt({ intent, references, principles })
           → finalPromptText(result)        Prompt 正文
           → buildPromptExport({...})        结构化载荷（纯函数）
           → promptExportToMarkdown(payload) 复制 / 导出 Markdown
```

每件参考只贡献它**真正写过的**字段。缺的字段在导出里进 `skipped`，
不会被补默认值。

### 3.4 记忆

localStorage 持久化，支持导出为可移植档案与再导入。

## 4. 目录职责

| 路径 | 职责 |
|---|---|
| `src/app/router.js` | 哈希路由 + 滚动记忆 |
| `src/pages/find.js` | 首页与 FIND 视图（含 `asHome` 模式） |
| `src/pages/create.js` | CREATE 选参、生成、导出 |
| `src/components/workPanel.js` | 作品详情侧栏 / 手机全屏层 |
| `src/services/retrieval/` | 意图解析、打分、召回 |
| `src/services/source/` | Commons 检索、电影概念拆分、许可判定 |
| `src/services/vision/` | Vision 契约与归一化 |
| `src/utils/image.js` | 图片 URL 分档与 IntersectionObserver 超时 |
| `src/utils/taskContext.js` | 参考与意图的跨页状态 |
| `src/utils/promptExport.js` | 导出载荷组装（纯函数） |
| `server/security/` | 访问控制、预算账本、静态路径守卫 |
| `scripts/server.mjs` | HTTP 服务与 Vision API |

## 5. 不在范围内

- 无用户系统、无云端持久化、无多租户
- 无前端框架与打包器（运行时零依赖）
- 无付费调用默认开启（Vision 需显式配置 + 预算）
