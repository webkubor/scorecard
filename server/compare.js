/**
 * 报告对比 —— 任意 type（GitHub / npm / 网页）两个报告横切，产出维度差分。
 *
 * 设计动机：测试 env vs 线上 env 这种用法里，单看两份报告没意义 —— 真正有用的是
 * 「同维度差多少」「谁独有这个 gap」。本模块做的就是这件事，不写库、不存历史，
 * 纯运行时计算；underlying 两个报告各自有缓存。
 *
 * 不假设两个报告 type 相同 —— 跨 type 比对会被拒绝（比如把 npm 包和 GitHub 仓库硬比
 * 没有意义），返回 null 让上层报错。
 */

const clamp = (n) => Math.max(0, Math.min(10, Math.round(n * 10) / 10))

/**
 * 对比两个报告。
 * @param {object} a  报告 A（来自 auditProject / auditPackage / auditPage）
 * @param {object} b  报告 B
 * @returns {object|null}  diff 结构；type 不匹配或 dims 维度集不一致时返回 null
 */
export function compareReports(a, b) {
  if (!a || !b) return null
  const aDims = a.dims || []
  const bDims = b.dims || []
  if (!aDims.length || !bDims.length) return null

  const byKey = (arr) => Object.fromEntries(arr.map((d) => [d.key, d]))
  const aMap = byKey(aDims)
  const bMap = byKey(bDims)
  const keys = Object.keys(aMap)
  // 维度集不一致 = 不是同类报告，按 null 算
  if (keys.length !== Object.keys(bMap).length || !keys.every((k) => k in bMap)) {
    return null
  }

  const dims = keys.map((key) => {
    const aDim = aMap[key]
    const bDim = bMap[key]
    const aScore = aDim.score
    const bScore = bDim.score
    const aGaps = new Set(aDim.gaps || [])
    const bGaps = new Set(bDim.gaps || [])
    const uniqueA = [...aGaps].filter((g) => !bGaps.has(g))
    const uniqueB = [...bGaps].filter((g) => !aGaps.has(g))
    const shared = [...aGaps].filter((g) => bGaps.has(g))
    let winner = 'tie'
    if (aScore != null && bScore != null) {
      if (aScore > bScore + 0.1) winner = 'a'
      else if (bScore > aScore + 0.1) winner = 'b'
    } else if (aScore != null) winner = 'a'
    else if (bScore != null) winner = 'b'
    return {
      key,
      name: aDim.name,
      aScore,
      bScore,
      delta: round((bScore ?? 0) - (aScore ?? 0)),
      winner,
      // 只在一方出现的 evidence（说明另一方做得更好）
      uniqueEvidences: {
        a: (aDim.evidence || []).filter((e) => !(bDim.evidence || []).includes(e)),
        b: (bDim.evidence || []).filter((e) => !(aDim.evidence || []).includes(e)),
      },
      uniqueGaps: { a: uniqueA, b: uniqueB },
      sharedGaps: shared,
    }
  })

  // 谁缺多少独有 gap —— 这是上线 / 测试差在哪的最直接信号
  const gapDelta = dims.reduce(
    (acc, d) => ({
      aOnly: acc.aOnly + d.uniqueGaps.a.length,
      bOnly: acc.bOnly + d.uniqueGaps.b.length,
    }),
    { aOnly: 0, bOnly: 0 }
  )

  return {
    totalDelta: round((b.score ?? 0) - (a.score ?? 0)),
    dims,
    summary: {
      aBetter: dims.filter((d) => d.winner === 'a').length,
      bBetter: dims.filter((d) => d.winner === 'b').length,
      tie: dims.filter((d) => d.winner === 'tie').length,
      aOnlyGaps: gapDelta.aOnly,
      bOnlyGaps: gapDelta.bOnly,
    },
  }
}

function round(n) {
  return Math.round(n * 10) / 10
}

/**
 * 对比报告的 Markdown 渲染 —— 直接喂给 AI 助手用的"测试 vs 线上"差距清单。
 */
export function compareMarkdown(a, b, diff, { site = '' } = {}) {
  if (!diff) return '# 对比失败：两份报告维度集不一致，可能不是同类目标。\n'
  const L = []
  const bar = (n) => '█'.repeat(Math.max(0, Math.round(n))) + '░'.repeat(10 - Math.max(0, Math.round(n)))

  L.push(`# 对比报告 · ${a.project}  ↔  ${b.project}`)
  L.push('')
  L.push(`**A: ${a.score} 分** · ${a.band} · ${a.project}`)
  L.push('')
  L.push(`**B: ${b.score} 分** · ${b.band} · ${b.project}`)
  L.push('')
  const arrow = diff.totalDelta > 0 ? '↗ B 领先' : diff.totalDelta < 0 ? '↘ B 落后' : '= 持平'
  L.push(`总分差 **${diff.totalDelta > 0 ? '+' : ''}${diff.totalDelta}** · ${arrow}`)
  L.push('')
  L.push(`A 独有 gap ${diff.summary.aOnlyGaps} 条 · B 独有 gap ${diff.summary.bOnlyGaps} 条`)
  L.push('')

  L.push('## 逐维度差分')
  L.push('')
  L.push('| 维度 | A | B | Δ | 胜负 |')
  L.push('|---|---:|---:|---:|---|')
  for (const d of diff.dims) {
    const winnerIcon = d.winner === 'a' ? '🅰️ 优' : d.winner === 'b' ? '🅱️ 优' : '🤝 平'
    L.push(`| ${d.name} | ${d.aScore ?? '—'} | ${d.bScore ?? '—'} | ${d.delta > 0 ? '+' : ''}${d.delta} | ${winnerIcon} |`)
  }
  L.push('')

  // 只列有独有 gap 的维度 —— 这是真正能落地的差异
  const actionable = diff.dims.filter((d) => d.uniqueGaps.a.length || d.uniqueGaps.b.length)
  if (actionable.length) {
    L.push('## B 独有、A 还没补的')
    L.push('')
    L.push('—— 把 B 的这一项补上，A 就能追上（或反之）。')
    L.push('')
    for (const d of actionable) {
      if (d.uniqueGaps.b.length) {
        L.push(`### ${d.name}`)
        for (const g of d.uniqueGaps.b) L.push(`- B 缺：${g}`)
        L.push('')
      }
    }
    L.push('## A 独有、B 还没补的')
    L.push('')
    for (const d of actionable) {
      if (d.uniqueGaps.a.length) {
        L.push(`### ${d.name}`)
        for (const g of d.uniqueGaps.a) L.push(`- A 缺：${g}`)
        L.push('')
      }
    }
  } else {
    L.push('两份报告的 gap 完全重合 —— 没有独有差距。')
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('## 把这份对比报告交给 AI')
  L.push('')
  L.push('复制整份对比报告，连同两个目标一起给 Claude Code / Cursor / Copilot，然后说：')
  L.push('')
  L.push('```')
  L.push('把 A 补到 B 的水准 —— 优先处理「B 独有、A 还没补」清单，每条改完告诉我')
  L.push('动了哪些文件、为什么这么改。')
  L.push('```')
  if (site) {
    L.push('')
    L.push(`> 本对比由 [Scorecard 开源项目质检](${site}) 生成。`)
  }
  return L.join('\n')
}