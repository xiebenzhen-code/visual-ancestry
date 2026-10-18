# Visual Ancestry · 视觉参考与创作工具

> 用电影的眼睛找画，用画的结构写镜头。

Visual Ancestry 连接艺术档案与开放馆藏，帮助创作者通过视觉描述寻找绘画和电影参考，并把选中的画面转化为创作提示与拍摄方案。

**寻找参考 → 理解视觉关系 → 生成创作提示 → 保存灵感**

[English](./README.en.md) · [架构与数据流](./docs/ARCHITECTURE.md) · [验收报告](./docs/ACCEPTANCE-REPORT.md) · [演示脚本](./docs/DEMO-SCRIPT.md) · [Agent Skill](./skill/visual-ancestry/SKILL.md)

![首页「画册」界面：1440×900 首屏 15 件作品，图像占首屏 73%](./docs/media/album-1-home.png)

<p align="center">
  <img src="./docs/media/album-2-search-results.png" width="49%" alt="搜索结果：命中带评分与理由">
  <img src="./docs/media/album-4-create-picks.png" width="49%" alt="CREATE 参考选择：TaskContext 参考排在最前并处于选中态">
</p>

<p align="center">
  <img src="./docs/media/album-1-home-mobile.png" width="32%" alt="390px 手机双列">
</p>

---

## 它能帮你做什么

- **FIND · 找参考** —— 用一句描述说出你要的画面（「夜晚 冷色」「雾 空旷」「一个人站在很大的空间里」），
  或直接输入片名，命中会给出评分与理由，并标明来源与许可。
- **CREATE · 写提示** —— 选 2–4 件参考，生成结构化 Prompt，导出 Markdown / JSON；只写真实存在的字段，不补编。
- **SHOOT · 定镜头** —— 把参考里的视觉原则（构图、光线、色彩、空间）翻成可执行的拍摄指导。
- **MEMORY · 存灵感** —— 把看中的画面存进个人视觉档案，可导出、可迁移、可清空，数据留在你自己的浏览器里。

## 参考从哪里来

- **本地档案** —— 公共领域绘画与电影影像，逐件记录来源机构、Commons 文件页与许可。
- **开放馆藏** —— Art Institute of Chicago、The Met、Cleveland Museum of Art、Rijksmuseum 的公开接口（免密钥）。
- **Wikimedia Commons** —— 电影画面检索；命中会做身份核验与许可判定，核不出来的导演与身份如实留空。

结果里会区分**视觉相关命中**与**文本元数据命中**：标题里恰好出现某个词，不会被说成「画面就是你要的」。

已知限制：Met 馆藏接口首次连接可能约 10 秒超时（适配器无自动重试），该渠道失败时会明确说明，不影响其他来源。

### 当前不提供的能力

- **Vision 上传识图尚未接通** —— 未配置识图模型，上传图片 / 以图搜图**实际不可用**（服务端返回 503，界面如实提示，不伪装成功）。
- **动画参考检索尚未完成** —— 档案里没有动画素材，选择动画媒介只会得到如实的空状态。

### 当前发布形态

这是 **GitHub 源码发布**：仓库内**没有独立的线上应用入口**，需要按下方说明在本地运行。

---

## 运行要求

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 20**（用到内置 `fetch`、`node:crypto`） |
| 运行时依赖 | **无**。只用 Node 内置模块，不需要 `npm install` |
| 可选依赖 | `sharp` —— 仅 `npm run build` 需要 |

## 技术说明

以下内容面向想读代码或改造它的人。

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

## 状态一览（技术视角）

**已实现并真实验证**

- 本地档案检索（绘画 51 + 电影影像 15），带评分与命中理由；中英文视觉描述都会先解析成
  结构化 VisualIntent 再打分
- 开放馆藏检索：AIC / Met / Cleveland / Rijksmuseum 免密钥接口（Met 走 v1.1 搜索，旧 v1 已退役）
- Wikimedia Commons 电影画面检索，含多概念拆分、身份核验与许可判定
- 45 条 VisualIntent 分析记录，读取时携带 provenance 与来源链接
- CREATE 选参 → 生成 Prompt → 复制 / 导出 Markdown / JSON
- TaskContext 参考在页间正确传递；SHOOT 拍摄指导；记忆的导出与再导入
- 静态路径守卫、预算 fail-closed

不提供的能力见上文「当前不提供的能力」。此外：**无用户系统、无云端持久化、无移动端原生壳**；
记忆数据只保存在使用者自己的浏览器中。

**Agent Skill 的能力边界**

- 本地能力（不依赖外部服务）：`search`（本地档案检索）、`intent`（读取 45 条 VisualIntent 记录）、`plan`（生成并导出创作方案）
- 依赖外部服务：`vision-status` 需要服务端 `/api/vision`（未配置时如实报告不可用）；带 `--external` 的检索需要访问 Wikimedia Commons（约 9–20s）

## 素材许可

代码 MIT。图片素材许可**逐件不同**；逐件许可、来源文件页与核验方法见
[`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md)：

- 46 件附带图像的绘画：**44 件 Public domain + 2 件 CC0**（公有领域奉献），
  全部经 Wikimedia Commons 文件页实时核验（核验日期 2026-10-18）
- 15 件电影影像：均为 Public domain（Commons 文件页核验）；其中 5 件为宣传类影像，
  10 件为影片帧 / 截图 / 剧照，性质已逐件标注
- 另有 5 件绘画未附带图像（仅保留著录），不涉及再分发
- 许可核验脚本与证据 JSON 随仓库分发（`qa/licence-audit/`），全新克隆后可复现

### 商业使用

| 内容 | 许可 | 可否商用 |
|---|---|---|
| 源代码 | MIT | **可以**（须保留版权与许可声明） |
| 仓库内置图像（183 个 webp） | Public domain / CC0 | **可以**，不设版权限制 |
| 在线检索结果（运行时取回的馆藏记录与图像） | **不适用本仓库许可**，由来源机构按各自条款提供 | 取决于来源条款；本仓库不转存、不镜像 |
| 产品生成的 Prompt / 拍摄方案 | 随 MIT | **可以**，但属参考建议，不构成法律意见 |

完整说明见 [`LICENSE-ASSETS.md` §6](./LICENSE-ASSETS.md)。一句话提醒：**MIT 不覆盖作品著作权**——
代码可商用，不代表馆藏藏品可以随意商用。

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

许可核验复现（免密钥，只读 Commons 公共 API）：

```bash
node qa/licence-audit/rc1-artwork-licence-audit.mjs   # 逐件核验 46 件画作
node qa/licence-audit/rc1-film-licence-audit.mjs      # 逐件核验 15 件电影影像
```

## 数据与隐私

- 视觉记忆保存在浏览器 localStorage，可一键导出/清空。
- 所有 Vision 凭据只存在于服务端进程环境变量；构建产物不包含任何 `VISION_*` 值。
