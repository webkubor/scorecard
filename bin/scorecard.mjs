#!/usr/bin/env node
/**
 * scorecard — 开源项目质检的命令行入口
 *
 * 为什么补这个：引擎、Web UI、API、skill 早就都有了，但一直没被用起来。
 * 复盘下来不是缺能力，是**形态不对**：
 *   · Web 应用要人打开浏览器粘 URL，而 agent 的默认动作是敲命令
 *   · 有 HTTP API，但 package.json 的 bin 是 null —— 没有命令行入口
 *   · 最关键的是没接进任何工作流：发布仓库、改完 README 的那一刻，
 *     没有任何东西提醒该跑一次质检
 *
 * 所以这层薄封装的意义不在功能，在**让它出现在该出现的时刻**：
 *   scorecard owner/repo --min 6    # 低于 6 分退出码 1，可直接卡在 CI / 发布脚本里
 *
 * 三种审计入口、各自判据集，不互通：
 *   scorecard webkubor/reel-kit              GitHub 仓库（9 维）
 *   scorecard react --type npm               npm 包（7 维）
 *   scorecard https://example.com --type page  网页（9 维，含 AI 识别 / 爬虫根目录 / WebMCP）
 *
 * 用法：
 *   scorecard webkubor/reel-kit              人读的九维表格 + 整改清单
 *   scorecard webkubor/reel-kit --json       给 agent 解析
 *   scorecard webkubor/reel-kit --md         Markdown 报告（可直接粘给 AI）
 *   scorecard webkubor/reel-kit --min 6      质量闸门
 */

const DEFAULT_API = process.env.SCORECARD_API || 'https://scorecard.webkubor.online'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const n = argv[i + 1]
      if (n === undefined || n.startsWith('--')) out[k] = true
      else { out[k] = n; i++ }
    } else out._.push(a)
  }
  return out
}

const HELP = `
scorecard — 开源项目质检（GitHub / npm / 网页三路）

用法:
  scorecard <owner/repo> [选项]              # GitHub 仓库质检（默认）
  scorecard <pkg> --type npm [选项]          # npm 包质检
  scorecard <url> --type page [选项]         # 网页质检

选项:
  --type <类型>   入口类型：github | npm | page（缺省按 <arg> 形式推断）
  --compare-a <X> --compare-b <Y>
                  对比两个目标（主用例：测试 env vs 线上 env）。type 必须一致。
  --json          输出原始 JSON（agent 解析用）
  --md            输出 Markdown 报告（可直接粘给 AI）
  --min <分数>    低于该分退出码 1，用于 CI / 发布前闸门
  --fresh         跳过 30 分钟缓存，强制重新审计
                  （刚推完整改就复测时必须带上，否则拿到的是改动前的分数）
  --api <地址>    自建实例地址，默认 ${DEFAULT_API}
                  （也可用环境变量 SCORECARD_API）

例子:
  scorecard webkubor/reel-kit
  scorecard react --type npm
  scorecard https://anthropic.com --type page
  scorecard webkubor/reel-kit --min 6      # 不达标就让脚本失败
  scorecard webkubor/reel-kit --md > report.md
  scorecard --compare-a https://test.example.com --compare-b https://example.com --type page
`

/** 分数条：把 0~10 画成 10 格，一眼看出短板在哪 */
function bar(score) {
  const n = Math.max(0, Math.min(10, Math.round(Number(score) || 0)))
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const target = args._[0]

  // ---- 对比模式：--compare-a / --compare-b 必填，跳过单目标流程 ----
  if (args['compare-a'] || args['compare-b']) {
    const a = (args['compare-a'] || '').toString().trim()
    const b = (args['compare-b'] || '').toString().trim()
    if (!a || !b) { console.error('❌ --compare-a 和 --compare-b 都要填'); process.exit(1) }
    const inferred = (s) => /^https?:\/\//i.test(s) ? 'page'
      : /^(@[\w.-]+\/)?[\w.-]+$/.test(s) ? 'npm'
      : /^[\w.-]+\/[\w.-]+$/.test(s) ? 'github'
      : null
    let type = (args.type || '').toString().toLowerCase()
    if (type && !['github', 'npm', 'page'].includes(type)) { console.error('❌ --type 只接受 github|npm|page'); process.exit(1) }
    if (!type) {
      const ta = inferred(a), tb = inferred(b)
      if (!ta || !tb) { console.error('❌ --compare 的两个目标都需可识别，加 --type 显式指定'); process.exit(1) }
      if (ta !== tb) { console.error(`❌ --compare 的两个目标 type 不一致（${ta} vs ${tb}），加 --type 显式指定`); process.exit(1) }
      type = ta
    }
    const api = String(args.api || DEFAULT_API).replace(/\/$/, '')
    const qs = `type=${type}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}${args.fresh ? '&fresh=1' : ''}`
    if (args.md) {
      const r = await fetch(`${api}/api/scorecard/compare.md?${qs}`, { signal: AbortSignal.timeout(120000) })
      const text = await r.text()
      if (!r.ok) { console.error(`❌ ${text.slice(0, 300)}`); process.exit(1) }
      console.log(text); return
    }
    const r = await fetch(`${api}/api/scorecard/compare?${qs}`, { signal: AbortSignal.timeout(120000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.error) { console.error('❌', j.error || r.status); process.exit(1) }
    if (args.json) { console.log(JSON.stringify(j, null, 2)); return }
    const arrow = j.diff.totalDelta > 0 ? '↗ B 领先' : j.diff.totalDelta < 0 ? '↘ B 落后' : '= 持平'
    console.log(`\n  A: ${j.a.project}  →  ${j.a.score} 分 · ${j.a.band}`)
    console.log(`  B: ${j.b.project}  →  ${j.b.score} 分 · ${j.b.band}`)
    console.log(`  Δ = ${j.diff.totalDelta > 0 ? '+' : ''}${j.diff.totalDelta} · ${arrow}`)
    console.log(`  维度: A 优 ${j.diff.summary.aBetter} · B 优 ${j.diff.summary.bBetter} · 平 ${j.diff.summary.tie}`)
    console.log(`  独有 gap: A ${j.diff.summary.aOnlyGaps} · B ${j.diff.summary.bOnlyGaps}\n`)
    for (const d of j.diff.dims) {
      const w = d.winner === 'a' ? '🅰️' : d.winner === 'b' ? '🅱️' : '🤝'
      console.log(`  ${w} ${String(d.name).padEnd(8, '　')} A=${String(d.aScore).padStart(4)}  B=${String(d.bScore).padStart(4)}  Δ=${d.delta > 0 ? '+' : ''}${d.delta}`)
    }
    const actionable = (j.diff.dims || []).filter((d) => d.uniqueGaps?.b?.length || d.uniqueGaps?.a?.length)
    if (actionable.length) {
      console.log('\n  B 独有、A 还没补的（补上即追上 B）:')
      for (const d of actionable) for (const g of (d.uniqueGaps?.b || [])) console.log(`    · [${d.name}] ${g}`)
      console.log('\n  A 独有、B 还没补的:')
      for (const d of actionable) for (const g of (d.uniqueGaps?.a || [])) console.log(`    · [${d.name}] ${g}`)
    }
    console.log('')
    return
  }

  if (!target || args.help || args.h) { console.log(HELP); process.exit(target ? 0 : 1) }

  // type 推断：--type 优先，否则按形态猜
  const explicitType = (args.type || '').toString().toLowerCase()
  const validTypes = ['github', 'npm', 'page']
  let type
  if (explicitType) {
    if (!validTypes.includes(explicitType)) { console.error(`❌ --type 只接受 ${validTypes.join('/')}`); process.exit(1) }
    type = explicitType
  } else if (/^https?:\/\//i.test(target)) type = 'page'
  else if (/^(@[\w.-]+\/)?[\w.-]+$/.test(target)) type = 'npm'
  else if (/^[\w.-]+\/[\w.-]+$/.test(target)) type = 'github'
  else { console.error(`❌ 目标格式无法识别：${target}\n   带 https:// 当 URL，否则 owner/repo 当仓库，单段名当 npm 包。\n   或显式 --type npm|page`); process.exit(1) }

  // type-specific 入口参数名
  const typeParam = type === 'github' ? 'repo' : type === 'npm' ? 'pkg' : 'url'
  // backward-compat: --md 的 github 路径也可以用 ?repo=
  const queryStr = type === 'github'
    ? `repo=${encodeURIComponent(target)}`
    : `${typeParam}=${encodeURIComponent(target)}&type=${type}`

  const api = String(args.api || DEFAULT_API).replace(/\/$/, '')

  if (args.md) {
    const r = await fetch(`${api}/api/scorecard/report.md?${queryStr}${args.fresh ? '&fresh=1' : ''}`, {
      signal: AbortSignal.timeout(90000),
    })
    const text = await r.text()
    if (!r.ok) { console.error(`❌ ${text.slice(0, 300)}`); process.exit(1) }
    console.log(text)
    return
  }

  let payload
  try {
    const r = await fetch(`${api}/api/scorecard?${queryStr}${args.fresh ? '&fresh=1' : ''}`, {
      signal: AbortSignal.timeout(90000),
    })
    payload = await r.json()
  } catch (e) {
    console.error(`❌ 请求 ${api} 失败：${e.message}`)
    console.error('   自建实例可用 --api 或环境变量 SCORECARD_API 指过去')
    process.exit(1)
  }

  if (payload.error) { console.error(`❌ ${payload.error}`); process.exit(1) }
  const report = payload.report || payload

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return }

  const score = Number(report.score)
  const typeLabel = { github: 'GitHub 仓库', npm: 'npm 包', page: '网页' }[type]
  const starsHint = report.stars && report.stars > 0 ? ` · ⭐${report.stars}` : ''
  const extra = type === 'npm' && report.weeklyDownloads != null
    ? ` · 周下载 ${report.weeklyDownloads.toLocaleString('en-US')}`
    : type === 'page' && report.ttfb != null
      ? ` · TTFB ${report.ttfb}ms`
      : ''
  console.log(`\n  ${target}   ${score} 分 · ${report.band || ''}${starsHint}${extra}${payload.cached ? '  (缓存)' : ''}  [${typeLabel}]\n`)

  for (const d of report.dims || []) {
    console.log(`  ${String(d.name).padEnd(8, '　')} ${String(d.score).padStart(4)}  ${bar(d.score)}`)
    // 只列 gaps（可验证的硬缺口），manual 那些要人判断的不在命令行里刷屏
    for (const g of (d.gaps || []).slice(0, 3)) console.log(`             ↳ ${g}`)
  }

  const todos = report.todos || []
  if (todos.length) {
    console.log('\n  整改清单（按影响÷成本排序）:')
    for (const t of todos.slice(0, 8)) {
      const text = typeof t === 'string' ? t : (t.title || t.text || JSON.stringify(t))
      console.log(`    · ${text}`)
    }
    if (todos.length > 8) console.log(`    …还有 ${todos.length - 8} 条，--md 看完整报告`)
  }

  if (args.min !== undefined) {
    const min = Number(args.min)
    if (Number.isNaN(min)) { console.error('\n❌ --min 需要一个数字'); process.exit(1) }
    if (score < min) {
      console.error(`\n❌ ${score} 分 < 闸门 ${min} 分`)
      process.exit(1)
    }
    console.log(`\n✅ ${score} 分 ≥ 闸门 ${min} 分`)
  }
  console.log('')
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1) })
