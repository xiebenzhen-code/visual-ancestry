# Visual Ancestry · 视觉参考工具

> 用电影的眼睛找画，用画的结构写镜头。
> A visual research desk that searches public-domain paintings and film stills,
> reads verifiable analysis of them, and turns a selection into a creation brief.

[English](./README.en.md) · [架构与数据流](./docs/ARCHITECTURE.md) · [Agent Skill](./skill/visual-ancestry/SKILL.md)

---

## 它是什么

一个零前端框架的 Web 应用 + 一个 Node Agent Skill，共用同一份检索与分析代码。

- **FIND** —— 在 51 件公共领域绘画与电影画面档案里检索；可选叠加 Wikimedia Commons 的实时检索。
- **CREATE** —— 选 2–4 件参考，生成 Prompt，并导出 Markdown。
- **SHOOT** —— 把选中的视觉原则翻成可执行的拍摄指导。
- **MEMORY** —— 视觉记忆与审美记忆，可导出成可移植档案。
- **Vision（可选）** —— 上传图片做视觉分析。**未配置 Provider 时明确不可用，不会伪装成功。**

## 运行要求

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 20**（用到内置 `fetch`、`node:crypto`） |
| 运行时依赖 | **无**。只用 Node 内置模块，不需要 `npm install` |
| 可选依赖 | `sharp` —— 仅 `npm run build` 需要 |

## 启动（Windows PowerShell）

```powershell
# 1. 进目录
cd <解压后的目录>

# 2. 启动（直接跑源码树，不需要先构建）
$env:PORT = 5173
npm start
```

或者不经过 npm：

```powershell
node scripts/server.mjs . 5173
```

然后打开 <http://127.0.0.1:5173>。

> 服务端的默认静态根是 `dist/`（构建产物）。`node scripts/server.mjs .` 是**显式选择**
> 直接服务源码树 —— 这是有意的：项目目录里有 `.env`，默认指向错误目录正是历史上
> `GET /.env` 泄漏的原因。白名单守卫两种方式都拦得住。

## 配置 Vision（可选）

不配置也能完整使用检索、分析、CREATE、SHOOT、MEMORY。只有「上传图片 / 以图搜图」不可用。

```powershell
Copy-Item .env.example .env
# 编辑 .env 填入 VISION_API_BASE / VISION_API_KEY（仅服务端生效）
$env:VISION_API_BASE = "https://.../v1/chat/completions"
$env:VISION_API_KEY = "..."
node scripts/server.mjs . 5173
```

安全默认：Provider 已配置但**没配预算账本时，服务端拒绝调用**（fail-closed），
不会因为「忘记设预算」而放开付费 Key。完整变量说明见 [`.env.example`](./.env.example)。

## Agent Skill

```bash
node skill/visual-ancestry/scripts/va.mjs search "孤独 夜晚" --limit 5
node skill/visual-ancestry/scripts/va.mjs intent bahram-gur-karg
node skill/visual-ancestry/scripts/va.mjs plan --refs bahram-gur-karg,the-kiss --out plan.md
node skill/visual-ancestry/scripts/va.mjs vision-status
```

Skill **直接 import 网页用的那份检索与分析模块**，不另写一套电影搜索算法。
没有 Vision Provider 时它会明确报告不可用，不会把本地检索结果包装成「识图结果」。
详见 [`skill/visual-ancestry/SKILL.md`](./skill/visual-ancestry/SKILL.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 入口；默认皮肤是「画册」A 方案 |
| `src/pages/` | 路由级页面：`find` / `create` / `shoot` / `memory` |
| `src/services/retrieval/` | 检索与打分（Skill 与网页共用） |
| `src/services/source/` | 外部来源：Commons 检索、电影概念拆分、许可判定 |
| `src/services/vision/` | 视觉分析契约与归一化 |
| `src/data/` | 档案数据（作品、电影画面、VisualIntent 记录） |
| `server/security/` | 访问控制、预算账本、静态路径守卫 |
| `scripts/server.mjs` | 静态服务 + Vision API |
| `public/assets/` | 本地图片素材（thumb / preview / detail 三档） |
| `qa/` | 可运行的验收脚本（不含浏览器 profile 与截图证据） |
| `docs/` | 架构说明与阶段报告 |

## 能力边界（诚实清单）

**已实现并真实验证**

- 51 件本地档案检索（绘画 + 电影画面），带评分与命中理由
- Wikimedia Commons 实时电影画面检索，含概念拆分与权利判定
- 46 条 VisualIntent 分析记录，读取时携带 provenance 与来源链接
- CREATE 选参 → 生成 Prompt → 复制 / 导出 Markdown
- TaskContext 参考在页间正确传递
- 记忆的导出与再导入

**未完成 / 不可用**

- **Vision 上传识图**：Provider 未配置，界面如实显示 `not-configured`
- **电影截图数量**：只有档案里已收录的部分，未做扩充
- **Animation**：检索管线已支持 `animation` 媒介，但本地档案里没有动画作品，
  选它会如实显示空状态，不会退化成「全部」
- 无用户系统、无云端持久化、无移动端原生壳

## 素材许可

代码 MIT。图片素材许可**逐件不同**，见 [`LICENSE`](./LICENSE) 与
`src/data/artworks/*`、`src/data/filmStills*.js`：

- 46 件绘画为公共领域作品，来源为各馆藏与 Wikimedia Commons
- 5 件仍受版权保护的现代作品**未附带图片**，只保留著录
- 电影画面来自 Wikimedia Commons，按各条目自身标注

## 最小真实验收

```powershell
npm start
# 浏览器打开 http://127.0.0.1:5173
#   1. 首页搜索「孤独 夜晚」→ 应出现命中作品与理由
#   2. 点开任一作品 → 侧栏出现「使用参考」
#   3. 进入 CREATE（#create）→ 该参考应排在参考区最前并处于选中态
#   4. 选到 2 幅 → 生成 Prompt → 导出 Markdown
# 5. Skill（另开一个终端）
node skill/visual-ancestry/scripts/va.mjs search "孤独 夜晚" --limit 3
node skill/visual-ancestry/scripts/va.mjs plan --refs bahram-gur-karg --out plan.md
```

验收脚本（需要本机 Edge）：`node qa/ui/ui-final-acceptance.mjs`、`node qa/find/edge-cdp-e2e.mjs`、`node qa/ui/round3-check.mjs`。

## 数据与隐私

- 视觉记忆保存在浏览器 localStorage，可一键导出/清空。
- 所有 Vision 凭据只存在于服务端进程环境变量；构建产物不包含任何 `VISION_*` 值。
