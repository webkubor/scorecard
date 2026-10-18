# Copilot / AI 助手指令

本文件是 Scorecard 项目「AI 可读性」维度的判据之一 —— 我们自己也过这一维。

## 先读这三份

1. `AGENTS.md` —— 项目的权威约定（三路引擎独立、维度同步规则）
2. `README.md` —— 对外口径。「无法核实」不等于「有问题」是本项目的核心纪律
3. `skills/project-maturity-audit/SKILL.md` —— 九维判据的标准原文

## 改判据时必须遵守

- **三路引擎互不通用**：`server/audit.js`（GitHub 9 维）/ `audit-npm.js`（npm 7 维）/
  `audit-page.js`（网页 9 维）/ `audit-geo.js`（GEO 4 维），判据、维度、报告模板各自独立。
  不要为了「统一」把某一路的判据搬到另一路。
- **查不到 ≠ 不满足**：读不到的判据要写进 `manual` 并累加 `unverifiable`，
  由 `normalizeDim(score, unv)` 从分母里剔除。**绝不能记 0 分。**
- **每条结论必须有 `evidence`**，写清依据是什么。
- **改 GitHub 维度要同步三处**：`server/audit.js`、`scripts/check-dimensions.mjs`、
  `skills/project-maturity-audit/SKILL.md`，然后跑 `bun run check`。

## 提交前

```bash
bun run check     # 维度一致性 + 四路引擎维度纪律 + 单元测试
```

全绿才提交。CI 会跑同一套。

## 前端约定

- `src/components/Scorecard.vue` 目前是单文件（含 landing / loading / report / compare 四态），
  改动前先看清是哪一态。
- 颜色走 CSS 变量（`var(--score-*)`），不要在 JS 里硬编码色值后又在 CSS 里用变量 ——
  这两者已经在 `bandColor()` 处漂移过一次。
- `<details>` 的展开态不要直接用 `:open` 绑表达式：父级 re-render 会把用户的收起动作覆盖掉。
  参考 `isDimOpen` / `onDimToggle` 的写法。

## 不要做的

- 不要把 `npx scorecard` 写进文档 —— npm 上那个名字是别人的包。
- 不要给 GEO 加「一键刷新」这类无节流的入口 —— 它每次调用都花真钱。
- 不要把主观判断塞进引擎（「看起来很专业」这类），主观项放 skill。
