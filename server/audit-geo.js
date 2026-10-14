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

  // ─────────────────────────────────────────────────────────────────────────
  // magpie —— 本机 LLM 网关（/Users/webkubor/dev/agent-infra 下无此物，网关在
  // magpie.app，监听 127.0.0.1:3425，说 Anthropic Messages 协议）。
  //
  // 它与其他四路有三点不同，都不是配置差异，是结构性的，所以单独写在这里：
  //
  // 1) **必须钉死具体模型，不能用 group/\*。**
  //    网关对 group/* 做动态路由，同一个 id 今天落这池明天落那池：
  //    实测 group/mian-model-group 先返回 codex/gpt-6-astra，三分钟后返回
  //    claude/claude-opus-5-5 —— 它会漂，而且能漂进禁用池里。所以 group/\*
  //    直接进了 MAGPIE_FORBIDDEN_POOL，不只是在 ask() 里拒绝。
  //
  // 2) **禁用 claude/\* 池。**
  //    那一池走的是用户自己 Claude Code 会话的额度。实测打过去直接回
  //    {"type":"error","error":{"type":"rate_limit_error"}}。GEO 要是碰了它，
  //    烧的是写代码的额度，编辑器当场不可用。这是本适配器最重要的一条。
  //    注意别被 modelgo-gateway/claude-* 的名字骗了：那一路有独立 endpoint 和
  //    独立的 mgk_ key，计费在 ModelGo 那边，跟本机会话不是一回事。
  //
  // 3) **只认 loopback，而且是白名单式的「认得出」，不是黑名单式的「没禁」。**
  //    这条曾经写反过，代价是生产能发出计费请求。见 isLoopbackURL 的注释。
  //
  // 4) **强证据有两个来源，都得收。**
  //    web_search_tool_result 块里的检索结果，和正文块自带的结构化 citations[]。
  //    只收前者会把真证据丢掉，让引用率系统性偏低 —— 而偏低会被读成
  //    「AI 不引用你」。弱证据（模型自己写在句子里的裸 URL）单列，不进分数。
  magpie: {
    keyEnv: 'SCORECARD_GEO_MAGPIE_KEY',
    // 钉死的具体 id —— 不能是 group/*（路由会漂），也不能是 claude/*（烧写代码的额度）。
    //
    // 换掉它是因为上一个默认值 modelgo-gateway/gpt-5.4 **实测不可用**：
    // HTTP 200、stop_reason=max_tokens、content 是空数组，白烧 1500 个输出 token。
    // 每一道题都会失败，但每一道都照样计费。这比「没有默认可用」糟得多 ——
    // 它看起来配好了，跑起来只是全灭。
    //
    // 现在这一路是 magpie 上唯一实测每次都真调用 web_search 的（4/4 成功）：
    // 端点 api.modelgo.com、凭证是 mgk_ 开头的 ModelGo key，
    // 跟 claude/* 那一池（无 endpoint 无 key，复用本机会话）计费完全分开。
    model: 'modelgo-gateway/claude-haiku-5.5',
    effectiveModel: (env = process.env) =>
      (env.SCORECARD_GEO_MAGPIE_MODEL || '').trim() || PROVIDERS.magpie.model,

    available(env = process.env) {
      const base = (env.SCORECARD_GEO_MAGPIE_BASE || '').trim()
      if (!base || !magpieKey(env)) return false
      const model = this.effectiveModel(env)
      // 禁掉的池子连「可用」都不该报 —— 报成 ready 然后一跑就报错，
      // 是比直接说「不可用」更差的体验。
      if (MAGPIE_FORBIDDEN_POOL.some((p) => model.startsWith(p))) return false
      // 白名单：非回环一律不认。见 isLoopbackURL 的注释 —— 这里曾经写反了，
      // 变成「只要不是 loopback 就放行」，公网地址配个 key 就能从生产发计费请求。
      if (!isLoopbackURL(base)) return false
      // 二次确认：光是对着 loopback 也不够，得用户明说「我知道这是本机地址」。
      if (env.SCORECARD_GEO_MAGPIE_ALLOW_LOCAL !== '1') return false
      return true
    },

    async ask(env, question) {
      const base = (env.SCORECARD_GEO_MAGPIE_BASE || '').trim().replace(/\/$/, '')
      const key = magpieKey(env)
      const model = this.effectiveModel(env)

      const banned = MAGPIE_FORBIDDEN_POOL.find((p) => model.startsWith(p))
      if (banned) throw new Error(`拒绝使用 ${model} —— ${forbiddenReason(model)}`)
      if (!isLoopbackURL(base)) {
        throw new Error(`拒绝连接 ${base} —— magpie 适配器只认 loopback（127.0.0.1 / localhost / ::1）。生产机到不了你电脑上的 3425 端口，GEO 请在本机跑。`)
      }
      if (env.SCORECARD_GEO_MAGPIE_ALLOW_LOCAL !== '1') {
        throw new Error('连本机网关要显式设 SCORECARD_GEO_MAGPIE_ALLOW_LOCAL=1 —— 二次确认「我知道这是本机地址」')
      }

      const maxTokens = Number(env.SCORECARD_GEO_MAGPIE_MAX_TOKENS) || 4000
      const r = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          // 4000 不是随手填的：默认那路实测在 1500/2000 上 stop_reason=max_tokens，
          // 来源列表被截断成零 —— 引用率会因为「答案被切断」被记成「没人引用你」。
          max_tokens: maxTokens,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages: [{ role: 'user', content: ASK_TEMPLATE(question) }],
        }),
        signal: AbortSignal.timeout(150000),
      })
      const raw = await r.text()
      let j
      try { j = JSON.parse(raw) } catch {
        throw new Error(`网关返回非 JSON（HTTP ${r.status}）：${raw.slice(0, 160)}`)
      }
      if (j?.type === 'error' || !r.ok) {
        throw new Error(`网关报错（HTTP ${r.status}）：${(j?.error?.message || raw).slice(0, 200)}`)
      }
      const content = Array.isArray(j.content) ? j.content : []
      if (!content.length) {
        // 实测 modelgo-gateway/gpt-5.4 会回一个空 content 数组，HTTP 200，
        // 而且白烧 1500 个输出 token。这种必须算「这一路失败」，不能当成
        // 「这一路没提到品牌」—— 两者在分数上一个是天一个是地。
        const spent = j?.usage?.output_tokens
        throw new Error(
          spent
            ? `网关回了空 content，但已计费 ${spent} 个输出 token —— ${model} 在这个配置下不产出正文。换一个实测能跑通的模型。`
            : '网关回了空 content（该模型在此不产出），这一路计为失败，不计入分母'
        )
      }
      const text = content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n')
      if (!text.trim()) throw new Error('这一路没有正文输出，计为失败')
      const citations = harvestSearchUrls(content)
      return {
        text,
        citations,
        inlineUrls: harvestInlineUrls(text),
        routedModel: j.model || model,
        stopReason: j.stop_reason || null,
        // 「模型到底有没有去搜」和「搜出来的来源里有没有你」是两个问题。
        // 混为一谈就是把「没搜」记成「没被引用」。这一路没搜过，引用率就不该给分。
        searchInvoked: citations.length > 0 || content.some((c) => c?.type === 'web_search_tool_result'),
      }
    },
  },
}

// claude/* 池走本机 Claude Code 会话额度 —— GEO 碰它就是在烧写代码的额度。
// （配置层面可证：~/.config/magpie/providers.json 里 claude 池既无 endpoint 也无 key，
//   它复用的是本机会话；modelgo-gateway 池有独立 endpoint 和 mgk_ 开头的 ModelGo key。
//   两者计费完全分开，所以 modelgo-gateway/claude-* 是安全的，claude/* 不是。）
//
// group/* 同样进黑名单：它会动态落到 claude/* 里去，是绕过上面那条的后门。
// opencode-zen-free/*：实测 403「只能在 OpenCode 内部用」，列在 /v1/models 里但打不通。
const MAGPIE_FORBIDDEN_POOL = ['claude/', 'group/', 'opencode-zen-free/']

// 拒绝理由要能直接告诉用户该怎么改，否则只是个「不可用」。
function forbiddenReason(model) {
  if (model.startsWith('claude/')) {
    return 'claude/* 池走的是本机 Claude Code 会话额度，GEO 跑一次就烧一次写代码的额度'
  }
  if (model.startsWith('group/')) {
    return '动态路由组会落到不同模型池（实测 group/mian-model-group 返回过 claude/claude-opus-5-5），趋势线量的就不是同一个东西。钉死一个具体 id'
  }
  if (model.startsWith('opencode-zen-free/')) {
    return 'opencode-zen-free 池只能在 OpenCode 内部用，从网关打过去实测 403'
  }
  return '模型池在禁用名单里'
}

function magpieKey(env) {
  const k = (env.SCORECARD_GEO_MAGPIE_KEY || '').trim()
  return k
}

// 「是 loopback」必须能从 URL 里**证明**，不能靠「没说不许」。
//
// 原来的写法是 `isLoopbackURL(base) && ALLOW_LOCAL !== '1'` —— 那是在**限制**
// loopback，不是**要求** loopback。于是配一个公网地址加一个 key 就直接放行：
//   https://gateway.example.com + key，无 ALLOW_LOCAL → available() === true
// 线上实例只要设了这两个变量，免登录的 /api/scorecard?type=geo= 就会从生产发出
// 计费请求。方向反了：这里要的是白名单，不是黑名单。
//
// 另外 0.0.0.0 是「本机所有网卡」，不是回环 —— 那是能被局域网访问的地址，
// 从「只有我自己能连」的角度看必须踢出白名单。'[::1]' 是 URL 解析 IPv6 回环的形式。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function isLoopbackURL(s) {
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.has(u.hostname)
  } catch { return false }
}

/** 强证据：web_search 真正检索到的 URL。两个来源，都算。 */
export function harvestSearchUrls(content) {
  const out = new Set()
  const walk = (v) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(walk); return }
    // 来源一：web_search_tool_result 块里逐条列出的检索结果。
    if (v.type === 'web_search_tool_result') {
      for (const r of Array.isArray(v.content) ? v.content : []) {
        if (typeof r?.url === 'string' && /^https?:/.test(r.url)) out.add(r.url)
      }
    }
    // 来源二：正文块自带的结构化 citations[]。这是 Anthropic 服务端 web_search
    // 在每句话旁边挂的出处，也是「这句话是从哪来的」的正路证据。
    //
    // 之前只认来源一，把来源二整个丢了 —— 实测 modelgo-gateway/claude-haiku-5.5
    // 每次都返回它，一次给 3~7 条。丢掉真证据比拿不到证据更糟：那会让引用率
    // 系统性地偏低，而偏低会被读成「AI 不引用你」，实际上它引用了。
    for (const c of Array.isArray(v.citations) ? v.citations : []) {
      if (typeof c?.url === 'string' && /^https?:/.test(c.url)) out.add(c.url)
    }
    Object.values(v).forEach(walk)
  }
  walk(content)
  return [...out]
}

/** 弱证据：模型自己在正文里写出来的裸 URL —— 可能来自记忆，也可能是编的 */
export function harvestInlineUrls(text) {
  return [...new Set((text.match(/https?:\/\/[^\s)\]，。、；"'`）]+/g) || []))]
}

export const magpieAvailable = (env = process.env) => PROVIDERS.magpie.available(env)
export const magpieAsk = (env, question) => PROVIDERS.magpie.ask(env, question)

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
 *
 * 引用分两档，这是 magpie 逼出来的：
 *   citations  = web_search 真检索到的 URL —— 强证据，能进分数
 *   inlineUrls = 模型自己在正文里写出来的 URL —— 弱证据，可能来自记忆也可能是编的，
 *                拿它算分等于把模型的幻觉记成你的可见度。
 * 所以 cited 只认强证据，弱证据单列出来给人看。
 */
export function mentions(text, citations, brand, domain, inlineUrls = []) {
  const hay = (text || '').toLowerCase()
  const nameHit = brand.toLowerCase().split(/\s+/).some((w) => w.length > 1 && hasWord(hay, w))
  const citeHit = Boolean(domain) && (citations || []).some((u) => urlHasDomain(u, domain))
  const inlineHit = Boolean(domain) && (inlineUrls || []).some((u) => urlHasDomain(u, domain))
  const pos = hay.indexOf(brand.toLowerCase())
  return {
    mentioned: nameHit || citeHit,
    cited: citeHit,
    inlineCited: inlineHit,
    position: pos >= 0 ? pos : null,
  }
}

/**
 * 品牌名按**词边界**匹配，不按子串。
 *
 * 之前是裸 includes()，四种误判全部当场可复现：
 *   「推荐 N1和M1」里有 N1      → 提到了（错的，那是另一个编号）
 *   「museum 展览」里有 muse    → 提到了（错的，那是另一个词）
 *   「N1」还会在「M1 和 N10」里误伤
 * 品牌名有多长都有可能被更长/更短的词包住，中文尤其严重 —— 没有空格可依赖，
 * 所以边界用「不是字母也不是数字」来定义，而不是 \b（\b 在中文里等于失效）。
 *
 * 这些误判全部朝**高估**的方向偏。GEO 唯一的用处就是告诉你数字低，
 * 一个系统性偏高的尺子，量出来的「你还行」是假的。
 */
function hasWord(hay, token) {
  if (!token) return false
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 前后必须是「非字母数字」或文本边界；中间允许是品牌名自带的空格/连字符
  const inner = esc.replace(/\s+/g, '[\\s\\-·_]*')
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${inner}(?![\\p{L}\\p{N}])`, 'u')
  return re.test(hay)
}

/**
 * 「这个 URL 算不算引用了你的域名」——按 hostname 比，不按整串比。
 *
 * 之前是 url.includes(domain)，三种误判：
 *   https://not-ai.com/x          里有 ai.com      → 引用了（错的）
 *   https://evil.com/?r=museav.com 里有 museav.com  → 引用了（错的）
 *   https://museav.com.evil.com   里有 museav.com  → 引用了（错的）
 * 第一条尤其糟：只要有人写个带你域名的查询串，你就「被引用」了。
 *
 * 现在解析 hostname，去掉 www.，然后 h === d || h.endsWith('.' + d) ——
 * 后者让子域名（blog.museav.com）算命中，这是对的：子域名确实是你在引用自己。
 */
function urlHasDomain(url, domain) {
  let host
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.+$/, '')
  if (!d) return false
  return host === d || host.endsWith(`.${d}`)
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
export async function auditGeo({ brand, domain = '', questions = [], competitors = [], provider = 'anthropic', env = process.env, adapter: injected = null }) {
  const b = (brand || '').trim()
  if (!b) return { error: '缺 brand', score: null }
  if (!questions.length) return { error: '缺 questions —— GEO 问的是用户会问的品类问题，品牌词测出来没有意义', score: null }

  const offline = provider === 'offline'
  // adapter 可以从外面塞进来。四个维度的算分逻辑（尤其「没检索过就不给引用率打���」
  // 这种分支）必须能在不发网络请求的情况下测到 —— 否则每次改判据都得真花钱跑一遍。
  const adapter = injected || PROVIDERS[provider]
  if (!offline && !injected && !adapter) return { error: `未知 provider：${provider}（可选：${Object.keys(PROVIDERS).join(' / ')} / offline）`, score: null }
  if (!offline && !injected && !adapter.available(env)) {
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
      runs.push({
        question: q,
        text: r.text || '',
        citations: r.citations || [],
        inlineUrls: r.inlineUrls || [],
        // 每路记下实际落到哪个模型。网关会路由，钉死也回显一下 ——
        // 趋势图上标的是「哪一路模型」，不然一周后没人知道那条线量的是谁。
        routedModel: r.routedModel || (provider === 'magpie' ? (env.SCORECARD_GEO_MAGPIE_MODEL || '').trim() : '') || '',
        // 「有没有去搜」和「搜出来有没有你」是两个问题。不分开记，模型偷懒不搜
        // 就会显示成「引用率 0%」—— 一个是量具没通电，一个是读数低。
        searchInvoked: r.searchInvoked !== false,
        // 被 max_tokens 切断的答案，来源列表可能是空的 —— 那是切断了，不是没引用。
        stopReason: r.stopReason || null,
        hit: mentions(r.text, r.citations, b, domain, r.inlineUrls),
      })
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
  //
  //    只算强证据（真检索到的 URL）。模型自己写在正文里的 URL 单列出来给人看，
  //    不进分数 —— 那可能是它凭记忆写的，甚至是编的，把它算成你的可见度，
  //    就是在给模型的幻觉发奖章。
  {
    const cited = runs.filter((r) => r.hit.cited)
    const inlineOnly = runs.filter((r) => r.hit.inlineCited && !r.hit.cited)
    const rate = Math.round((cited.length / runs.length) * 100)
    // 三种情况这一维都判不了，全部标「无法核实」，而不是给一个数：
    //   ① 没给 domain         —— 没有可比对的目标
    //   ② 模型压根没调用 web_search —— **没有证据来源**。实测 deepseek-v4-pro 会
    //      老老实实回一段正文、HTTP 200、从不用检索工具。这时报「引用率 0%」是
    //      把「它没搜」记成「没人引用你」—— 一个是量具没通电，一个是读数低。
    //   ③ 答案被 max_tokens 截断且零来源 —— 来源列表是被切断的，不是空的。
    //      截断的那道题不进这一维的分母，但它产出了正文，提及/份额仍然算数。
    const searched = runs.some((r) => r.searchInvoked !== false)
    const truncatedNoSrc = runs.filter((r) => r.stopReason === 'max_tokens' && !(r.citations || []).length)
    const scored = runs.filter((r) => !truncatedNoSrc.includes(r))
    const citedScored = scored.filter((r) => r.hit.cited)
    const rateScored = scored.length ? Math.round((citedScored.length / scored.length) * 100) : 0
    const whyUnverified = !domain
      ? '没给 domain，无法判引用 —— 引用率是本报告里最能看出差距的一维，别省'
      : !searched
        ? '本轮所选模型一次都没调用 web_search —— 这一维没有证据来源，不是「没有被引用」。换 provider，或换一个实测会检索的模型'
        : !scored.length
          ? '所有答案都被 max_tokens 截断且没有来源可读，这一维无从判断'
          : ''
    const unverified = whyUnverified ? 1 : 0
    dims.push({
      key: 'citation', name: '引用率', score: unverified ? null : clamp(rateScored / 10), unverifiable: unverified,
      evidence: unverified
        ? []
        : [`${citedScored.length}/${scored.length} 个问题的检索来源里含 ${domain}（${rateScored}%）`],
      gaps: unverified ? [whyUnverified] : rateScored < 30 ? [`引用率仅 ${rateScored}%：AI 说得到你，但点不进你的站`] : [],
      manual: unverified
        ? []
        : [
            '不是所有 provider 都返回来源列表；不返回时这一维会系统性偏低，跨 provider 比较时注意',
            ...(inlineOnly.length
              ? [`另有 ${inlineOnly.length} 个问题里模型在正文里手写了你的地址但没进检索来源 —— 那是弱证据，没算进分。它说明模型「知道」你，但没真正检索到你`]
              : []),
            ...(truncatedNoSrc.length
              ? [`${truncatedNoSrc.length} 道题因 max_tokens 截断且零来源，已从这一维的分母里剔除（它们仍计入提及与份额）`]
              : []),
          ],
      detail: {
        rate: rateScored, asked: scored.length, inlineOnly: inlineOnly.length,
        searched, truncatedDropped: truncatedNoSrc.length,
        routedModels: [...new Set(runs.map((r) => r.routedModel).filter(Boolean))],
      },
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
        // 同样按词边界判，不能用 includes —— 否则 muse 会被 museum 算一次，
        // 份额的分母被凭空灌水，你和对手的相对位置就失真了。
        if (hasWord(hay, n.toLowerCase()) || (r.citations || []).some((u) => u.toLowerCase().includes(n.toLowerCase())))
          tally[n]++
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
    // 显示「实际会用哪个模型」，不是「代码里写的默认值」。
    // 配了 SCORECARD_GEO_MAGPIE_MODEL 却看到默认模型，人会以为覆盖没生效。
    model: p.effectiveModel ? p.effectiveModel(env) : p.model,
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