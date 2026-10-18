# FIND Remote — 发布候选清单与架构说明

> 生成时间：2026-10-15
> 状态：**本地完成，未推送 GitHub、未部署公网、未覆盖 R4.5**

---

## 1. 发布判定

| 项 | 值 |
|---|---|
| `FIND_RELEASE_CANDIDATE` | **YES**（本地候选就绪） |
| `PUBLIC_RELEASE_READY` | **NO** |
| 浏览器验收 | 18/18 PASS（`qa/find/final-gate.mjs`） |
| 单元/接线验收 | 41/41 PASS（`qa/find/remote-discovery-wiring-test.mjs`） |
| 本地检索回归 | retrieval-test 20/20、product-flow-test 12/12 |
| 构建 | 干净重建 246 文件 / 42M，84 文件 0 forbidden tokens |
| src/dist 同步 | 3 个改动源文件全部一致 |

**判定为 NO 的原因**：真实付费 Vision Provider 验收未执行（`realApiCallsMade=0`，
无 `VISION_API_KEY`）。远程发现层本身已完成且经真实浏览器验证，但 FIND 的图像上传
路径依赖该 Provider，故公网发布仍需等待授权。

---

## 2. 三层发布内容区分

### A. R4.5 已发布基线（线上，不动）
- 公网版本 `r45-release`、回滚包 `r45-rollback-0.9.1`
- 本轮**未触碰**：未部署、未覆盖、未回滚

### B. 本地已完成 —— 电影与远程检索（本轮候选内容）
| 模块 | 职责 | 本轮改动 |
|---|---|---|
| `src/services/source/remoteDiscovery.js` | 远程发现层 | 修 CORS、`origin=*`、`thumburl` 字段名、复数漏匹配、超时参数、`unsupported` 语义 |
| `src/services/retrieval/remoteReferences.js` | 远程→FIND 接线 | 相关性过滤、`unrelatedCount` 透传 |
| `src/pages/find.js` | FIND 页面 | 异步生命周期三重守卫、`clearRemote`、远程区段四态 |
| `src/styles/v5.css` | 样式 | 远程区段、390px 适配 |
| `qa/find/*.mjs` | 验收 | 3 个脚本（wiring / live / final-gate） |

### C. 仍未完成 —— 真实付费 Vision 后端
- `VISION_API_BASE` / `VISION_API_KEY` / `VISION_MODEL` / `VISION_ACCESS_CODE` / `VISION_ACCESS_SECRET` **全部 NOT_SET**
- FIND 图像上传模式、SHOOT 识图在无 Provider 时 fail-closed（**这是正确行为**，不是缺陷）
- 未发起任何真实付费调用

---

## 3. Git 仓库实况（重要风险）

```
仓库根：C:<local-path>   ← 注意：不是 visual-ancestry/
已跟踪文件数：0
```

**`visual-ancestry/` 整个目录尚未纳入版本控制。** 这是本次发现的最大发布风险：
本地 266 个源文件没有任何提交历史可回溯，也没有远端备份。

本轮已修正 `.gitignore`，补入此前缺失的关键排除项：
- `work/`（**872M 历史归档，原先未排除** —— 若直接 `git add .` 会把回滚包与验收证据一起提交）
- `qa/**/*.png`、`*.json`、`*.log`（验收证据非源码）
- `.env.*`（防止密钥意外入库）

---

## 4. 可复现构建

```bash
cd visual-ancestry
node scripts/build.mjs
```

实测：`rm -rf dist && node scripts/build.mjs` → 246 文件 / 42M，
`Leak scan clean: 84 file(s), 0 forbidden tokens`。
构建为纯本地静态产物，无外部依赖解析，可重复执行。

---

## 5. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 项目未纳入 Git，无版本历史 | **高** | 见回滚步骤 0 |
| Wikimedia 渠道跨境不稳定（实测 53s 超时） | 中 | 超时已压至 12s×1 次；失败有明确降级，本地检索不受影响 |
| 远程渠道返回内容随馆方数据变化 | 低 | 不缓存到发布物；`showable` 闸门 + 相关性过滤兜底 |
| 真实 Vision Provider 未验收 | 中 | 无密钥时 fail-closed，不会假装成功 |

### 回滚步骤
0. **先建立基线**：`git init && git add -A && git commit -m "baseline"`（当前 0 跟踪文件，这是第一步）
1. 本地回滚：`git checkout -- src/`（若已提交）或从 `work/` 下的历史快照恢复
2. 远程发现回滚：删除 `src/services/retrieval/remoteReferences.js`，还原 `src/pages/find.js` 与 `remoteDiscovery.js` —— FIND 自动回到纯本地检索，无数据残留
3. 公网回滚：R4.5 基线未动，无需操作；若已部署则回退至 `r45-rollback-0.9.1`

---

## 6. Architecture Learning Layer

### 模块职责与设计理由

```
用户查询
   │
   ├─► retrieveByText() ──────────► 本地 VisualIntent 评分器
   │      （同步，评分器未被改动）        本地池 46 绘画 + 3 电影帧
   │
   └─► findRemoteReferences() ───► 远程发现（异步，旁路）
          │                             博物馆渠道 + Commons
          │                             ↓ 不进入评分器
          └─► #find-remote 独立区段渲染
```

**为什么远程不进评分器**：`retrieveByIntent` 是同步的，远程是异步的；更重要的是，
远程件的 `analysisLevel=0`、无 VisualIntent。把它塞进评分器会让「远程件也能被本地
intent 排序」变成假象——那是把馆方文本分类伪装成视觉分析。

**为什么分两个区段展示**：依据类型不同。本地件贴「依据 VisualIntent 评分」，
远程件贴「依据馆方分类字段」。混在一张列表贴同一种标签，等于宣称模型看过远程图。

### 来源标注（provenance）体系
| 值 | 含义 | 产出方 |
|---|---|---|
| `text-parse` | 文字查询被规则解析 | 本地 |
| `rule-derivation` | 从策展文本推导 | 本地 |
| `calibration-cache` | 冻结的 P2.8 真实 Vision 结果 | 本地 |
| `live-vision` | 本次真实 Provider 调用 | 本地 |
| `channel-metadata` | 馆方元数据（归一化后） | 远程 |
| `channel-metadata-text` | 馆方字段的文本匹配 | 远程 |

远程件的 `note` 恒为「依据馆方主体字段的文本匹配，非模型视觉分析」。

### 相关性判定的字段分界（本轮核心设计）
- **主体字段**（`title` / `classification` / `subjects` / `department`）—— 描述「画什么」，**可产生相关性分**
- **归属字段**（`culture` / `medium` / 年代）—— 描述「是谁的、用什么做的」，**只作事实展示，计分恒为 0」

这条分界修掉了真实缺陷：查询「量子纠缠与孤独」曾因 `culture=Chinese` 而推荐
《Bathing of the Buddha Festival》。

### 异步生命周期三重守卫
远程响应要同时通过才算有效：
1. **查询令牌**有效（本实例内无更新检索）
2. **仍在文字模式**（切到图片/作品模式后远程区段不再更新）
3. **页面实例号**一致（未重新进入 FIND）

**为什么不只用 `app.isConnected`**：router 每次进 `#find` 都重建 DOM，旧 app 节点
是被 `innerHTML` 覆盖而非移除，`isConnected` 可能仍为 `true`，旧响应就会写进新页面。
实例号是单调自增的，不可复用，从根本上区分两次挂载。

**为什么 `clearRemote` 不做模式守卫**：切换模式时 `activeMode` 已被改为 `image`，
若复用带守卫的 `paintRemote` 做清空，这次清空会被自己挡掉，上一个查询的「正在检索」
就留在图片模式页面上。这是本轮实测到的失败原因。

### 缓存设计
- `remoteDiscovery.js` 的 `CHANNEL_CACHE`：按 `渠道:分类:查询:limit` 键缓存，**仅进程内存**
- 不写入发布物、不落盘 —— 远程内容随馆方数据变化，持久化会造成「截图与线上不符」
- `clearDiscoveryCache()` 供测试重置
- 超时 12s×1 次：实测跨境 53s 才失败，压短上限让用户尽快看到降级说明

---

## 7. 邮箱投递

`EMAIL_DELIVERY_BLOCKED` —— Agent 邮箱仍未开通（`GetMe` 持续返回 `not_bound`），
本报告**未能**发送至 xiebenzhen@gmail.com。
