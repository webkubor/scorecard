#!/usr/bin/env node
/**
 * 八维定义一致性 —— 引擎和 skill 必须说同一套话。
 *
 * `server/audit.js` 的头部注释自己写了这条风险：
 *   「评分标准不是这里发明的，照搬 project-maturity-audit skill…
 *     否则面板给 7 分、skill 给 4 分，人就不知道该信谁了。」
 *
 * 在 2026-08-20 之前，这个风险是**结构性**的：引擎在 gham 仓库、skill 在
 * webkubor/project-maturity-audit 仓库，两份平行的文字，改一边不会惊动另一边。
 * 当天实测两边八个维度还完全对应——但那是运气，不是机制。
 *
 * skill 并进本仓库后，这个检查把「运气」换成「机制」：维度名对不上就报错。
 * 引擎是权威（代码跑出来的分数以它为准），skill 跟着它走。
 *
 *   node scripts/check-dimensions.mjs           # 报告
 *   node scripts/check-dimensions.mjs --strict  # 不一致就 exit 1
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = process.argv.includes('--strict')

const audit = readFileSync(join(ROOT, 'server/audit.js'), 'utf8')
const skill = readFileSync(join(ROOT, 'skills/project-maturity-audit/SKILL.md'), 'utf8')

// 引擎里的维度是数据，直接取；顺序就是面板上的顺序
const engine = [...audit.matchAll(/key: '([a-z]+)', name: '([^']+)'/g)]
  .map((m) => ({ key: m[1], name: m[2] }))

if (engine.length !== 8) {
  console.error(`❌ 从 server/audit.js 只解析出 ${engine.length} 个维度，期望 8 个。`)
  console.error('   要么维度真的增减了（那就同步改 skill 和这个脚本），要么写法变了导致正则失效。')
  process.exit(1)
}

// skill 是散文，只能按中文名找。这也是为什么权威在引擎那边——
// 散文里的名字可以有多种说法，代码里的 key 只有一个
const missing = engine.filter((d) => !skill.includes(d.name))

console.log('引擎八维：' + engine.map((d) => `${d.name}(${d.key})`).join(' · '))

if (!missing.length) {
  console.log('\n✅ skill 里都能找到对应维度，两边说的是同一套')
  process.exit(0)
}

console.log(`\n❌ skill 里找不到这 ${missing.length} 个维度：`)
for (const d of missing) console.log(`   · ${d.name}（${d.key}）`)
console.log('\n引擎是权威（面板分数由它算出）。skill 要么补上这些维度的判断标准，')
console.log('要么说明为什么它不覆盖——两边说不同的话，用户就不知道该信哪个分数。\n')
process.exit(STRICT ? 1 : 0)
