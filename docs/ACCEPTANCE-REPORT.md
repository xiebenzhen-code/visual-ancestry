# 验收报告 · Release Candidate 1

> 历史报告范围保持不变。2026-10-19 feature 分支的单张 REAL-PROVIDER 存档、MOCK 回放、两项缺陷复验及未通过的像素判别实验，另见 [P4.10 复验报告](P4.10-FIX-REVALIDATION.md)。本文件中的 BLOCKED 描述对应当时 RC1 环境，不是后来单张实测的否定，也不能据后来的回放扩大此处验收结论。

日期：2026-10-18
候选 commit：`5e329ab`（分支 `master`，仓库根即候选源码）
运行环境：Windows / Node v24.21.0 / Edge（CDP 无头）

> **可复现前提**：所有数字都在 `git clone` 出来的新目录里取得，
> 不复用开发副本的 `node_modules`、浏览器 profile 或已在运行的服务。
> 这是本轮最重要的一条纪律 —— 本地跑通不等于交付物跑得通。

---

## 1. 结果总览

| 项目 | 状态 | 证据 |
|---|---|---|
| 定向验收（本轮） | **REAL-TESTED · 37/37 PASS** | `qa/ui/ui-final-acceptance.mjs` |
| Edge E2E（含外部来源真实访问） | **REAL-TESTED · 23/23 PASS** | `qa/find/edge-cdp-e2e.mjs` |
| Round 3 回归 | **REAL-TESTED · 88/88 PASS** | `qa/ui/round3-check.mjs` |
| Agent Skill 真实调用 | **REAL-TESTED**（另一 Agent 会话实际执行 7 条命令） | 见 §5 |
| 干净克隆启动 | **REAL-TESTED** `/healthz 200`，无 `node_modules`、无 `dist`、无 `.env` | 见 §2 |
| 本地检索 | **REAL-TESTED** 51 件档案，命中带评分与理由 | 见 §3 |
| 外部来源（Commons） | **REAL-TESTED** 电影画面 4a/4b/4c PASS | 见 §3 |
| 真实图片解码 | **REAL-TESTED** 桌面 20/20、390px 20/20、占位 0 | 见 §3 |
| TaskContext 跨页传递 | **REAL-TESTED** 参考位于参考区位置 0、`aria-pressed=true` | 见 §3 |
| 导出文件内容 | **REAL-TESTED** 真实 Markdown 落盘并回读 | 见 §4 |
| 无 Provider 降级 | **REAL-TESTED** `provider=not-configured`，未伪装成功 | 见 §3 |
| 静态路径守卫 | **REAL-TESTED** `/.env`、`/.env.example`、路径穿越均拒绝 | 见 §2 |
| 真实视觉识图（Vision 上传） | **BLOCKED** Provider 未配置；本轮禁止付费调用 | — |
| 动画本地素材 | **BLOCKED** 检索管线支持，档案无动画作品，如实显示空状态 | — |

> 没有一项是 Mock PASS。凡是 Mock 覆盖的地方都标成 BLOCKED。

---

## 2. 干净环境验证

```
git clone <repo> C:\...\va-fresh-accept      # HEAD = 3151b17（当时的最新）
```

| 检查 | 结果 |
|---|---|
| 文件数 | 511 |
| `node_modules` | 不存在（运行时零依赖） |
| `dist` | 不存在（直接服务源码树） |
| `.env` | 不存在 |
| `GET /healthz` | 200 `{"ok":true,"service":"visual-ancestry-bridge",...}` |
| `GET /.env` | 404 拒绝 |
| `GET /.env.example` | 404 拒绝 |
| `GET /../../../../Windows/win.ini` | 404 拒绝 |
| 私人路径残留 | 0（两遍扫描，大小写不敏感） |
| 密钥形态残留 | 0 |
| 浏览器 profile / 截图证据 | 0 个目录 |

---

## 3. 功能验收明细

### 3.1 首页密度与图像加载（1440×900）

| 指标 | 值 |
|---|---|
| 默认皮肤 | `album`（A「画册」） |
| 列数 | 5 |
| 首屏可见作品 | 15（10 完整 + 5 局部） |
| 图像占首屏 | 73% |
| 解码 | 20/20 |
| 占位卡 | 0 |
| 重复作品 | 0 |
| 横向溢出 | 无 |

移动 390×844：双列、6 件可见、解码 20/20、占位 0、超宽 0px、搜索框 top=114px。

### 3.2 CREATE TaskContext

| 断言 | 结果 |
|---|---|
| CREATE 参考区存在 | PASS（12 件） |
| 《巴赫拉姆·古尔战角兽》出现在参考区 | PASS（位置 0） |
| 标记为已选中（`is-on` + `aria-pressed=true`） | PASS |
| TaskContext 参考排在参考区前部 | PASS |
| 参考区无重复 | PASS（0） |
| 未给无分析作品伪造分析标注 | PASS |
| 取消选择 / 重新选择 / 离开重进状态 | PASS |
| 无图作品显示「无图」而非占位图 | PASS（《夜游者》） |

> **一处需求无法按原样满足，如实记录**：要求「增加一件没有分析记录的陌生作品验证」。
> 实测本地 51 件档案里 46 件有图，**全部都有分析记录**，不存在这样的作品。
> 没有伪造一件，改用「无图作品」作等价案例验证显示路径。

### 3.3 外部来源真实访问

| 断言 | 结果 |
|---|---|
| Commons 电影候选出现 / 图片真实解码 / 导演未编造 | 4a/4b/4c PASS |
| 中文查询在电影渠道的诚实降级 | 5a/5b/5c PASS |
| 远程被阻断时本地结果仍正常且有明确说明 | 8a/8b PASS |

直连实测（同一时刻）：

| 端点 | 结果 |
|---|---|
| `collectionapi.metmuseum.org/.../v1/search` | **HTTP 410 —— 该端点已于 2026-10-01 下线** |
| `openaccess-api.clevelandart.org` | HTTP 200，3 条 |
| `api.artic.edu` | 当时不可达 |
| `data.rijksmuseum.nl` | 当时不可达 |
| `commons.wikimedia.org/w/api.php` | HTTP 200 |

> Met 的 410 是**上游退役**，不是本仓库的缺陷：同一时刻用同一套 harness 跑开发树，
> 只要外部端点可达就是 23/23。曾有一次全新克隆跑出 19/23，复跑即 23/23 ——
> 原因是那一刻 AIC 与 Rijks 都连不上。**外部来源的可用性不由本项目控制，
> 但产品对此的降级路径是被测到的（8a/8b）。**

---

## 4. 导出内容验证

Skill 实际写盘后回读（`plan --refs bahram-gur-karg,the-kiss`）：

```markdown
# CREATE Prompt 导出 · 2026-10-18T06:44:20.370Z
> visual-ancestry-create-prompt v1 · 导出时间 ...

## Prompt

Composition Prompt：diagonal confrontation, rider and beast as two opposing masses
Lighting Prompt：flat gold ground, no shadows
Camera Prompt：wide action shot, 35mm lens, lateral tracking
...
```

- 文件真实落盘（46 行），含作者、馆藏、来源链接、权利状态与证据等级。
- `missingAnalysis: []` —— 两件参考都有分析记录，无需附注。
- 意图里 3 个字段进 `skipped`，理由 `no-executable-template`（没有可执行模板，
  **不硬塞进 Prompt**）。

---

## 5. Agent Skill 真实调用

由另一 Agent 会话按 `SKILL.md` 实际执行 7 条命令（非模拟）：

| 命令 | 真实结果 |
|---|---|
| `search "孤独 夜晚" --limit 4` | 4 条命中：星月夜 / 雾海上的旅人 / 海边的僧侣 / 麦田群鸦，均带权利状态 |
| `search --external` | Commons 请求成功但 0 命中；如实报告 `empty:true` 与未映射词「孤独」 |
| `intent bahram-gur-karg` | `hasAnalysis:true`，provenance `calibration-cache`，缺失字段保持空而非 null |
| `intent starry` | 15 个字段为空字符串；**无一为 null**，符合「不补默认值」 |
| `plan --refs ... --out` | 文件真实写入并回读成功 |
| `vision-status` | `provider=not-configured`，`ok:false`，明确拒绝替代 |
| `intent does-not-exist-123` | 退出码 1，`{"ok":false,"code":"NOT_FOUND",...}`，无堆栈 |

### 该次实测发现并已修的三个问题

1. **外部 0 命中仍报 `ok:true`** —— 读起来像「拿到了外部参考」。已改为
   `ok:false, requested:true, empty:true` 并附说明命中了哪些概念词、哪些词未映射。
2. **导出里有空 bullet** —— `[]` 能通过 `!== ""` 判断，随后 `join()` 成空串，
   留下 `- emotion: `。已补空数组判断。
3. **`fromCache` 永远是 false** —— 缓存依赖 `window.localStorage`，Node 下不存在，
   故每次都是实时请求（实测 9–20 秒）。这是环境限制，已写进 `SKILL.md`，
   而不是假装有缓存。

---

## 6. 本轮被验收抓出来的真实缺陷

| # | 缺陷 | 怎么发现的 | 状态 |
|---|---|---|---|
| 1 | `qa/ui/` 整个目录没进候选仓库（README 承诺 harness 可运行） | **从干净克隆跑验收** | 已修（`e753114`） |
| 2 | 390px 前置检查只探一次，冷目录下误判为失败 | 全新克隆 32/33 | 已修（`3151b17`） |
| 3 | 外部 0 命中报 `ok:true` | Agent 实际执行 | 已修（`5e329ab`） |
| 4 | 导出空 bullet | Agent 实际执行 | 已修（`5e329ab`） |

> 第 1、2 条只有换目录才会暴露 —— 开发副本里文件一直都在、模块一直有缓存。

---

## 7. 复现步骤

```powershell
git clone <repo> va-rc
cd va-rc
node scripts/server.mjs . 5173          # 另开一个终端保持运行

# 必须串行，不要并发（并发时两个 Edge 实例共用 profile，探针返回 undefined）
node qa/find/edge-cdp-e2e.mjs           # → 23/23
node qa/ui/ui-final-acceptance.mjs http://127.0.0.1:5173 rc   # → 37/37
node qa/ui/round3-check.mjs http://127.0.0.1:5173 rc          # → 88/88

# Skill
node skill/visual-ancestry/scripts/va.mjs search "孤独 夜晚" --limit 3
node skill/visual-ancestry/scripts/va.mjs intent bahram-gur-karg
node skill/visual-ancestry/scripts/va.mjs plan --refs bahram-gur-karg,the-kiss --out plan.md
node skill/visual-ancestry/scripts/va.mjs vision-status
```

外部来源相关的断言依赖公网可达性。若 Met/AIC/Rijks 不可达，相关项会失败但
**降级路径仍会被验证**（8a/8b）——这是设计如此，不是掩盖。

---

## 8. 未做的事（明确边界）

- 未公开仓库、未 push、未创建 Release —— 等授权
- 未修改 R4.6 冻结树、R4.5 公网、Vision Provider 配置、预算账本
- 未调用任何付费 Vision 接口
- 未新增云资源
