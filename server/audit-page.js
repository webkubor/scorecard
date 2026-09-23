/**
 * 网页审计引擎 —— 独立判据集，不与 GitHub repo / npm 包审计共用维度。
 *
 * 为什么独立成文件：网页、仓库、npm 包是三件不同的事，硬塞进同一套维度会失真。
 * 仓库看"陌生人会不会 10 秒 star / install / trust"；npm 包看"装上能不能用"；
 * 网页看"站点对 AI 爬虫 / 编码助手 / 终端用户是否友好" —— 三套判据互不通用。
 *
 * 九维（每维满分 10）：
 *   ① 可访问性        — HTTPS / status / 重定向链 / TTFB
 *   ② SEO 基础        — title / meta description / og:image / canonical / viewport / twitter:card
 *   ③ 内容结构        — h1-h6 层级 / 语义 HTML
 *   ④ AI 识别         — llms.txt / llms-full.txt / og:type / schema.org 类型 / AI 专属 meta
 *   ⑤ 爬虫根目录      — robots.txt / sitemap.xml / .well-known/* / favicon / security.txt / humans.txt
 *   ⑥ 安全响应头      — CSP / HSTS / X-Frame-Options / Referrer-Policy / X-Content-Type-Options
 *   ⑦ 性能            — compression / cache-control / 响应大小 / 图片格式
 *   ⑧ WebMCP 友好性   — /.well-known/mcp.json / ai-plugin.json / openapi.json / MCP 端点
 *   ⑨ 内容质量        — 内容长度 / SPA 空壳 / 死链 / last-modified / html lang
 *
 * 所有根目录探测并发一次拉完；HTML 解析用正则（不引第三方依赖，保持 bun 单进程）。
 */

const UA = 'scorecard-audit (+https://scorecard.webkubor.online)'

const clamp = (n) => Math.max(0, Math.min(10, Math.round(n * 10) / 10))

/** 模块本地的归一化，与 audit.js / audit-npm.js 的同名函数不共享 —— 各自口径独立 */
function normalizeDim(score, unv) {
  const denom = 10 - unv
  if (denom < 2) return null
  return clamp((score / denom) * 10)
}

function bandOf(score) {
  if (score >= 9) return { label: 'AI 与人类都友好', hint: 'robots / llms / schema.org / MCP 一应俱全' }
  if (score >= 6) return { label: '可访问、需补 AI 端', hint: '基础可用，但 AI 友好性还差一截' }
  if (score >= 3) return { label: '能打开但欠账多', hint: '' }
  return { label: '站点对 AI 不友好', hint: '' }
}

function looksLikeHtml(text) {
  return /<!doctype\s+html|<html[\s>]/i.test(String(text).slice(0, 200))
}

/** llms.txt 应当是 markdown 文档：非 HTML + 长度足够 + 有标题行 */
function isRealLlmsTxt(text) {
  if (looksLikeHtml(text)) return false
  const t = String(text).trim()
  return t.length > 50 && /^#{1,3}\s+\S/m.test(t)
}

/** robots.txt 解析 —— 复用 audit.js 的成熟实现，避免重写一份机器人规则导致分歧 */
import { robotsBlocksAiBots } from './audit.js'

// 单请求超时：8s 在生产到 modelgo 这类站偶发卡住（Cloudflare 边缘节点跨地域延迟），
// 主页面单独允许 15s，根目录探测保持 8s —— 总并行 13 个，最坏情况 15s 内返回。
async function fetchMeta(target, { timeout = 8000, followRedirect = true } = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeout),
      redirect: followRedirect ? 'follow' : 'manual',
    })
    const text = await res.text()
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text,
      finalUrl: res.url || target,
      ttfb: Date.now() - t0,
      redirected: res.redirected,
      redirectChain: res.redirected ? [target, res.url] : [target],
    }
  } catch (e) {
    return {
      ok: false, status: 0, headers: null, text: '', finalUrl: target,
      ttfb: Date.now() - t0, error: e.message || 'fetch failed',
    }
  }
}

/** HTML 里抠 meta 标签 —— name/property → content */
function parseMetaTags(html) {
  const tags = {}
  const re = /<meta\s+(?:[^>]*?\s+)?(?:name|property)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*\/?>/gi
  let m
  while ((m = re.exec(html)) !== null) tags[m[1].toLowerCase()] = m[2]
  // 兼容 content 在前 / name 在后 的写法
  const re2 = /<meta\s+(?:[^>]*?\s+)?content\s*=\s*["']([^"']*)["'][^>]*?(?:name|property)\s*=\s*["']([^"']+)["'][^>]*\/?>/gi
  while ((m = re2.exec(html)) !== null) tags[m[2].toLowerCase()] = m[1]
  return tags
}

function parseHeadings(html) {
  const out = []
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const level = Number(m[1])
    const text = String(m[2]).replace(/<[^>]+>/g, '').trim()
    if (text) out.push({ level, text })
  }
  return out
}

function parseJsonLd(html) {
  const out = []
  const re = /<script\s+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1])
      out.push(parsed)
    } catch { /* 解析失败就当没声明 */ }
  }
  return out
}

function parseLinks(html) {
  const out = []
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const href = m[1]
    if (!href.startsWith('#') && !/^(javascript|mailto|tel):/i.test(href)) out.push(href)
  }
  return out
}

function parseImages(html) {
  const out = []
  const re = /<img\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = re.exec(html)) !== null) out.push(m[1])
  return out
}

/** 从 link 标签里抓 canonical 等 */
function parseLinkRels(html) {
  const out = {}
  const re = /<link\s+[^>]*?rel\s*=\s*["']([^"']+)["'][^>]*?href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const rel = m[1].toLowerCase()
    if (!out[rel]) out[rel] = m[2]
  }
  return out
}

/** 把 url 字符串规范成可访问 origin */
function normalizeUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    if (!/^https?:$/.test(u.protocol)) return null
    return u
  } catch {
    return null
  }
}

/** robots.txt 是否明确放行了 AI 爬虫（审计对方站点的判据） */
function robotsAllowsAiBots(text) {
  return robotsBlocksAiBots(text).length === 0
}

/** schema.org 类型集合 —— AI 抓站时常按这些类型做事实抽取 */
const AI_SCHEMA_TYPES = new Set([
  'Article', 'NewsArticle', 'BlogPosting', 'TechArticle',
  'WebSite', 'WebPage', 'Product', 'SoftwareApplication',
  'Organization', 'Person', 'BreadcrumbList', 'FAQPage', 'HowTo',
])

/** 收集所有 JSON-LD 里出现过的 @type */
function collectSchemaTypes(jsonLdBlocks) {
  const types = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node['@type'] === 'string') types.add(node['@type'])
    if (Array.isArray(node['@type'])) node['@type'].forEach((t) => types.add(t))
    if (node['@graph']) walk(node['@graph'])
    for (const k of Object.keys(node)) {
      if (k.startsWith('@')) continue
      walk(node[k])
    }
  }
  jsonLdBlocks.forEach(walk)
  return [...types]
}

/**
 * 跑一次完整网页审计。
 * @param {{url:string, token?:string}} opts
 */
export async function auditPage({ url }) {
  const u = normalizeUrl(url)
  if (!u) return { error: 'url 格式不合法', score: null }

  const origin = u.origin
  const startUrl = u.toString()

  // 一次性并发把所有需要的资源都拉下来。
  // 13 个并发请求，单次失败不应阻塞其它判据 —— 用 Promise.allSettled。
  const fetches = await Promise.allSettled([
    fetchMeta(startUrl, { timeout: 30000 }),                         // 主页面：单页内容大且要解析 HTML，给 30s
    fetchMeta(`${origin}/robots.txt`),                                // 爬虫根：robots
    fetchMeta(`${origin}/llms.txt`),                                  // AI 识别：llms.txt
    fetchMeta(`${origin}/llms-full.txt`),                             // AI 识别：llms-full.txt
    fetchMeta(`${origin}/sitemap.xml`),                               // 爬虫根：sitemap
    fetchMeta(`${origin}/.well-known/security.txt`),                  // 爬虫根：security
    fetchMeta(`${origin}/.well-known/mcp.json`),                      // WebMCP
    fetchMeta(`${origin}/.well-known/ai-plugin.json`),                // WebMCP
    fetchMeta(`${origin}/openapi.json`),                              // WebMCP
    fetchMeta(`${origin}/api/openapi.json`),                          // WebMCP 备选
    fetchMeta(`${origin}/favicon.ico`),                               // 爬虫根：favicon
    fetchMeta(`${origin}/humans.txt`),                                // 爬虫根：humans
    fetchMeta(`${origin}/apple-touch-icon.png`),                      // 爬虫根：apple-touch
  ])

  const [page, robots, llms, llmsFull, sitemap, securityTxt, mcpJson, aiPlugin, openapi1, openapi2, favicon, humans, appleTouch] = fetches.map((f) =>
    f.status === 'fulfilled' ? f.value : { ok: false, status: 0, text: '', headers: null, error: 'rejected' }
  )

  // 主页面失败就基本没得判 —— 整次返回错误
  if (!page.ok && page.status !== 200 && page.status !== 301 && page.status !== 302) {
    return { error: `主页面 HTTP ${page.status || page.error || 'fail'}`, score: null }
  }

  const html = page.text || ''
  const finalUrl = page.finalUrl || startUrl
  const finalOrigin = (() => { try { return new URL(finalUrl).origin } catch { return origin } })()
  const meta = parseMetaTags(html)
  const headings = parseHeadings(html)
  const jsonLd = parseJsonLd(html)
  const links = parseLinks(html)
  const images = parseImages(html)
  const linkRels = parseLinkRels(html)
  const schemaTypes = collectSchemaTypes(jsonLd)

  // noindex 信号：搜索引擎主动声明不收录。三处来源按优先级并联取：
  //   · meta robots / googlebot / bingbot 等带 noindex
  //   · 响应头 X-Robots-Tag: noindex
  //   这是测试 / 预发 / 内部页的典型标记 —— 检测到后取消 canonical 冲突扣分 + 报告标注。
  const META_NOINDEX_BOTS = ['robots', 'googlebot', 'bingbot', 'duckduckbot', 'baiduspider']
  const hasNoindex = (() => {
    for (const k of META_NOINDEX_BOTS) {
      const v = meta[k]
      if (typeof v === 'string' && /\bnoindex\b/i.test(v)) return true
    }
    const xrt = page.headers?.get?.('x-robots-tag')
    if (xrt && /\bnoindex\b/i.test(xrt)) return true
    return false
  })()

  // 内容类型
  const contentType = page.headers?.get?.('content-type') || ''
  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || looksLikeHtml(html)
  // 主文本长度（剥掉 HTML 标签）
  const textContentLen = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length

  const dims = []

  // ① 可访问性
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    const u0 = normalizeUrl(url)
    if (u0?.protocol === 'https:') { ev.push('HTTPS'); score += 3 }
    else gaps.push('不是 HTTPS —— 浏览器会标"不安全"，AI 爬虫也常跳过')

    if (page.status === 200) { ev.push(`HTTP 200`); score += 2 }
    else if (page.status) gaps.push(`HTTP ${page.status}（非 200）`)

    if (page.redirected) { ev.push(`重定向到 ${finalUrl}`); score += 0.5 }
    else { ev.push('无重定向'); score += 1 }

    if (page.ttfb < 500) { ev.push(`TTFB ${page.ttfb}ms`); score += 2 }
    else if (page.ttfb < 1500) { ev.push(`TTFB ${page.ttfb}ms`); score += 1 }
    else gaps.push(`TTFB ${page.ttfb}ms —— 太慢`)

    dims.push({
      key: 'accessibility', name: '可访问性', score: normalizeDim(score, 0), unverifiable: 0,
      evidence: ev, gaps, manual: ['真实浏览体验（CDN 边缘节点的延迟本报告未算）'],
    })
  }

  // ② SEO 基础
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
    if (title && title.length <= 60) { ev.push(`title: "${title.slice(0, 40)}…"（${title.length} 字符）`); score += 1.5 }
    else if (title) { ev.push(`title 偏长（${title.length} 字符）`); score += 0.5 }
    else gaps.push('没有 <title>')

    if (meta.description) { ev.push('meta description 存在'); score += 2 }
    else gaps.push('没有 meta description')

    // OG 拆开打分：og:image 是 Twitter / LinkedIn / 微信分享的预览图，没它分享卡片就裂；
// og:title / og:description 是基础 OG —— 拆开后哪条缺一眼能看出。
    if (meta['og:title']) { ev.push('有 og:title'); score += 0.5 }
    else gaps.push('没有 og:title')
    if (meta['og:description']) { ev.push('有 og:description'); score += 0.5 }
    else gaps.push('没有 og:description')
    if (meta['og:image']) { ev.push(`有 og:image: ${String(meta['og:image']).slice(0, 60)}${String(meta['og:image']).length > 60 ? '…' : ''}`); score += 1.5 }
    else gaps.push('没有 og:image —— Twitter / LinkedIn / 微信分享时没预览图')

    // canonical 冲突：声明了 canonical，但指向的 host 跟当前页 host 不一致 —— 搜索引擎要么按
    // canonical 收录（等于本页白做），要么看到冲突降权。两个常见原因：测试站指向生产域名，
    // 或者不同语言/区域的副本没各自指回自己。
    // 例外：声明了 noindex（测试/预发/内部页）时，搜索引擎本来就不会收录本页，
    // canonical 指哪儿都无所谓，冲突扣分撤销。
    const canonical = linkRels.canonical || meta.canonical
    if (canonical) {
      try {
        const cu = new URL(canonical, finalOrigin)
        if (cu.origin === finalOrigin) {
          ev.push(`canonical 一致（${canonical}）`); score += 1.5
        } else if (hasNoindex) {
          ev.push(`canonical 指 ${cu.origin}（已声明 noindex，搜索引擎不收录，指向无影响）`); score += 1.5
        } else {
          gaps.push(`canonical 冲突：当前 ${finalOrigin}，canonical 指 ${cu.origin} —— 重复内容会稀释权重`)
          score += 0.5
        }
      } catch {
        ev.push(`有 canonical（${canonical}）`); score += 1
      }
    } else if (hasNoindex) {
      // 测试/预发页不该有 canonical —— 没声明反而是正确做法
      ev.push('没声明 canonical（已 noindex —— 搜索引擎不会收录，无需去重）'); score += 1.5
    } else {
      gaps.push('没有 canonical —— 重复内容会稀释搜索权重')
    }

    // 顶层把 noindex 信号标注一次 —— 让报告读者一眼知道这是测试/预发页
    if (hasNoindex) ev.unshift('页面声明 noindex（测试 / 预发 / 内部页）—— 搜索引擎不会收录')

    if (meta.viewport) { ev.push('有 viewport meta'); score += 1.5 }
    else gaps.push('没有 viewport meta —— 移动端会按桌面宽度渲染')

    if (meta['twitter:card']) { ev.push('有 twitter:card'); score += 1 }
    else gaps.push('没有 twitter:card')

    dims.push({
      key: 'seo', name: 'SEO 基础', score: normalizeDim(score, 0), unverifiable: 0,
      evidence: ev, gaps, manual: ['站内链接权重分配（PageRank 这类指标本报告不算）'],
    })
  }

  // ③ 内容结构 — h1-h6 / 语义 HTML
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    const h1s = headings.filter((h) => h.level === 1)
    if (h1s.length === 1) { ev.push('h1 恰好 1 个'); score += 2.5 }
    else if (h1s.length === 0) gaps.push('没有 h1')
    else gaps.push(`h1 有 ${h1s.length} 个 —— SEO 不友好`)

    const h2Count = headings.filter((h) => h.level === 2).length
    if (h2Count >= 3) { ev.push(`h2 有 ${h2Count} 个 —— 结构清晰`); score += 2 }
    else if (h2Count > 0) { ev.push(`h2 只有 ${h2Count} 个`); score += 1 }
    else gaps.push('没有 h2 —— 没有章节划分')

    // 层级跳跃检测：h4 直接出现在没 h3 的位置 = 跳过
    let skip = 0
    let prev = 1
    for (const h of headings) {
      if (h.level > prev + 1) skip++
      prev = h.level
    }
    if (!skip) { ev.push('标题层级无跳跃'); score += 1.5 }
    else gaps.push(`${skip} 处标题层级跳跃（h3 缺失却出现 h4）`)

    // 语义标签
    const semantic = (html.match(/<(article|main|nav|aside|section|header|footer)\b/gi) || []).length
    if (semantic >= 5) { ev.push(`${semantic} 个语义化标签（article / main / nav ...）`); score += 2 }
    else if (semantic >= 2) { ev.push(`${semantic} 个语义化标签`); score += 1 }
    else gaps.push('几乎没有 <article> / <main> / <nav> 等语义化标签')

    dims.push({
      key: 'structure', name: '内容结构', score: normalizeDim(score, 0), unverifiable: 0,
      evidence: ev, gaps, manual: ['关键内容是否在 main landmark 内（需可视化检查）'],
    })
  }

  // ④ AI 识别 — llms.txt / llms-full.txt / og:type / schema.org 类型 / AI 专属 meta
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    let unv = 0

    if (llms.ok && isRealLlmsTxt(llms.text)) { ev.push(`llms.txt 存在且为真 markdown（${llms.text.trim().length} 字符）`); score += 3 }
    else if (llms.status === 200 && looksLikeHtml(llms.text)) {
      // SPA fallback 把 llms.txt 顶成 index.html
      gaps.push('llms.txt 路径返回的是 HTML（SPA 没抢）')
    } else {
      unv += 3
      manual.push('llms.txt 不存在 —— 这 3 分已从满分中剔除（llmstxt.org 是 AI 助手的标准入口）')
    }

    if (llmsFull.ok && isRealLlmsTxt(llmsFull.text)) { ev.push(`llms-full.txt 存在（${llmsFull.text.trim().length} 字符，给 AI 长上下文用）`); score += 1.5 }
    else { unv += 1.5; manual.push('llms-full.txt 不存在 —— 这 1.5 分已从满分中剔除') }

    if (meta['og:type']) { ev.push(`og:type = ${meta['og:type']}`); score += 1 }
    else gaps.push('没有 og:type —— AI 抓站时难以判断页面类型')

    const aiTypes = schemaTypes.filter((t) => AI_SCHEMA_TYPES.has(t))
    if (aiTypes.length) { ev.push(`schema.org 类型：${aiTypes.join('、')}`); score += 1.5 }
    else gaps.push('没有 schema.org JSON-LD 或没有 AI 友好的类型')

    // AI 专属 meta（出现就算 —— 标准未定，先记出现）
    const aiMeta = ['ai-content-declaration', 'ai-training-allowed', 'ai-crawler-policy'].filter((k) => meta[k])
    if (aiMeta.length) { ev.push(`AI 专属 meta: ${aiMeta.join('、')}`); score += 1 }
    else { unv += 1; manual.push('AI 专属 meta 标签未声明 —— 这 1 分已从满分中剔除（标准尚不成熟）') }

    dims.push({
      key: 'ai-id', name: 'AI 识别', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['llms.txt 内容质量（引擎只判存在与格式，内容语义需人工）'],
    })
  }

  // ⑤ 爬虫根目录 — robots.txt / sitemap.xml / .well-known/* / favicon / humans.txt
  {
    const ev = [], gaps = [], manual = []
    let score = 0
    let unv = 0

    if (robots.ok && !looksLikeHtml(robots.text)) {
      const allows = robotsAllowsAiBots(robots.text)
      allows ? ev.push('robots.txt 放行 AI 爬虫') : gaps.push('robots.txt 屏蔽了 AI 爬虫')
      score += allows ? 2.5 : 0.5
    } else if (robots.status === 200 && looksLikeHtml(robots.text)) {
      ev.push('robots.txt 路径返回 HTML（SPA fallback —— 默认放行所有爬虫）'); score += 2
    } else {
      // 404 = robots 协议下默认放行
      ev.push('没有 robots.txt —— 按协议默认放行所有爬虫（含 AI）'); score += 2
    }

    // sitemap.xml：不仅判"是不是有效 XML"，还要看里面 URL 数。1 个 URL 的 sitemap 等于没有；
// 一个产品站点的 sitemap 应当覆盖全部可索引页面（典型 10+）。阈值按"明显不合理"给：
// < 5 → 几乎等于没写；≥ 50 → 健康。
if (sitemap.ok && /<\?(xml|xml-stylesheet)|<urlset|<sitemapindex/i.test(sitemap.text)) {
  const urlCount = (sitemap.text.match(/<loc>[^<]+<\/loc>/g) || []).length
  if (urlCount >= 50) { ev.push(`sitemap.xml 有效 · 含 ${urlCount} 个 URL —— 覆盖完整`); score += 2.5 }
  else if (urlCount >= 10) { ev.push(`sitemap.xml 有效 · 含 ${urlCount} 个 URL`); score += 2 }
  else if (urlCount >= 1) { gaps.push(`sitemap.xml 只有 ${urlCount} 个 URL —— 几乎等于没写，搜索引擎能抓的页面数被卡死`); score += 0.5 }
  else { gaps.push('sitemap.xml 是空 XML（无 <loc> 条目）'); score += 0.5 }
} else { unv += 2; manual.push('sitemap.xml 不存在或不是有效 XML —— 这 2 分已从满分中剔除') }

    if (securityTxt.ok) { ev.push('.well-known/security.txt 存在'); score += 1 }
    else gaps.push('没有 .well-known/security.txt —— 安全研究者联系不到')

    if (humans.ok && !looksLikeHtml(humans.text)) { ev.push('humans.txt 存在（站点人认领口）'); score += 0.5 }
    else gaps.push('没有 humans.txt')

    if (favicon.ok) { ev.push('favicon.ico 存在'); score += 1 }
    else gaps.push('没有 favicon.ico —— 浏览器标签页空白')

    if (appleTouch.ok) { ev.push('apple-touch-icon.png 存在（iOS 主屏）'); score += 0.5 }
    else gaps.push('没有 apple-touch-icon.png')

    dims.push({
      key: 'root-files', name: '爬虫根目录', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['sitemap.xml 是否覆盖全部 URL（XML 内部判断需遍历）'],
    })
  }

  // ⑥ 安全响应头
  {
    const ev = [], gaps = [], manual = []
    let score = 0
    let unv = 0
    const h = page.headers
    if (!h) {
      gaps.push('响应头未拿到 —— 这维全维作废')
      unv += 9
    } else {
      if (h.get('content-security-policy')) { ev.push('有 CSP'); score += 2.5 }
      else gaps.push('没有 Content-Security-Policy')

      if (h.get('strict-transport-security')) { ev.push(`有 HSTS：${h.get('strict-transport-security').slice(0, 60)}`); score += 2 }
      else gaps.push('没有 Strict-Transport-Security')

      if (h.get('x-frame-options') || h.get('content-security-policy')?.includes('frame-ancestors')) { ev.push('有 X-Frame-Options 或 frame-ancestors'); score += 1.5 }
      else gaps.push('没有 X-Frame-Options —— 可被 iframe 嵌入')

      if (h.get('referrer-policy')) { ev.push(`Referrer-Policy: ${h.get('referrer-policy')}`); score += 1.5 }
      else gaps.push('没有 Referrer-Policy')

      if (h.get('x-content-type-options') === 'nosniff') { ev.push('X-Content-Type-Options: nosniff'); score += 1 }
      else gaps.push('没有 X-Content-Type-Options: nosniff')

      if (h.get('permissions-policy')) { ev.push('有 Permissions-Policy'); score += 0.5 }
    }

    dims.push({
      key: 'security-headers', name: '安全响应头', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['CSP 是否真的有效（语法正确性需要专业工具）'],
    })
  }

  // ⑦ 性能
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    const h = page.headers
    const ce = h?.get('content-encoding')
    if (ce && /\b(gzip|br|deflate|zstd)\b/i.test(ce)) { ev.push(`响应已压缩：${ce}`); score += 2.5 }
    else gaps.push('响应未压缩')

    const cc = h?.get('cache-control')
    if (cc && /max-age|public|immutable/i.test(cc)) { ev.push(`Cache-Control: ${cc.slice(0, 60)}`); score += 1.5 }
    else if (cc) { ev.push(`Cache-Control: ${cc.slice(0, 60)}`); score += 0.5 }
    else gaps.push('没有 Cache-Control')

    if (page.ttfb < 300) { ev.push(`TTFB ${page.ttfb}ms`); score += 2 }
    else if (page.ttfb < 1000) { ev.push(`TTFB ${page.ttfb}ms`); score += 1 }
    else gaps.push(`TTFB ${page.ttfb}ms`)

    // 现代图片格式
    const webp = images.some((src) => /\.webp(\?|$)/i.test(src))
    const avif = images.some((src) => /\.avif(\?|$)/i.test(src))
    if (avif) { ev.push('用了 AVIF 图片'); score += 1.5 }
    else if (webp) { ev.push('用了 WebP 图片'); score += 1 }
    else if (images.length > 5) gaps.push('图片很多但没用 WebP/AVIF')
    else { ev.push(`图片 ${images.length} 张，无需现代格式`); score += 0.5 }

    const sizeKB = html.length / 1024
    if (sizeKB < 100) { ev.push(`HTML 主体 ${sizeKB.toFixed(0)} KB`); score += 1.5 }
    else if (sizeKB < 300) { ev.push(`HTML 主体 ${sizeKB.toFixed(0)} KB`); score += 0.5 }
    else gaps.push(`HTML 主体 ${sizeKB.toFixed(0)} KB —— 偏大`)

    dims.push({
      key: 'performance', name: '性能', score: normalizeDim(score, 0), unverifiable: 0,
      evidence: ev, gaps, manual: ['Lighthouse / WebPageTest 完整跑分（本报告只看原始指标）'],
    })
  }

  // ⑧ WebMCP 友好性 — MCP 端点 / ai-plugin / openapi
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    let unv = 0

    // 主信号：MCP 清单
    if (mcpJson.ok) {
      try {
        const j = JSON.parse(mcpJson.text)
        // MCP server descriptor 通常含 name/servers/tools/...
        const looksMcp = j && (j.servers || j.mcpServers || j.tools || j.name)
        if (looksMcp) {
          ev.push(`/.well-known/mcp.json 存在（${Object.keys(j).join('、')}）`); score += 4
        } else {
          ev.push('.well-known/mcp.json 是 JSON 但不含 MCP 标准字段'); score += 1
        }
      } catch {
        ev.push('.well-known/mcp.json 是 200 但不是 JSON'); score += 0.5
      }
    } else { unv += 4; manual.push('.well-known/mcp.json 不存在 —— 这 4 分已从满分中剔除（MCP 还是新标准，多数站没暴露）') }

    // OpenAI plugin manifest
    if (aiPlugin.ok) {
      try {
        const j = JSON.parse(aiPlugin.text)
        if (j.schema_version || j.name_for_model || j.api) {
          ev.push('OpenAI plugin manifest（/.well-known/ai-plugin.json）'); score += 2
        } else {
          ev.push('.well-known/ai-plugin.json 是 JSON 但字段不像 plugin 清单'); score += 0.5
        }
      } catch { ev.push('.well-known/ai-plugin.json 是 200 但不是 JSON'); score += 0.5 }
    } else { unv += 2; manual.push('.well-known/ai-plugin.json 不存在 —— 这 2 分已从满分中剔除') }

    // OpenAPI 规范
    const openapi = openapi1.ok ? openapi1 : (openapi2.ok ? openapi2 : null)
    if (openapi) {
      try {
        const j = JSON.parse(openapi.text)
        if (j.openapi || j.swagger) { ev.push(`OpenAPI 规范暴露（${j.info?.title || j.openapi || j.swagger}）`); score += 1.5 }
        else { ev.push('openapi.json 存在但不像规范'); score += 0.5 }
      } catch { /* 不是 JSON */ }
    } else { unv += 1.5; manual.push('openapi.json / api/openapi.json 都不存在 —— 这 1.5 分已从满分中剔除') }

    dims.push({
      key: 'webmcp', name: 'WebMCP 友好性', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['MCP server 端点是否真的在线（需实际握手）', '插件 manifest 的 schema 版本是否符合对应协议规范'],
    })
  }

  // ⑨ 内容质量
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    if (textContentLen > 1500) { ev.push(`主文本 ${textContentLen} 字符`); score += 2 }
    else if (textContentLen > 400) { ev.push(`主文本 ${textContentLen} 字符`); score += 1 }
    else if (textContentLen > 100) gaps.push(`主文本只有 ${textContentLen} 字符 —— SPA / 单页壳？`)
    else gaps.push(`主文本 ${textContentLen} 字符 —— 几乎没内容`)

    // SPA fallback 检测：标题与正文都空
    const isSpaShell = isHtml && textContentLen < 200 && links.length < 5
    if (isSpaShell) gaps.push('看起来是 SPA 空壳 —— 客户端 JS 跑起来之前没实质内容（SEO 与爬虫拿不到）')

    if (links.length >= 10) { ev.push(`${links.length} 个站内 / 出站链接`); score += 1.5 }
    else if (links.length > 0) { ev.push(`${links.length} 个链接`); score += 0.5 }
    else gaps.push('没有任何 <a> 链接')

    if (page.headers?.get('last-modified')) { ev.push('有 Last-Modified 响应头'); score += 1.5 }
    else gaps.push('没有 Last-Modified 响应头 —— 缓存与新鲜度信号弱')

    const lang = (html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)/i)?.[1] || '').trim()
    if (lang) { ev.push(`html lang="${lang}"`); score += 1.5 }
    else gaps.push('没有 <html lang="..."> —— 屏幕阅读器 / 翻译工具拿不到语言')

    if (isHtml && contentType && !/text\/html/i.test(contentType)) gaps.push(`content-type 不是 text/html（${contentType.slice(0, 40)}）`)

    dims.push({
      key: 'content', name: '内容质量', score: normalizeDim(score, 0), unverifiable: 0,
      evidence: ev, gaps, manual: ['死链体检（需要遍历所有内链逐个 HEAD）', '正文真实性（AI 生成内容占比需要专门的检测器）'],
    })
  }

  // 总分
  const scored = dims.filter((d) => d.score != null)
  const inconclusive = dims.filter((d) => d.score == null).map((d) => d.name)
  if (!scored.length) {
    return { error: '九个维度都无从核实', score: null, project: startUrl, dims, scoredCount: 0, inconclusiveDims: inconclusive }
  }
  const score = clamp(scored.reduce((s, d) => s + d.score, 0) / scored.length)

  const todos = scored
    .filter((d) => d.gaps.length)
    .sort((a, b) => a.score - b.score)
    .flatMap((d) => d.gaps.map((g) => ({ dim: d.name, dimScore: d.score, text: g })))

  return {
    project: startUrl,
    finalUrl,
    finalOrigin,
    type: 'webpage',
    score,
    band: bandOf(score).label,
    bandHint: bandOf(score).hint,
    stars: 0,
    ttfb: page.ttfb,
    httpStatus: page.status,
    contentType,
    // 测试/预发/内部页主动声明不收录的信号 —— 报告里显眼地标出来
    noindex: hasNoindex,
    dims,
    todos,
    scoredCount: scored.length,
    inconclusiveDims: inconclusive,
    ts: new Date().toISOString(),
  }
}

/**
 * Markdown 报告 —— 与 audit.js / audit-npm.js 同一骨架（结论 → 清单 → 证据 → 可照抄指令），
 * 文案换成网页上下文。
 */
export function reportMarkdown(a, { site = '' } = {}) {
  const L = []
  const pct = (n) => '█'.repeat(Math.round(n)) + '░'.repeat(10 - Math.round(n))

  L.push(`# 网页质检报告 · ${a.project}`)
  L.push('')
  L.push(`**${a.score} / 9** — ${a.band}`)
  if (a.bandHint) L.push(`*${a.bandHint}*`)
  L.push('')
  // 测试/预发/内部页会主动声明 noindex，报告里一眼可见 —— 不会被误读为"上线了"
  if (a.noindex) {
    L.push(`> 🚧 本页声明了 **noindex** —— 测试 / 预发 / 内部页，搜索引擎不会收录，参考用`)
    L.push('')
  }
  L.push(`站点类型 \`${a.type}\` · HTTP ${a.httpStatus || '?'}${a.finalUrl && a.finalUrl !== a.project ? ` · 最终 ${a.finalUrl}` : ''}${a.ttfb != null ? ` · TTFB ${a.ttfb}ms` : ''} · 生成于 ${new Date(a.ts).toISOString().slice(0, 16).replace('T', ' ')}`)
  if (a.scoredCount != null && a.scoredCount < 9) {
    L.push('')
    L.push(`> 本次只有 ${a.scoredCount} 个维度拿到了可核实的证据，总分是这几维的平均。`)
    if (a.inconclusiveDims?.length) {
      L.push(`> 未计入：${a.inconclusiveDims.join('、')} —— 不是这些维度不合格，是审计引擎读不到判据（如新标准 MCP / llms.txt）。`)
    }
  }
  L.push('')
  L.push('九维标准独立于 scorecard 的 GitHub 仓库与 npm 包质检 —— 网页有自己的判据集：')
  L.push('评的不是"代码好不好"，是"站点对人类与 AI 助手是否都友好"。')
  L.push('')

  L.push('## 记分卡')
  L.push('')
  L.push('| 维度 | 得分 | | 最该补的一件事 |')
  L.push('|---|---:|---|---|')
  for (const d of a.dims) {
    if (d.score == null) {
      L.push(`| ${d.name} | — | \`判不了\` | 审计引擎读不到这一维的判据，未计入总分 |`)
      continue
    }
    const note = d.unverifiable > 0 ? `（按可核实的 ${10 - d.unverifiable} 分归一化）` : ''
    L.push(`| ${d.name} | ${d.score}${note} | \`${pct(d.score)}\` | ${d.gaps[0] || '—'} |`)
  }
  L.push('')

  if (a.todos.length) {
    L.push('## 整改清单')
    L.push('')
    L.push('按维度得分升序 —— 排在前面的影响最大。')
    L.push('')
    a.todos.forEach((t, i) => L.push(`${i + 1}. **[${t.dim} ${t.dimScore}]** ${t.text}`))
    L.push('')
  }

  L.push('## 逐维度证据')
  L.push('')
  L.push('每条结论都有实际查到的东西支撑，没有"有待完善"这种没法行动的话。')
  L.push('')
  for (const d of a.dims) {
    L.push(`### ${d.name} — ${d.score == null ? '判不了（未计入总分）' : `${d.score}/9`}`)
    L.push('')
    for (const e of d.evidence) L.push(`- ✅ ${e}`)
    for (const g of d.gaps) L.push(`- ❌ ${g}`)
    if (d.manual?.length) {
      L.push(`- ⚠️ 自动判不了，需人工或 AI 判断：${d.manual.join('、')}`)
    }
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('## 把这份报告交给 AI')
  L.push('')
  L.push('复制整份报告，连同站点一起给 Claude Code / Cursor / Copilot，然后说：')
  L.push('')
  L.push('```')
  L.push('照这份质检报告改进这个站点。从整改清单第 1 条开始，一次做一条，')
  L.push('每条改完告诉我动了哪些文件、为什么这么改。')
  L.push('标着"自动判不了"的几项，你打开站点后给我你的结论。')
  L.push('```')
  if (site) {
    L.push('')
    L.push(`> 本报告由 [Scorecard 开源项目质检](${site}) 生成，任何公开 URL 都能免费跑一次。`)
  }
  return L.join('\n')
}