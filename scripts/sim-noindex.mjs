/**
 * 回归测试：noindex 检测对 SEO 评分的修正。
 *
 * 三个 case 必须符合预期，否则引擎行为坏掉：
 *   1. 测试站没声明 noindex → canonical 冲突应扣分（SEO 8.5）
 *   2. 测试站声明了 noindex → canonical 冲突撤销、改标注"已声明 noindex"（SEO 9.5）
 *   3. 官网保持现状 → noindex: false，评分不受影响
 *
 * 跑法：bun scripts/sim-noindex.mjs
 */
import { auditPage } from '../server/audit-page.js'

const TEST_URL = 'https://global-web.test.modelgo.com/'
const PROD_URL = 'https://modelgo.ai/'

/** 通过全局 fetch 注入 noindex，模拟"测试站已部署 noindex"的状态 */
async function runWithInjection(url, injectNoindex) {
  const orig = globalThis.fetch
  globalThis.fetch = async (u, opts) => {
    const res = await orig.call(globalThis, u, opts)
    const ct = res.headers.get('content-type') || ''
    if (String(u) === url && ct.includes('text/html') && injectNoindex) {
      let text = await res.text()
      // 强制注入，去掉旧的 robots meta 避免重复
      text = text.replace(/<meta\s+(?:[^>]*?\s+)?name\s*=\s*["']robots["'][^>]*\/?>/i, '')
      text = text.replace(/<head([^>]*)>/, '$&<meta name="robots" content="noindex">')
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    return res
  }
  const r = await auditPage({ url })
  globalThis.fetch = orig
  return r
}

function show(label, r) {
  const seo = r.dims.find(d => d.key === 'seo')
  console.log(`${label.padEnd(28)}  noindex: ${String(r.noindex).padEnd(5)}  SEO: ${seo.score}/10`)
  for (const e of seo.evidence.slice(0, 3)) console.log(`   ✓ ${e}`)
  const gaps = seo.gaps.filter((g) => /canonical|og:image/.test(g))
  for (const g of gaps) console.log(`   ✗ ${g}`)
}

console.log('=== 回归：noindex 检测 ===\n')
show('测试站 · 无 noindex', await runWithInjection(TEST_URL, false))
console.log()
show('测试站 · 加 noindex', await runWithInjection(TEST_URL, true))
console.log()
show('官网 · 应不受影响', await runWithInjection(PROD_URL, false))
console.log()

// 硬断言：发现回归就 exit 1
async function assertCase(label, url, inject, expected) {
  const r = await runWithInjection(url, inject)
  const seo = r.dims.find(d => d.key === 'seo')
  const pass = (
    r.noindex === expected.noindex &&
    seo.score === expected.seoScore &&
    !!(seo.evidence.find(e => e.includes('已声明 noindex'))) === expected.noindexInEvidence
  )
  console.log(`  ${pass ? '✅' : '❌'} ${label}  (期望 noindex=${expected.noindex} SEO=${expected.seoScore})`)
  if (!pass) process.exitCode = 1
}

console.log('=== 断言 ===\n')
await assertCase('测试站 · 无 noindex', TEST_URL, false, { noindex: false, seoScore: 8.5, noindexInEvidence: false })
await assertCase('测试站 · 加 noindex', TEST_URL, true,  { noindex: true,  seoScore: 9.5, noindexInEvidence: true  })
await assertCase('官网 · 应不受影响',   PROD_URL, false, { noindex: false, seoScore: 9.5, noindexInEvidence: false })