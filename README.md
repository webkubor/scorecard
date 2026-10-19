# Scorecard

[![license](https://img.shields.io/github/license/webkubor/scorecard.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/webkubor/scorecard.svg)](https://github.com/webkubor/scorecard/stargazers)
[![online status](https://img.shields.io/website-up-down-green-red/https/scorecard.webkubor.online.svg)](https://scorecard.webkubor.online)
[![issues](https://img.shields.io/github/issues/webkubor/scorecard.svg)](https://github.com/webkubor/scorecard/issues)

> **做决定之前，先跑一次体检。**
>
> 粘一个 **GitHub 仓库 / npm 包名 / 网页 URL**，几秒钟拿到一份体检报告：
> 九维度雷达图、按「影响÷成本」排序的整改清单，一份可直接粘给 AI 的 Markdown 报告。
> 免登录，公开仓库无需 token。

**它和 [OpenSSF Scorecard](https://scorecard.dev/) 是什么关系？** 名字撞了，做的不是一件事。
OpenSSF 那个管**供应链安全** —— 依赖有没有钉版本、token 权限多大、发包有没有签名，
面向企业安全审计。本项目管**项目成熟度** —— 门面试不试人、文档齐不齐、
发布工程规不规范，面向「我这个仓拿出手吗、能不能交给别人用」。
两个方向互补，不重叠。

四套引擎（GitHub 9 维 / npm 7 维 / 网页 9 维 / GEO 4 维）**判据互不通用** ——
把 npm 包的「周下载」塞进 GitHub 仓的「star 增速」位会系统性误判。

**四个入口，对应四种「我该拿它干嘛」**：

| 我要做的事 | 入口 | 它会告诉我 |
|---|---|---|
| 刚开源，不知道差在哪 | <https://scorecard.webkubor.online> | 别人第一眼会看到什么、文档够不够用 |
| 要发版，想补齐门面 | 同上 | tag / Release / CHANGELOG / CI 少了哪套仪式 |
| 交给 coding agent 改 | [`/skill.md`](https://scorecard.webkubor.online/skill.md) | 让 agent 按同一套判据先看清现状 |
| 一堆仓库，先修哪个 | `/api/scorecard/compare` | 逐维度差分，哪边领先、差在哪 |

**线上版**：<https://scorecard.webkubor.online>

<p align="center">
  <img src="https://scorecard.webkubor.online/og/scorecard/webkubor/typora-Bloom-theme"
       alt="Scorecard 报告示例" width="640">
</p>

## 它回答什么问题

「我这个项目，到底差在哪？」（项目 / 包 / 站点都行）

star 数只告诉你结果，不告诉你原因。Scorecard 按目标类型拆三套独立判据，
每条结论只看**客观证据**——API 拿得到、文件在不在、状态码是多少：

| 入口 | 引擎 | 维度数 | 主要看什么 |
|---|---|---:|---|
| GitHub 仓库 | `server/audit.js` | 9 | description / topics / CI / issue 响应 / llms.txt 等 |
| npm 包 | `server/audit-npm.js` | 7 | registry 元数据 + 周/月下载 + 文档 + 安全 + AI 可读性 |
| 任意网页 | `server/audit-page.js` | 9 | 含 **AI 识别**（llms.txt / schema.org）、**爬虫根目录**（robots / sitemap / .well-known / favicon）、**WebMCP 友好性**（mcp.json / ai-plugin / openapi）等 |
| 品牌 | `server/audit-geo.js` | 4 | AI 答案里的提及率 / 引用率 / 竞品份额 / 评价倾向（见下节） |

四套维度**互不通用**——把 npm 包的"周下载"塞进 GitHub 仓的"star 增速"位会系统性误判，
所以引擎、判据、报告模板各自独立。

输出不是一个分数了事，而是一份**可执行清单**——每条都带证据和「改完预计 +X 分」，
还能一键复制成可直接交给 AI 的整改 prompt。

## 「无法核实」不等于「有问题」

这是本项目和多数打分工具最不一样的地方。

打分工具量的是自己看得见的东西。所以公开 API 读不到的——需要 push 权限的 GitHub
traffic、没配 homepage 的官网、抓超时的 robots——在别的工具里通常被记成 0 分。
**那是在拿量具的盲区给项目扣分。**

Scorecard 的做法：读不到的判据从分母里剔除，该维度标 `score: null` +「无法核实」，
报告单列一份「我们看不到的清单」和 `manual` 手动核验项。后果很具体：
**一个公开仓库跑出来的总分，可以低于它的真实水平，但绝不会高于。**

同样的纪律贯穿全引擎：

- GitHub traffic 需要 push 权限，公共质检永远读不到 → 归入 manual，不扣分
- tag 超过取样上限时判不准 → 那几分从满分里剔除，而不是记 gap
- GEO 这一轮模型一次都没调 `web_search` → 「引用率」标无法核实而不是 0%
  ——**量具没通电和读数低，是两回事**

## 九维度是怎么定出来的

这套维度不是拍脑袋列的。每一维对应一个可外部核实的「陌生人用你的项目会卡在哪」的问题，
设计上受三条约束：

1. **只判客观项。** 判据限定在 API 拿得到、文件在不在、状态码是多少。
   主观项（「10 秒看不看得懂」「logo 是否与品牌统一」）判不了可复现，
   单列在 `skills/project-maturity-audit/`，不进网页引擎。
2. **三套引擎互不通用。** GitHub 9 维 / npm 7 维 / 网页 9 维 / GEO 4 维，判据各自独立。
3. **分数可被人推翻。** 每条结论都附证据原文与来源 URL，不同意可以对着证据直接反驳。

计分口径是「拿到多少判据就归一化多少」（`normalizeDim(score, unv)`），
不是拿满分 10 去减：读不到 README，就把那几条从**分母**里剔除，而不是记 0 分。

## 判据出处：与公开标准的对照

我们不是自创了一套「神秘评分」。每一维的判据都能在下面的公开标准里找到对应条款，
标准本身不适用时（如 OpenSSF 只管供应链安全）我们明确不套用。

| 维度 | 我们实际看什么 | 对应公开出处 |
|---|---|---|
| 门面 | description / topics / homepage / README 首屏图与徽章 | GitHub 仓库元数据；topics 即站内检索分类入口 |
| 分发 | registry 发布 / README 安装命令 / release 可下载产物 | [OpenSSF Scorecard](https://scorecard.dev/) · Packaging |
| 发布工程 | 版本 tag / GitHub Release / CHANGELOG / CI 最近一次**已完成**结论 | [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)、[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)、OpenSSF · CI-Tests |
| 质量护栏 | test / lint / typecheck 声明、独立测试目录 | [NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) · PW（Produce Well-Secured Software） |
| 社区卫生 | LICENSE / CONTRIBUTING / issue 模板 / issue 积压时效 / 最后提交 | OpenSSF Scorecard · Security-Policy、Maintained |
| 文档 | 安装 / 快速开始 / API 参考 / FAQ 四件套 | 通用开源文档基线（细则见 SKILL.md ⑥） |
| 安全 | SECURITY.md / 根目录误提交 .env / .gitignore | OpenSSF Scorecard · Security-Policy |
| 度量 | star / release 累计下载 / fork / homepage | 采用信号。**star 只当「有人在用」，不当质量证据** |
| AI 可读性 | AGENTS.md / llms.txt / Copilot 指令 / 官网 robots 是否放行 AI 爬虫 | [llms.txt 规范](https://llmstxt.org/)、[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) |

**引用清单**

- [OpenSSF Scorecard](https://scorecard.dev/) —— 源码
  [ossf/scorecard](https://github.com/ossf/scorecard)，检查项说明
  [docs/checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md)
- [NIST SP 800-218 · Secure Software Development Framework (SSDF) v1.1](https://csrc.nist.gov/pubs/sp/800/218/final)
  —— 四个 practice group：PO / PS / PW / RV
- [RFC 9309 · Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
  （2022-09，Standards Track）—— 我们的 robots 判定直接照它实现：按 `user-agent`
  分组做大小写不敏感匹配、命中多条规则时合并、**4xx 视为 unavailable，此时爬虫 MAY
  访问任意资源**，所以站点返回 404 时我们记「默认放行」而不是「屏蔽」
- [llms.txt 提案](https://llmstxt.org/) —— 第 9 维 `llms.txt` 判据即来自此
- [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)、
  [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)

> 引用粒度：上表列到 practice group / 检查项一级是确定的。若要在文案里引用 NIST
> 的具体 practice ID（如 `PW.4`）或 SLSA 的具体 level，落地前请对照原文核编号 ——
> 框架改版会动编号，引用错编号比不引用更伤可信度。

## 这个工具不做什么

主动划清边界，比多认领几个维度更能建立信任：

- **不做安全漏洞扫描。** 不跑 SCA、不查 CVE、不做 SAST、不扫 Dangerous Workflow。
  那是 [OpenSSF Scorecard](https://scorecard.dev/)（Pinned-Dependencies、
  Token-Permissions、Signed-Releases 等）与 [OWASP SCVS](https://scvs.owasp.org/scvs/) 的范围。
  我们的安全维只做最表层三项：`SECURITY.md` 是否存在、根目录是否误提交 `.env`、有无 `.gitignore`。
- **不做 provenance 验证。** 不核验构建产物来源，那需要构建平台侧配合。
- **不做主观判断。** 判不了可复现的项交给 `skills/project-maturity-audit/`，不进引擎。
- **GEO 不进排行榜。** 那会把「谁在盯哪些竞品」公开出去。

## GEO —— 测品牌在 AI 答案里的可见度

前三套测的是「你自己的东西做得好不好」，GEO 测的是**别人问 AI 时你会不会被提到**。
入口：<https://scorecard.webkubor.online/#/geo>，或落地页顶部那张卡片。

要四个输入：品牌名、自有域名、**用户会问的问题清单**、竞品。四维：

| 维度 | 怎么算 | 为什么这么算 |
|---|---|---|
| 提及率 | 品牌名出现在答案正文里的问题占比 | 最直接的"在不在" |
| 引用率 | 品牌域名出现在引用来源 URL 里的占比 | 被引用是转化路径，比被提及更值钱 |
| 竞品份额 | 你被提及的次数 ÷ 全部品牌被提及次数 | 单看提及率会被「品类很小」骗过去 |
| 评价倾向 | 出现位置的措辞：正面 / 中性 / 负面 | 只在有负面样本时才给分，没有就标「无法核实」 |

**判据只有两种硬证据**：品牌名在正文里、域名在引用 URL 里。刻意不让 LLM 自评
「这个品牌有名吗」——那是最容易被编出来的一类数字。拿不到证据的维度一律标
`score: null` + 「无法核实」，不猜。

两个容易踩的坑，引擎会挡：

- **问题必须是品类问题**，不是品牌词。问「museav 怎么样」模型会顺着你的问题去提它，
  数字好看但一文不值。所以要问「有哪些好用的 AI 视频生成工具」。
- **不给竞品就算不出份额**。此时分母只有你自己，恒等于 100% —— 引擎直接标「无法核实」而不是给你一个满分。

### 跑 GEO 要花钱，所以线上实例不配 key

GEO 每次查询都要调付费 LLM API。线上实例**故意不配任何 key**：它只跑离线 fixture
（报告首行强制标注「这份是假数据」）和读本地存下来的历史趋势，零花费。
完整功能在本地跑：

```bash
export SCORECARD_GEO_ANTHROPIC_KEY=sk-ant-xxx   # 或 _OPENAI_ / _GEMINI_ / _PERPLEXITY_
bun run server
```

`GET /api/geo/providers` 会告诉你本机哪几路配好了（只回报就绪与否，**永不回显 key**）。
没配也可以用 `provider=offline` 看报告长什么样。

GEO 不进排行榜也不进 trending —— 那会把「谁在盯哪些竞品」公开出去。

### 用本机网关跑（magpie）

如果本机装了 [magpie](https://github.com/webkubor/magpie) 这类 Anthropic 协议的
LLM 网关，不用去申请 key，直接指过去：

```bash
export SCORECARD_GEO_MAGPIE_BASE=http://127.0.0.1:3425
export SCORECARD_GEO_MAGPIE_KEY=<网关的 caller key>
export SCORECARD_GEO_MAGPIE_ALLOW_LOCAL=1        # 显式确认「我知道这是本机地址」
export SCORECARD_GEO_MAGPIE_MODEL=modelgo-gateway/claude-haiku-5.5
export SCORECARD_GEO_MAGPIE_MAX_TOKENS=4000   # 默认值；2000 会把来源列表截断成零
bun run server
```

默认模型是 `modelgo-gateway/claude-haiku-5.5`，**因为这是实测唯一每次都真调用 `web_search` 的一路**（4/4）。
换模型前先探一次：`node scripts/probe-magpie.mjs <model>`。`/v1/models` 列出来的**不是能力清单** ——
实测 `opencode-go/*` 额度耗尽、`modelgo-gateway/gemini-3.6-flash` 直接 400、
上一个默认值 `modelgo-gateway/gpt-5.4` HTTP 200 但回空 content 还白烧 token。照着列表配会得到一个「看起来配好了、跑起来只是全灭」的适配器。

三条硬规矩，都不是洁癖，是被实测打过脸：

| 规矩 | 为什么 |
|---|---|
| **不许用 `claude/*` 池** | 那一池走的是你自己 Claude Code 会话的额度。GEO 跑一次就烧一次写代码的额度，编辑器当场不可用（实测直接回 `rate_limit_error`）。这条是硬的，代码里直接拒。**别被名字骗了** —— `modelgo-gateway/claude-*` 不在这一池：它在 `~/.config/magpie/providers.json` 里有独立 endpoint 和 `mgk_` 开头的 ModelGo key，计费在 ModelGo 那边，跟本机会话不是一回事。 |
| **不许用 `group/*` 路由组** | 网关对路由组做动态选择。实测同一个 `group/mian-model-group` 先落 `codex/gpt-6-astra`、三分钟后落 `claude/claude-opus-5-5`。趋势图会把两个不同模型的结果画成一条线 —— 那条线量的不是同一个东西的变化。**钉死一个具体模型 id。**（它能漂进禁用池，所以是**禁用**，不是只在发起请求时拒绝。） |
| **只认 loopback 地址，且必须显式 `ALLOW_LOCAL=1`** | 生产在服务器、网关在你电脑上，两者隔着网络。这里是**白名单**：地址必须能从 URL 里证明是 `127.0.0.1` / `localhost` / `::1`，否则不放行 —— 不是「没禁就放行」。`0.0.0.0` 也踢掉，那是本机所有网卡，局域网够得着。 |

**引用分强弱两档。** 强证据有两个来源，都收：`web_search_tool_result` 里逐条列出的检索结果，
和正文块自带的结构化 `citations[]`（Anthropic 服务端给每句话挂的出处）。实测默认那路每次都返回后者，
一次 3~7 条。弱证据是模型自己在句子里写的裸 URL —— 可能是凭记忆写的，甚至是编的 ——
所以它单列提示，**不进分数**。把幻觉算成可见度，比不测更糟。

**模型没检索 ≠ 没人引用你。** 报告里另有一条：如果这一轮所选模型一次都没调用 `web_search`
（实测 `modelgo-gateway/deepseek-v4-pro` 就会回一段像模像样的正文、HTTP 200、从不用检索工具），
「引用率」标 **无法核实**，而不是 0%。一个是量具没通电，一个是读数低，混同就没有意义了。
提及 / 份额 / 倾向不依赖检索，照常给分。

### 一次测一个品牌

品牌清单在 `data/geo-brands.json`，出自 [Social Hub](https://github.com/webkubor/social-hub)
的 IP 矩阵（12 个平台账号归并成 5 个品牌）。有了它，「测某个品牌」是一条命令：

```bash
scorecard geo --list                    # 看有哪些品牌和问题
scorecard geo --brand 山鬼映画 --provider magpie
```

注意 `--q` 是可以重复给的，且**必须是品类问题而不是品牌词** —— 问「X 怎么样」模型会顺着
你的问题去提它，数字好看但一文不值。清单里的问题来自 Social Hub 的账号定位，不是从 bio 自动生成的。

## 对比模式

把两个目标放一起跑，输出维度差分 + 独有 gap 清单——主用例是**测试环境 vs 线上环境**：

- 9 维逐条 Δ，A 独有 / B 独有 gap 分开列
- 报告里自带 "把 A 补到 B 的水准" 的 AI prompt
- 分享 URL：`https://scorecard.webkubor.online/?share=<A>&compare=<B>&type=page` —— 直接扔 IM 即可

## 快速开始

```bash
bun install          # 或 npm install
bun run build        # 构建前端到 dist/
bun run server       # 起后端（默认 :54445），自动托管 dist/
```

打开 <http://127.0.0.1:54445> 即可。开发模式要前后端一起：

```bash
bun run server &     # 后端 :54445
bun run dev          # 前端 :54446，/api 代理到后端
```

### 配一个只读 token（可选，但建议）

不配也能跑，走 GitHub 匿名 API（60 次/小时/IP）；配了之后限额提到 5000 次/小时，
并且能读到 PR / Issues 活跃度这几维——**不配的话这几维拿不到数据，分数会偏低**
（同一个仓库实测 6.4 vs 6.8）。

```bash
export SCORECARD_GITHUB_TOKEN=ghp_xxx   # 只需 public_repo 只读权限
bun run server
```

token 只在服务端使用，从不下发给前端。

## CLI

```bash
# 三路审计（type 推断：URL=page，pkg 名=npm，owner/repo=github）
scorecard webkubor/scorecard                    # GitHub 仓库（9 维）
scorecard react --type npm                      # npm 包（7 维）
scorecard https://example.com --type page       # 网页（9 维）

# 同一类两个目标对比
scorecard --compare-a https://test.example.com \
          --compare-b https://example.com \
          --type page

# 报告 Markdown
scorecard webkubor/scorecard --md > report.md

# CI 闸门
scorecard react --type npm --min 6

# 跳过 30 分钟缓存
scorecard webkubor/scorecard --fresh

# GEO：品牌在 AI 答案里的可见度（--q 可重复给多条问题）
scorecard geo --brand museav --domain museav.com \
  --q "有哪些好用的 AI 视频生成工具" \
  --q "有哪些能批量做小红书内容的工具" \
  --competitors runway,pika --provider perplexity
```

GEO 的 CLI 与网页同一套判据。两条它特有的约定：**没法用 `--min` 卡离线结果**
（fixture 是假数据，闸门通过与否都不说明问题，命令会直接失败），以及
**没给 `--domain` / `--competitors` 时会先提醒再跑**，对应维度标「无法核实」而不是给满分。

CLI 把对应 HTTP 端点暴露成 stdout，agent 默认动作就能跑。

## GitHub 维度的 skill 互补

GitHub 仓这一路额外配 Claude skill 版（深度诊断），互补不重复：

| | 网页引擎（`server/audit.js`） | Claude skill（`skills/project-maturity-audit/`） |
|---|---|---|
| 擅长 | **广度 + 趋势**：一键扫多个仓库、可定时、看得到「上次 62 这次 78」 | **深度 + 修复**：读 README 判断首屏说不说得清、给排序后的整改清单 |
| 判据 | 只做客观项——API 拿得到、文件在不在、状态码是多少 | 主观项——「10 秒能否看懂」「logo 配色是否与品牌统一」「同品类头部差在哪」 |
| 边界 | 每个维度的 `manual` 字段标出「这几项判不了，去跑 skill」 | 每条结论必须有命令输出/文件内容/状态码支撑 |

引擎没有 LLM，判不了主观项；skill 没有并发和历史库，扫不了一批仓库、也画不出趋势。
谁都替代不了谁。

GitHub 引擎是权威：改维度必须同步三处 —— `server/audit.js`、`scripts/check-dimensions.mjs`、
`skills/project-maturity-audit/SKILL.md`，再跑 `bun run check:dimensions`。

```bash
bun run check:dimensions   # 维度名对不上就报错
```

## 部署

单个 bun 进程 + sqlite，2 核小机足够：

```ini
# /etc/systemd/system/scorecard.service
[Service]
Environment=SCORECARD_HOST=127.0.0.1        # 只监听本机，公网走隧道
Environment=SCORECARD_PORT=54445
Environment=SCORECARD_GITHUB_TOKEN=<只读 token，别写进仓库>
WorkingDirectory=/opt/scorecard
ExecStart=/root/.bun/bin/bun server/index.js
Restart=always
```

前面挂 Cloudflare Tunnel 指到 `127.0.0.1:54445`，不用对公网开端口。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SCORECARD_PORT` / `PORT` | 54445 | 后端监听端口 |
| `SCORECARD_HOST` / `HOST` | 0.0.0.0 | 监听地址（生产建议 127.0.0.1） |
| `SCORECARD_GITHUB_TOKEN` | – | 只读 token，提升 API 限额并解锁 PR/Issues 维度 |
| `SCORECARD_GEO_ANTHROPIC_KEY` | – | GEO 的 anthropic 路。**线上故意不配**（只读历史，零花费） |
| `SCORECARD_GEO_OPENAI_KEY` | – | GEO 的 openai 路 |
| `SCORECARD_GEO_GEMINI_KEY` | – | GEO 的 gemini 路 |
| `SCORECARD_GEO_PERPLEXITY_KEY` | – | GEO 的 perplexity 路（唯一自带来源列表的一路，引用率判得最准） |
| `SCORECARD_GEO_MAGPIE_BASE` | – | 本机 magpie 网关地址，如 `http://127.0.0.1:3425` |
| `SCORECARD_GEO_MAGPIE_KEY` | – | 网关的 caller key。**刻意不给默认值** —— 这个仓是公开的，本地开发密钥也是密钥 |
| `SCORECARD_GEO_MAGPIE_ALLOW_LOCAL` | – | 必须显式设 `1` 才允许连 loopback 网关（防止生产误配） |
| `SCORECARD_GEO_MAGPIE_MODEL` | `modelgo-gateway/claude-haiku-5.5` | 钉死的模型 id。**不许 `claude/*`，不许 `group/*`，不许 `opencode-zen-free/*`** |
| `SCORECARD_GEO_MAGPIE_MAX_TOKENS` | 4000 | 单次回答上限。调到 2000 会让默认模型被截断，来源列表清零 |
| `SCORECARD_DATA_DIR` | ./data | sqlite 存放目录 |
| `SCORECARD_BRAND` | SCORECARD | OG 图上的品牌字样 |
| `SCORECARD_SITE_URL` | scorecard.webkubor.online | OG 图 CTA 里的站点地址 |

## API

全部免登录（除 GitHub 维度可加 token 升限）：

| 端点 | 说明 |
|---|---|
| `GET /api/scorecard?repo=owner/name` | GitHub 仓 9 维质检（30 分钟内同 target 复用缓存） |
| `GET /api/scorecard?type=npm&pkg=react` | npm 包 7 维质检 |
| `GET /api/scorecard?type=page&url=https://...` | 网页 9 维质检 |
| `GET /api/scorecard/report.md?type=...&...` | 同一份报告的 Markdown 版，写给 AI 助手读 |
| `GET /api/scorecard/compare?type=...&a=X&b=Y` | 两路对比，返回两份报告 + 维度 diff |
| `GET /api/scorecard/compare.md?type=...&a=X&b=Y` | 对比报告的 Markdown 版 |
| `GET /api/scorecard/history?target=owner/name` | 同一项目的历次评估与维度变化（改完再跑一次，就能看出动没动） |
| `GET /api/scorecard/stats` | 累计查询次数与平均分 |
| `GET /api/scorecard/trending` | 近 24h 热门仓库 Top 10 |
| `GET /api/scorecard/leaderboard?limit=20` | 参照榜：每个项目取最新一次质检，按分数排 |
| `GET /api/scorecard?type=geo&brand=X&q=Q1,Q2&competitors=A,B&provider=...` | GEO 4 维可见度（**不走 30 分钟缓存**，见下） |
| `GET /api/geo/trend?brand=X` | 该品牌的历史曲线，live 与 offline 两类分开返回 |
| `GET /api/geo/providers` | 本机哪几路 GEO key 配好了（不回显 key） |
| `GET /api/geo/brands` | 品牌清单（出自 Social Hub 的 IP 矩阵），CLI 与前端用它免去手抄问题 |
| `GET /og/scorecard/:owner/:repo` | 1200×630 OG 分享图（**PNG**；`?fmt=svg` 取矢量版） |
| `GET /skill.md` | Agent skill 全文（带 frontmatter），供 coding agent 直接取用 |
| `GET /api/skill` | skill 的元信息 + 安装方式 + 端点清单 |
| `GET /api/health` | 健康检查 |

**给 agent 用**：`/skill.md` 是这套判据的 skill 形态，与网页端同源。装法：

```bash
curl -sL <站点>/skill.md -o <你的 skills 目录>/project-maturity-audit/SKILL.md
```

不给「一键安装」是刻意的：各家 agent 的 skills 目录与加载机制都不一样，
猜错落点比不装更糟。

任何端点加 `fresh=1` 跳过 30 分钟缓存，强制重跑。**GEO 例外**：它每次调用都花真钱，
且离线 fixture 与真实结果不可比，所以既不吃缓存也不写进别人的缓存 —— 跑一次存一次，
趋势读历史。

## 技术栈

Vue 3（无路由库，hash 路由手写）+ Vite + Hono + `bun:sqlite`。
生产就一个 bun 进程，内存约 80MB。没有任何外部前端依赖 —— 报告以 Markdown 交付，
由服务端 `reportMarkdown()` 生成，所以前端不需要 html2canvas 这类截图库。

## 身世

这个项目原本是 `github-accounts-manager`（一个 GitHub/GitLab 多账户与 token 管理中台）
里的一个页面。两个产品挤在一个仓库，导致对外传播的门面顶着「账户管理」的名字和标签，
而私有的 token 管理代码躺在公开仓库里。2026-08-20 拆开：Scorecard 独立公开，
账户管理回到私有仓库。

## License

MIT
