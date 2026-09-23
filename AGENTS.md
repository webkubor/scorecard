# AGENTS.md — AI 助手工作守则

本文件给进入本仓库的 AI 编码助手（GitHub Copilot / Codex / Claude Code 等）提供工作上下文。
它是本项目「AI 可读性」维度的一部分 —— 想改这份文件，先读下面的约定。

## 这是什么

Scorecard —— 开源项目质检工具。粘一个 GitHub URL / npm 包名 / 网页 URL，拿到雷达图、整改清单和可喂给 AI 的 Markdown 报告。三路入口，**各自有独立的判据集**，互不通用 —— 强行合并会让某类项目被系统性误判。

关键文件：

- `server/audit.js`：GitHub 仓库质检引擎，**权威**。9 维：门面 / 分发 / 发布工程 / 质量护栏 / 社区卫生 / 文档 / 安全 / 度量 / AI 可读性。每个维度只使用**客观判据**；查不到的判据计为 `unverifiable` 并从该维满分中剔除（`normalizeDim`），不能当成「不满足」扣分。
- `server/audit-npm.js`：npm 包独立审计引擎，**7 维**，判据集与 GitHub 完全不同（registry / 下载量 / 依赖治理 / 文档 / 安全 / AI 可读性）。
- `server/audit-page.js`：网页独立审计引擎，**9 维**，含 ④ AI 识别（llms.txt / schema.org）/ ⑤ 爬虫根目录（robots / sitemap / .well-known / favicon）/ ⑧ WebMCP 友好性（mcp.json / ai-plugin / openapi）。
- `server/compare.js`：任意 type 两个报告的横切差分（独有 gap / 共用 gap / 维度 Δ / 总分 Δ）。
- `server/index.js`：Hono 后端，按 `type` 路由分发；统一 `getOrAudit()` 给单目标与 compare 共用缓存逻辑；`audits` 表加 `targetType` + `meta` 列。
- `bin/scorecard.mjs`：CLI 入口，加 `--type github|npm|page` 与 `--compare-a/--compare-b`。
- `src/components/Scorecard.vue`：前端面板（落地页 / loading / 报告三态 + 对比模式）。
- `skills/project-maturity-audit/SKILL.md`：Claude skill 版标准，与 **GitHub 仓库引擎**必须同一套维度。npm 与网页没有 skill 副本 —— 它们的判据在引擎里。
- `scripts/check-dimensions.mjs`：校验 GitHub 引擎与 skill 维度一致。

## 常用命令

- `bun run build`：构建前端到 `dist/`
- `bun run server`：起后端（默认 :54445），自动托管 `dist/`
- `bun run dev`：前端 dev 服务（:54446，`/api` 代理到后端）
- `bun run check:dimensions`：维度一致性检查（只覆盖 GitHub 引擎 ↔ skill）

## 约定

- **三路独立，不可混用**：GitHub 仓库（9 维）/ npm 包（7 维）/ 网页（9 维）各自一套引擎、维度、判据。报告里不要给统一总分，分头说各路分数。
- **GitHub 引擎是权威**：改 GitHub 维度必须同步三处 —— `server/audit.js`、`scripts/check-dimensions.mjs`、`skills/project-maturity-audit/SKILL.md`，再跑 `bun run check:dimensions`。
- 每条结论必须有证据（`evidence`）；不足写进 `gaps`；判不了写进 `manual` 并加 `unverifiable` 分值。
- 报告以 Markdown 交付（三个引擎各自的 `reportMarkdown()`），前端不做图片导出。
- 对比维度集必须一致 —— 跨 type 对比返回 400，避免拿 7 维 npm 和 9 维网页硬比。
- 文案中的「九维 / 九维度」是 GitHub 仓库的品牌口径，npm 引擎是「七维」，网页是「九维」，各自说自己的数。
