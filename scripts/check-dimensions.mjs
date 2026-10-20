#!/usr/bin/env node
/**
 * 九维定义一致性 —— 引擎和 skill 必须说同一套话。
 *
 * `server/audit.js` 的头部注释自己写了这条风险：
 *   「评分标准不是这里发明的，照搬 project-maturity-audit skill…
 *     否则面板给 7 分、skill 给 4 分，人就不知道该信谁了。」
 *
 * 在 2026-08-20 之前，这个风险是**结构性**的：引擎在 gham 仓库、skill 在
 * webkubor/project-maturity-audit 仓库，两份平行的文字，改一边不会惊动另一边。
 * 当天实测两边九个维度还完全对应——但那是运气，不是机制。
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

// 门面新增的元数据判据也需在 skill 中明确，避免仅维度名一致、判据却漂移。
for (const criterion of ['description', 'topics', '关键词', '人工']) {
  if (!skill.includes(criterion)) {
    console.error(`❌ skill 缺少元数据判据说明：${criterion}`)
    process.exit(1)
  }
}

// 引擎里的维度是数据，直接取；顺序就是面板上的顺序
const engine = [...audit.matchAll(/key: '([a-z]+)', name: '([^']+)'/g)]
  .map((m) => ({ key: m[1], name: m[2] }))

// 这里原本硬编码「必须等于 9」。那条检查在两件事上都是错的：
//   ① 加维度是正常演进，不该被门禁挡住 —— 挡人的门禁最后会被绕过；
//   ② 它把「正则没匹配上」和「维度真的变了」混成同一个错误，看不出是哪种。
// 改为只守真正的不变量：能解析出维度、key 不重复、skill 覆盖得到。
if (engine.length === 0) {
  console.error('❌ 从 server/audit.js 解析不出任何维度 —— 正则失效或写法变了。')
  process.exit(1)
}

const dupKeys = engine.map((d) => d.key).filter((k, i, a) => a.indexOf(k) !== i)
if (dupKeys.length) {
  console.error(`❌ 引擎里有重复的维度 key：${[...new Set(dupKeys)].join(', ')}`)
  console.error('   重复 key 会让前端按 key 渲染的列表串位。')
  process.exit(1)
}

// skill 是散文，只能按中文名找。这也是为什么权威在引擎那边——
// 散文里的名字可以有多种说法，代码里的 key 只有一个
const missing = engine.filter((d) => !skill.includes(d.name))

console.log(`引擎 ${engine.length} 维：` + engine.map((d) => `${d.name}(${d.key})`).join(' · '))

if (!missing.length) {
  console.log('\n✅ skill 里都能找到对应维度，两边说的是同一套')
  process.exit(0)
}

console.log(`\n❌ skill 里找不到这 ${missing.length} 个维度：`)
for (const d of missing) console.log(`   · ${d.name}（${d.key}）`)
console.log('\n引擎是权威（面板分数由它算出）。skill 要么补上这些维度的判断标准，')
console.log('要么说明为什么它不覆盖——两边说不同的话，用户就不知道该信哪个分数。\n')
process.exit(STRICT ? 1 : 0)
