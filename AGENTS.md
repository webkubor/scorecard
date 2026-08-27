# AGENTS.md — AI 助手工作守则

本文件给进入本仓库的 AI 编码助手（GitHub Copilot / Codex / Claude Code 等）提供工作上下文。
它是本项目「AI 可读性」维度的一部分 —— 想改这份文件，先读下面的约定。

## 这是什么

Scorecard —— 开源项目**九维度**质检工具。粘一个 GitHub URL，拿到雷达图、整改清单和可喂给 AI 的 Markdown 报告。

关键文件：

- `server/audit.js`：质检引擎（**权威**，面板分数由它算出）。每个维度只使用**客观判据**（API 拿得到、文件在不在、状态码是多少）；查不到的判据计为 `unverifiable` 并从该维满分中剔除（`normalizeDim`），不能当成「不满足」扣分。
- `server/index.js`：Hono 后端，提供缓存、排行榜、OG 图、Markdown 报告端点。
- `src/components/Scorecard.vue`：前端面板（落地页 / loading / 报告三态）。
- `skills/project-maturity-audit/SKILL.md`：Claude skill 版标准，与引擎必须同一套维度。
- `scripts/check-dimensions.mjs`：校验引擎与 skill 维度一致。

## 常用命令

- `bun run build`：构建前端到 `dist/`
- `bun run server`：起后端（默认 :54445），自动托管 `dist/`
- `bun run dev`：前端 dev 服务（:54446，`/api` 代理到后端）
- `bun run check:dimensions`：维度一致性检查

## 约定

- **引擎是权威**：改维度必须同步三处 —— `server/audit.js`、`scripts/check-dimensions.mjs`、`skills/project-maturity-audit/SKILL.md`，再跑 `bun run check:dimensions`。
- 每条结论必须有证据（`evidence`）；不足写进 `gaps`；判不了写进 `manual` 并加 `unverifiable` 分值。
- 报告以 Markdown 交付（`reportMarkdown()`），前端不做图片导出。
- 文案中的「九维 / 九维度」是品牌口径，不要改回八维。
