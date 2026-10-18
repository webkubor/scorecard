# 安全策略

## 报告漏洞

请**不要**用公开 issue 报安全问题。用 GitHub 的私有漏洞报告：

<https://github.com/webkubor/scorecard/security/advisories/new>

请在报告里带上：影响版本、复现步骤、你能想到的最坏后果。
如果涉及凭据，**不要贴明文**，只说在哪一类输入/配置里能触发。

预期响应：3 个工作日内确认收到，修复时间按严重程度定。

## 这个项目「安全」这一维在量什么

先划清边界，免得误会：

**做的**：`SECURITY.md` 是否存在、根目录是否误提交 `.env`、是否有 `.gitignore`。
只做最表层三项。

**不做的**：不跑 SCA、不查 CVE、不做 SAST、不扫 GitHub Actions 的危险用法。
那是 [OpenSSF Scorecard](https://scorecard.dev/)（Pinned-Dependencies、
Token-Permissions、Signed-Releases 等）和 [OWASP SCVS](https://scvs.owasp.org/scvs/) 的范围。

**Scorecard 自己的一个高分项也可能是个危险信号**：它只判「有没有安全策略文件」，
不判「策略写得对不对」。

## 部署时该注意的

本项目会从外部拉取数据（GitHub API、npm registry、任意网页），所以：

- **不要把它当成不可信输入的沙箱。** 引擎会对你给的 URL 发请求，
  内网地址同样可达 —— 部署到公网前请限制出站，别让它成为 SSRF 的跳板。
- **GEO 会花钱。** 它调用真实 LLM provider，线上实例默认不配 key 是刻意的；
  一旦配上，`/api/scorecard?type=geo` 就成了免登录的计费入口，请自行加限流。
- **GitHub token 只读。** `SCORECARD_GITHUB_TOKEN` 只需要 `public_repo` 只读权限，
  给多了没好处。
- **不要提交 `.env`。** CI 里没有密钥需求，测试不依赖任何 key。
