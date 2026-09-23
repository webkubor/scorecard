/**
 * npm 包审计引擎 —— 独立判据集，不与 GitHub repo 审计共用维度。
 *
 * 为什么独立成文件：npm 包和开源仓库是两件不同的事，硬塞进同一套九维会失真。
 * 仓库看"陌生人会不会 10 秒 star / install / trust"；npm 包看的是"装上能不能用、
 * 有没有维护、依赖是否干净、AI 助手要不要读得懂这个包页"。两边判据互不通用。
 *
 * 同 audit.js 一样：只做客观项（registry API / 文件内容 / HTTP 状态码），
 * 查不到的判据归 unverifiable，不当作"不满足"扣分。
 *
 * 七维（每维满分 10）：
 *   ① 门面        — 描述、关键词、主页、作者、license
 *   ② 版本节奏    — 最新版本号、semver 严格度、距上次发布天数
 *   ③ 下载量      — 周下载、月下载、增长趋势
 *   ④ 依赖治理    — 直接依赖数、peerDeps、engines 字段
 *   ⑤ 文档        — README 章节、示例代码块、TS 类型支持
 *   ⑥ 安全        — deprecated 标记、危险 scripts、维护者数量
 *   ⑦ AI 可读性   — 结构化 README、示例、机器可读字段
 */

const REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS_API = 'https://api.npmjs.org/downloads'

const clamp = (n) => Math.max(0, Math.min(10, Math.round(n * 10) / 10))

/**
 * 归一化：当一部分判据对当前包型态无从核实，剔除分母、把剩下归一回 10 分制。
 * 判据是模块本地的，和 audit.js 的同名函数不共享 —— 各自口径独立。
 */
function normalizeDim(score, unv) {
  const denom = 10 - unv
  if (denom < 2) return null
  return clamp((score / denom) * 10)
}

function bandOf(score) {
  if (score >= 9) return { label: '同品类头部', hint: '依赖少、周下载高、维护活跃、类型完备' }
  if (score >= 6) return { label: '可放心使用', hint: '维护活跃、文档齐全' }
  if (score >= 3) return { label: '能用但有欠账', hint: '' }
  return { label: '谨慎使用', hint: '' }
}

/** 检测 npm 包页是否真的是 SPA fallback（dist 路径的 tarball HTML） */
function looksLikeHtml(text) {
  return /<!doctype\s+html|<html[\s>]/i.test(String(text).slice(0, 200))
}

async function safeJson(url, { timeout = 15000 } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'scorecard-audit (+https://scorecard.webkubor.online)' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return { ok: false, status: res.status, data: null }
    const data = await res.json().catch(() => null)
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message }
  }
}

/**
 * 拿 README —— registry 自带的 readme 字段对"从 GitHub 发布"的大包经常为空。
 * 这种包真正的 README 在仓库里，按 repository 字段 fallback 到 raw.githubusercontent.com。
 */
async function resolveReadme(meta, pkgName) {
  if (meta.readme && meta.readme.length > 50) return meta.readme
  // 从 repository 字段解出 owner/repo
  const repoUrl = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url
  const m = String(repoUrl || '').match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (!m) return meta.readme || ''
  const [, owner, repo] = m
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'scorecard-audit' },
      })
      if (res.ok) {
        const t = await res.text()
        if (t.length > 50) return t
      }
    } catch { /* 试下一分支 */ }
  }
  return meta.readme || ''
}

/**
 * 跑一次完整审计。
 * @param {{pkg:string, token?:string}} opts
 */
export async function auditPackage({ pkg, token }) {
  const full = String(pkg || '').trim()
  if (!full) return { error: 'pkg required', score: null }
  // npm 包名：允许 @scope/name、带 - 加 _ 加 ~，不允许斜杠和点结尾
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(full)) {
    return { error: 'pkg 格式不合法', score: null }
  }

  // 并发拉 registry 元数据 + 两个时间窗的下载量
  const [meta, weekly, monthly] = await Promise.all([
    safeJson(`${REGISTRY}/${encodeURIComponent(full).replace('%40', '@')}`),
    safeJson(`${DOWNLOADS_API}/point/last-week/${encodeURIComponent(full)}`),
    safeJson(`${DOWNLOADS_API}/range/last-month/${encodeURIComponent(full)}`),
  ])

  if (!meta.ok) return { error: `registry HTTP ${meta.status || meta.error || 'fail'}`, score: null }

  const m = meta.data
  const latest = m['dist-tags']?.latest
  const latestMeta = latest ? m.versions?.[latest] || {} : {}
  // README：registry 自带的 readme 经常为空（"从 GitHub 发布"的大包多见），
  // 见 resolveReadme() 走 GitHub raw fallback —— 不读到才算读不到。
  const readme = await resolveReadme(m, full)
  const readmeLen = readme.length
  const created = m.time?.created
  const modified = m.time?.modified
  const lastPublished = latest ? m.time?.[latest] : modified
  // readme 来源：registry 自带 / GitHub raw 兜底 / 都拿不到
  const readmeSource = !readme ? 'none' : (readme === m.readme ? 'registry' : 'github')

  // 包型态（用于决定哪些维度的解读重点）
  const type = latestMeta.bin ? 'cli'
    : (latestMeta.types || latestMeta.typings) ? 'library'
    : /react|vue|svelte/i.test(full) ? 'framework'
    : 'package'

  const dims = []

  // ① 门面 — 包页在 npmjs.com 上展示的元数据
  {
    const ev = [], gaps = []
    let score = 1
    let unv = 0
    if (m.description) { ev.push(`description: "${String(m.description).slice(0, 60)}"`); score += 2 }
    else gaps.push('description 为空 —— npm 搜索结果会显示空白')

    const kws = Array.isArray(m.keywords) ? m.keywords : []
    if (kws.length >= 5) { ev.push(`keywords ${kws.length} 个`); score += 2 }
    else gaps.push(`keywords 只有 ${kws.length} 个（应 ≥5，便于搜索命中）`)

    if (m.homepage) { ev.push(`homepage: ${m.homepage}`); score += 1.5 }
    else gaps.push('homepage 未配置')

    const author = typeof m.author === 'string' ? m.author : m.author?.name
    if (author) { ev.push(`author: ${author}`); score += 1.5 }
    else gaps.push('author 未声明')

    if (m.license) {
      const lic = typeof m.license === 'string' ? m.license : m.license?.type
      if (lic) { ev.push(`license: ${lic}`); score += 2 }
    } else gaps.push('license 未声明 —— 公司用户直接过滤掉')

    dims.push({
      key: 'facade', name: '门面', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['包在 npmjs.com 上的实际排版 / banner 是否专业（API 不暴露）'],
    })
  }

  // ② 版本节奏 — 多久更一版、版本号规不规范
  {
    const ev = [], gaps = []
    let score = 1
    let unv = 0
    if (latest) { ev.push(`最新版本 ${latest}`); score += 2 }
    else { gaps.push('没有 latest 版本'); }

    // semver 严格匹配 X.Y.Z；预发布 / 构建元数据允许
    if (latest && /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(latest)) { ev.push('严格 semver'); score += 2 }
    else if (latest) gaps.push(`版本号 "${latest}" 不符合严格 semver X.Y.Z`)

    const versions = Object.keys(m.versions || {})
    if (versions.length >= 5) { ev.push(`共 ${versions.length} 个版本`); score += 1 }
    else if (versions.length > 1) { ev.push(`共 ${versions.length} 个版本`); score += 0.5 }
    else gaps.push('只有 1 个版本 —— 迭代痕迹不明显')

    if (lastPublished) {
      const days = Math.floor((Date.now() - new Date(lastPublished).getTime()) / 86400000)
      if (days <= 30) { ev.push(`${days} 天前发布`); score += 3 }
      else if (days <= 90) { ev.push(`${days} 天前发布`); score += 2 }
      else if (days <= 365) { ev.push(`${days} 天前发布`); score += 1 }
      else gaps.push(`最后一次发布在 ${days} 天前 —— 可能已停更`)
    } else { unv += 3; manual.push('发布时间读不到 —— 这 3 分已从满分中剔除') }

    dims.push({
      key: 'cadence', name: '版本节奏', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['破坏性变更是否在 major bump 中体现', '是否跟随上游依赖主动升级'],
    })
  }

  // ③ 下载量 — 真的有人在用吗
  {
    const ev = [], gaps = []
    let score = 0
    let unv = 0
    if (weekly.ok) {
      const w = Number(weekly.data?.downloads || 0)
      if (w >= 100000) { ev.push(`周下载 ${w.toLocaleString('en-US')}`); score += 4 }
      else if (w >= 10000) { ev.push(`周下载 ${w.toLocaleString('en-US')}`); score += 3 }
      else if (w >= 1000) { ev.push(`周下载 ${w.toLocaleString('en-US')}`); score += 2 }
      else if (w >= 100) { ev.push(`周下载 ${w}`); score += 1 }
      else gaps.push(`周下载 ${w} —— 几乎无人使用`)
    } else { unv += 4; manual.push('周下载量读不到 —— 这 4 分已从满分中剔除') }

    // 趋势：用最近 7 天平均 vs 月度平均比较
    if (monthly.ok && Array.isArray(monthly.data?.downloads)) {
      const days = monthly.data.downloads
      const last7 = days.slice(-7).reduce((s, d) => s + d.downloads, 0)
      const avg30 = days.reduce((s, d) => s + d.downloads, 0) / Math.max(days.length, 1)
      const projWeek = (last7 / 7) * 30
      const trend = projWeek > avg30 * 1.05 ? '↑ 上升' : projWeek < avg30 * 0.95 ? '↓ 下降' : '→ 平稳'
      ev.push(`月下载趋势 ${trend}`)
      if (trend === '↑ 上升') score += 3
      else if (trend === '→ 平稳') score += 2
      else score += 0.5
    } else { unv += 1.5; manual.push('月度下载曲线读不到 —— 这 1.5 分已从满分中剔除') }

    dims.push({
      key: 'downloads', name: '下载量', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['下游依赖此包的知名项目列表（npmjs 不直接暴露）'],
    })
  }

  // ④ 依赖治理 — 装上会不会拖一大堆东西进来
  {
    const ev = [], gaps = []
    let score = 1
    let unv = 0
    const deps = latestMeta.dependencies || {}
    const peer = latestMeta.peerDependencies || {}
    const dev = latestMeta.devDependencies || {}
    const depCount = Object.keys(deps).length
    const peerCount = Object.keys(peer).length

    if (depCount === 0) { ev.push('零运行时依赖 —— 最干净'); score += 3 }
    else if (depCount <= 5) { ev.push(`${depCount} 个运行时依赖`); score += 2.5 }
    else if (depCount <= 15) { ev.push(`${depCount} 个运行时依赖 —— 偏多`); score += 1 }
    else gaps.push(`${depCount} 个运行时依赖 —— 依赖图复杂，供应链风险高`)

    if (peerCount > 0) { ev.push(`${peerCount} 个 peerDependencies`); score += 1.5 }
    else gaps.push('没声明 peerDependencies —— 宿主框架可能要手动装')

    const engines = latestMeta.engines || {}
    if (engines.node) { ev.push(`engines.node: ${engines.node}`); score += 2 }
    else gaps.push('未声明 engines.node —— 用户不知道最低 Node 版本')

    // 传递依赖体量（unpackedSize 是 npm 算好的间接信号）
    const unSize = latestMeta.dist?.unpackedSize
    if (typeof unSize === 'number' && unSize > 0) {
      const mb = (unSize / 1024 / 1024).toFixed(2)
      ev.push(`安装包体积 ${mb} MB`)
      if (unSize <= 1 * 1024 * 1024) score += 1.5
      else if (unSize <= 10 * 1024 * 1024) score += 0.5
      else gaps.push(`安装包体积 ${mb} MB —— 偏大`)
    }

    dims.push({
      key: 'deps', name: '依赖治理', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['依赖中是否含有已弃用 / 已知漏洞包（npm audit 才知道）'],
    })
  }

  // ⑤ 文档 — 装上后能不能照着 README 跑通
  {
    const ev = [], gaps = []
    const manual = []
    let score = 1
    let unv = 0
    const sec = (re) => re.test(readme)
    if (!readme) {
      unv += 9
      manual.push('README 读不到 —— 这 9 分已从满分中剔除')
    } else {
      // 标记 README 真实来源 —— 从 GitHub 发布的大包 registry 不带 readme
      const srcLabel = readmeSource === 'github' ? '（来自 GitHub raw fallback）' : '（来自 registry）'
      if (readmeLen > 800) { ev.push(`README ${readmeLen} 字符${srcLabel}`); score += 2 }
      else gaps.push(`README 只有 ${readmeLen} 字符${srcLabel}`)

      if (sec(/^#{1,4}[^\n]*(install|安装|setup|getting started)/im)) { ev.push('有安装章节'); score += 1.5 }
      else gaps.push('README 没有安装章节')

      if (sec(/^#{1,4}[^\n]*(usage|使用|用法|example|示例|api|config|options)/im)) { ev.push('有使用 / API 章节'); score += 1.5 }
      else gaps.push('README 没有使用 / API 章节')

      const codeBlocks = (readme.match(/```[\s\S]*?```/g) || []).length
      if (codeBlocks >= 3) { ev.push(`含 ${codeBlocks} 段代码块`); score += 1.5 }
      else if (codeBlocks >= 1) { ev.push(`含 ${codeBlocks} 段代码块`); score += 0.5 }
      else gaps.push('README 一段代码示例都没有')

      const hasTypes = latestMeta.types || latestMeta.typings || !!latestMeta.exports
      if (hasTypes) { ev.push('声明了 TS 类型（types/typings/exports）'); score += 1.5 }
      else if (/^@types\//.test(full)) { ev.push('本身是 @types 包'); score += 2 }
      else gaps.push('未声明 TS 类型 —— TS 用户没法直接用')
    }

    dims.push({
      key: 'docs', name: '文档', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['示例代码是否真的能跑（API 不暴露）', '导出 API 的完整性'],
    })
  }

  // ⑥ 安全 — deprecated / 危险 scripts / 单点维护
  {
    const ev = [], gaps = []
    let score = 2 // 没发现问题不等于安全，但也不默认按最差算
    const unv = 0
    const deprecated = m.versions?.[latest]?.deprecated
    if (deprecated) {
      gaps.push(`⚠️ 当前版本已 deprecated：${typeof deprecated === 'string' ? deprecated.slice(0, 80) : '原因见 npm 页面'}`)
      score -= 2
    } else { ev.push('当前 latest 未弃用'); score += 2 }

    const scripts = latestMeta.scripts || {}
    const dangerous = Object.keys(scripts).filter((s) => /^(pre|post)?install$|^prepublish$/.test(s))
    if (dangerous.length) { gaps.push(`scripts 有 install 钩子：${dangerous.join('、')} —— 已知供应链攻击载体`); score -= 2 }
    else { ev.push('scripts 无 install 钩子'); score += 2 }

    const maintainers = Array.isArray(m.maintainers) ? m.maintainers : []
    if (maintainers.length >= 3) { ev.push(`${maintainers.length} 位维护者 —— 不单点`); score += 2 }
    else if (maintainers.length === 2) { ev.push('2 位维护者'); score += 1 }
    else if (maintainers.length === 1) { ev.push('1 位维护者 —— 单点风险'); score += 0 }
    else { gaps.push('无维护者记录'); }

    dims.push({
      key: 'security', name: '安全', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['npm audit 已知漏洞数', '维护者邮箱是否已验证（注册年限）'],
    })
  }

  // ⑦ AI 可读性 — AI 编码助手装上后能不能从这个包页读到足够信息
  {
    const ev = [], gaps = []
    let score = 1
    const unv = 0
    // 仓库 README 在 npm 也会展示，所以 README 章节也算 AI 友好
    if (readme) {
      const headings = readme.match(/^#{1,4}\s+\S.*$/gm) || []
      if (headings.length >= 6) { ev.push(`README 含 ${headings.length} 个章节标题`); score += 2 }
      else if (headings.length >= 3) { ev.push(`README 含 ${headings.length} 个章节标题`); score += 1 }
      else gaps.push(`README 仅 ${headings.length} 个章节标题 —— AI 抓重点难`)

      const codeBlocks = (readme.match(/```[\s\S]*?```/g) || []).length
      if (codeBlocks >= 3) { ev.push(`${codeBlocks} 段代码示例 —— 可直接喂给 AI`); score += 2 }
      else if (codeBlocks >= 1) { ev.push(`${codeBlocks} 段代码示例`); score += 0.5 }
      else gaps.push('README 一段代码示例都没有 —— AI 无法拼出调用方式')
    } else { gaps.push('没有 README —— AI 助手只能看 package.json 猜用途') }

    if (m.description && m.description.length >= 30) { ev.push('description 长度充足，AI 能从一行话判断是否相关'); score += 1.5 }
    else if (m.description) gaps.push('description 偏短，AI 难以判断相关性')

    // 仓库链接字段对 AI 也是个提示
    const repoUrl = typeof m.repository === 'string' ? m.repository : m.repository?.url
    if (repoUrl && /^https?:\/\//.test(repoUrl)) { ev.push('有 repository 字段，AI 可跳转看完整源码'); score += 1 }
    else gaps.push('未声明 repository 字段')

    if (m.homepage) { ev.push('有 homepage'); score += 0.5 }

    dims.push({
      key: 'ai', name: 'AI 可读性', score: normalizeDim(score, unv), unverifiable: unv,
      evidence: ev, gaps, manual: ['package.json 是否有 schema.org 标注', '是否在 LLM 友好的 agent-skills 类索引中被收录'],
    })
  }

  // 总分：只对「有结论」的维度求平均
  const scored = dims.filter((d) => d.score != null)
  const inconclusive = dims.filter((d) => d.score == null).map((d) => d.name)
  if (!scored.length) {
    return { error: '七个维度都无从核实', score: null, project: full, dims, scoredCount: 0, inconclusiveDims: inconclusive }
  }
  const score = clamp(scored.reduce((s, d) => s + d.score, 0) / scored.length)

  const todos = scored
    .filter((d) => d.gaps.length)
    .sort((a, b) => a.score - b.score)
    .flatMap((d) => d.gaps.map((g) => ({ dim: d.name, dimScore: d.score, text: g })))

  return {
    project: full,
    type,
    score,
    band: bandOf(score).label,
    bandHint: bandOf(score).hint,
    // 与 GitHub 审计保持字段一致（stars 字段对 npm 无意义，给 0）
    stars: 0,
    weeklyDownloads: weekly.ok ? Number(weekly.data?.downloads || 0) : null,
    readmeSource,
    latestVersion: latest,
    deprecated: !!m.versions?.[latest]?.deprecated,
    dims,
    todos,
    scoredCount: scored.length,
    inconclusiveDims: inconclusive,
    ts: new Date().toISOString(),
  }
}

/**
 * Markdown 报告 —— 读者是 AI 编码助手，结构沿用 audit.js 的"先结论、再清单、再证据"骨架，文案换成 npm 包上下文。
 */
export function reportMarkdown(a, { site = '' } = {}) {
  const L = []
  const pct = (n) => '█'.repeat(Math.round(n)) + '░'.repeat(10 - Math.round(n))

  L.push(`# npm 包质检报告 · ${a.project}`)
  L.push('')
  L.push(`**${a.score} / 7** — ${a.band}`)
  if (a.bandHint) L.push(`*${a.bandHint}*`)
  L.push('')
  L.push(`包类型 \`${a.type}\` · 最新版本 ${a.latestVersion || '?'}${a.deprecated ? ' · ⚠️ deprecated' : ''}${a.weeklyDownloads != null ? ` · 周下载 ${a.weeklyDownloads.toLocaleString('en-US')}` : ''} · 生成于 ${new Date(a.ts).toISOString().slice(0, 16).replace('T', ' ')}`)
  if (a.scoredCount != null && a.scoredCount < 7) {
    L.push('')
    L.push(`> 本次只有 ${a.scoredCount} 个维度拿到了可核实的证据，总分是这几维的平均。`)
    if (a.inconclusiveDims?.length) {
      L.push(`> 未计入：${a.inconclusiveDims.join('、')} —— 不是这些维度不合格，是 registry 没暴露判据。`)
    }
  }
  L.push('')
  L.push('七维标准独立于 scorecard 的 GitHub 仓库质检 —— npm 包有自己的判据集：')
  L.push('评的不是"代码好不好"，是"装上能不能用、维护是不是活的、AI 助手能不能读懂"。')
  L.push('')

  L.push('## 记分卡')
  L.push('')
  L.push('| 维度 | 得分 | | 最该补的一件事 |')
  L.push('|---|---:|---|---|')
  for (const d of a.dims) {
    if (d.score == null) {
      L.push(`| ${d.name} | — | \`判不了\` | registry 没暴露这一维的判据，未计入总分 |`)
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
    L.push(`### ${d.name} — ${d.score == null ? '判不了（未计入总分）' : `${d.score}/10`}`)
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
  L.push('复制整份报告，连同 npm 包一起给 Claude Code / Cursor / Copilot，然后说：')
  L.push('')
  L.push('```')
  L.push('照这份质检报告改进这个 npm 包。从整改清单第 1 条开始，一次做一条，')
  L.push('每条改完告诉我动了哪些字段、为什么这么改。')
  L.push('标着"自动判不了"的几项，你读过 README 之后给我你的判断。')
  L.push('```')
  if (site) {
    L.push('')
    L.push(`> 本报告由 [Scorecard 开源项目质检](${site}) 生成，任何 npm 包都能免费跑一次。`)
  }
  return L.join('\n')
}