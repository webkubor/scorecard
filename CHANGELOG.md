# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 2.3.0 — 2026-10-26

### 修复

- `fix(og)` — **分享卡的雷达是编造的形状，改成真数据**。原 `radarPolygon(score)` 只吃
  总分，用 `sin()` 造了一圈抖动的点，还画 8 轴（报告实际 9 维）。分享卡是本项目
  对外传播的主载体，而卖点恰恰是「证据制、不猜分」—— 分享一张编出来的雷达，等于在
  最重要的环节放弃立身之本。现在从 `audits.dims` 取**真实**维度分：9 轴真形状、
  每维标签带分数、只画有分的维度（判不了的不画，填 0 会被读成「这维很差」），
  并加一行核实口径「已核实 N/M 维 · 最弱：X n」
- `fix(og)` — **线上分享卡吐的是 SVG，多数平台渲染出来是空白图**。服务器没装
  SVG 转码器，一直走 SVG 兜底。已装 `librsvg2-bin`，现在稳定返回 PNG
  （1200×630，114 KB，实测 0.07 秒出图）
- `fix(build)` — **线上前端停在两周前的版本**。根因是构建在服务器上一直失败：
  `@vue/compiler-core@3.5.44` 要 `entities@^7`，但依赖提升可能把 v8 放到顶层
  （v8 删了 `decode.fromCodePoint`）→ `decode.fromCodePoint is not a function`。
  本机 bun 1.4.0 会自动嵌套装 v7 所以没事，线上机 bun 1.3.14 不嵌套。已显式把
  `entities` 钉到 `^7.0.1`（任何 bun 版本都能构建），并把线上 bun 升到 1.4.4
- `fix(deploy)` — 补 `scripts/deploy.sh`：`dist/` 不进 git，`git pull` 不会更新线上
  前端（曾出现线上前端停在两周前、后端却已更新的静默不一致）。把 build 纳入部署流程
- `fix(og)` — `/10` 压住大分数（比例字体下字符数算不准宽度，改用 tspan 让渲染器排）；
  `⭐` 在服务器字体里没有字形（渲染成空白），换 `★`
- `fix(ui)` — stars 复数（`1 star`）；大分数不用等宽字体（等宽里小数点占满一格，
  「8.4」看着像「8 . 4」三个字符）

## 2.2.0 — 2026-10-26

### 新增

- `feat(profile)` — **GitHub 个人首页质检（第五路入口，7 维）**：把 `github.com/<user>`
  当一份简历测 —— ① 身份门面（name / bio / company / location / hireable）
  ② 首页自述（`<u>/<u>` 仓库的 profile README 在不在、结构撑不撑得起简历；
  组织账号走 `.github/profile/README.md`）③ **可视化**（stats 卡 / streak /
  技能图标 / trophy / 活跃曲线 / 贪吃蛇 / 访客计数，按 README 源码的服务特征判）
  ④ 活跃度（贡献图 / streak / 最近 push / 公共事件）⑤ 作品集（原创仓库 / 总 star /
  代表作 / fork 占比 / 语言广度）⑥ 影响力（followers / 被 fork / 跨仓库协作 PR）
  ⑦ 链接触达（blog 配置与可达 / README 外链 / email / twitter）。
  动机：GitHub 首页正在变成开发者的简历，而个人主页与仓库的判据完全不同 ——
  拿九维去评一个人会系统性失真，所以独立成路。数据面全公开可读：贡献图从
  `github.com/users/<u>/contributions` 抓取（个人主页 HTML 已改客户端渲染，
  登录态外没有日历），置顶仓库从主页 HTML 的 pinned 区块抓取，抓不到按
  unverifiable 剔除不扣分。入口：`?type=profile&user=<login>`（`@user` /
  `github.com/<user>` 都收，缓存 key 归一成裸 login）、CLI `scorecard @webkubor`、
  网页端输入 `@用户名`。compare 支持 profile vs profile。附 mock 网络层回归测试。

### 变更

- `chore(deps)` — **前端工具链整链升到当前最新**：vite 5.4 → **8.3**（依赖管线底层
  换代为 rolldown，esbuild 退出依赖树）、@vitejs/plugin-vue 5 → **6**、vue 3.4 →
  **3.5.44**、hono → 4.13.14。前置排查确认无阻碍：vite-plugin-refresh-guard peer
  范围 `vite >=4 <10`、plugin-vue 6 官方支持 vite 8。构建产物 gzip 52.16 → 50.87 KB，
  60 个测试全过，dev 代理链路（/api、SFC 编译）实测正常。

## 2.1.0 — 2026-10-26

### 变更

- `feat(api)` — `/api/*` 加 CORS 白名单（`SCORECARD_CORS_ORIGINS` 可配）：GHAM 项目详情页的「快速质检」直连本服务，白名单收紧到具体域名，非名单来源不回 Allow-Origin 头。附白名单/预检回归测试。

### 修复

- `fix(api)` — **引擎错误线上只见「error code: 502」，真实原因被 Cloudflare 吞掉**。
  引擎报错（仓库不存在 / npm 包不存在 / 网页打不开 / GitHub 限流 / 上游超时）时，
  API 一律回 502；而本服务部署在 Cloudflare 后面，代理会把 502 响应体整个换成自己的
  错误页，用户拿着「仓库读取失败 HTTP 404」这种可自救的信息，看到的却只有一句
  502。原代码里按文案前缀 `HTTP 4` 转 400 的判断永远匹配不上中文开头的错误串，
  等于所有错误全落 502。改为各引擎在错误现场带 `errorStatus`（404 = 目标不存在，
  429 = 被上游限流，400 = 请求问题，503 = 上游故障），API 原样采用，绝不出 502/504。
  顺带把引擎抛出的网络层异常在 `getOrAudit` 收住 —— 之前会穿到 Hono 默认 500，
  用户只能看到「HTTP 500」。附 mock 网络层的回归测试

## 2.0.0 — 2026-10-18

首个正式版本。此前 0 tag / 0 release —— 而本项目自己的「发布工程」维度明确判这一项，
所以这个 tag 同时是「用自己工具改自己」的产物。

### 2.0 新增（可用性闭环）

- `feat(landing)` — **场景化入口**：刚开源 / 要发版 / 交给 Agent 改 / 两个项目比。
  只改「先看哪几维」的排序，**不给场景加权、不给不同分数** —— 同一套判据、同一份报告，
  否则同一个仓库在两个场景下两个分数，那才是真的不可信
- `feat(report)` — **复检对照**：报告页显示「距上次 X月X日 +N」与逐维度 from → to。
  `audits` 表本来就每次 INSERT 留历史，缺的只是出口。没有这条，项目只是一次性玩具：
  改完回来看的是一个全新分数，跟上次毫无关系
- `feat(agent)` — **skill 一行可取**：`GET /skill.md`（纯 SKILL.md，带 frontmatter）与
  `GET /api/skill`（安装方式 + 端点清单）。第一用户是 coding agent，之前却只能
  git clone 整个仓库再翻目录。刻意不给「一键安装」：各家 agent 的 skills 目录与
  加载机制都不同，猜错落点比不装更糟
- `feat(api)` — `/api/scorecard/history`：同一项目的历次评估与维度变化。
  `score` 为 `null` 的维度不参与相减（「无法核实」不是 0 分），Δ 为 0 的不上列表

### 修复

- `fix(evidence)` — **九维明细「进得去出不来」**。`:open` 是 Vue 的 prop，父级每次
  re-render 都把判定值写回 DOM，用户手动收起的状态不在 vnode 里，于是被覆盖。
  改为：用户表过态的维度不再渲染 `open` 属性，展开态交还浏览器持有；
  「低分自动展开」这条产品决策完好保留。附 7 例回归测试，其中一条静态断言锁住旧写法
- `fix(og)` — **分享卡改吐 PNG**。原代码注释写着「Twitter/微博/即刻都认
  image/svg+xml，2024 起标准支持」—— 这条是错的。og:image 规范要求 raster image，
  主流平台抓取器不渲染 SVG，分享出去是空白图。改走 rsvg-convert，`?fmt=svg` 仍可取矢量
- `fix(dist)` — **包名让开被占的 `scorecard`**。npm 上 `scorecard` 是 2018 年的无关包
  （维护者 unmeshvinchurkar），`scorecard-cli` 属 OpenSSF 生态，`scorecard-ai` 属
  Stripe Scorecard API。照 README 敲 `npx scorecard` 会执行到别人的代码 ——
  分发链信任问题，不是文案问题。改为 `project-scorecard`（实测未注册）

### 引擎

- `fix(audit)` — npmmirror 镜像 fallback 校验，防止直连 npm 超时被误判成「未发布」
- `fix(audit)` — 代码托管平台 homepage 不再误当成独立官网去判 robots.txt；
  支持探测 `.github/ISSUE_TEMPLATE` 目录

### 文档与工程

- `docs(readme)` — 补权威性四章：**「无法核实」不等于「有问题」**（放到最显眼位，
  这是本项目唯一真正区别于其它打分工具的机制）、九维度的三条设计约束、
  **判据出处与公开标准的对照表**（OpenSSF / NIST SSDF / SemVer / Keep a Changelog /
  RFC 9309 / llms.txt，9 条引用 URL 实测 200，RFC 9309 §2.3.2 逐字核过原文）、
  **这个工具不做什么**（主动划界比多认领维度更能建立信任）
- `docs(llms.txt)` — 升 v2 结构；根目录与 `public/` 两份此前内容不同，已统一
- `chore` — 补 `scripts/check-axes.mjs`（四路引擎维度层纪律的静态守卫，
  拆掉 `check-dimensions.mjs` 里写死的「必须等于 9」）、`scripts/check-syntax.mjs`
  （零依赖语法 + 红线扫描，替代 linter —— 不为 2 分破掉「零重依赖」的卖点）、
  CI workflow、SECURITY.md、CONTRIBUTING.md、issue 模板、copilot-instructions.md
- 自测：用 scorecard 测 scorecard，**6.5 → 8.2**（社区卫生 10 / AI 可读性 10）

## Unreleased

### 特性

- `feat(audit-geo)` — **接本机 LLM 网关 `magpie`（第五路 provider）**。它同时带来一个只有本地才有的能力：真正的多模型可见性测量
  - `SCORECARD_GEO_MAGPIE_BASE` / `_KEY` / `_MODEL` / `_MAX_TOKENS`，跑本地实例才需要
  - **禁用 `claude/*` 池**：那一池走使用者自己 Claude Code 会话的额度，GEO 跑一次就烧一次写代码的额度（实测直接回 `rate_limit_error`）。`modelgo-gateway/claude-*` 不算 —— 它有独立 endpoint 和 ModelGo key，计费分开
  - **拒绝 `group/*` 动态路由组**：同一个 id 实测先落 `codex/gpt-6-astra`、三分钟后落 `claude/claude-opus-5-5`。趋势线会把两个不同模型的结果画成一条曲线，那条线量的不是同一个东西。group 能漂进禁用池，所以进黑名单而不只是拒绝
  - **引用分强弱两档**：真检索到的 URL 才算引用率，模型写在正文里的裸 URL 只单列提示、不进分数 —— 后者可能来自记忆也可能是编的，算进去等于给幻觉发奖章
  - 空 `content`、空正文、非 JSON 一律算这一路失败并踢出分母，不算「没提到品牌」
- `feat(geo)` — **品牌清单接 Social Hub**：`data/geo-brands.json` 收录 IP 矩阵的 5 个品牌与各自品类问题，`/api/geo/brands` 供前端与 CLI 取用。于是「测山鬼映画」从手抄问题清单变成一条命令 `scorecard geo --brand 山鬼映画`；`scorecard geo --list` 看全部
- `feat(audit-geo)` — **模型没检索时，引用率标「无法核实」而不是 0%**。实测 `modelgo-gateway/deepseek-v4-pro` 会回一段像模像样的正文、HTTP 200、从不用检索工具。那时报 0% 是把「它没搜」记成「没人引用你」—— 一个是量具没通电，一个是读数低。提及/份额/倾向不依赖检索，照常给分
- `feat(audit-npm)` — npm 包独立审计引擎（7 维）：registry + 周/月下载 + GitHub README 兜底 + 文档/安全/AI 可读性
- `feat(audit-page)` — 网页独立审计引擎（9 维）：含 ④AI 识别（llms.txt / og:type / schema.org）/ ⑤爬虫根目录（robots / sitemap / .well-known / favicon）/ ⑧WebMCP 友好性（mcp.json / ai-plugin.json / openapi.json）
- `feat(compare)` — 报告对比：任意 type 两个目标的维度差分 + 独有 gap 清单，CLI 加 `--compare-a/--compare-b`，新增 `/api/scorecard/compare` 与 `compare.md`
- `feat(db)` — audits 表加 `targetType` 与 `meta` 列，按入口类型分流；`getOrAudit` 抽出来给单目标 + compare 共享
- `feat(front)` — 顶部 tab 切换「单目标质检 / 对比」；对比模式左右两输入 + 侧栏 A/B 进度条 + Δ 列

### 修复

- `fix(audit-geo)` — **loopback 守卫方向写反了**。原来是「是回环且没二次确认才拒绝」，等于「只要不是回环就放行」：公网地址配个 key 就 `ready`，免登录的 `/api/scorecard?type=geo=` 会从生产发出计费请求。改为**白名单**——地址必须能从 URL 证明是回环，另加 `0.0.0.0` 出局（那是本机所有网卡，局域网够得着）。这是设计文档与 README 都声称已经做到、实际没做到的那条
- `fix(audit-geo)` — **默认模型 `modelgo-gateway/gpt-5.4` 实测不可用**：HTTP 200、`stop_reason=max_tokens`、`content` 是空数组，白烧 1500 个输出 token。每一道题都失败，每一道都计费 —— 看起来配好了，跑起来只是全灭。改钉 `modelgo-gateway/claude-haiku-5.5`（实测 4/4 会调用 `web_search`），`max_tokens` 提到 4000（2000 会把来源列表截断成零）
- `fix(audit-geo)` — **结构化 `citations[]` 被整个丢掉**。正文块自带的出处（Anthropic 服务端给每句话挂的）是强证据，实测默认那路每次返回 3~7 条；之前只认 `web_search_tool_result`，把这些丢了。丢真证据比拿不到证据更糟 —— 会让引用率系统性偏低，而偏低会被读成「AI 不引用你」
- `fix(audit-geo)` — **品牌名与域名按子串匹配，四种误判当场可复现**：`N1` 命中「N1和M1」、`muse` 命中「museum」、`ai.com` 命中 `not-ai.com`、`museav.com` 命中 `evil.com/?r=museav.com`。全部朝**高估**偏。改为按词边界判品牌名（`\b` 在中文里失效，用「非字母数字」定义）、按 hostname 比域名（子域名算命中）
- `fix(audit-geo)` — `group/*` 以前只在发起请求时拒绝，`/api/geo/providers` 照样报 `ready`。报 ready 再一跑就炸比直接说不可用更差
- `fix(audit-geo)` — 空 content 但已计费 token 时，错误消息要带上烧掉多少 token，并指出该换模型。原先只说「空 content」，看不出这是适配器配错了而不是这道题难
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