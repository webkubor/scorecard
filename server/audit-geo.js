// GEO 引擎 —— AI 搜索里的品牌可见性。
//
// 与前三路引擎的根本差别（2026-10-13 起）：
//   github / npm / page  = 读公开数据，零成本、零凭据、每次结果稳定
//   geo                  = 主动去问 LLM，每次都要付费，且同一问题两次答案会不同
//
// 所以 GEO 有两条硬约束：
//
// 1) **成本**：没有 key 就不能跑。线上实例不配 key，只读本地跑存下来的历史，
//    这样线上永远零花费 —— 形态与前三路不同是刻意的，不是没做完。
// 2) **可复现**：LLM 输出有随机性，一次实时查询拿不到趋势。趋势是这个产品全部的
//    价值，而趋势的前提是每次跑都留下来。所以结果一律入库，看趋势时读历史、不重问。
//    离线模式（无 key）用 fixture 跑通全链路，只保证结构正确、不代表真实可见性。
//
// 判据与前三路同构：只认证据（原文里有没有出现、引用里有没有你的域名），
// 不让 LLM 自己打分 —— 它说「我认为该品牌很知名」不算证据。

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions'

// 每个 provider 问的是「同样的用户问题」，不是「请评价这个品牌」——
// 后者会让模型主动去提它，测出来的数字是假的。
const ASK_TEMPLATE = (question) =>
  `${question}\n\n用两三句话直接回答，不要客套。`

function clamp(n) { return Math.max(0, Math.min(10, n)) }
function bandOf(score) {
  if (score >= 8) return { label: 'AI 里有存在感', hint: '多个问题被提及并带引用' }
  if (score >= 5) return { label: '偶尔出现，位置不稳', hint: '提到过但没进推荐位' }
  if (score >= 2) return { label: '几乎不被提及', hint: 'AI 答这些问题时不带你' }
  return { label: 'AI 里查不到你', hint: '所有问题都没有出现' }
}

/**
 * provider 适配。每个适配器只负责「把问题发出去，拿回 {text, citations}」，
 * 判据全在下面统一的 analyze 里 —— 否则四个 provider 的口径会各自漂移，
 * 跨 provider 比份额就成了假的。
 */
const PROVIDERS = {
  openai: {
    keyEnv: 'SCORECARD_GEO_OPENAI_KEY',
    model: 'gpt-4o-mini',
    available: (env) => Boolean(env.SCORECARD_GEO_OPENAI_KEY),
    async ask(env, question) {
      const r = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.SCORECARD_GEO_OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: ASK_TEMPLATE(question) }],
          temperature: 0,
          max_tokens: 500,
        }),
      })
      if (!r.ok) throw new Error(`openai HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const j = await r.json()
      return { text: j?.choices?.[0]?.message?.content || '', citations: [] }
    },
  },

  anthropic: {
    keyEnv: 'SCORECARD_GEO_ANTHROPIC_KEY',
    model: 'claude-haiku-4-5',
    available: (env) => Boolean(env.SCORECARD_GEO_ANTHROPIC_KEY),
    async ask(env, question) {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.SCORECARD_GEO_ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 500,
          temperature: 0,
          messages: [{ role: 'user', content: ASK_TEMPLATE(question) }],
        }),
      })
      if (!r.ok) throw new Error(`anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const j = await r.json()
      const text = (j?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      return { text, citations: [] }
    },
  },

  gemini: {
    keyEnv: 'SCORECARD_GEO_GEMINI_KEY',
    model: 'gemini-2.5-flash',
    available: (env) => Boolean(env.SCORECARD_GEO_GEMINI_KEY),
    async ask(env, question) {
      const r = await fetch(`${GEMINI_URL}/${this.model}:generateContent?key=${env.SCORECARD_GEO_GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: ASK_TEMPLATE(question) }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 500 },
        }),
      })
      if (!r.ok) throw new Error(`gemini HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const j = await r.json()
      const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || ''
      // groundingMetadata 里是它实际去搜了的来源 —— 这是「AI 引用了谁」的证据，
      // 不看它就等于只测了模型记忆。
      const citations = (j?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
        .map((c) => c?.web?.uri)
        .filter(Boolean)
      return { text, citations }
    },
  },

  perplexity: {
    keyEnv: 'SCORECARD_GEO_PERPLEXITY_KEY',
    model: 'sonar',
    available: (env) => Boolean(env.SCORECARD_GEO_PERPLEXITY_KEY),
    async ask(env, question) {
      const r = await fetch(PERPLEXITY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.SCORECARD_GEO_PERPLEXITY_KEY}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: ASK_TEMPLATE(question) }],
          temperature: 0,
        }),
      })
      if (!r.ok) throw new Error(`perplexity HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const j = await r.json()
      const text = j?.choices?.[0]?.message?.content || ''
      const citations = (j?.citations || []).filter(Boolean)
      return { text, citations }
    },
  },
}

// 离线 fixture —— 没有 key 时也能把结构跑通。明确标注这是假数据：
// 报告里会带 offline: true，UI 与 markdown 都要显眼标出「未接真实数据源」，
// 免得有人拿离线报告当成真结论去汇报。
const OFFLINE_FIXTURE = {
  provider: 'offline-fixture',
  answers: {
    '有哪些好用的 AI 视频生成工具': {
      text: '常见的有 Runway、Pika、museav 等，其中 Runway 在专业工作流里最成熟，museav 更适合中文短视频批量生产。',
      citations: ['https://runwayml.com', 'https://museav.com'],
    },
    '有哪些能批量做小红书内容的工具': {
      text: '小红书内容生产工具里，创客贴和 museav 常被提到，前者偏设计模板，后者偏批量投放。',
      citations: ['https://chuangkit.tencent.com', 'https://museav.com'],
    },
  },
}

/**
 * 品牌提及判据 —— 只认两种硬证据：
 *   ① 正文里出现品牌名（大小写不敏感）
 *   ② 引用 URL 里含品牌域名
 * 刻意不做的：让 LLM 自评「这个品牌是否知名」。模型会顺着你的问题去提它，
 * 那测出来的数字是假的 —— 看着好看，一分钱价值没有。
 */
function mentions(text, citations, brand, domain) {
  const hay = (text || '').toLowerCase()
  const nameHit = brand.toLowerCase().split(/\s+/).some((w) => w.length > 1 && hay.includes(w))
  const citeHit = Boolean(domain) && (citations || []).some((u) => u.includes(domain))
  const pos = hay.indexOf(brand.toLowerCase())
  return { mentioned: nameHit || citeHit, cited: citeHit, position: pos >= 0 ? pos : null }
}

function sentiment(text, brand) {
  // 极简三分类：看品牌名附近 120 字里有没有贬义词。刻意不做情感模型 ——
  // 一个 0-1 词的启发式，标成「未核实」比给个假精确的分数诚实。
  const idx = (text || '').toLowerCase().indexOf(brand.toLowerCase())
  if (idx < 0) return null
  const near = text.slice(Math.max(0, idx - 120), idx + 120).toLowerCase()
  const NEG = ['不推荐', '不好用', '差评', '缺点', '无法', '不支持', 'lacking', 'lacks', 'poor', 'weak', 'not recommended']
  const POS = ['推荐', '好用', '强大', '成熟', '领先', 'popular', 'excellent', 'great', 'leading', 'mature']
  const neg = NEG.filter((w) => near.includes(w)).length
  const pos = POS.filter((w) => near.includes(w)).length
  if (pos > neg) return '正面'
  if (neg > pos) return '负面'
  return '中性'
}

/**
 * GEO 主入口。
 * @param brand   品牌名，如 'museav'
 * @param domain  品牌自有域名，如 'museav.com' —— 有它才能判「引用」而非「提及」
 * @param questions 用户会真的问的问题（品类词，不是品牌词）
 * @param competitors 对手品牌名，用于算份额
 * @param provider offline 时不花钱、不发网络请求
 */
export async function auditGeo({ brand, domain = '', questions = [], competitors = [], provider = 'anthropic', env = process.env }) {
  const b = (brand || '').trim()
  if (!b) return { error: '缺 brand', score: null }
  if (!questions.length) return { error: '缺 questions —— GEO 问的是用户会问的品类问题，品牌词测出来没有意义', score: null }

  const offline = provider === 'offline'
  const adapter = PROVIDERS[provider]
  if (!offline && !adapter) return { error: `未知 provider：${provider}（可选：${Object.keys(PROVIDERS).join(' / ')} / offline）`, score: null }
  if (!offline && !adapter.available(env)) {
    return {
      error: `${provider} 没配 key（环境变量 ${adapter.keyEnv}）—— GEO 要花钱调 LLM，没 key 不能跑。线上实例故意不配，只读本地存下来的历史；本机想跑完整功能就自己 clone 一份配上 key，或用 provider=offline 看结构。`,
      score: null,
      offline: false,
    }
  }

  const dims = []
  const runs = []
  const failures = []

  for (const q of questions) {
    try {
      const r = offline ? (OFFLINE_FIXTURE.answers[q] || { text: '', citations: [] }) : await adapter.ask(env, q)
      runs.push({ question: q, text: r.text || '', citations: r.citations || [], hit: mentions(r.text, r.citations, b, domain) })
    } catch (e) {
      // 一个问题挂掉不能废掉整次 —— 少一路样本照样能出报告，但必须说清少了几路。
      failures.push({ question: q, error: (e.message || String(e)).slice(0, 200) })
    }
  }

  if (!runs.length) {
    return {
      error: `全部 ${questions.length} 个问题都问失败${failures[0] ? `，首个原因：${failures[0].error}` : ''}`,
      score: null,
      offline,
      failures,
    }
  }

  // ① 提及率 —— 分母是「实际问成功的问题数」，不是配置的问题数。
  //    用失败数当分母会把「API 挂了」算成「你没被提及」，那是最坏的一种假象。
  {
    const hits = runs.filter((r) => r.hit.mentioned)
    const rate = Math.round((hits.length / runs.length) * 100)
    dims.push({
      key: 'mention', name: '提及率', score: clamp(rate / 10), unverifiable: 0,
      evidence: [`${hits.length}/${runs.length} 个问题的回答里出现了「${b}」（${rate}%）`],
      gaps: rate < 50 ? [`只有 ${rate}% 的问题提到你 —— AI 答品类问题时过半不带你的名字`] : [],
      manual: ['各provider 的模型版本、随机性与语料库都会变，这个数字只代表「今天问的这几路」'],
      detail: { rate, asked: runs.length, failed: failures.length },
    })
  }

  // ② 引用率 —— 比提及率更难，也更值钱：被提到只是一句话名字，
  //    被引用意味着你的域名进了来源列表，点进去能转化。
  {
    const cited = runs.filter((r) => r.hit.cited)
    const rate = Math.round((cited.length / runs.length) * 100)
    const unverified = domain ? 0 : 1
    dims.push({
      key: 'citation', name: '引用率', score: unverified ? null : clamp(rate / 10), unverifiable: unverified,
      evidence: unverified
        ? []
        : [`${cited.length}/${runs.length} 个问题的来源里含 ${domain}（${rate}%）`],
      gaps: unverified
        ? [`没给 domain，无法判引用 —— 引用率是本报告里最能看出差距的一维，别省`]
        : rate < 30 ? [`引用率仅 ${rate}%：AI 说得到你，但点不进你的站`] : [],
      manual: unverified ? [] : ['不是所有 provider 都返回来源列表；不返回时这一维会系统性偏低，跨 provider 比较时注意'],
      detail: { rate, asked: runs.length },
    })
  }

  // ③ 竞品份额 —— 你和对手在同一个答案里的出现次数比。
  {
    // 没有竞品就无从谈「份额」：分母只剩你自己，算出来必然是 100%，那不是分数，
    // 是把「没人比」说成「你赢了」。所以没给竞品就明确标无法核实。
    const unverifiable = competitors.length ? 0 : 1
    const tally = Object.fromEntries([b, ...competitors].map((n) => [n, 0]))
    for (const r of runs) {
      const hay = r.text.toLowerCase()
      for (const n of Object.keys(tally)) {
        const key = n.toLowerCase()
        if (hay.includes(key) || (r.citations || []).some((u) => u.toLowerCase().includes(key))) tally[n]++
      }
    }
    const total = Object.values(tally).reduce((s, v) => s + v, 0)
    const share = total ? Math.round((tally[b] / total) * 100) : 0
    dims.push({
      key: 'share', name: '竞品份额', score: unverifiable ? null : clamp(share / 10), unverifiable,
      evidence: unverifiable ? [] : [`${b} 占 ${share}%：${JSON.stringify(tally)}`],
      gaps: unverifiable
        ? ['没给 competitors，这维无从判断 —— 单看提及率会被「品类很小」的错觉骗过去：你在小品类里 100% 提及，也可能等于零可见度']
        : share < 30 ? [`只占 ${share}%：同样的答案里，对手拿走了更多位置`] : [],
      manual: unverifiable ? [] : ['份额按「出现次数」统计，同一个品牌被提两次算两次；不是排名也不是推荐序'],
      detail: { tally, share },
    })
  }

  // ④ 评价倾向 —— 只在品牌出现的位置附近看词。
  {
    const withBrand = runs.filter((r) => r.hit.mentioned)
    const moods = withBrand.map((r) => sentiment(r.text, b)).filter(Boolean)
    const neg = moods.filter((m) => m === '负面').length
    const pos = moods.filter((m) => m === '正面').length
    // 没有 provider 返回带贬义的样本时，不该给满分：宁可标「无法核实」。
    const unverified = moods.length ? 0 : 1
    dims.push({
      key: 'sentiment', name: '评价倾向', score: unverified ? null : clamp(((pos * 2) / Math.max(1, moods.length)) * 10), unverifiable: unverified,
      evidence: moods.length ? [`出现位置的措辞：正面 ${pos} / 中性 ${moods.length - pos - neg} / 负面 ${neg}`] : [],
      gaps: unverified ? ['本轮没有品牌出现的样本，这维无法核实（不代表评价差，代表没样本）'] : neg > pos ? ['负面措辞多于正面'] : [],
      manual: ['词表判断，不是情感模型；「不支持」「无法」这类词在技术语境里可能是中性的'],
      detail: { moods },
    })
  }

  const scored = dims.filter((d) => d.score != null)
  const inconclusive = dims.filter((d) => d.score == null).map((d) => d.name)
  if (!scored.length) {
    return { error: '各维度都无从核实', score: null, dims, scoredCount: 0, inconclusiveDims: inconclusive, offline, failures }
  }
  const score = clamp(scored.reduce((s, d) => s + d.score, 0) / scored.length)

  const todos = scored
    .filter((d) => d.gaps.length)
    .sort((a, b2) => a.score - b2.score)
    .flatMap((d) => d.gaps.map((g) => ({ dim: d.name, dimScore: d.score, text: g })))

  return {
    project: b,
    domain,
    type: 'geo',
    provider: offline ? 'offline' : provider,
    offline,
    questions,
    competitors,
    score,
    band: bandOf(score).label,
    bandHint: bandOf(score).hint,
    stars: 0,
    dims,
    todos,
    scoredCount: scored.length,
    inconclusiveDims: inconclusive,
    failures,
    ts: new Date().toISOString(),
  }
}

/** 当前环境配了哪些 GEO provider —— UI 用来告诉用户「你现在能跑哪几路」。 */
export function geoProviderStatus(env = process.env) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    model: p.model,
    keyEnv: p.keyEnv,
    ready: p.available(env),
  }))
}

/**
 * 把「自动」解成具体的一路。
 *
 * 不做这一步的代价很具体：auditGeo 的形参默认值只在 undefined 时生效，所以调用方
 * 什么都不传、或传空串，得到的都不是 anthropic 而是「未知 provider：」——
 * 调用方说的是「自动」，返回的是一个报错。
 *
 * 一个都没就绪时落到 offline 而不是报错。线上实例故意不配 key，它的职责是让人看懂
 * 报告长什么样、再去本地配 key 跑真的；直接报错的话那个页面就只剩一个红色错误框，
 * 那不叫「零花费预览」，叫「坏了」。
 */
export function resolveGeoProvider(requested = '', env = process.env) {
  if (requested && requested !== 'auto') return requested
  const ready = geoProviderStatus(env).filter((p) => p.ready)
  return ready.length ? ready[0].id : 'offline'
}

/** 从 SQLite 历史行还原成可用的 GEO 报告（与前三路 hydrate 同一形状）。 */
export function hydrateGeo(row, key) {
  let meta = {}
  try { meta = typeof row.meta === 'string' ? JSON.parse(row.meta || '{}') : row.meta || {} } catch {}
  return {
    ...row,
    ...meta,
    project: row.project || key,
    targetType: 'geo',
    type: 'geo',
    dims: typeof row.dims === 'string' ? JSON.parse(row.dims || '[]') : row.dims || [],
    todos: typeof row.todos === 'string' ? JSON.parse(row.todos || '[]') : row.todos || [],
  }
}

export function reportMarkdown(a) {
  const L = []
  const off = a.offline ? '\n\n> ⚠️ **这份报告来自离线 fixture（未接真实数据源）** —— 数字是假的，只能用来验证结构长什么样，不能当结论用。' : ''

  L.push(`# AI 搜索可见性质检报告 · ${a.project}${off}`)
  L.push('')
  L.push(`> provider \`${a.provider || 'offline'}\` · ${a.ts || ''}`)
  L.push('')
  L.push(`**${a.score?.toFixed(1)}/10 · ${a.band}**${a.bandHint ? ` —— ${a.bandHint}` : ''}`)
  L.push('')

  if (a.questions?.length) {
    L.push('## 测的问题')
    for (const q of a.questions) L.push(`- ${q}`)
    L.push('')
  }
  if (a.competitors?.length) L.push(`对比品牌：${a.competitors.join(' / ')}`)
  L.push('')

  L.push('## 结论 → 可执行清单')
  if (!a.todos?.length) {
    L.push('没有待整改项 —— 各维度都达标。')
  } else {
    a.todos.forEach((t, i) => L.push(`${i + 1}. **[${t.dim}]** ${t.text}`))
  }
  L.push('')

  L.push('## 证据')
  for (const d of a.dims || []) {
    L.push(`### ${d.name}${d.score == null ? '（无法核实）' : ` — ${d.score.toFixed(1)}/10`}`)
    for (const e of d.evidence || []) L.push(`- ${e}`)
    for (const g of d.gaps || []) L.push(`- ⚠️ ${g}`)
    for (const m of d.manual || []) L.push(`- ℹ️ ${m}`)
    L.push('')
  }

  if (a.failures?.length) {
    L.push('## 本轮没问成的')
    for (const f of a.failures) L.push(`- ${f.question}：${f.error}`)
    L.push('')
  }

  L.push('## 交给 AI 就能开工')
  L.push('')
  L.push('```text')
  L.push(`帮我改善「${a.project}」在 AI 搜索里的可见性。当前各维度：`)
  for (const d of a.dims || []) {
    L.push(`- ${d.name}：${d.score == null ? '无法核实' : `${d.score.toFixed(1)}/10`}${d.gaps?.[0] ? `（${d.gaps[0]}）` : ''}`)
  }
  L.push('请按「影响大且改动成本低」排序给行动项，每条要能落到具体文件或内容。')
  L.push('```')
  L.push('')

  return L.join('\n')
}