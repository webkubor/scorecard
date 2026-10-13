# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## Unreleased

### 特性

- `feat(audit-geo)` — **GEO 引擎（4 维）**：测品牌在 AI 答案里的可见度。四个 provider（openai / anthropic / gemini / perplexity）共用一套 `ASK_TEMPLATE`，问的是**品类问题**（「XX 类产品有哪些」），不是「请评价这个品牌」——后者模型会顺着你的问题去提它，数字好看但一文不值
  - 四维只看两种硬证据：品牌名出现在正文里、域名出现在引用 URL 里。不让 LLM 自评「这个品牌有名吗」——那是最容易编的一类数字
  - 拿不到证据的维度标 `score: null` + 「无法核实」，不猜。尤其中竞品份额：没给 competitors 就算不出份额，此时分母只有自己，永远 100%
  - `offline` fixture 供无 key 环境看结构；报告首行强制写明「这份是假数据」，不与真实结果混用
  - 新增 `/api/geo/trend`（读历史，live / offline 两类分开，不进同一条曲线）与 `/api/geo/providers`（只暴露就绪与否，永不回显 key）
  - `GeoCard.vue` 独立视图 + `#/geo` 路由 + 落地页入口。**刻意不进排行榜与 trending** —— 那会把「谁在盯哪些竞品」公开出去
- `feat(audit-npm)` — npm 包独立审计引擎（7 维）：registry + 周/月下载 + GitHub README 兜底 + 文档/安全/AI 可读性
- `feat(audit-page)` — 网页独立审计引擎（9 维）：含 ④AI 识别（llms.txt / og:type / schema.org）/ ⑤爬虫根目录（robots / sitemap / .well-known / favicon）/ ⑧WebMCP 友好性（mcp.json / ai-plugin.json / openapi.json）
- `feat(compare)` — 报告对比：任意 type 两个目标的维度差分 + 独有 gap 清单，CLI 加 `--compare-a/--compare-b`，新增 `/api/scorecard/compare` 与 `compare.md`
- `feat(db)` — audits 表加 `targetType` 与 `meta` 列，按入口类型分流；`getOrAudit` 抽出来给单目标 + compare 共享
- `feat(front)` — 顶部 tab 切换「单目标质检 / 对比」；对比模式左右两输入 + 侧栏 A/B 进度条 + Δ 列

### 修复

- `fix(front)` — **带查询串的 hash 分享链接一律落回落地页**：`#/geo?brand=x` 按 `/` 切段时第一段拿到的是 `geo?brand=x` 而不是 `geo`。同样的 bug 也让 `#/compare?a=…&b=…` 的分享链接失效 —— 链接能生成、能贴、点开是空白。改为先摘查询串再切段
- `fix(front)` — GEO provider「自动」选项名不副实：留空会走后端默认的 anthropic，在没配 key 的机器上等于「必失败」。改为按就绪情况落地成具体 provider，一个都没就绪则落到 offline
- `fix(audit-geo)` — 没给 competitors 时份额维一边标「无法核实」一边照算（分母只有自己 → 恒 100%）。改为不打分
- `fix(front)` — GEO 各维度进度条统一按总分上色，竞品份额 3.3 显示成绿色。改为按各自分数上色
- `fix(audit-npm)` — registry 的 `readme` 字段对从 GitHub 发布的大包为空，加 GitHub raw fallback 才算"读到"
- `fix(infra)` — 缓存命中时 latestVersion / weeklyDownloads / ttfb / finalUrl 这些 type-specific 元数据丢失（meta 列修复）

## 历史（按时间倒序）

### 修复

- `78ad084` — fix(audit): robots.txt 判定误报 —— 忽略了 Allow，且分组回落逻辑错
- `f8a36fb` — fix(report): compact desktop score summary
- `71441e9` — fix(audit): exclude inapplicable dimensions by repository role
- `fef8aba` — fix(audit): score only engineering GitHub Actions runs
- `1342078` — fix(audit): ignore in-progress CI runs when scoring
- `92625b8` — fix(audit): recognize HTML README signals and DSH install
- `cc2b6ff` — fix(audit): 看不到的判据不再算项目的错，按可核实部分归一化

### 特性

- `14f8ac2` — feat: 加 `fresh=1` / `--fresh` 跳过缓存
- `9b66761` — feat: 补 CLI 入口 —— 让质检能出现在该出现的时刻
- `d6d1f61` — feat(robots): 站点 robots.txt 放行所有爬虫（含 AI 爬虫）
- `fc81dc5` — feat(audit): 新增第 9 维「AI 可读性」—— AI 爬虫 / 编码助手能否读懂项目
- `d140e2a` — feat(refresh-guard): 接入 vite-plugin-refresh-guard —— 新版本 toast 自动刷新 + `vite:preloadError` 白屏兜底
- `723679a` — feat(report): show audit findings before AI export

### 文档

- `c73ecf2` — docs: README 顶部补全徽章（license / stars / online-status / issues）
- `1856b32` — style: 摘要区与操作条改用 SVG 图标，去掉与图标重复的 emoji
- `6284aea` — feat: 参照榜 + 八维说明，并校准两处系统性失分

### 重构

- `1c4bdd3` — feat: Scorecard 从 `github-accounts-manager` 拆出，独立成仓

---

完整 commit 列表见 `git log`。版本号随仓库 git tag 走。