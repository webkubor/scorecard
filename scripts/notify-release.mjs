// 版本发布飞书通知 —— 用自家 im-notify-kit 把发版卡片推进群。
//
// 触发：GitHub Actions 在 release published 时跑本脚本（webhook 走 Actions secret），
// 本地也可手动跑（发版后补推、或验证链路）：
//   SCORECARD_FEISHU_WEBHOOK=<url> bun scripts/notify-release.mjs
//   bun scripts/notify-release.mjs --dry-run
//
// webhook 是凭据，只从环境变量来，绝不写进仓库。
// 卡片内容以 CHANGELOG.md 顶部最新版本段为唯一真源 —— 没写 CHANGELOG 就不发空卡片。
import { readFileSync } from 'node:fs'
import { feishu } from 'im-notify-kit'

const dryRun = process.argv.includes('--dry-run')
const hook = process.env.SCORECARD_FEISHU_WEBHOOK || ''
const SITE = 'https://scorecard.webkubor.online'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// CHANGELOG 顶部第一个 `## ` 段就是本次发布（本仓惯例：`## 2.1.0 — 日期`，不带方括号）。
// 线性解析：找到第一个版本行，收集到下一个 `## ` 行为止，取 `- ` 条目。
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const lines = changelog.split('\n')
const start = lines.findIndex((l) => /^##\s*\d/.test(l))
if (start === -1) {
  console.error('CHANGELOG 里读不到版本段（## x.y.z）—— 先写发布条目再发版。')
  process.exit(2)
}
const changelogVersion = (lines[start].match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/) || [])[0]
if (changelogVersion !== version) {
  console.error(`CHANGELOG 顶部版本（${changelogVersion ?? '读不到'}）与 package.json（${version}）不一致 —— 先对齐再发版。`)
  process.exit(2)
}
let items = []
for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
  const l = lines[i].trim()
  if (/^- /.test(l)) items.push(l.slice(2))
}
if (!items.length) {
  console.error('CHANGELOG 顶部版本段没有条目 —— 不发空卡片。')
  process.exit(2)
}

const markdown = [
  `**Scorecard v${version} 已发布**`,
  '',
  ...items.slice(0, 6).map((l) => `- ${l}`),
  ...(items.length > 6 ? [`- … 共 ${items.length} 条`] : []),
].join('\n')

const card = {
  title: `⬢ Scorecard v${version}`,
  template: 'green',
  markdown,
  buttons: [
    { text: 'Release 说明', url: `https://github.com/webkubor/scorecard/releases/tag/v${version}`, type: 'primary' },
    { text: '在线体验', url: SITE },
  ],
}

if (dryRun) {
  console.log('（dry-run）将推送卡片：')
  console.log(JSON.stringify(card, null, 2))
  process.exit(0)
}

if (!hook) {
  console.error('缺少 SCORECARD_FEISHU_WEBHOOK（CI 走 secrets.FEISHU_WEBHOOK；本地手动注入）')
  process.exit(1)
}

// im-notify-kit 永不抛异常：HTTP 200 且 body.code=0 才算送达，结果如实报告
const r = await feishu.card(hook, card)
if (r.ok) {
  console.log(`✅ v${version} 发布卡片已送达（${items.length} 条变更）`)
} else {
  console.error(`❌ 卡片未送达：${r.error}${r.code != null ? `（code ${r.code}）` : ''}`)
  process.exit(1)
}
