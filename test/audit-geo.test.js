// GEO 引擎契约测试 —— 不需要任何 API key。
//
// 判据按前三路同构：只测「能不能测」的结构契约，不测具体分数。
// 特别注意两类假象，这里必须锁住：
//   ① 没配 key 时不能静默返回 0 分 —— 那会让「没跑」看起来像「跑过了但很烂」
//   ② 离线 fixture 与真实 provider 的结果不可比 —— 混进同一条趋势就是骗人
import { test } from 'bun:test'
import { auditGeo, geoProviderStatus, reportMarkdown, hydrateGeo, resolveGeoProvider, mentions, magpieAvailable, magpieAsk, harvestSearchUrls, harvestInlineUrls } from '../server/audit-geo.js'

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
test('「自动」provider 必须真的自动 —— 空串不能落到「未知 provider」', () => {
  // 症状是调用方说「自动」，拿回一个报错。auditGeo 的形参默认值只在 undefined
  // 时生效，所以空串会一路走到 `PROVIDERS['']` 那里。
  const fake = { SCORECARD_GEO_OPENAI_KEY: 'x' }
  if (resolveGeoProvider('', fake) !== 'openai') throw new Error('有就绪的必须选它')
  if (resolveGeoProvider('auto', fake) !== 'openai') throw new Error('auto 要等价于空')
  if (resolveGeoProvider('gemini', fake) !== 'gemini') throw new Error('显式指定的不能被改写')

  // 一个都没就绪 → offline，不是报错：线上实例故意不配 key，
  // 它要给的是「报告长什么样」，不是一个红色错误框。
  const picked = resolveGeoProvider('', NO_ENV)
  if (picked !== 'offline') throw new Error(`没 key 时该落到 offline，实际 ${picked}`)

  // offline 本身必须能被 auditGeo 接住 —— 否则「落到 offline」只是把报错换了个位置。
  return auditGeo({ brand: 'x', questions: ['q'], provider: picked, env: NO_ENV })
    .then((r) => { if (r.error || !r.offline) throw new Error(`offline 跑不通：${r.error}`) })
})

test('空 provider 经由 resolveGeoProvider 之后能直接跑通（回归：CLI 的默认路径）', async () => {
  const provider = resolveGeoProvider('', NO_ENV)
  const r = await auditGeo({ brand: 'acmetest', questions: ['有哪些好用的工具'], provider, env: NO_ENV })
  if (r.error) throw new Error(`CLI 默认路径会失败：${r.error}`)
  if (r.score == null) throw new Error('offline 必须给出分数，否则报告页是空的')
})

// ─────────────────────────────────────────────────────────────────────────
// magpie 网关适配器的护栏。
//
// 这些测试的共同点：全部不需要网关在线。护栏的价值恰恰在于「网关挂了也拦得住」——
// 真出事的时候（打到 claude 池烧了会话额度、线上连上了本机网关），
// 网关本身通常是好的，坏的是配置。
// ─────────────────────────────────────────────────────────────────────────

const MAGPIE_ENV = {
  SCORECARD_GEO_MAGPIE_BASE: 'http://127.0.0.1:3425',
  SCORECARD_GEO_MAGPIE_KEY: 'test-key',
  SCORECARD_GEO_MAGPIE_ALLOW_LOCAL: '1',
}

test('禁用 claude/* 池 —— GEO 跑一次就烧一次写代码的额度', async () => {
  const env = { ...MAGPIE_ENV, SCORECARD_GEO_MAGPIE_MODEL: 'claude/claude-opus-5-5' }
  // 1) 不能报成「可用」——报 ready 再一跑就炸，比直接说不可用更差
  if (magpieAvailable(env)) throw new Error('claude/* 池不能被报成 ready')
  // 2) 真被指到时，ask 必须拒绝而不是发请求出去
  let threw = null
  try { await magpieAsk(env, '有哪些好用的工具') } catch (e) { threw = e }
  if (!threw) throw new Error('claude/* 池必须被拒绝')
  if (!/Claude Code 会话额度/.test(threw.message)) throw new Error(`错误要说清代价：${threw.message}`)
})

test('拒绝 group/* 动态路由组 —— 趋势线量的必须是同一个东西', async () => {
  const env = { ...MAGPIE_ENV, SCORECARD_GEO_MAGPIE_MODEL: 'group/mian-model-group' }
  let threw = null
  try { await magpieAsk(env, '有哪些好用的工具') } catch (e) { threw = e }
  if (!threw) throw new Error('group/* 必须被拒绝')
  if (!/动态路由组/.test(threw.message)) throw new Error(`错误要说清代价：${threw.message}`)
})

test('线上不许连本机网关 —— 没开二次确认就不给跑', () => {
  // 生产在 nanzhu，网关在 Mac 的 127.0.0.1。这里模拟「生产上误配了 base」：
  // 光配了 base 不够，必须还有 ALLOW_LOCAL=1 才放行。
  if (magpieAvailable({ SCORECARD_GEO_MAGPIE_BASE: 'http://127.0.0.1:3425', SCORECARD_GEO_MAGPIE_KEY: 'k' })) {
    throw new Error('loopback 网关没二次确认就放行了')
  }
  if (!magpieAvailable(MAGPIE_ENV)) throw new Error('明确确认后应该可用')
})

test('非 loopback 的 base 配了 ALLOW_LOCAL 反而要拒绝 —— 二次确认是给本机用的', async () => {
  const env = { ...MAGPIE_ENV, SCORECARD_GEO_MAGPIE_BASE: 'https://gateway.example.com' }
  let threw = null
  try { await magpieAsk(env, 'q') } catch (e) { threw = e }
  if (!threw || !/只认 loopback/.test(threw.message)) {
    throw new Error(`公网地址 + ALLOW_LOCAL 应被拒：${threw ? threw.message : '没有拒绝'}`)
  }
})

// ↓ 以下是「网关适配器对完设计文档」之后补的回归锁。每一个都对应一个当场复现过的缺陷。

test('公网/LAN base 配了 key 也一律不放行 —— 守卫曾经是反的', () => {
  // 这条曾经写反：判断是 `是 loopback 且没二次确认 才拒绝`，
  // 等于「只要不是 loopback 就放行」。于是公网地址配个 key 就 ready，
  // 免登录的 /api/scorecard?type=geo= 会从生产发出计费请求。
  for (const base of ['https://gateway.example.com', 'http://192.168.1.9:3425']) {
    if (magpieAvailable({ SCORECARD_GEO_MAGPIE_BASE: base, SCORECARD_GEO_MAGPIE_KEY: 'k' })) {
      throw new Error(`${base} 不该放行 —— 生产会从这里发出计费请求`)
    }
    if (magpieAvailable({ SCORECARD_GEO_MAGPIE_BASE: base, SCORECARD_GEO_MAGPIE_KEY: 'k', SCORECARD_GEO_MAGPIE_ALLOW_LOCAL: '1' })) {
      throw new Error(`${base} 配了 ALLOW_LOCAL 也不该放行 —— ALLOW_LOCAL 不是万能钥匙`)
    }
  }
})

test('0.0.0.0 不算 loopback —— 那是本机所有网卡，局域网够得着', () => {
  if (magpieAvailable({ SCORECARD_GEO_MAGPIE_BASE: 'http://0.0.0.0:3425', SCORECARD_GEO_MAGPIE_KEY: 'k', SCORECARD_GEO_MAGPIE_ALLOW_LOCAL: '1' })) {
    throw new Error('0.0.0.0 是所有网卡不是回环，放行等于开放给局域网')
  }
})

test('禁用池不能被报成 ready —— 报 ready 再一跑就炸', () => {
  for (const model of ['claude/claude-opus-5-5', 'group/mian-model-group', 'opencode-zen-free/big-pickle']) {
    if (magpieAvailable({ ...MAGPIE_ENV, SCORECARD_GEO_MAGPIE_MODEL: model })) {
      throw new Error(`${model} 不能报 ready`)
    }
  }
})

test('默认模型必须是实测能跑通的那一路', () => {
  // 上一个默认 modelgo-gateway/gpt-5.4 实测 HTTP 200 + 空 content + 白烧 1500 token：
  // 每一道题都失败，每一道都计费。看起来配好了，跑起来只是全灭。
  const m = geoProviderStatus({}).find((p) => p.id === 'magpie')
  if (m.model !== 'modelgo-gateway/claude-haiku-5.5') {
    throw new Error(`默认模型是 ${m.model} —— 必须是实测 4/4 会调用 web_search 的那一路`)
  }
  if (m.model.startsWith('claude/') || m.model.startsWith('group/')) {
    throw new Error('默认模型不能落在禁用池里')
  }
})

test('text.citations[] 也是强证据 —— 丢掉真证据比拿不到更糟', () => {
  // 实测 claude-haiku-5.5 每次都返回结构化 citations[]（一次 3~7 条）。
  // 之前只认 web_search_tool_result，把这些整个丢了：引用率会系统性偏低，
  // 而偏低会被读成「AI 不引用你」—— 实际上它引用了。
  const content = [
    { type: 'text', text: '推荐 museav。', citations: [
      { type: 'web_search_result_location', url: 'https://museav.com/pricing', title: '定价' },
    ] },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
  ]
  if (!harvestSearchUrls(content).includes('https://museav.com/pricing')) {
    throw new Error('结构化 citation 被丢了')
  }
})

test('品牌名按词边界判，不按子串 —— 误判全都朝高估偏', () => {
  const bad = [
    ['推荐 N1和M1 两个方案', [], 'N1', '', 'mentioned'],       // N1 嵌在编号里
    ['推荐 museum 展览', [], 'muse', '', 'mentioned'],          // muse 是 museum 的一部分
  ]
  for (const [text, cites, brand, dom, field] of bad) {
    if (mentions(text, cites, brand, dom)[field]) {
      throw new Error(`「${text}」不该算提到了 ${brand} —— 子串匹配会让分数虚高`)
    }
  }
  if (!mentions('推荐 museav 很好用', [], 'museav').mentioned) throw new Error('真提及不能被漏掉')
})

test('域名按 hostname 比，不按整串比', () => {
  const bad = [
    ['https://not-ai.com/x', 'ai.com'],       // 子域名前缀撞车
    ['https://evil.com/?r=museav.com', 'museav.com'], // 查询串里带你的域名
    ['https://museav.com.evil.com/x', 'museav.com'],  // 域名后缀挂在你后面
  ]
  for (const [url, dom] of bad) {
    if (mentions('x', [url], 'museav', dom).cited) {
      throw new Error(`${url} 不该算引用了 ${dom}`)
    }
  }
  // 真引用和子域名必须仍然算数：子域名确实是你在引用自己
  if (!mentions('推荐 museav', ['https://museav.com/x'], 'museav', 'museav.com').cited) {
    throw new Error('真引用被漏掉了')
  }
  if (!mentions('推荐 museav', ['https://blog.museav.com/x'], 'museav', 'museav.com').cited) {
    throw new Error('子域名算命中是对的')
  }
})

test('模型压根没调用 web_search 时，引用率是无法核实而不是 0%', async () => {
  // 实测 deepseek-v4-pro 会回一段像模像样的正文、HTTP 200、从不用检索工具。
  // 那种情况下报「引用率 0%」是把「它没搜」记成「没人引用你」——
  // 一个是量具没通电，一个是读数低。两者混同，整个工具就失去了意义。
  const q = '有哪些好用的 AI 视频生成工具'
  const r = await auditGeo({
    brand: 'museav', domain: 'museav.com', competitors: ['runway'], questions: [q],
    provider: 'fake', env: {},
    adapter: {
      async ask() {
        return { text: '常见的有 Runway、Pika、museav 等。', citations: [], searchInvoked: false, routedModel: 'fake/lazy' }
      },
    },
  })
  const cite = r.dims.find((d) => d.key === 'citation')
  if (cite.score !== null || cite.unverifiable !== 1) {
    throw new Error(`没检索过就该标无法核实，实际拿到 score=${cite.score}`)
  }
  if (!/没调用 web_search/.test(cite.gaps.join(' '))) {
    throw new Error(`要说清是「没搜」不是「没被引用」：${JSON.stringify(cite.gaps)}`)
  }
  // 提及不依赖检索，必须照常给分
  const mention = r.dims.find((d) => d.key === 'mention')
  if (mention.score === null) throw new Error('提及率不依赖检索，不该跟着变成无法核实')
})

test('引用分两档：正文手写的 URL 不算强证据', () => {
  // 模型自己在正文里写出你的域名 ≠ 它检索到了你。这两者的差别就是幻觉与可见度的差别。
  const weak = mentions('推荐 museav（详见 https://museav.com）', [], 'museav', 'museav.com',
    ['https://museav.com'])
  if (weak.cited) throw new Error('正文裸 URL 不得算作强引用')
  if (!weak.inlineCited) throw new Error('但要标出来它是弱证据')
  if (!weak.mentioned) throw new Error('正文出现品牌名仍然算提及')

  const strong = mentions('推荐 museav', ['https://museav.com/x'], 'museav', 'museav.com', [])
  if (!strong.cited) throw new Error('检索来源里的 URL 必须算强引用')
})

test('空 content 算这一路失败，不算「没提到品牌」', async () => {
  // 实测该网关会让某些模型回 HTTP 200 + 空 content 数组。若不拦，
  // 它会进分母变成「问到了但你没出现」—— 把网关故障说成品牌不可见。
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ type: 'message', model: 'x/y', content: [] }),
  })
  try {
    let threw = null
    try { await magpieAsk(MAGPIE_ENV, '有哪些好用的工具') } catch (e) { threw = e }
    if (!threw) throw new Error('空 content 必须算失败')
    if (!/计为失败/.test(threw.message)) throw new Error(`要说清是失败不是没提到：${threw.message}`)
  } finally { globalThis.fetch = realFetch }
})

test('检索来源与正文 URL 要分开收 —— 证据强度不同', () => {
  const content = [
    { type: 'text', text: '推荐 museav，详见 https://museav.com/about 另见 https://example.com' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', url: 'https://museav.com/pricing', title: '定价' }] },
  ]
  const strong = harvestSearchUrls(content)
  const weak = harvestInlineUrls(content.find((b) => b.type === 'text').text)
  if (!strong.includes('https://museav.com/pricing')) throw new Error('检索来源里的 URL 必须收进强证据')
  if (strong.includes('https://museav.com/about')) throw new Error('正文裸 URL 不得混进强证据')
  if (!weak.includes('https://museav.com/about')) throw new Error('正文裸 URL 要收进弱证据')
  if (!weak.includes('https://example.com')) throw new Error('正文里的第三方 URL 也要收')
})
