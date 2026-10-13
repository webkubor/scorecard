# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## Unreleased

### 特性

- `feat(audit-geo)` — **接本机 LLM 网关 `magpie`（第五路 provider）**。它同时带来一个只有本地才有的能力：真正的多模型可见性测量
  - `SCORECARD_GEO_MAGPIE_BASE` / `_KEY` / `_MODEL`，跑本地实例才需要
  - **禁用 `claude/*` 池**：那一池走使用者自己 Claude Code 会话的额度，GEO 跑一次就烧一次写代码的额度（实测直接回 `rate_limit_error`）
  - **拒绝 `group/*` 动态路由组**：同一个 id 实测先落 `codex/gpt-6-astra`、三分钟后落 `claude/claude-opus-5-5`。趋势线会把两个不同模型的结果画成一条曲线，那条线量的不是同一个东西
  - **引用分强弱两档**：`web_search_tool_result` 里真检索到的 URL 才算引用率，模型写在正文里的裸 URL 只单列提示、不进分数 —— 后者可能来自记忆也可能是编的，算进去等于给幻觉发奖章
  - 空 `content`、空正文、非 JSON 一律算这一路失败并踢出分母，不算「没提到品牌」
- `feat(geo)` — **品牌清单接 Social Hub**：`data/geo-brands.json` 收录 IP 矩阵的 5 个品牌与各自品类问题，`/api/geo/brands` 供前端与 CLI 取用。于是「测山鬼映画」从手抄问题清单变成一条命令 `scorecard geo --brand 山鬼映画`；`scorecard geo --list` 看全部
- `feat(audit-npm)` — npm 包独立审计引擎（7 维）：registry + 周/月下载 + GitHub README 兜底 + 文档/安全/AI 可读性
- `feat(audit-page)` — 网页独立审计引擎（9 维）：含 ④AI 识别（llms.txt / og:type / schema.org）/ ⑤爬虫根目录（robots / sitemap / .well-known / favicon）/ ⑧WebMCP 友好性（mcp.json / ai-plugin.json / openapi.json）
- `feat(compare)` — 报告对比：任意 type 两个目标的维度差分 + 独有 gap 清单，CLI 加 `--compare-a/--compare-b`，新增 `/api/scorecard/compare` 与 `compare.md`
- `feat(db)` — audits 表加 `targetType` 与 `meta` 列，按入口类型分流；`getOrAudit` 抽出来给单目标 + compare 共享
- `feat(front)` — 顶部 tab 切换「单目标质检 / 对比」；对比模式左右两输入 + 侧栏 A/B 进度条 + Δ 列

### 修复

- `fix(audit-geo)` — `/api/geo/providers` 回显的是代码里的默认模型，不是 `SCORECARD_GEO_MAGPIE_MODEL` 实际覆盖的值。配了覆盖却看到默认值，人会以为覆盖没生效
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