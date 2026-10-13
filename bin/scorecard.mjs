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
 * 四种审计入口、各自判据集，不互通：
 *   scorecard webkubor/reel-kit              GitHub 仓库（9 维）
 *   scorecard react --type npm               npm 包（7 维）
 *   scorecard https://example.com --type page  网页（9 维，含 AI 识别 / 爬虫根目录 / WebMCP）
 *   scorecard geo --brand X --q "..."        GEO（4 维，品牌在 AI 答案里的可见度）
 *
 * 用法：
 *   scorecard webkubor/reel-kit              人读的九维表格 + 整改清单
 *   scorecard webkubor/reel-kit --json       给 agent 解析
 *   scorecard webkubor/reel-kit --md         Markdown 报告（可直接粘给 AI）
 *   scorecard webkubor/reel-kit --min 6      质量闸门
 *   scorecard geo --brand X --q "..." --min 5   GEO 也能当闸门（会花钱，别放进 CI 每轮跑）
 */

const DEFAULT_API = process.env.SCORECARD_API || 'https://scorecard.webkubor.online'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const n = argv[i + 1]
      const val = (n === undefined || n.startsWith('--')) ? true : (i++, n)
      // --q 是可重复的：GEO 的问题清单天然是多条，靠重复给比用分隔符拼更好 ——
      // 问题本身就会带逗号（「有哪些好用的工具，便宜的」），拼串会把它切碎。
      if (k === 'q') out.q = [...(Array.isArray(out.q) ? out.q : []), val]
      else out[k] = val
    } else out._.push(a)
  }
  return out
}

const HELP = `
scorecard — 开源项目质检（GitHub / npm / 网页 / GEO 四路）

用法:
  scorecard <owner/repo> [选项]              # GitHub 仓库质检（默认）
  scorecard <pkg> --type npm [选项]          # npm 包质检
  scorecard <url> --type page [选项]         # 网页质检
  scorecard geo --brand <名> --q <问题> ...  # GEO：品牌在 AI 答案里的可见度

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

GEO 专用选项:
  --brand <名>     品牌名（必填）
  --q <问题>       用户会问的问题，可重复给多条（必填）
                   必须是**品类问题**不是品牌词 —— 问「X 怎么样」模型会顺着
                   你的问题去提它，数字好看但一文不值
  --domain <域名>  自有域名，用来判「引用率」。留空则该维标无法核实
  --competitors <a,b>  竞品，逗号分隔。留空则「份额」维标无法核实
  --provider <路>  openai | anthropic | gemini | perplexity | offline
                   缺省按本机就绪情况自动选；本机没配 key 会落到 offline
  （GEO 每次调用都调付费 API，且不吃缓存 —— 跑一次存一次，趋势读历史）

例子:
  scorecard webkubor/reel-kit
  scorecard react --type npm
  scorecard https://anthropic.com --type page
  scorecard webkubor/reel-kit --min 6      # 不达标就让脚本失败
  scorecard webkubor/reel-kit --md > report.md
  scorecard --compare-a https://test.example.com --compare-b https://example.com --type page
  scorecard geo --brand museav --domain museav.com \\
    --q "有哪些好用的 AI 视频生成工具" --competitors runway,pika --provider anthropic
`

/** 分数条：把 0~10 画成 10 格，一眼看出短板在哪 */
function bar(score) {
  const n = Math.max(0, Math.min(10, Math.round(Number(score) || 0)))
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

/**
 * 从服务端的品牌清单里找一条。
 *
 * 刻意「找不到就返回 null」而不是报错：清单是便利设施，不是前置条件。
 * 清单挂了或离线实例上没有这份文件，用户手写 --brand + --q 照样该能跑。
 */
async function fetchGeoBrand(api, brand) {
  try {
    const r = await fetch(`${api}/api/geo/brands`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const j = await r.json()
    const list = j.brands || []
    if (!list.length) return null
    if (!brand) return null
    const want = brand.toLowerCase()
    return list.find((b) => b.brand.toLowerCase() === want)
      || list.find((b) => b.brand.toLowerCase().includes(want) || want.includes(b.brand.toLowerCase()))
      || null
  } catch { return null }
}

async function printGeoBrands(api) {
  try {
    const r = await fetch(`${api}/api/geo/brands`, { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    if (!j.brands?.length) { console.error(`❌ 品牌清单为空${j.error ? `：${j.error}` : ''}`); process.exit(1) }
    console.log(`\n  可用品牌（真源：${j.source || 'Social Hub'}）\n`)
    for (const b of j.brands) {
      console.log(`  ${b.brand}  ${b.category}`)
      console.log(`    ${b.questions.length} 个问题${b.domain ? ` · domain ${b.domain}` : ' · 无自有域名（引用率天然无法核实）'}`)
      for (const q of b.questions) console.log(`      · ${q}`)
      if (b.note) console.log(`    ⓘ ${b.note}`)
      console.log('')
    }
    return
  } catch (e) {
    console.error(`❌ 取品牌清单失败：${e.message}`)
    process.exit(1)
  }
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

  // ---- GEO：测品牌在 AI 答案里的可见度 ----
  // 单独一条路径，不走下面的 type 推断：GEO 的入参不是一个「目标串」，
  // 是品牌名 + 问题清单 + 竞品，把它硬塞进 <owner/repo> 那种单值形态只会逼出一堆特例。
  if (args.geo || args.list || target === 'geo') {
    let brand = (args.brand || '').toString().trim()
    let domain = (args.domain || '').toString().trim()
    let competitors = (args.competitors || '').toString().split(',').map((s) => s.trim()).filter(Boolean)
    let questions = (Array.isArray(args.q) ? args.q : args.q ? [args.q] : [])
      .map((s) => String(s).trim()).filter(Boolean)
    const provider = (args.provider || '').toString().trim()

    const api = String(args.api || DEFAULT_API).replace(/\/$/, '')

    if (args.list) { await printGeoBrands(api); return }

    // 品牌清单在服务端（出自 Social Hub 的 IP 矩阵）。--q / --domain / --competitors
    // 给了就用给的，没给就从清单里取 —— 这样「测山鬼映画」是一条命令，
    // 而不是每次手抄一遍问题清单（抄错一次，数字就白测了）。
    if (!questions.length || !domain || !competitors.length) {
      const reg = await fetchGeoBrand(api, brand)
      if (reg) {
        if (!brand) brand = reg.brand
        if (!questions.length) questions = reg.questions || []
        if (!domain) domain = reg.domain || ''
        if (!competitors.length) competitors = reg.competitors || []
        if (reg.category && !args.q) console.error(`📋 ${reg.brand} · ${reg.category}（问题清单取自 Social Hub）`)
      }
    }

    if (!brand) {
      console.error('❌ GEO 要 --brand')
      console.error('   可用品牌：scorecard geo --list')
      process.exit(1)
    }
    if (!questions.length) {
      console.error(`❌ 「${brand}」没有问题清单 —— 加 --q "用户会真的问的品类问题"`)
      console.error('   必须是品类问题不是品牌词：问「X 怎么样」模型会顺着你的问题去提它，数字好看但一文不值')
      process.exit(1)
    }
    if (!domain) console.error('⚠️  没给 --domain，「引用率」这一维会标无法核实')
    if (!competitors.length) console.error('⚠️  没给 --competitors，「竞品份额」这一维会标无法核实')
    if (!provider) console.error('⚠️  没给 --provider，按本机就绪情况自动选（一个都没配就落到 offline）')

    const params = new URLSearchParams({ type: 'geo', brand, domain, q: questions.join(',') })
    if (competitors.length) params.set('competitors', competitors.join(','))
    if (provider && provider !== 'auto') params.set('provider', provider)

    // GEO 每次调用都花钱，所以这里不传 fresh —— 服务端本来就不缓存它，
    // 传了反而像是在说「缓存是可以绕过的」，而实际上它压根不参与缓存。
    if (args.md) {
      const r = await fetch(`${api}/api/scorecard/report.md?${params}`, { signal: AbortSignal.timeout(180000) })
      const text = await r.text()
      if (!r.ok) { console.error(`❌ ${text.slice(0, 300)}`); process.exit(1) }
      console.log(text)
      return
    }

    let payload
    try {
      const r = await fetch(`${api}/api/scorecard?${params}`, { signal: AbortSignal.timeout(180000) })
      payload = await r.json()
    } catch (e) {
      console.error(`❌ 请求 ${api} 失败：${e.message}`)
      console.error('   自建实例可用 --api 或环境变量 SCORECARD_API 指过去')
      process.exit(1)
    }
    if (payload.error) { console.error(`❌ ${payload.error}`); process.exit(1) }
    const g = payload.report || payload
    if (args.json) { console.log(JSON.stringify(g, null, 2)); return }

    // 离线 fixture 必须先说，再说数字。反过来的话，人第一眼记住的是那个假分数。
    if (g.offline) {
      console.log('\n  ⚠️  离线样例（假数据）—— 本机没配 LLM key，这一份不能拿去汇报')
    }
    console.log(`\n  ${g.project}   ${Number(g.score).toFixed(1)} 分 · ${g.band || ''}  [GEO · provider ${g.provider}]\n`)
    for (const d of g.dims || []) {
      // 无法核实的维度必须显式打出来。留空或画成 0 格，等于把「没测」说成「得了 0 分」。
      if (d.score == null) { console.log(`  ${String(d.name).padEnd(8, '　')}   ——   （无法核实）`); continue }
      console.log(`  ${String(d.name).padEnd(8, '　')} ${String(d.score).padStart(4)}  ${bar(d.score)}`)
      for (const x of (d.gaps || []).slice(0, 3)) console.log(`             ↳ ${x}`)
    }
    const notes = (g.dims || []).flatMap((d) => (d.manual || []).slice(0, 1).map((m) => `[${d.name}] ${m}`))
    if (notes.length) {
      console.log('')
      for (const n of notes) console.log(`  ℹ️  ${n}`)
    }
    if (g.failures?.length) console.log(`\n  ⚠️  ${g.failures.length} 个问题没跑成功，已从分母里剔除（不是算作没提及）`)

    if (args.min !== undefined) {
      const min = Number(args.min)
      if (Number.isNaN(min)) { console.error('\n❌ --min 需要一个数字'); process.exit(1) }
      // 拿 fixture 当闸门比不设闸门更糟：它会让 CI 稳定地绿（或稳定地红），
      // 而那个颜色跟你的真实可见度毫无关系。宁可让这条命令直接失败。
      if (g.offline) {
        console.error('\n❌ --min 不能用在离线样例上 —— 它是一份假数据，通过或不通过都没有意义')
        console.error('   配上 SCORECARD_GEO_*_KEY 跑真实 provider 再用闸门')
        process.exit(1)
      }
      if (Number(g.score) < min) { console.error(`\n❌ ${g.score} 分 < 闸门 ${min} 分`); process.exit(1) }
      console.log(`\n✅ ${g.score} 分 ≥ 闸门 ${min} 分`)
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
