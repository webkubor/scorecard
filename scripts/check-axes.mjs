#!/usr/bin/env node
/**
 * 四路引擎的静态纪律守卫（维度层）。
 *
 * 为什么需要它：`check-dimensions.mjs` 只比对 GitHub 引擎与 skill 的维度名，
 * 而 npm / page / GEO 三路**没有 skill 副本**，等于完全不在门禁覆盖内。
 * 加了维度却漏写 evidence、漏过 normalizeDim、或者把 key 写重了，
 * 都可能在「分数看起来正常」的情况下悄悄上线。
 *
 * 这里只做读源码即可判定的静态检查，不跑引擎、不联网：
 *   ① 每路都能解析出维度，且 key 在本路内唯一
 *   ② 每个维度块里有「查不到」的显式表达，且分数经过归一化
 *   ③ 维度块里带 evidence / gaps / manual 证据字段
 *
 * 关于 ② 的两种合法写法（不是所有引擎都该长得一样）：
 *   · 判据式（github / npm / page）：满分 10 分制，逐条判据累加，查不到的
 *     用 `normalizeDim(score, unv)` 从分母里剔除。
 *   · 比率式（geo）：分数本来就是百分比折算（`clamp(rate / 10)`），没有「10 条
 *     判据」这个分母，所以它不该套 normalizeDim；但它必须显式给出
 *     `unverifiable` 标记，让「量具没通电」和「读数低」区分开。
 *   两种都合规，缺的是「既没归一化、也没 unverifiable」—— 那才是真违规。
 *
 *   node scripts/check-axes.mjs           # 报告
 *   node scripts/check-axes.mjs --strict  # 有问题 exit 1
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = process.argv.includes('--strict')

const ENGINES = [
  { file: 'server/audit.js', label: 'GitHub 仓库' },
  { file: 'server/audit-npm.js', label: 'npm 包' },
  { file: 'server/audit-page.js', label: '网页' },
  { file: 'server/audit-geo.js', label: 'GEO' },
]

const problems = []
const summary = []

for (const { file, label } of ENGINES) {
  const src = readFileSync(join(ROOT, file), 'utf8')

  // 维度定义形如 `key: 'xxx', name: '中文名'`。按出现位置切块，
  // 每块 = 该 key 到下一个 key 之间的源码，用来判断这个维度自己的写法。
  const matches = [...src.matchAll(/key: '([a-z0-9-]+)', name: '([^']+)'/g)]
  if (!matches.length) {
    problems.push(`${label}（${file}）：解析不出任何维度`)
    continue
  }

  const keys = matches.map((m) => m[1])
  const dup = [...new Set(keys.filter((k, i, a) => a.indexOf(k) !== i))]
  if (dup.length) problems.push(`${label}（${file}）：维度 key 重复 ${dup.join(', ')}`)

  let normalized = 0
  matches.forEach((m, i) => {
    const start = m.index
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length
    const block = src.slice(start, end)
    const key = m[1]

    // 两种合规写法：判据式走 normalizeDim；比率式显式给 unverifiable。
    // unverifiable 可能是 `unverifiable: 0`，也可能是简写 `unverifiable,` —— 都要认。
    const hasNormalize = block.includes('normalizeDim')
    const hasUnverifiable = /\bun(?:verifiable|verified)\s*[:,}]/.test(block)
    if (hasNormalize || hasUnverifiable) normalized += 1
    else {
      problems.push(
        `${label}（${file}）维度 ${key}：既没走 normalizeDim、也没给 unverifiable —— ` +
        '「查不到」会变成扣分，违背 unverifiable 纪律'
      )
    }

    if (!/evidence/.test(block)) {
      problems.push(`${label}（${file}）维度 ${key}：没有 evidence 字段 —— 每条结论必须有证据`)
    }
  })

  summary.push({ label, file, count: matches.length, normalized, keys })
}

console.log('四路引擎维度层检查：\n')
for (const s of summary) {
  const ok = s.normalized === s.count
  console.log(
    `  ${ok ? '✅' : '⚠️ '} ${s.label.padEnd(12)} ${String(s.count).padStart(2)} 维` +
    `  归一化 ${s.normalized}/${s.count}`
  )
  console.log(`     ${s.keys.join(' · ')}`)
}

if (!problems.length) {
  console.log('\n✅ 四路引擎的维度层纪律一致')
  process.exit(0)
}

console.log(`\n❌ 发现 ${problems.length} 个问题：\n`)
for (const p of problems) console.log(`   · ${p}`)
console.log('')
process.exit(STRICT ? 1 : 0)
