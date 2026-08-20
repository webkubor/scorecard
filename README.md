# Scorecard

> 粘一个 GitHub URL，几秒钟拿到八维度质检报告：雷达图、按「影响÷成本」排序的整改清单，
> 和一份可以直接粘给 AI 的 Markdown 报告。免登录，公开仓库无需 token。

**线上版**：<https://scorecard.webkubor.online>

<p align="center">
  <img src="https://scorecard.webkubor.online/og/scorecard/webkubor/typora-Bloom-theme"
       alt="Scorecard 报告示例" width="640">
</p>

## 它回答什么问题

「我这个开源项目，到底差在哪？」

star 数只告诉你结果，不告诉你原因。Scorecard 把项目成熟度拆成八个维度，
每一维只看**客观证据**——API 拿得到、文件在不在、状态码是多少：

| 维度 | 看什么 |
|---|---|
| 门面 | description / topics / homepage 有没有把「这是什么」说清楚 |
| 分发 | 能不能被装上：npm / release 产物 / 安装说明 |
| 发布工程 | semver tag、CHANGELOG、release 节奏 |
| 质量护栏 | CI、测试脚本、lint |
| 社区卫生 | CONTRIBUTING、CoC、issue 模板、响应速度 |
| 文档 | README 结构、快速开始、示例 |
| 安全 | 依赖治理、SECURITY.md、告警 |
| 度量 | star 增速、fork、下载量 |

输出不是一个分数了事，而是一份**可执行清单**——每条都带证据和「改完预计 +X 分」，
还能一键复制成可直接交给 AI 的整改 prompt。

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

## 两种形态：网页引擎 + Claude skill

同一套八维标准，两种交付方式，**互补而不是重复**：

| | 网页引擎（`server/audit.js`） | Claude skill（`skills/project-maturity-audit/`） |
|---|---|---|
| 擅长 | **广度 + 趋势**：一键扫多个仓库、可定时、看得到「上次 62 这次 78」 | **深度 + 修复**：读 README 判断首屏说不说得清、给排序后的整改清单 |
| 判据 | 只做客观项——API 拿得到、文件在不在、状态码是多少 | 主观项——「10 秒能否看懂」「logo 配色是否与品牌统一」「同品类头部差在哪」 |
| 边界 | 每个维度的 `manual` 字段标出「这几项判不了，去跑 skill」 | 每条结论必须有命令输出/文件内容/状态码支撑 |

引擎没有 LLM，判不了主观项；skill 没有并发和历史库，扫不了一批仓库、也画不出趋势。
谁都替代不了谁。

两边的维度定义必须对齐，否则「面板给 7 分、skill 给 4 分」，人就不知道该信谁。
这件事不靠记性：

```bash
npm run check:dimensions   # 维度名对不上就报错
```

引擎是权威（面板分数由它算出），skill 跟着走。

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
| `SCORECARD_DATA_DIR` | ./data | sqlite 存放目录 |
| `SCORECARD_BRAND` | SCORECARD | OG 图上的品牌字样 |
| `SCORECARD_SITE_URL` | scorecard.webkubor.online | OG 图 CTA 里的站点地址 |

## API

全部免登录：

| 端点 | 说明 |
|---|---|
| `GET /api/scorecard?repo=owner/name` | 跑一次质检（30 分钟内同仓库复用缓存） |
| `GET /api/scorecard/report.md?repo=owner/name` | 同一份报告的 Markdown 版，写给 AI 助手读 |
| `GET /api/scorecard/stats` | 累计查询次数与平均分 |
| `GET /api/scorecard/trending` | 近 24h 热门仓库 Top 10 |
| `GET /api/scorecard/leaderboard?limit=20` | 参照榜：每个项目取最新一次质检，按分数排 |
| `GET /og/scorecard/:owner/:repo` | 1200×630 OG 分享图（SVG） |
| `GET /api/health` | 健康检查 |

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
