// Scorecard 后端 —— 开源项目九维度质检。
//
// Run: bun server/index.js   （先 bun run build 生成 dist/）
//
// 这个服务只做一件事：给定 owner/repo，产出九维度报告。没有登录、没有账户、
// 没有 token 库 —— 它从 github-accounts-manager 拆出来正是为了不再背这些。
// 唯一的凭据是 SCORECARD_GITHUB_TOKEN（只需 public_repo 只读），用来把
// GitHub API 限额从匿名 60 次/小时/IP 提到 5000 次/小时；不设也能跑。

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { auditProject, reportMarkdown as reportMarkdownGithub } from './audit.js'
import { auditPackage, reportMarkdown as reportMarkdownNpm } from './audit-npm.js'
import { auditPage, reportMarkdown as reportMarkdownPage } from './audit-page.js'
import { auditGeo, reportMarkdown as reportMarkdownGeo, geoProviderStatus, hydrateGeo, resolveGeoProvider } from './audit-geo.js'
import { compareReports, compareMarkdown } from './compare.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const PORT = Number(process.env.SCORECARD_PORT || process.env.PORT || 54445)
const HOST = process.env.SCORECARD_HOST || process.env.HOST || '0.0.0.0'
const DATA_DIR = process.env.SCORECARD_DATA_DIR || join(ROOT, 'data')
const DIST_DIR = join(ROOT, 'dist')
const HAS_DIST = existsSync(join(DIST_DIR, 'index.html'))

// 品牌与站点地址集中在这里 —— OG 图、CTA 文案都从这两个常量取。
// 散落成字面量的话，改名要改十几处，漏一处就出现两个品牌名并存。
const BRAND = process.env.SCORECARD_BRAND || 'SCORECARD'
const SITE_URL = process.env.SCORECARD_SITE_URL || 'scorecard.webkubor.online'

// 只读 token（public_repo 足够）。服务端自用，绝不下发给前端。
const GITHUB_TOKEN = process.env.SCORECARD_GITHUB_TOKEN || ''

// ---------- DB ----------
// 只有两张表：质检历史 + 操作日志。原仓那份 sqlite 还有 accounts / projects，
// 都是账户管理侧的，拆仓时留在原处。
await mkdir(DATA_DIR, { recursive: true })
const db = new Database(join(DATA_DIR, 'scorecard.sqlite'), { create: true })

// 质检历史。每次质检存一行，不覆盖 —— 要的是「上次 62 这次 78」这条曲线，
// 只存最新一次就等于把趋势丢了。
db.run(`
  CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId TEXT NOT NULL,
    ts TEXT NOT NULL,
    score REAL,
    band TEXT,
    type TEXT,
    stars INTEGER,
    dims TEXT,
    todos TEXT
  )
`)
db.run(`CREATE INDEX IF NOT EXISTS idx_audits_project ON audits(projectId, ts DESC)`)

// 列迁移：2026-09 加 npm / page 两种审计入口，老数据全是 github。
// sqlite 没有 ADD COLUMN IF NOT EXISTS，启动时程序判断一次。
const auditCols = db.query(`PRAGMA table_info(audits)`).all()
if (!auditCols.find((col) => col.name === 'targetType')) {
  db.run(`ALTER TABLE audits ADD COLUMN targetType TEXT DEFAULT 'github'`)
  db.run(`UPDATE audits SET targetType = 'github' WHERE targetType IS NULL`)
}
// meta 列：存放不同 type 各自的额外字段（npm: latestVersion/weeklyDownloads/readmeSource；
// page: finalUrl/ttfb/httpStatus/contentType）。这样缓存命中时 markdown 报告也不会丢字段。
if (!auditCols.find((col) => col.name === 'meta')) {
  db.run(`ALTER TABLE audits ADD COLUMN meta TEXT DEFAULT '{}'`)
}
db.run(`CREATE INDEX IF NOT EXISTS idx_audits_type ON audits(targetType, ts DESC)`)

db.run(`
  CREATE TABLE IF NOT EXISTS ops_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ok INTEGER DEFAULT 1
  )
`)
db.run(`CREATE INDEX IF NOT EXISTS idx_ops_ts ON ops_log(ts DESC)`)

function logOp({ actor, action, target = '', detail = '', ok = 1 }) {
  try {
    db.run(
      `INSERT INTO ops_log (ts, actor, action, target, detail, ok) VALUES (?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      (actor || 'anonymous').toString().slice(0, 64),
      (action || '').toString().slice(0, 64),
      (target || '').toString().slice(0, 200),
      (detail || '').toString().slice(0, 500),
      ok ? 1 : 0
    )
  } catch (e) {
    console.warn('[ops] log failed:', e.message)
  }
}

// audits 表里存的列名是 projectId，而报告对象（auditProject 的产出）用的是
// project。从缓存行还原报告时必须补上这个字段，否则下游看到 undefined ——
// reportMarkdown 的标题就变成「开源项目质检报告 · undefined」。
// 原仓没暴露这个问题只是因为前端从不读 report.project，它自己有 parsedRepo。
function hydrate(row, key, type = 'github') {
  // GEO 有自己的还原函数：它的 band/bandHint 不在数据库列里（band 列只有 label），
  // 而 markdown 报告要 bandHint 才能出提示语。走通用 hydrate 会让 GEO 报告少一句。
  if (type === 'geo') return hydrateGeo(row, key)
  let meta = {}
  try { meta = row.meta ? (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta) : {} } catch {}
  return {
    ...row,
    ...meta,
    project: row.project || key,
    targetType: row.targetType || type,
    dims: typeof row.dims === 'string' ? JSON.parse(row.dims || '[]') : row.dims || [],
    todos: typeof row.todos === 'string' ? JSON.parse(row.todos || '[]') : row.todos || []
  }
}

/** 从三路报告里挑出该 type 需要缓存的额外字段 */
function extractMeta(report, type) {
  if (!report) return {}
  if (type === 'npm') return {
    latestVersion: report.latestVersion,
    weeklyDownloads: report.weeklyDownloads,
    deprecated: report.deprecated,
    readmeSource: report.readmeSource,
  }
  if (type === 'page') return {
    finalUrl: report.finalUrl,
    ttfb: report.ttfb,
    httpStatus: report.httpStatus,
    contentType: report.contentType,
    finalOrigin: report.finalOrigin,
    noindex: report.noindex,
  }
  // GEO 的问题清单/竞品/离线标记必须跟着历史一起存：趋势页面只读历史，
  // 没有这三样就画不出「你这周问的还是那几道题吗」。
  if (type === 'geo') return {
    domain: report.domain,
    provider: report.provider,
    offline: report.offline,
    questions: report.questions,
    competitors: report.competitors,
    inconclusiveDims: report.inconclusiveDims,
    failures: report.failures,
  }
  return {}
}

const app = new Hono()

// ---------- Scorecard：单次质检 ----------
//
// 三路入口互相独立、各自判据：
//   ?repo=owner/name              → type=github（保留旧 API）
//   ?type=npm&pkg=react           → npm 包质检（registry + downloads + 兜底 GitHub README）
//   ?type=page&url=https://...    → 网页质检（主页面 + 11 个根目录探测并发）
//
// 设计要点：
// 1. 免登录；只有 GitHub 入口吃 SCORECARD_GITHUB_TOKEN，npm/page 不需要
// 2. 30 分钟内同 target 直接复用上次结果
// 3. 每次结果都写进 audits 表，留趋势（targetType 列区分入口）
function resolveType(c) {
  const explicit = (c.req.query('type') || '').toString().toLowerCase().trim()
  if (['github', 'npm', 'page', 'geo'].includes(explicit)) return explicit
  // 向后兼容：老 URL 只传 ?repo=
  if (c.req.query('repo')) return 'github'
  return null
}

function resolveTarget(type, c) {
  const repo = (c.req.query('repo') || '').toString().trim()
  const pkg = (c.req.query('pkg') || '').toString().trim()
  const url = (c.req.query('url') || c.req.query('target') || '').toString().trim()
  if (type === 'github') return { key: repo || url, repo, pkg, url }
  if (type === 'npm') return { key: pkg, repo: '', pkg, url: '' }
  if (type === 'page') return { key: url, repo: '', pkg: '', url }
  // GEO 的 target 是品牌名。问题清单与竞品走逗号分隔 —— 不另开 body 参数是因为
  // 这个入口要能用 GET 直接分享/预览，跟前三路保持同一种打开方式。
  if (type === 'geo') {
    const brand = (c.req.query('brand') || c.req.query('target') || url || '').toString().trim()
    const split = (raw) => raw.toString().split(',').map((s) => s.trim()).filter(Boolean)
    return {
      key: brand,
      repo: '', pkg: '', url: '',
      brand,
      domain: (c.req.query('domain') || '').toString().trim(),
      questions: split(c.req.query('q') || ''),
      competitors: split(c.req.query('competitors') || ''),
      // 空 / auto 不留空串下去：auditGeo 的形参默认值只在 undefined 时生效，
      // 传 '' 会直接撞上「未知 provider：」—— 调用方说「自动」，返回的却是一个报错。
      // 就当「自动」在这里解开：有就绪的就用，一个都没有落到 offline。
      provider: resolveGeoProvider((c.req.query('provider') || '').toString().trim()),
    }
  }
  return { key: '', repo: '', pkg: '', url: '' }
}

/**
 * 按 type 跑对应审计引擎，并返回对应的 Markdown 报告函数。
 * 不共用一个 reportMarkdown —— 三个引擎各自的口径、记分牌、提示词模板都不一样。
 */
async function runAudit(type, { owner, repo, pkg, url, brand, domain, questions, competitors, provider }) {
  if (type === 'github') {
    const [o, n] = (repo || '').split('/')
    const report = await auditProject({ owner: o, repo: n, token: GITHUB_TOKEN })
    return { report, md: reportMarkdownGithub }
  }
  if (type === 'npm') {
    const report = await auditPackage({ pkg })
    return { report, md: reportMarkdownNpm }
  }
  if (type === 'page') {
    const report = await auditPage({ url })
    return { report, md: reportMarkdownPage }
  }
  if (type === 'geo') {
    const report = await auditGeo({ brand, domain, questions, competitors, provider })
    return { report, md: reportMarkdownGeo }
  }
  return { report: null, md: null }
}

/**
 * 缓存优先拿一份报告：30 分钟内直接复用，否则现跑并落库。
 * /api/scorecard 与 /api/scorecard/compare 都走这里，避免两边各维护一份缓存逻辑。
 */
async function getOrAudit(type, key, opts) {
  const { repo, pkg, url, brand, domain, questions, competitors, provider, fresh } = opts
  // GEO 不用 30 分钟缓存，两个原因都不是性能：
  //  ① 它要花钱，重复查询直接烧钱；
  //  ② 离线 fixture 和真实 provider 的结果不可比 —— 缓存里如果躺着一份 offline
  //     报告，下一次真实查询会被它挡住，用户看到的还是假数据。
  // GEO 的「缓存」语义是趋势：读历史。而历史由下面的 trend 接口显式提供，
  // 这里只负责「跑一次就存一次」。
  if (type !== 'geo') {
    const cached = fresh ? null : db
      .query(`SELECT * FROM audits WHERE projectId = ? AND targetType = ? ORDER BY ts DESC LIMIT 1`)
      .get(key, type)
    if (cached && Date.now() - new Date(cached.ts).getTime() < 30 * 60 * 1000) {
      return { report: hydrate(cached, key, type), cached: true }
    }
  }
  const { report } = await runAudit(type, { repo, pkg, url, brand, domain, questions, competitors, provider })
  if (report && !report.error && report.score != null) {
    try {
      db.run(
        `INSERT INTO audits (projectId, targetType, ts, score, band, type, stars, dims, todos, meta) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        key, type, report.ts, report.score, report.band, report.type || type, report.stars || 0,
        JSON.stringify(report.dims || []), JSON.stringify(report.todos || []),
        JSON.stringify(extractMeta(report, type))
      )
    } catch (e) {
      console.warn('[scorecard] persist failed:', e.message)
    }
  }
  return { report, cached: false }
}

app.get('/api/scorecard', async (c) => {
  const type = resolveType(c)
  if (!type) return c.json({ error: 'type 必填：github | npm | page | geo（github 可省略，靠 ?repo= 推断）' }, 400)

  const { key, repo, pkg, url, brand, domain, questions, competitors, provider } = resolveTarget(type, c)
  if (!key) return c.json({ error: `${type} 入口缺少目标参数` }, 400)

  // type-specific 格式校验
  if (type === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(key)) {
    return c.json({ error: 'repo must be owner/name' }, 400)
  }
  if (type === 'npm' && !/^(@[\w.-]+\/)?[\w.-]+$/.test(key)) {
    return c.json({ error: 'pkg 格式不合法（例：react / @vue/runtime-core）' }, 400)
  }
  if (type === 'page' && !/^https?:\/\//i.test(key)) {
    return c.json({ error: 'url 必须以 http(s):// 开头' }, 400)
  }

  /*
   * fresh=1 跳过缓存 —— 刚推完整改就复测是最常见的用法，
   * 而 30 分钟缓存会让人拿到整改前的旧分数，误以为改动没生效。
   */
  const fresh = ['1', 'true', 'yes'].includes((c.req.query('fresh') || '').toString().toLowerCase())
  const { report, cached } = await getOrAudit(type, key, { repo, pkg, url, brand, domain, questions, competitors, provider, fresh })
  if (report?.error) return c.json({ error: report.error }, report.error.startsWith('HTTP 4') ? 400 : 502)
  if (!report || report.score == null) {
    return c.json({ error: report?.error || 'audit returned no score' }, 400)
  }

  logOp({
    actor: c.req.header('x-visitor-id') || 'anonymous',
    action: `scorecard.generate.${type}`,
    target: key,
    detail: `score=${report.score} band=${report.band}`
  })

  return c.json({ cached, type, report })
})

// 累计统计 —— 落地页信任状：已查过几次、平均分
app.get('/api/scorecard/stats', (c) => {
  const total = db.query(`SELECT COUNT(*) AS n FROM audits`).get()?.n || 0
  const avg = db.query(`SELECT AVG(score) AS a FROM audits WHERE score IS NOT NULL`).get()?.a
  return c.json({
    total,
    avg: avg != null ? Number(Number(avg).toFixed(1)) : 0
  })
})

// 排行榜 —— 每个项目取最新一次质检，按分数排。
//
// 用窗口函数取「每个 projectId 的最新一行」，而不是 GROUP BY + MAX(ts)：
// 后者在 sqlite 里取到的其它列不保证来自同一行（非聚合列是随机挑的），
// 会出现「score 来自这次、stars 来自上次」的错位数据。
app.get('/api/scorecard/leaderboard', (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 20, 100)
  const rows = db.query(`
    SELECT projectId, score, band, type, stars, ts FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY ts DESC) AS rn
      FROM audits
    ) WHERE rn = 1
    ORDER BY score DESC, stars DESC
    LIMIT ?
  `).all(limit)
  return c.json({ items: rows })
})

// 复检 —— 同一个项目的「上一次 vs 这一次」。
//
// 和 /api/scorecard/compare 的区别：compare 比 A、B 两个不同目标；
// 这里比同一个项目的两次时间点。它回答的是「我照整改清单改完，到底变好没有」。
//
// 没有这条，项目就只是个一次性工具：用户改完代码回来，看到的是一个
// 全新的分数，和上次没有任何关系，无法证明自己做的工作有没有用。
//
// 缓存命中不算一次新审计 —— 只有真正跑了引擎才写 audits 表，
// 所以这里的时间点都是真实的重新评估，不是「刷新了页面」。
app.get('/api/scorecard/history', (c) => {
  const target = c.req.query('target') || c.req.query('repo')
  const type = c.req.query('type') || 'github'
  if (!target) return c.json({ error: '缺少 target 参数' }, 400)

  const limit = Math.min(Number(c.req.query('limit')) || 10, 50)
  const rows = db.query(`
    SELECT ts, score, band, dims, todos
    FROM audits
    WHERE projectId = ? AND targetType = ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(target, type, limit)

  if (!rows.length) return c.json({ target, type, points: [], changes: [], firstRun: true })

  // 时间正序更符合「读 trend」的直觉
  const points = rows
    .slice()
    .reverse()
    .map((r) => ({ ts: r.ts, score: r.score, band: r.band }))

  // 维度级变化：拿最新一次和上一轮比。只有两轮以上才有「变化」可言。
  let changes = []
  if (rows.length >= 2) {
    const [latest, prev] = rows
    const parse = (s) => {
      try { return JSON.parse(s) || [] } catch { return [] }
    }
    const prevDims = new Map(parse(prev.dims).map((d) => [d.key, d]))
    changes = parse(latest.dims)
      .map((d) => {
        const before = prevDims.get(d.key)
        if (!before) return null
        // null 是「无法核实」，不是 0 —— 和分数之间不能直接相减
        if (d.score == null || before.score == null) return null
        const delta = Math.round((d.score - before.score) * 10) / 10
        return delta === 0
          ? null
          : { key: d.key, name: d.name, from: before.score, to: d.score, delta }
      })
      .filter(Boolean)
      .sort((a, b) => b.delta - a.delta)
  }

  const latestScore = rows[0].score
  const prevScore = rows[1]?.score ?? null
  const totalDelta =
    latestScore != null && prevScore != null
      ? Math.round((latestScore - prevScore) * 10) / 10
      : null

  return c.json({
    target,
    type,
    points,
    changes,
    totalDelta,
    latest: { ts: rows[0].ts, score: latestScore, band: rows[0].band },
    previous: rows[1] ? { ts: rows[1].ts, score: prevScore, band: rows[1].band } : null,
    runs: rows.length,
  })
})

// 今日热门 —— 近 24h 被查过几次
app.get('/api/scorecard/trending', (c) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const rows = db.query(`
    SELECT target, COUNT(*) AS hits
    FROM ops_log
    WHERE action = 'scorecard.generate' AND ts >= ?
    GROUP BY target
    ORDER BY hits DESC, MAX(ts) DESC
    LIMIT 10
  `).all(since)
  return c.json({ since, items: rows })
})

// ---------- GEO 专属接口 ----------
//
// 这两个接口是 GEO 能「线上免费看」的全部原因：都不调 LLM，只读库里已存的结果。
// 线上实例不配 key，所以离线预览、历史趋势都在这里闭环；本机配了 key 才能触发
// 新的查询（走 /api/scorecard?type=geo）。
//
// 注意 GEO 不进 leaderboard / trending：那两个接口的含义是「很多人在查的目标」，
// 而 GEO 的 brandId 是使用者自己配的私有问题集，混进去会泄露他在盯什么竞品。

// 趋势 —— 一个品牌的历史曲线。这是 GEO 唯一真正的产品价值：
// 「上周 6.2，这周 4.8，第 2 位换成了竞品」比任何单次分数都有用。
app.get('/api/geo/trend', (c) => {
  const brand = (c.req.query('brand') || '').toString().trim()
  if (!brand) return c.json({ error: 'brand 必填' }, 400)
  const rows = db.query(`
    SELECT ts, score, band, meta FROM audits
    WHERE projectId = ? AND targetType = 'geo'
    ORDER BY ts ASC
  `).all(brand)

  const points = rows.map((r) => {
    let meta = {}
    try { meta = typeof r.meta === 'string' ? JSON.parse(r.meta || '{}') : r.meta || {} } catch {}
    return {
      ts: r.ts,
      score: r.score,
      band: r.band,
      provider: meta.provider,
      offline: Boolean(meta.offline),
      dims: (() => {
        const full = db.query(`SELECT dims FROM audits WHERE projectId=? AND targetType='geo' AND ts=?`).get(brand, r.ts)
        try { return JSON.parse(full?.dims || '[]') } catch { return [] }
      })(),
    }
  })

  // 离线与真实的分数不可比，但放进同一条曲线会骗人 —— 这里显式分开。
  const live = points.filter((p) => !p.offline)
  const offl = points.filter((p) => p.offline)

  let delta = null
  if (live.length >= 2) {
    delta = Number((live[live.length - 1].score - live[0].score).toFixed(2))
  }

  return c.json({
    brand,
    live,
    offline: offl,
    delta,
    note: live.length >= 2
      ? `真实数据点 ${live.length} 个：${live[0].ts} → ${live[live.length - 1].ts}`
      : live.length === 1
        ? '只有 1 个真实数据点，看不出趋势 —— GEO 的价值在历史，多跑几次才有意义'
        : '没有真实数据点（本机配 LLM key 后跑一次就有了）',
  })
})

// provider 就绪状态 —— UI 用来告诉你「你现在能跑哪几路」。
// 刻意不在响应里回显任何 key 值，只给 keyEnv 变量名。
app.get('/api/geo/providers', (c) => {
  const providers = geoProviderStatus()
  return c.json({
    providers,
    offline: true,
    online: providers.some((p) => p.ready),
    note: providers.some((p) => p.ready)
      ? '本机已配至少一路 LLM key，可跑真实查询（会花钱）'
      : '本机没有任何 GEO key —— 只能看历史或用 offline 假数据看结构。GEO 要花钱调 LLM，线上实例故意不配。',
  })
})

/**
 * 品牌清单 —— 出自 Social Hub 的 IP 矩阵。
 *
 * 为什么是文件而不是接口：social-hub 跑在 nanzhu，本机网关 magpie 跑在 Mac，
 * 线上实例两边都够不着。做成接口就得让线上跨机取数据，为一个「预设清单」不值得。
 * 清单变化极慢（IP 矩阵几个月动一次），文件足够，而且能进 git 留下改动记录。
 *
 * 品类问题刻意是手写的：从库里的 bio 生成不出「用户真的会问什么」。
 * 而 GEO 最容易被做假的一环正是问题 —— 问「X 怎么样」必中，一文不值。
 */
app.get('/api/geo/brands', (c) => {
  try {
    const raw = readFileSync(new URL('../data/geo-brands.json', import.meta.url), 'utf8')
    const j = JSON.parse(raw)
    return c.json({
      source: j._source || '',
      brands: (j.brands || []).map((b) => ({
        brand: b.brand,
        domain: b.domain || '',
        category: b.category || '',
        questions: b.questions || [],
        competitors: b.competitors || [],
        note: b.note || '',
      })),
    })
  } catch (e) {
    // 清单读不到不该让整个 GEO 页挂掉 —— 手填品牌名照样能用。
    return c.json({ brands: [], error: `品牌清单读取失败：${e.message}` })
  }
})

// OG / Twitter card 图 —— 1200x630 SVG。
// 用 SVG 而不是 PNG：少 1 个依赖，bun 直接吐 string。Twitter/微博/即刻 都认
// og:image 的 image/svg+xml，2024 起标准支持。
app.get('/og/scorecard/:owner/:repo', async (c) => {
  const owner = c.req.param('owner')
  const repo = c.req.param('repo').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(`${owner}/${repo}`)) return c.text('bad repo', 400)

  // 从缓存拿最近一次结果；没缓存就 0 分兜底
  const cached = db
    .query(`SELECT score, band, type, stars FROM audits WHERE projectId = ? ORDER BY ts DESC LIMIT 1`)
    .get(`${owner}/${repo}`)
  const score = cached?.score ?? 0
  const band = cached?.band ?? '—'
  const stars = cached?.stars ?? 0

  const color = score >= 9 ? '#7d9d8c' : score >= 6 ? '#7c94ad' : score >= 3 ? '#c4a47c' : '#b08585'

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7c94ad"/>
      <stop offset="100%" stop-color="#7d9d8c"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="630" fill="#0d1117"/>
  <rect x="0" y="0" width="1200" height="4" fill="url(#accent)"/>

  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif">
    <!-- brand -->
    <text x="60" y="78" font-size="22" font-weight="700" letter-spacing="3" fill="#7c94ad">⬢ ${escapeXml(BRAND)}</text>

    <!-- repo -->
    <text x="60" y="180" font-size="28" font-weight="600" fill="#8b949e" font-family="ui-monospace, SFMono-Regular, monospace">${escapeXml(owner)}/${escapeXml(repo)}</text>

    <!-- big score -->
    <text x="60" y="380" font-size="180" font-weight="800" fill="${color}" letter-spacing="-4">${score}</text>
    <text x="${60 + String(score).length * 90}" y="380" font-size="48" font-weight="500" fill="#6e7681">/10</text>

    <!-- band -->
    <text x="60" y="430" font-size="26" font-weight="600" fill="${color}">${escapeXml(band)}</text>
    <text x="60" y="464" font-size="20" fill="#8b949e">⭐ ${stars} stars · type: ${escapeXml(cached?.type || 'unknown')}</text>

    <!-- radar placeholder: a hex ring -->
    <g transform="translate(820 315)">
      <circle cx="0" cy="0" r="160" fill="none" stroke="rgba(124,148,173,0.18)" stroke-width="2"/>
      <circle cx="0" cy="0" r="120" fill="none" stroke="rgba(124,148,173,0.18)" stroke-width="2"/>
      <circle cx="0" cy="0" r="80" fill="none" stroke="rgba(124,148,173,0.18)" stroke-width="2"/>
      <circle cx="0" cy="0" r="40" fill="none" stroke="rgba(124,148,173,0.18)" stroke-width="2"/>
      ${radarPolygon(score)}
      <circle cx="0" cy="0" r="160" fill="none" stroke="#7c94ad" stroke-width="2" opacity="0.6"/>
    </g>

    <!-- CTA -->
    <text x="60" y="570" font-size="22" font-weight="600" fill="#e6edf3">测你的开源项目 → ${escapeXml(SITE_URL)}</text>
    <text x="60" y="600" font-size="18" fill="#6e7681">9 维度 · 免登录 · Markdown 报告可喂给 AI</text>
  </g>
</svg>`.trim()

  c.header('Content-Type', 'image/svg+xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=1800')
  return c.body(svg)
})

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[c])
}

// 简单 8 角雷达多边形（octagon）
function radarPolygon(score) {
  const n = 8
  const cx = 0, cy = 0, r = 140
  const pts = []
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    // 给一个围绕 score 抖动的假形状（OG 图不展示真实维度，纯视觉）
    const variance = 0.7 + 0.3 * Math.sin(i * 1.7 + score)
    const rr = Math.min(r, Math.max(r * 0.4, score * 14 * variance))
    pts.push(`${(cx + Math.cos(angle) * rr).toFixed(1)},${(cy + Math.sin(angle) * rr).toFixed(1)}`)
  }
  return `<polygon points="${pts.join(' ')}" fill="rgba(124,148,173,0.25)" stroke="#7c94ad" stroke-width="3" stroke-linejoin="round"/>`
}

// Markdown 报告 —— 这是主要的分享形态。
//
// 为什么是 Markdown 而不是长图：图片好看但是死的，别人看完还得自己动手翻译成任务。
// Markdown 能直接粘进 Claude Code / Cursor 让它照着改，改完再回来测一次分数
// —— 传播链多了一环，而且那一环是真正产生价值的一环。
// 三个审计引擎各自的 reportMarkdown() 提示词模板不同（GitHub 改 README / npm 改 package.json / 网页改配置），
// 这里按 type 路由到对应那个。
app.get('/api/scorecard/report.md', async (c) => {
  const type = resolveType(c)
  if (!type) return c.text('type 必填：github | npm | page', 400)
  const { key, repo, pkg, url, brand, domain, questions, competitors, provider } = resolveTarget(type, c)
  if (!key) return c.text(`${type} 入口缺少目标参数`, 400)

  if (type === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(key)) return c.text('repo must be owner/name', 400)
  if (type === 'npm' && !/^(@[\w.-]+\/)?[\w.-]+$/.test(key)) return c.text('pkg 格式不合法', 400)
  if (type === 'page' && !/^https?:\/\//i.test(key)) return c.text('url 必须以 http(s):// 开头', 400)

  const fresh = ['1', 'true', 'yes'].includes((c.req.query('fresh') || '').toString().toLowerCase())
  const { report, cached } = await getOrAudit(type, key, { repo, pkg, url, brand, domain, questions, competitors, provider, fresh })
  if (report?.error) return c.text(report.error, report.error.startsWith('HTTP 4') ? 400 : 502)
  if (!report || report.score == null) return c.text('audit returned no score', 400)

  const mdFn = type === 'npm' ? reportMarkdownNpm
    : type === 'page' ? reportMarkdownPage
    : type === 'geo' ? reportMarkdownGeo
    : reportMarkdownGithub
  const md = mdFn(report, { site: `https://${SITE_URL}` })
  logOp({
    actor: c.req.header('x-visitor-id') || 'anonymous',
    action: `scorecard.share.${type}`,
    target: key,
    detail: `markdown${cached ? ' (cached)' : ''}`
  })
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  return c.body(md)
})

// ---------- Scorecard：对比 ----------
//
// ?type=page&a=...&b=...   比较两个同 type 目标的质检结果。
// 主用例：测试 env vs 线上 env 的站点差距。underlying 各自走 30 分钟缓存，
// 真正的 diff 在运行时算 —— 不写库。
app.get('/api/scorecard/compare', async (c) => {
  const type = (c.req.query('type') || '').toString().toLowerCase().trim()
  const aRaw = (c.req.query('a') || '').toString().trim()
  const bRaw = (c.req.query('b') || '').toString().trim()
  if (!['github', 'npm', 'page'].includes(type)) return c.json({ error: 'type 必填：github | npm | page' }, 400)
  if (!aRaw || !bRaw) return c.json({ error: 'a / b 必填' }, 400)
  if (aRaw === bRaw) return c.json({ error: 'a 和 b 是同一个目标，没必要比' }, 400)

  const fresh = ['1', 'true', 'yes'].includes((c.req.query('fresh') || '').toString().toLowerCase())

  // a / b 各自的 type-specific 参数：github 用 repo / npm 用 pkg / page 用 url
  const paramName = type === 'github' ? 'repo' : type === 'npm' ? 'pkg' : 'url'
  const optsFor = (raw) => {
    if (type === 'github') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(raw)) return { error: `${paramName} 格式应为 owner/name`, report: null }
      return { repo: raw, pkg: '', url: '' }
    }
    if (type === 'npm') {
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(raw)) return { error: `${paramName} 格式不合法`, report: null }
      return { repo: '', pkg: raw, url: '' }
    }
    if (!/^https?:\/\//i.test(raw)) return { error: `${paramName} 必须以 http(s):// 开头`, report: null }
    return { repo: '', pkg: '', url: raw }
  }

  const aOpts = optsFor(aRaw)
  const bOpts = optsFor(bRaw)
  if (aOpts.error || bOpts.error) return c.json({ error: aOpts.error || bOpts.error }, 400)

  // 并发拿两边（不互相阻塞）
  const [aRes, bRes] = await Promise.all([
    getOrAudit(type, aRaw, { ...aOpts, fresh }),
    getOrAudit(type, bRaw, { ...bOpts, fresh }),
  ])

  const errors = []
  if (aRes.report?.error) errors.push({ side: 'a', error: aRes.report.error })
  if (bRes.report?.error) errors.push({ side: 'b', error: bRes.report.error })
  if (errors.length) return c.json({ errors }, 502)

  if (!aRes.report || aRes.report.score == null) return c.json({ error: `a 审计失败：${aRes.report?.error || 'no score'}` }, 400)
  if (!bRes.report || bRes.report.score == null) return c.json({ error: `b 审计失败：${bRes.report?.error || 'no score'}` }, 400)

  const diff = compareReports(aRes.report, bRes.report)
  if (!diff) return c.json({ error: '两份报告维度集不一致 —— 可能 type 不一致或审计器变更' }, 400)

  logOp({
    actor: c.req.header('x-visitor-id') || 'anonymous',
    action: `scorecard.compare.${type}`,
    target: `${aRaw}|${bRaw}`,
    detail: `delta=${diff.totalDelta} aOnlyGaps=${diff.summary.aOnlyGaps} bOnlyGaps=${diff.summary.bOnlyGaps}`,
  })

  return c.json({
    type,
    a: aRes.report,
    b: bRes.report,
    diff,
    cached: { a: aRes.cached, b: bRes.cached },
  })
})

// 对比的 Markdown 报告 —— 直接喂给 AI 助手的"差距清单"。
app.get('/api/scorecard/compare.md', async (c) => {
  const type = (c.req.query('type') || '').toString().toLowerCase().trim()
  const aRaw = (c.req.query('a') || '').toString().trim()
  const bRaw = (c.req.query('b') || '').toString().trim()
  if (!['github', 'npm', 'page'].includes(type)) return c.text('type 必填：github | npm | page', 400)
  if (!aRaw || !bRaw) return c.text('a / b 必填', 400)

  const paramName = type === 'github' ? 'repo' : type === 'npm' ? 'pkg' : 'url'
  const optsFor = (raw) => {
    if (type === 'github') return /^[\w.-]+\/[\w.-]+$/.test(raw) ? { repo: raw, pkg: '', url: '' } : { error: `${paramName} 格式应为 owner/name` }
    if (type === 'npm') return /^(@[\w.-]+\/)?[\w.-]+$/.test(raw) ? { repo: '', pkg: raw, url: '' } : { error: `${paramName} 格式不合法` }
    return /^https?:\/\//i.test(raw) ? { repo: '', pkg: '', url: raw } : { error: `${paramName} 必须以 http(s):// 开头` }
  }
  const aOpts = optsFor(aRaw)
  const bOpts = optsFor(bRaw)
  if (aOpts.error || bOpts.error) return c.text(aOpts.error || bOpts.error, 400)

  const fresh = ['1', 'true', 'yes'].includes((c.req.query('fresh') || '').toString().toLowerCase())
  const [aRes, bRes] = await Promise.all([
    getOrAudit(type, aRaw, { ...aOpts, fresh }),
    getOrAudit(type, bRaw, { ...bOpts, fresh }),
  ])
  if (aRes.report?.error || bRes.report?.error) return c.text(aRes.report?.error || bRes.report?.error, 502)
  if (!aRes.report || aRes.report.score == null) return c.text('a 审计失败', 400)
  if (!bRes.report || bRes.report.score == null) return c.text('b 审计失败', 400)

  const diff = compareReports(aRes.report, bRes.report)
  if (!diff) return c.text('两份报告维度集不一致', 400)
  const md = compareMarkdown(aRes.report, bRes.report, diff, { site: `https://${SITE_URL}` })
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  return c.body(md)
})

// 分享埋点 —— 前端 logShare() 打这个端点。
// 原仓只实现了 GET /api/ops，没有 POST，所以这个埋点一直静默 404，
// 传播数据从来没落过库（fetch 的 .catch(() => {}) 把它吞了）。拆仓时补上。
app.post('/api/ops', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const action = (body.action || '').toString()
  // 白名单：只收 scorecard 自己的埋点，不做通用日志入口
  if (!['scorecard.share'].includes(action)) {
    return c.json({ error: 'unsupported action' }, 400)
  }
  logOp({
    actor: c.req.header('x-visitor-id') || 'anonymous',
    action,
    target: body.target || '',
    detail: body.detail || ''
  })
  return c.json({ ok: true })
})

// 分享数据 —— 各渠道分别被点了多少次
app.get('/api/ops', (c) => {
  const rows = db.query(`
    SELECT action, detail, COUNT(*) AS hits
    FROM ops_log
    WHERE action = 'scorecard.share'
    GROUP BY action, detail
    ORDER BY hits DESC
  `).all()
  return c.json({ items: rows })
})

// 健康检查 —— 部署烟雾测试用，不碰 GitHub
app.get('/api/health', (c) => c.json({ ok: true, hasToken: !!GITHUB_TOKEN, dist: HAS_DIST }))

// ---------- static + SPA fallback（注册在最后，让 /api/* 优先） ----------
if (HAS_DIST) {
  app.use('/assets/*', serveStatic({ root: DIST_DIR, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }))
  app.use('/favicon.svg', serveStatic({ root: DIST_DIR, headers: { 'Cache-Control': 'public, max-age=3600' } }))
  // 自己的 robots.txt —— 放行所有爬虫（含 AI 爬虫）。必须在通配 catch-all
  // 之前注册，否则 SPA fallback 会拿 index.html 顶替。
  app.use('/robots.txt', serveStatic({ root: DIST_DIR, headers: { 'Cache-Control': 'public, max-age=3600' } }))
  // 自己的 llms.txt —— 第九维「AI 可读性」的判据之一，Scorecard 也要达标。
  // public/llms.txt 会被 Vite 拷进 dist/；必须先于下面通配 catch-all 注册，
  // 否则 SPA fallback 会拿 index.html 顶替，被自己的引擎判成「空壳」。
  app.use('/llms.txt', serveStatic({ root: DIST_DIR, headers: { 'Cache-Control': 'public, max-age=3600' } }))
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound()
    c.header('Cache-Control', 'no-cache, must-revalidate')
    return c.html(await readFile(join(DIST_DIR, 'index.html'), 'utf8'))
  })
}

// ---------- start ----------
console.log(`[scorecard] listening on http://${HOST}:${PORT}`)
console.log(`[scorecard] data dir: ${DATA_DIR}`)
console.log(`[scorecard] static: ${HAS_DIST ? DIST_DIR : '(no dist/ — run `bun run build` first)'}`)
console.log(`[scorecard] github token: ${GITHUB_TOKEN ? 'configured (5000 req/h)' : 'anonymous (60 req/h/IP)'}`)

// page 引擎一次要并发拉主页面 + 11 个根目录探测，匿名 API 慢的时候
// 13 个请求合并起来偶尔会超过 Bun 默认 10s 的 idleTimeout。放到 60s 给宽裕点。
export default { port: PORT, hostname: HOST, fetch: app.fetch, idleTimeout: 60 }
