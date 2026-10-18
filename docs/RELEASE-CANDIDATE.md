# Release Candidate 1 — 候选清单

生成日期：2026-10-18（修订：发布前文档修正轮）
产品候选 commit：**`5642f379ef6dd18388482c45f4a843808fe0a357`**（分支 `master`，已经全量真实验证）
仓库位置：`visual-ancestry/release/visual-ancestry/`（**独立 Git 仓库**，不是外层仓库的分支）

> 外层 `referenced-chatgpt-conversation-…` 仓库只有 8 个已跟踪文件，
> `visual-ancestry/` 整体未被 Git 跟踪，`work/ui-home-find/` 更是被忽略。
> 因此「本地测试通过」并不代表 GitHub 上有这些东西 —— 本轮据此新建独立仓库。
>
> **本修订轮（D1–D5）只改文档、许可证据与 QA 脚本度量口径，不动任何产品运行时代码。**
> 修订 commit 在 `5642f37` 之上，完整 SHA 见审核报告末节。

---

## 1. 候选 commit 与历史

```
5642f37  Add release candidate manifest: commit, file scope, capability matrix
cd4f3fd  Add job-showcase material: real screenshots, generated architecture diagram, demo script, decisions, acceptance report
5e329ab  Separate 'request succeeded' from 'found hits' in the Skill
3151b17  Poll for the 390px precondition instead of probing once
e753114  Add qa/ui harnesses that the release README promises are runnable
d41a4c3  Add Agent Skill exposing search, VisualIntent read, and plan export
9ba7da5  Add release scaffolding: bilingual README, .env.example, LICENSE, .gitignore
1958657  Add runnable acceptance harnesses (no browser profiles, no evidence dumps)
59863d9  Add architecture and data-flow notes plus stage reports
8539567  Import product source: retrieval, CREATE, memory, vision contract, server
```

- 仓库身份为**仓库内局部设置**（`user.name = Visual Ancestry`），未改动全局 Git 配置。
- **未 push、未创建远端、未发布** —— 等你授权。

---

## 2. 文件变更范围（修订轮后）

| 分类 | 内容 | 规模 |
|---|---|---|
| 产品源码 `src/` | 105 个 JS 模块 | 860 KB |
| 服务端 `server/` + `scripts/` | 6 + 22 个模块 | 120 KB |
| 素材 `public/assets/` | 184 个文件（thumb/preview/detail 三档） | 42.6 MB |
| 文档 `docs/` | 121 份文档 + 架构图 + 4 张截图 | 2.1 MB |
| 验收 `qa/` | 103 个脚本 + `qa/licence-audit/` 4 个许可证据文件（**无** profile、**无** 截图证据） | 1.3 MB |
| Skill `skill/` | SKILL.md + 1 个 CLI | 12 KB |
| 根文件 | `index.html`、`package.json`、README 中英双语、`LICENSE-ASSETS.md`、`LICENSE`、`.env.example`、`.gitignore` | — |
| **合计** | **555 个文件** | **47.7 MB** |

**被刻意排除的内容**（各 1.8 GB 级）：

| 排除项 | 原因 |
|---|---|
| `qa/**/profile/`、`*-edge-profile/` | 浏览器 profile 含访问历史 |
| `qa/**/*-shots/`、`ui-shots/` | 验收证据，不进产品仓库 |
| `work/` | 一次性诊断与实验产物 |
| `node_modules/`、`dist/` | 可生成 |
| `.env`、日志、账本 | 不存在或不应存在（已扫描确认） |

---

## 3. 能力矩阵

| 能力 | 状态 | 依据 |
|---|---|---|
| 本地档案检索（绘画 51 + 电影影像 15） | **REAL-TESTED** | 命中带评分与理由 |
| 结构化意图解析（中文 → 视觉维度） | **REAL-TESTED** | `parseVisualIntent` |
| 外部来源检索（Wikimedia Commons） | **REAL-TESTED** | E2E 4a/4b/4c |
| 外部来源降级说明 | **REAL-TESTED** | E2E 8a/8b |
| **Met 博物馆 API（v1.1 搜索 + v1 详情）** | **REAL-TESTED** | 独立实测：v1.1 搜索 200（分页正确）、旧 v1 已于 2026-10-01 退役（410）、详情 200、图片真实解码；已知限制：首次连接偶发 ~10s 超时且无自动重试 |
| 外部来源缓存（浏览器内 24h） | **INTEGRATED**（仅网页；Node 下不生效，已在 SKILL.md 说明） |
| VisualIntent 分析读取（45 条，含 provenance） | **REAL-TESTED** | `va.mjs intent` |
| 跨页参考传递 TaskContext | **REAL-TESTED** | 参考位于位置 0、选中态正确 |
| Prompt 生成 | **REAL-TESTED** | 每件只贡献真实存在的字段 |
| Markdown 导出 | **REAL-TESTED** | 真实落盘并回读 |
| 记忆（导出 / 再导入） | **IMPLEMENTED** | 随仓库交付 |
| SHOOT 拍摄指导 | **IMPLEMENTED** | 随仓库交付 |
| **Agent Skill 本地能力**（search / intent / plan） | **REAL-TESTED** | 三条命令实测 ok；全程不依赖外部服务 |
| **Agent Skill 外部依赖**（vision-status / `--external`） | **INTEGRATED** | vision-status 需服务端 `/api/vision`；`--external` 需 Commons 网络（约 9–20s）；未配置时如实报告 |
| 静态路径守卫 | **REAL-TESTED** | `.env` / 路径穿越均拒绝 |
| 预算 fail-closed | **IMPLEMENTED** | 逻辑在 `server/security/budget.mjs` |
| **Vision P3.1 Mock 安全门禁** | **REAL-TESTED** | 45 条意图缓存 + 未配置时 503 诚实降级 + 构建产物 0 个 `VISION_*` 值 |
| **Vision 真实 Provider 识图** | **BLOCKED** | 未配置真实识图模型；上传/以图搜图实际不可用（503），不伪装成功；本轮禁止付费调用 |
| **动画本地素材 / 动画视觉检索** | **BLOCKED** | 仓库内 0 件动画素材；动画视觉检索不可用，选择 animation 媒介仅得如实空状态，**不宣称支持动画检索** |
| 素材再分发许可 | **EVIDENCED** | 46 画作（44 PD + 2 CC0）+ 15 电影影像全部经 Commons 文件页实时核验；逐件声明见 `LICENSE-ASSETS.md`，脚本与证据随仓库分发（`qa/licence-audit/`） |

> 状态定义：`IMPLEMENTED` 已实现未实测 ｜ `INTEGRATED` 已接入但依赖外部条件 ｜
> `REAL-TESTED` 真实环境验证通过 ｜ `BLOCKED` 明确不可用 ｜ `EVIDENCED` 有逐件证据。
> **没有 Mock PASS。**

---

## 4. 候选与开发树的差异（已核对）

| 项 | 结果 |
|---|---|
| `src` 文件数 | 105 vs 105，**无缺失** |
| `src` 内容差异 | 15 个文件仅换行符不同（CRLF vs LF），语义等价 |
| `index.html` | 完全一致 |
| `server` / `scripts` / `public` | 无实质差异 |
| 差异文件 | 4 个零字节 `.gitkeep`（占位文件，可忽略） |

修订轮相对 `5642f37` 的差异：**仅** `LICENSE-ASSETS.md`（新增）、`README.md` / `README.en.md` / `docs/RELEASE-CANDIDATE.md`（文档修正）、`qa/licence-audit/`（4 个许可证据文件，新增）、`qa/ui/ui-final-acceptance.mjs`（图片懒加载度量口径修正，断言未删）。**产品检索、Vision、CREATE、SHOOT、MEMORY 等运行时代码零改动。**

---

## 5. 本轮不动的边界

- R4.6 冻结树 `work/p6.4-release`：**0 文件改动**
- R4.5 公网部署：未触碰
- Vision Provider 配置：未修改，`VISION_*` 环境变量 **0 个**
- 预算账本：未重置，仍为 2 行
- 云资源：未新增
- **未 push、未公开仓库、未创建 Release**
