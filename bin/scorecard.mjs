#!/usr/bin/env node
/**
 * scorecard — 开源项目九维度质检的命令行入口
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
scorecard — 开源项目九维度质检

用法:
  scorecard <owner/repo> [选项]

选项:
  --json          输出原始 JSON（agent 解析用）
  --md            输出 Markdown 报告（可直接粘给 AI）
  --min <分数>    低于该分退出码 1，用于 CI / 发布前闸门
  --api <地址>    自建实例地址，默认 ${DEFAULT_API}
                  （也可用环境变量 SCORECARD_API）

例子:
  scorecard webkubor/reel-kit
  scorecard webkubor/reel-kit --min 6      # 不达标就让脚本失败
  scorecard webkubor/reel-kit --md > report.md
`

/** 分数条：把 0~10 画成 10 格，一眼看出短板在哪 */
function bar(score) {
  const n = Math.max(0, Math.min(10, Math.round(Number(score) || 0)))
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = args._[0]

  if (!repo || args.help || args.h) { console.log(HELP); process.exit(repo ? 0 : 1) }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(`❌ 仓库格式应为 owner/name，收到 "${repo}"`)
    process.exit(1)
  }

  const api = String(args.api || DEFAULT_API).replace(/\/$/, '')

  if (args.md) {
    const r = await fetch(`${api}/api/scorecard/report.md?repo=${encodeURIComponent(repo)}`, {
      signal: AbortSignal.timeout(90000),
    })
    const text = await r.text()
    if (!r.ok) { console.error(`❌ ${text.slice(0, 300)}`); process.exit(1) }
    console.log(text)
    return
  }

  let payload
  try {
    const r = await fetch(`${api}/api/scorecard?repo=${encodeURIComponent(repo)}`, {
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
  console.log(`\n  ${repo}   ${score} 分 · ${report.band || ''}${report.stars != null ? ` · ⭐${report.stars}` : ''}${payload.cached ? '  (缓存)' : ''}\n`)

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
