// Scorecard 后端 —— 开源项目八维度质检。
//
// Run: bun server/index.js   （先 bun run build 生成 dist/）
//
// 这个服务只做一件事：给定 owner/repo，产出八维度报告。没有登录、没有账户、
// 没有 token 库 —— 它从 github-accounts-manager 拆出来正是为了不再背这些。
// 唯一的凭据是 SCORECARD_GITHUB_TOKEN（只需 public_repo 只读），用来把
// GitHub API 限额从匿名 60 次/小时/IP 提到 5000 次/小时；不设也能跑。

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { auditProject, reportMarkdown } from './audit.js'

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
function hydrate(row, repo) {
  return {
    ...row,
    project: row.project || repo,
    dims: typeof row.dims === 'string' ? JSON.parse(row.dims || '[]') : row.dims || [],
    todos: typeof row.todos === 'string' ? JSON.parse(row.todos || '[]') : row.todos || []
  }
}

const app = new Hono()

// ---------- Scorecard：单次质检 ----------
// 设计要点：
// 1. 免登录。公开仓库匿名 60 次/小时/IP 已够单次报告；配了 token 则 5000 次/小时
// 2. 30 分钟内同仓库直接复用上次结果，不重复打 GitHub
// 3. 每次结果都写进 audits 表，留趋势
app.get('/api/scorecard', async (c) => {
  const repo = (c.req.query('repo') || '').toString().trim()
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return c.json({ error: 'repo must be owner/name' }, 400)
  }
  const [owner, name] = repo.split('/')

  // cache hit：30 分钟内同仓库直接复用
  const cached = db
    .query(`SELECT * FROM audits WHERE projectId = ? ORDER BY ts DESC LIMIT 1`)
    .get(repo)
  if (cached && Date.now() - new Date(cached.ts).getTime() < 30 * 60 * 1000) {
    return c.json({
      cached: true,
      report: hydrate(cached, repo)
    })
  }

  let report
  try {
    report = await auditProject({ owner, repo: name, token: GITHUB_TOKEN })
  } catch (err) {
    return c.json({ error: `audit failed: ${err.message}` }, 502)
  }
  if (!report || report.score == null) {
    return c.json({ error: report?.error || 'audit returned no score', status: report?.status }, 400)
  }

  try {
    db.run(
      `INSERT INTO audits (projectId, ts, score, band, type, stars, dims, todos) VALUES (?,?,?,?,?,?,?,?)`,
      repo,
      report.ts,
      report.score,
      report.band,
      report.type || '',
      report.stars || 0,
      JSON.stringify(report.dims || []),
      JSON.stringify(report.todos || [])
    )
  } catch (e) {
    console.warn('[scorecard] persist failed:', e.message)
  }

  logOp({
    actor: c.req.header('x-visitor-id') || 'anonymous',
    action: 'scorecard.generate',
    target: repo,
    detail: `score=${report.score} band=${report.band} token=${GITHUB_TOKEN ? 'yes' : 'no'}`
  })

  return c.json({ cached: false, report })
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
    <text x="60" y="600" font-size="18" fill="#6e7681">8 维度 · 免登录 · Markdown 报告可喂给 AI</text>
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
// audit.js 的 reportMarkdown() 本来就是照「读者是 AI 助手」写的，前端一直没用上。
app.get('/api/scorecard/report.md', async (c) => {
  const repo = (c.req.query('repo') || '').toString().trim()
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return c.text('repo must be owner/name', 400)
  }

  // 复用 audits 缓存；没有就现跑一次，让直接访问这个 URL 也能拿到报告
  let row = db.query(`SELECT * FROM audits WHERE projectId = ? ORDER BY ts DESC LIMIT 1`).get(repo)
  let report
  if (row && Date.now() - new Date(row.ts).getTime() < 30 * 60 * 1000) {
    report = hydrate(row, repo)
  } else {
    const [owner, name] = repo.split('/')
    try {
      report = await auditProject({ owner, repo: name, token: GITHUB_TOKEN })
    } catch (err) {
      return c.text(`audit failed: ${err.message}`, 502)
    }
    if (!report || report.score == null) return c.text('audit returned no score', 400)
    try {
      db.run(
        `INSERT INTO audits (projectId, ts, score, band, type, stars, dims, todos) VALUES (?,?,?,?,?,?,?,?)`,
        repo, report.ts, report.score, report.band, report.type || '', report.stars || 0,
        JSON.stringify(report.dims || []), JSON.stringify(report.todos || [])
      )
    } catch {}
  }

  const md = reportMarkdown(report, { site: `https://${SITE_URL}` })
  logOp({
    actor: c.req.header('x-visitor-id') || 'anonymous',
    action: 'scorecard.share',
    target: repo,
    detail: 'markdown'
  })
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

export default { port: PORT, hostname: HOST, fetch: app.fetch }
