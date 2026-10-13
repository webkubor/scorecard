// GEO 引擎契约测试 —— 不需要任何 API key。
//
// 判据按前三路同构：只测「能不能测」的结构契约，不测具体分数。
// 特别注意两类假象，这里必须锁住：
//   ① 没配 key 时不能静默返回 0 分 —— 那会让「没跑」看起来像「跑过了但很烂」
//   ② 离线 fixture 与真实 provider 的结果不可比 —— 混进同一条趋势就是骗人
import { test } from 'bun:test'
import { auditGeo, geoProviderStatus, reportMarkdown, hydrateGeo } from '../server/audit-geo.js'

const QUESTIONS = ['有哪些好用的 AI 视频生成工具', '有哪些能批量做小红书内容的工具']
const NO_ENV = {}

test('缺品牌 / 缺问题都不给分数 —— 「没跑」不能长得像「跑了但很烂」', async () => {
  const noBrand = await auditGeo({ brand: '', questions: QUESTIONS, provider: 'offline', env: NO_ENV })
  if (!noBrand.error || noBrand.score !== null) throw new Error('缺 brand 必须报错且无分数')

  const noQ = await auditGeo({ brand: 'museav', questions: [], provider: 'offline', env: NO_ENV })
  if (!noQ.error) throw new Error('缺 questions 必须报错')
  if (!/品牌词/.test(noQ.error)) throw new Error(`错误要说清为什么：${noQ.error}`)
})

test('没配 key 时明确说「要去哪配」，且绝不给分数', async () => {
  const r = await auditGeo({
    brand: 'museav', questions: QUESTIONS, provider: 'anthropic', env: NO_ENV,
  })
  if (r.score !== null) throw new Error('没 key 却给了分数 —— 这是最坏的一种假象')
  if (!/SCORECARD_GEO_ANTHROPIC_KEY/.test(r.error)) throw new Error(`错误必须点名要配的变量：${r.error}`)
})

test('离线模式跑通全链路，四维齐出且分数有界', async () => {
  const r = await auditGeo({
    brand: 'museav', domain: 'museav.com', questions: QUESTIONS,
    competitors: ['runway'], provider: 'offline', env: NO_ENV,
  })
  if (r.error) throw new Error(`离线不该报错：${r.error}`)
  if (!r.offline) throw new Error('离线报告必须标 offline，否则会被当成真实结论汇报')
  if (r.score == null || r.score < 0 || r.score > 10) throw new Error(`分数越界：${r.score}`)
  const keys = r.dims.map((d) => d.key)
  for (const k of ['mention', 'citation', 'share', 'sentiment']) {
    if (!keys.includes(k)) throw new Error(`缺维度 ${k}，实际有 ${keys}`)
  }
  for (const d of r.dims) {
    if (d.score != null && (d.score < 0 || d.score > 10)) throw new Error(`${d.key} 分数越界：${d.score}`)
    if (!d.name || !Array.isArray(d.evidence) || !Array.isArray(d.gaps)) {
      throw new Error(`${d.key} 缺 name/evidence/gaps，与前三路不同构`)
    }
  }
})

test('只认正文出现与引用域名两种证据；不给 LLM 自评开口子', async () => {
  const q = '有哪些好用的 AI 视频生成工具'
  // fixture 里 museav 出现且 museav.com 被引用 → 两项都该命中
  const hit = await auditGeo({ brand: 'museav', domain: 'museav.com', questions: [q], provider: 'offline', env: NO_ENV })
  const mention = hit.dims.find((d) => d.key === 'mention')
  const cite = hit.dims.find((d) => d.key === 'citation')
  if (mention.detail.rate !== 100) throw new Error(`fixture 里两处都该命中：${mention.detail.rate}%`)
  if (cite.detail.rate !== 100) throw new Error(`引用应命中：${cite.detail.rate}%`)

  // 没被提到的品牌 → 0%，且这必须是真的 0 分而不是「无法核实」
  const miss = await auditGeo({ brand: 'nonexistentbrandxyz', domain: '', questions: [q], provider: 'offline', env: NO_ENV })
  const m2 = miss.dims.find((d) => d.key === 'mention')
  if (m2.detail.rate !== 0) throw new Error(`未被提及应为 0%：${m2.detail.rate}`)
})

test('缺 domain 时引用率标「无法核实」而非 0 分 —— 两者含义完全不同', async () => {
  const r = await auditGeo({
    brand: 'museav', domain: '', questions: QUESTIONS, provider: 'offline', env: NO_ENV,
  })
  const cite = r.dims.find((d) => d.key === 'citation')
  if (cite.score !== null) throw new Error('没 domain 就不该给引用率分数')
  if (cite.unverifiable !== 1) throw new Error('必须标 unverifiable')
  if (!r.inconclusiveDims.includes('引用率')) throw new Error('要进 inconclusiveDims')
  if (!cite.gaps.some((g) => /domain/.test(g))) throw new Error('要告诉用户补什么才能测这维')
})

test('没给竞品时份额维标无法核实 —— 单看提及率会被「品类小」的错觉骗过去', async () => {
  const r = await auditGeo({
    brand: 'museav', domain: 'museav.com', questions: QUESTIONS, competitors: [], provider: 'offline', env: NO_ENV,
  })
  const share = r.dims.find((d) => d.key === 'share')
  if (share.score !== null) throw new Error('没竞品就不该给份额分数')
  if (!share.gaps.length) throw new Error('要说明为什么这维重要')
})

test('问的问题清单必须跟着结果存 —— 趋势页要能回答「这周问的还是那几道题吗」', async () => {
  const r = await auditGeo({
    brand: 'museav', domain: 'museav.com', questions: QUESTIONS, competitors: ['runway'],
    provider: 'offline', env: NO_ENV,
  })
  if (JSON.stringify(r.questions) !== JSON.stringify(QUESTIONS)) throw new Error('questions 没带出来')
  if (!r.provider) throw new Error('provider 必须带出来')
})


test('markdown 报告：离线报告必须显眼标「假数据」，且带可照抄的 prompt', async () => {
  const r = await auditGeo({
    brand: 'museav', domain: 'museav.com', questions: QUESTIONS, competitors: ['runway'],
    provider: 'offline', env: NO_ENV,
  })
  const md = reportMarkdown(r)
  if (!/离线 fixture/.test(md)) throw new Error('离线报告必须标出是假数据，否则会被人当结论汇报')
  if (!/museav/.test(md)) throw new Error('要写清测的是谁')
  if (!/交给 AI 就能开工/.test(md)) throw new Error('要保留「一键交 AI」的交付物')
  if (!/影响大且改动成本低/.test(md)) throw new Error('prompt 里要带排序判据')
})

test('hydrateGeo 能把库里的行还原成能出报告的形状', () => {
  const row = {
    projectId: 'museav', ts: '2026-10-13T00:00:00.000Z', score: 6.5, band: '偶尔出现，位置不稳',
    stars: 0, dims: '[]', todos: '[]',
    meta: JSON.stringify({ provider: 'anthropic', offline: false, domain: 'museav.com' }),
  }
  const h = hydrateGeo(row, 'museav')
  if (h.targetType !== 'geo' || h.type !== 'geo') throw new Error('type/targetType 要标成 geo')
  if (h.domain !== 'museav.com') throw new Error('meta 没摊开')
  if (!Array.isArray(h.dims) || !Array.isArray(h.todos)) throw new Error('dims/todos 要还原成数组')
  if (h.offline !== false) throw new Error('离线标记要区分 false 与 undefined')
})

test('provider 状态只给变量名，绝不回显 key', () => {
  const s = geoProviderStatus(NO_ENV)
  if (s.length < 3) throw new Error('至少要列 OpenAI / Anthropic / Gemini')
  for (const p of s) {
    if (!p.keyEnv) throw new Error(`缺 keyEnv：${p.id}`)
    if (JSON.stringify(p).includes('sk-')) throw new Error('状态接口泄露了 key')
    if (p.ready !== false) throw new Error(`${p.id} 在无 key 环境不该 ready`)
  }
})