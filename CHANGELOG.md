# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## Unreleased

### 特性

- `feat(audit-npm)` — npm 包独立审计引擎（7 维）：registry + 周/月下载 + GitHub README 兜底 + 文档/安全/AI 可读性
- `feat(audit-page)` — 网页独立审计引擎（9 维）：含 ④AI 识别（llms.txt / og:type / schema.org）/ ⑤爬虫根目录（robots / sitemap / .well-known / favicon）/ ⑧WebMCP 友好性（mcp.json / ai-plugin.json / openapi.json）
- `feat(compare)` — 报告对比：任意 type 两个目标的维度差分 + 独有 gap 清单，CLI 加 `--compare-a/--compare-b`，新增 `/api/scorecard/compare` 与 `compare.md`
- `feat(db)` — audits 表加 `targetType` 与 `meta` 列，按入口类型分流；`getOrAudit` 抽出来给单目标 + compare 共享
- `feat(front)` — 顶部 tab 切换「单目标质检 / 对比」；对比模式左右两输入 + 侧栏 A/B 进度条 + Δ 列

### 修复

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