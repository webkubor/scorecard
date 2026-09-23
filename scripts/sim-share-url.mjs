const BASE = 'http://127.0.0.1:54445'
let failed = 0

async function step(name, fn) {
  process.stdout.write(`▶ ${name} ... `)
  try { await fn(); console.log('✅') }
  catch (e) { console.log('❌', e.message); failed++ }
}

await step('1. ?share=&compare=&type= 返 SPA HTML', async () => {
  const r = await fetch(`${BASE}/?share=https%3A%2F%2Fexample.com&compare=https%3A%2F%2Fanthropic.com&type=page`)
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('text/html')) throw new Error(`content-type ${ct}`)
})

await step('2. hash #/compare?share=&compare= 返 SPA HTML', async () => {
  const r = await fetch(`${BASE}/#/compare?share=react&compare=vue&type=npm`)
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
})

await step('3. compare API 跑通 (type=npm react vs vue)', async () => {
  const r = await fetch(`${BASE}/api/scorecard/compare?type=npm&a=react&b=vue`)
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  if (j.a?.project !== 'react' || j.b?.project !== 'vue') throw new Error('目标错位')
  if (!j.diff?.dims?.length) throw new Error('diff 为空')
})

await step('4. dist bundle 含 compareShareUrl 生成函数', async () => {
  const fs = await import('node:fs')
  const assetName = fs.readdirSync('dist/assets').find(f => f.startsWith('index-') && f.endsWith('.js'))
  const js = fs.readFileSync(`dist/assets/${assetName}`, 'utf8')
  if (!js.includes('compareShareUrl')) throw new Error('未生成 compareShareUrl 函数')
  if (!/window\.location\.origin[^}]+\?[^}]+share/.test(js)) throw new Error('URL 形态不对')
  if (!/compare-copy-link/.test(js)) throw new Error('没生成 ops 日志 action')
})

await step('5. parseRoute 识别 share / compare 关键字', async () => {
  const fs = await import('node:fs')
  const assetName = fs.readdirSync('dist/assets').find(f => f.startsWith('index-') && f.endsWith('.js'))
  const js = fs.readFileSync(`dist/assets/${assetName}`, 'utf8')
  if (!js.includes("search.get('share')") || !js.includes("search.get('compare')")) {
    throw new Error('parseRoute 没识别 share/compare')
  }
})

await step('6. initialCompare prop + generateCompare 自动跑', async () => {
  const fs = await import('node:fs')
  const assetName = fs.readdirSync('dist/assets').find(f => f.startsWith('index-') && f.endsWith('.js'))
  const js = fs.readFileSync(`dist/assets/${assetName}`, 'utf8')
  if (!js.includes('initialCompare')) throw new Error('没接 initialCompare')
  if (!/generateCompare/.test(js)) throw new Error('没调 generateCompare')
})

console.log()
console.log(failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
