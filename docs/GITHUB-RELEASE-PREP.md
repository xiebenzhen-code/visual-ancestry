# FIND 最终修复与 GitHub 发布准备

> 生成时间：2026-10-15
> 状态：**本地就绪，未 push、未覆盖公网 R4.5**

---

## 1. 状态变量

| 变量 | 值 |
|---|---|
| `FIND_INSTANCE_GUARD` | **PASS**（11/11 对抗测试） |
| `STATIC_RELEASE_READY` | **YES** |
| `PAID_VISION_RELEASE_READY` | **NO** |
| `GITHUB_REPOSITORY_VERIFIED` | **PARTIAL**（remote 正确，基线不可验） |
| `GITHUB_SYNC_READY` | **NO**（阻塞原因见 §4） |
| `PUBLIC_DEPLOYMENT_AUTHORIZATION_REQUIRED` | **YES** |
| `EMAIL_DELIVERY_BLOCKED` | **是** |

---

## 2. STEP 1 — 页面实例守卫

### 修掉的缺陷
`FIND_ACTIVE_INSTANCE` 原先声明在 `renderFind()` **函数体内**，每次挂载重置为 0，
`instanceId` 恒为 1、`instanceAlive()` 恒为 true —— **守卫形同虚设**。移到模块作用域后
序列跨挂载保持。

同时记录本次 `.find-page` DOM 根节点，响应提交前校验四条：
1. 查询令牌仍有效
2. 当前模式仍是文字检索
3. 当前实例号仍有效
4. 当前页面根节点仍是发起请求时的节点

### 关键设计：实例有效性 ≠ 模式有效性
`instanceAlive()` **只判断实例**（实例号 + 根节点在文档中 + 仍是当前 `.find-page`），
不含模式。模式判断只加在 `paintRemote()` 上。

**为什么**：把 `activeMode === "text"` 折进 `instanceAlive()` 后，切到图片模式时
`clearRemote()` 被自己挡掉，旧查询的「正在检索」留在图片模式页面上 —— 这与上轮已修过
的 B2 是**同一类错误，只是换了入口**。本轮实测再次抓到（B2 FAIL），拆开职责后通过。

> 教训：守卫逻辑复用时必须考虑调用时机。「清空」需要绕过模式守卫，「写入」需要它。
> 合成一个函数就会互相误伤。

### 对抗测试（`qa/find/instance-guard-test.mjs`，11/11 PASS）
用 **hash 路由**做 A→B 切换（同文档导航，JS 上下文存活 —— 这正是守卫要防的场景；
若用 `Page.navigate` 会整页重载、请求被中止，反而测不到问题）。

覆盖 `window.fetch` 让远程请求挂起，精确控制 A 的响应在 B 挂载之后才返回：

| 断言 | 结果 |
|---|---|
| 0a/0b 两次挂载实例号不同且递增 | PASS（证伪旧实现） |
| 1a A 已发起查询且有远程请求在途 | PASS |
| 1b B 是与 A 不同的实例 | PASS |
| **1c A 的陈旧响应未写入 B 的远程区段** | **PASS** |
| **1d B 的本地结果未被 A 的响应改变** | **PASS** |
| **1e B 的首位结果仍是 B 自己的查询结果** | **PASS** |
| 2a/2b 反向对照：B 自己的响应能正常处理 | PASS |

**旧实例的写入被证明拒绝。**

---

## 3. STEP 2 — 静态发布边界

### `STATIC_RELEASE_READY = YES`
覆盖范围：本地绘画与电影参考、FIND 文字视觉检索、Commons/博物馆远程发现、
CREATE/SHOOT 已有功能、MEMORY、来源与许可标注。

验证：
- 干净生产构建：246 文件 / 42M，`Leak scan clean: 84 file(s), 0 forbidden tokens`
- 密钥扫描（`sk-*` / `VISION_API_KEY` / `BEGIN PRIVATE KEY` / `password=`）：**零命中**
- 上传图片模式诚实显示不可用（无 Provider 时 fail-closed，不假装成功）
- 源码 JSON 未被 `.gitignore` 误排除（`git check-ignore` 逐条验证 `src/data/visual-intents/artworks.json`、`public/assets/artworks/manifest.json` 均保留）

### `PAID_VISION_RELEASE_READY = NO`
`VISION_API_BASE` / `VISION_API_KEY` / `VISION_MODEL` / `VISION_ACCESS_CODE` /
`VISION_ACCESS_SECRET` **全部 NOT_SET**，`realApiCallsMade=0`。

**两项独立**：静态前端不包含、也不依赖 Provider 密钥；付费 Vision 未验收不阻止静态发布。

---

## 4. STEP 3 — GitHub 接回（核对结果）

### 仓库实况
```
实际仓库根：.../Codex/2026-09-20/referenced-chatgpt-conversation-this-is-an/
remote github → https://github.com/xiebenzhen-code/visual-archive.git   ✓ 与指定仓库一致
HEAD         → f20be51200fb7c30337b293b153f2c2837afeb01 (master)
跟踪文件数   → 8（且属于另一个项目的 MVP 产物：dist/app.js、outputs/frame-atlas-mvp/*）
refs         → 仅 master 与 remotes/sites/main，无 github/*，无任何 tag
```

### 阻塞事实
**R4.5 基线 `111c3f4461410103fe98d090b1c1817d298b685a` 不在本地仓库**
（`git cat-file -t` 返回 could not get object info），且 GitHub 连接器当前不可用，
无法 fetch 核实。

本地 `master` 的 HEAD（`f20be51`）**不是** R4.5 基线，跟踪的 8 个文件属于另一个项目。
在此状态下 push 会与线上真实历史冲突，**有覆盖 R4.5 的风险**。

### 因此 `GITHUB_SYNC_READY = NO`
按约束未在上级 Codex 目录执行 `git init` / `git add -A` / `git clean`，
未擅自 push 或覆盖公网 R4.5。

### 已准备的发布副本
`work/github-staging/` —— 44M / 449 文件，独立干净副本：
- 纳入：`src/` `public/` `scripts/` `server/` `docs/` `qa/*.mjs` `index.html` `package*.json` `.gitignore`
- 排除：`node_modules/` `dist/` `work/` `.env` `portfolio/`（9.1M 历史演示截图，无代码引用）
- 已逐项验证排除生效、零密钥

---

## 5. STEP 4 — 最小发布验证

| 项 | 结果 |
|---|---|
| 干净生产构建 | **PASS**（246 文件 / 42M，0 forbidden tokens） |
| 生命周期专项测试 | **11/11 PASS** |
| FIND 本地+远程功能检查 | **18/18 PASS** |
| 真实图片解码 | **PASS**（Met 450px/449px、Cleveland 583px/929px、Commons 电影帧） |
| 来源链接 | **PASS**（4/4 卡片带外链） |
| 静态构建无 API Key / Bearer | **PASS**（零命中） |
| wiring / retrieval / product-flow 回归 | 41/41、20/20、12/12 |

### 相对 R4.5 的差异
以本地快照 `work/p6.4-release/r45-release/` 作**代理对照**（非 git 基线，已如实标注）：

`src` 差异 16 项，其中**新增 5 个文件**：
- `src/data/filmStills.js`（电影帧数据）
- `src/pages/filmDetail.js`（电影详情页）
- `src/services/retrieval/remoteReferences.js`（远程→FIND 接线）
- `src/services/source/remoteDiscovery.js`（远程发现层）
- `src/services/source/channelMatrix.js`（渠道矩阵）

修改 11 项：`router.js`、`archiveGrid.js`、`artworkFigure.js`、`artwork.js`、
`find.js`、`shoot.js`、`metAdapter.js`、`retrievalService.js`、`visionProvider.js`、
`visionService.js`、`v5.css`。`public` 差异 3 项。

---

## 6. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| **R4.5 基线不可验，push 有覆盖风险** | **高** | `GITHUB_SYNC_READY=NO`；须先 fetch 核实基线再同步 |
| 本地仓库混装两个项目（8 个无关跟踪文件） | 中 | 发布副本已隔离；正式同步须用干净副本 |
| 远程渠道跨境不稳定（Wikimedia 曾 53s 超时、AIC IIIF 返 403） | 中 | 超时压至 12s×1；失败有明确降级；本地检索不受影响 |
| 付费 Vision 未验收 | 中 | 无密钥时 fail-closed |

### 回滚步骤
1. **回滚 commit**：线上 R4.5 = `111c3f4461410103fe98d090b1c1817d298b685a`（未改动，可直接 `git reset --hard` 回退）
2. 本地回滚：`git checkout -- src/`（若已提交）；或从 `work/p6.4-release/r45-rollback-0.9.1` 恢复
3. 远程发现回滚：删除 `src/services/retrieval/remoteReferences.js` 与 `src/services/source/remoteDiscovery.js`，还原 `find.js` —— FIND 自动回到纯本地检索，无数据残留
4. R4.5 commit、标签与回滚路径**本轮全程未触碰**

---

## 7. Architecture Learning Layer

### 模块职责
```
用户查询
   ├─► retrieveByText() ──────► 本地 VisualIntent 评分器（同步，未改动）
   │                                本地池 46 绘画 + 3 电影帧
   └─► findRemoteReferences() ─► 远程发现（异步，旁路，不进评分器）
          │                         博物馆渠道 + Commons
          └─► #find-remote 独立区段
```

**为什么远程不进评分器**：`retrieveByIntent` 同步而远程异步；更重要的是远程件
`analysisLevel=0`、无 VisualIntent。塞进评分器会让「远程件也能被本地 intent 排序」
变成假象 —— 把馆方文本分类伪装成视觉分析。

### 来源标注（provenance）六值
`text-parse` / `rule-derivation` / `calibration-cache` / `live-vision`（本地四源）
与 `channel-metadata` / `channel-metadata-text`（远程两源）。远程件 note 恒为
「依据馆方主体字段的文本匹配，非模型视觉分析」。

### 相关性判定的字段分界
- **主体字段**（title/classification/subjects/department）描述「画什么」→ 可计分
- **归属字段**（culture/medium/年代）描述「是谁的、用什么做的」→ 只作 facts，**计分恒为 0**

修掉的真实缺陷：「量子纠缠与孤独」曾因 `culture=Chinese` 推荐《Bathing of the Buddha Festival》。

### 异步生命周期四重守卫
令牌 + 模式 + 实例号 + `.find-page` 根节点。

**为什么不用 `app.isConnected` 单一判断**：router 每次进 `#find` 重建 DOM，旧节点是被
`innerHTML` 覆盖而非移除，`isConnected` 可能仍为 true。实例号单调自增、不可复用，
从根本上区分两次挂载；根节点比对兜底。

**为什么实例与模式要分开**：见 §2 的教训。

### 缓存设计
`CHANNEL_CACHE` 按 `渠道:分类:查询:limit` 键缓存，**仅进程内存**，不落盘、不进发布物 ——
远程内容随馆方数据变化，持久化会造成「截图与线上不符」。超时 12s×1 次：实测跨境 53s
才失败，压短上限让用户尽快看到降级说明。

---

## 8. 邮箱投递

`EMAIL_DELIVERY_BLOCKED` —— `GetMe` 持续返回 `not_bound`，Agent 邮箱仍未开通，
本报告**未能**发送至 xiebenzhen@gmail.com。需在「更多 - 我的邮箱」开通后重发。
