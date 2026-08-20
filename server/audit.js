/**
 * 开源项目质检引擎 —— 八维度自动扫描。
 *
 * 评分标准不是这里发明的，照搬 project-maturity-audit skill（~/dev/github/agent/）：
 * 八个维度、0-10 分、"陌生人会不会 10 秒内 star 这个项目"的视角。两边必须同一套标准，
 * 否则面板给 7 分、skill 给 4 分，人就不知道该信谁了。
 *
 * ## 这里只做客观项，主观项留给 skill
 *
 * 「README 首屏 10 秒能不能讲清楚」这种要模型读了才知道，API 判不了。
 * 所以分工是：本引擎做**广度扫描 + 趋势追踪**（一键扫 20 个仓库、可定时、能看
 * 上次 62 分这次 78 分），skill 做**深度诊断 + 修复**（读 README、给整改方案）。
 * 每个维度的 `manual` 字段标出哪些项没法自动判，面板上提示"这几项要跑 skill"。
 *
 * ## 每条结论都带证据
 *
 * skill 的铁律是「每个 claim 要有命令输出/文件/状态码支撑，不给含糊的表扬或指责」。
 * 这里同样：evidence 和 gaps 里写的是实际查到的东西（topics 几个、CI 什么状态、
 * 哪个文件缺），不写"文档有待完善"这种没法行动的话。
 */

import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const GH = 'https://api.github.com'

/** 评分基准，照搬 SKILL.md「评分基准」一节 */
export const SCORE_BANDS = [
  { min: 9, label: '同品类头部', hint: '有渠道、有度量、发布全自动、issue 响应 < 7 天' },
  { min: 6, label: '工程健康但分发薄弱', hint: '"好代码没人看"' },
  { min: 3, label: '能用但门面/发布有欠账', hint: '' },
  { min: 0, label: '个人练习仓库', hint: '' },
]

export const bandOf = (score) => SCORE_BANDS.find((b) => score >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1]

async function gh(path, token, { raw = false } = {}) {
  const res = await fetch(`${GH}${path}`, {
    headers: {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'User-Agent': 'github-accounts-manager',
      ...(token ? { Authorization: `token ${token}` } : {}),
    },
  })
  if (!res.ok) return { ok: false, status: res.status, data: null }
  return { ok: true, status: res.status, data: raw ? await res.text() : await res.json() }
}

/** 项目类型决定某些维度的及格线（skill 里每维都有「类型特有检查」） */
function detectType(files, pkg) {
  const has = (n) => files.some((f) => f.toLowerCase() === n.toLowerCase())
  if (has('SKILL.md')) return 'skill'
  if (pkg?.bin) return 'cli'
  if (files.some((f) => /^(theme|themes)$/i.test(f)) || /theme/i.test(pkg?.name || '')) return 'theme'
  if (pkg?.main || pkg?.exports) return 'library'
  if (files.some((f) => /^(index\.html|public|src)$/i.test(f))) return 'app'
  return 'other'
}

const clamp = (n) => Math.max(0, Math.min(10, Math.round(n * 10) / 10))

/**
 * 各生态的清单文件 → 包名 → registry 查询地址。
 *
 * SKILL.md 写的标准是「是否发布到 registry（npm/PyPI/crates/…）」，但引擎原先
 * 只查 npm：没有 package.json 就直接判「不是 npm 包，也没看到其它 registry 的痕迹」。
 * 于是 Rust / Go / Python 项目在分发这一维天花板只有 4 分 —— 实测 19 个知名项目
 * 有 15 个被判「分发薄弱」，其中包括 CPython。那不是事实，是引擎只会看一个生态。
 */
const MANIFESTS = [
  {
    file: /^package\.json$/i,
    eco: 'npm',
    pick: (t) => JSON.parse(t)?.name,
    url: (n) => `https://registry.npmjs.org/${encodeURIComponent(n)}`
  },
  {
    file: /^Cargo\.toml$/i,
    eco: 'crates.io',
    pick: (t) => (t.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1],
    url: (n) => `https://crates.io/api/v1/crates/${encodeURIComponent(n)}`
  },
  {
    file: /^pyproject\.toml$/i,
    eco: 'PyPI',
    pick: (t) => (t.match(/^\s*name\s*=\s*"?([A-Za-z0-9._-]+)"?/m) || [])[1],
    url: (n) => `https://pypi.org/pypi/${encodeURIComponent(n)}/json`
  },
  {
    file: /^setup\.py$/i,
    eco: 'PyPI',
    pick: (t) => (t.match(/name\s*=\s*["']([A-Za-z0-9._-]+)["']/) || [])[1],
    url: (n) => `https://pypi.org/pypi/${encodeURIComponent(n)}/json`
  },
  {
    file: /^composer\.json$/i,
    eco: 'Packagist',
    pick: (t) => JSON.parse(t)?.name,
    url: (n) => `https://repo.packagist.org/packages/${n}.json`
  },
  {
    file: /\.gemspec$/i,
    eco: 'RubyGems',
    pick: (t) => (t.match(/\.name\s*=\s*["']([^"']+)["']/) || [])[1],
    url: (n) => `https://rubygems.org/api/v1/gems/${encodeURIComponent(n)}.json`
  }
]

/** README 里的安装命令 —— 「陌生人能不能装上」最直接的证据，且不用多打一次 API */
const INSTALL_HINTS = [
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+[@\w][\w./@-]*/i, how: 'npm 系安装命令' },
  { re: /\bpip3?\s+install\s+[\w.[\]-]+/i, how: 'pip 安装命令' },
  { re: /\b(?:uv|pipx)\s+(?:pip\s+)?install\s+[\w.-]+/i, how: 'uv/pipx 安装命令' },
  { re: /\bcargo\s+(?:add|install)\s+[\w-]+/i, how: 'cargo 安装命令' },
  { re: /\bgo\s+(?:get|install)\s+[\w./-]+/i, how: 'go install 命令' },
  { re: /\bbrew\s+(?:install|tap)\s+[\w./-]+/i, how: 'Homebrew 安装命令' },
  { re: /\bgem\s+install\s+[\w-]+/i, how: 'gem 安装命令' },
  { re: /\bcomposer\s+require\s+[\w./-]+/i, how: 'composer 安装命令' },
  { re: /\bdocker\s+(?:pull|run)\s+[\w./:-]+/i, how: 'Docker 镜像' },
  { re: /\b(?:apt|apt-get|dnf|yum|pacman|apk)\s+(?:install|add|-S)\s+[\w.-]+/i, how: '系统包管理器安装命令' },
  { re: /\bcurl\s+[^\n|]*\|\s*(?:sh|bash)/i, how: '一行式安装脚本' },
  { re: /\bnpx\s+[@\w][\w./@-]*/i, how: 'npx 直接运行' }
]

/**
 * 跑一次完整质检。
 * @param {{owner:string, repo:string, token?:string}} opts
 */
export async function auditProject({ owner, repo, token }) {
  const full = `${owner}/${repo}`

  // 一轮并发把要用的都拉下来。GitHub 带 token 是 5000 次/小时，
  // 20 个仓库 × 8 次 = 160 次，一天扫几十轮都不会撞限额。
  const [repoRes, community, readmeRes, contentsRes, releases, tags, runs, openIssues] = await Promise.all([
    gh(`/repos/${full}`, token),
    gh(`/repos/${full}/community/profile`, token),
    gh(`/repos/${full}/readme`, token, { raw: true }),
    gh(`/repos/${full}/contents`, token),
    gh(`/repos/${full}/releases?per_page=5`, token),
    gh(`/repos/${full}/tags?per_page=10`, token),
    gh(`/repos/${full}/actions/runs?per_page=5`, token),
    gh(`/repos/${full}/issues?state=open&per_page=30`, token),
  ])

  if (!repoRes.ok) return { error: `仓库读取失败 HTTP ${repoRes.status}`, score: null }

  const r = repoRes.data
  const readme = readmeRes.ok ? readmeRes.data : ''
  const files = (contentsRes.ok && Array.isArray(contentsRes.data) ? contentsRes.data : []).map((f) => f.name)
  const hasFile = (re) => files.some((f) => re.test(f))
  const cf = community.ok ? community.data?.files || {} : {}

  // package.json 要单独取内容（contents 列表只给文件名）
  let pkg = null
  if (files.includes('package.json')) {
    const p = await gh(`/repos/${full}/contents/package.json`, token, { raw: true })
    if (p.ok) { try { pkg = JSON.parse(p.data) } catch { /* 坏 json 不该让整次质检失败 */ } }
  }
  const type = detectType(files, pkg)

  const dims = []

  // ① 门面 —— 权重最高，决定 10 秒去留
  {
    const ev = [], gaps = []
    const topics = r.topics || []
    r.description ? ev.push(`description: "${r.description.slice(0, 50)}"`) : gaps.push('description 空着 —— 搜索结果里就是一片空白')
    topics.length >= 6 ? ev.push(`topics ${topics.length} 个`) : gaps.push(`topics 只有 ${topics.length} 个（应 ≥6，这是被搜到的主要途径）`)
    r.homepage ? ev.push(`homepage: ${r.homepage}`) : gaps.push('homepage 未配置')

    const badges = (readme.match(/!\[[^\]]*\]\(https:\/\/img\.shields\.io[^)]*\)/g) || []).length
    if (badges >= 4 && badges <= 6) ev.push(`徽章 ${badges} 个（4-6 为宜）`)
    else if (badges > 6) gaps.push(`徽章 ${badges} 个，超过 6 个反而稀释可信度`)
    else gaps.push(`徽章 ${badges} 个（应 4-6 个：CI/license/版本/下载量）`)

    const imgs = (readme.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length
    imgs > 0 ? ev.push(`README 含 ${imgs} 张图`) : gaps.push('README 没有任何图片')

    let score = 2
    if (r.description) score += 2
    if (topics.length >= 6) score += 2
    if (r.homepage) score += 1
    if (badges >= 4 && badges <= 6) score += 1.5
    if (imgs > 0) score += 1.5
    dims.push({
      key: 'facade', name: '门面', score: clamp(score), evidence: ev, gaps,
      manual: ['README 首屏 10 秒清晰度', 'Social Preview 是否已在 Settings 上传 2:1 图', 'logo 是否 1:1 透明底'],
    })
  }

  // ② 分发 —— 「好代码没人看」的分水岭
  //
  // 三条独立证据，任一条成立都说明「陌生人拿得到」：
  //   registry 发布(+4) · README 有安装命令(+3) · release 带可下载产物(+2)
  // 都不看 star —— 用 star 证明分发是循环论证。
  {
    const ev = [], gaps = []
    const manual = ['awesome-list / marketplace 收录情况', 'HN/Reddit/V2EX/掘金首发帖']
    let score = 0

    // ── registry：按清单文件挑对应生态，不再假设人人都发 npm
    const m = MANIFESTS.find((x) => files.some((f) => x.file.test(f)))
    if (m) {
      const fname = files.find((f) => m.file.test(f))
      let name = null
      try {
        // package.json 已经取过内容，别再打一次
        const text = m.eco === 'npm' && pkg ? JSON.stringify(pkg) : (await gh(`/repos/${full}/contents/${fname}`, token, { raw: true })).data
        if (text) name = m.pick(text)
      } catch { /* 清单文件格式坏不该让整次质检失败 */ }

      if (m.eco === 'npm' && pkg?.private) {
        ev.push('package.json 标了 private，不走 registry')
        score += 2
      } else if (name) {
        // crates.io / Packagist 不带 UA 会拒
        const res = await fetch(m.url(name), {
          headers: { 'User-Agent': 'scorecard-audit (+https://scorecard.webkubor.online)' }
        }).catch(() => null)
        if (res?.ok) {
          ev.push(`${m.eco} 已发布：${name}`)
          score += 4
        } else {
          gaps.push(`${fname} 声明了 ${name}，但 ${m.eco} 上查不到 —— 没发布`)
        }
      }
    }

    // ── README 安装命令：最贴近「陌生人能不能装上」的证据
    const hits = INSTALL_HINTS.filter((h) => h.re.test(readme))
    if (hits.length) {
      ev.push(`README 给了安装方式：${hits.slice(0, 3).map((h) => h.how).join('、')}`)
      score += 3
    } else {
      gaps.push('README 里找不到一条可以照抄的安装命令')
    }

    // ── release 产物：官方下载渠道，公开可读，不需要任何权限
    const relAssets = releases.ok && Array.isArray(releases.data)
      ? releases.data.reduce((n, x) => n + (x.assets?.length || 0), 0)
      : 0
    if (relAssets > 0) {
      ev.push(`最近的 release 带 ${relAssets} 个可下载产物`)
      score += 2
    }

    if (r.homepage) { score += 1; ev.push('有 homepage 可导流') } else { gaps.push('没有 demo/官网链接') }
    if ((r.topics || []).length >= 6) score += 0.5

    // 一条证据都没有时才算真的「拿不到」
    if (!ev.length) {
      gaps.push('看不到任何分发渠道：registry、安装命令、release 产物都没有')
      manual.push('是否通过官网/系统包管理器等本引擎看不到的渠道分发')
    }

    dims.push({
      key: 'distribution', name: '分发', score: clamp(score + 1), evidence: ev, gaps, manual,
    })
  }

  // ③ 发布工程
  {
    const ev = [], gaps = []
    let score = 1
    const tagList = tags.ok ? tags.data : []
    const semver = tagList.filter((t) => /^v?\d+\.\d+\.\d+/.test(t.name))
    if (semver.length) { ev.push(`semver tag ${semver.length} 个，最新 ${semver[0].name}`); score += 3 }
    else gaps.push('没有 semver tag —— 用户无法固定版本')

    const rel = releases.ok ? releases.data : []
    if (rel.length) { ev.push(`GitHub Release ${rel.length} 个，最新 ${rel[0].tag_name}`); score += 2 }
    else gaps.push('没有 GitHub Release')

    hasFile(/^CHANGELOG/i) ? (score += 2, ev.push('有 CHANGELOG')) : gaps.push('没有 CHANGELOG —— 升级的人不知道变了什么')

    const runList = runs.ok ? runs.data?.workflow_runs || [] : []
    if (runList.length) {
      const last = runList[0]
      if (last.conclusion === 'success') { ev.push(`CI 最近一次 success（${last.name}）`); score += 2 }
      else { gaps.push(`CI 最近一次是 ${last.conclusion || last.status}（${last.name}）—— 红着的 CI 比没有 CI 更伤`); score += 0.5 }
    } else gaps.push('没有 CI 运行记录')

    dims.push({
      key: 'release', name: '发布工程', score: clamp(score), evidence: ev, gaps,
      manual: ['Release 资产直链是否真的 200', '仓库里有没有误提交 dist/build 产物'],
    })
  }

  // ④ 质量护栏
  {
    const ev = [], gaps = []
    let score = 1
    const scripts = pkg?.scripts || {}
    scripts.test ? (score += 3, ev.push(`有 test 脚本：${scripts.test.slice(0, 40)}`)) : gaps.push('package.json 没有 test 脚本')
    ;(scripts.lint || scripts.typecheck) ? (score += 2, ev.push('有 lint/typecheck 脚本')) : gaps.push('没有 lint/typecheck')
    hasFile(/^\.github$/) ? (score += 2, ev.push('有 .github（CI 配置）')) : gaps.push('没有 .github 目录')
    if (files.some((f) => /^(test|tests|__tests__|spec)$/i.test(f))) { score += 2; ev.push('有独立测试目录') }
    dims.push({
      key: 'quality', name: '质量护栏', score: clamp(score), evidence: ev, gaps,
      manual: ['测试是否真在 CI 里跑', 'commit message 是否守 conventional commits'],
    })
  }

  // ⑤ 社区卫生 —— open issue 积压会造成「项目已死」的错觉
  {
    const ev = [], gaps = []
    let score = 1
    cf.license ? (score += 3, ev.push(`LICENSE: ${r.license?.spdx_id || '有'}`)) : gaps.push('没有 LICENSE —— 公司用户直接过滤掉')
    cf.contributing ? (score += 1.5, ev.push('有 CONTRIBUTING')) : gaps.push('没有 CONTRIBUTING')
    cf.issue_template ? (score += 1, ev.push('有 issue 模板')) : gaps.push('没有 issue 模板')

    const issues = (openIssues.ok ? openIssues.data : []).filter((i) => !i.pull_request)
    const now = Date.now()
    const stale = issues.filter((i) => dayjs().diff(dayjs(i.created_at), 'day') > 30)
    if (!issues.length) { ev.push('没有 open issue'); score += 1.5 }
    else if (stale.length) gaps.push(`${stale.length} 个 open issue 超 30 天没动（共 ${issues.length} 个）—— 口碑杀手`)
    else { ev.push(`${issues.length} 个 open issue，都在 30 天内`); score += 1.5 }

    const days = dayjs().diff(dayjs(r.pushed_at), 'day')
    if (days <= 90) { ev.push(`${dayjs(r.pushed_at).fromNow()}有提交`); score += 2 }
    else gaps.push(`最后一次提交在${dayjs(r.pushed_at).fromNow()} —— 看起来已停更`)

    dims.push({ key: 'community', name: '社区卫生', score: clamp(score), evidence: ev, gaps, manual: [] })
  }

  // ⑥ 文档
  {
    const ev = [], gaps = []
    let score = 1
    // 匹配「标题行里包含关键词」，不是「关键词紧跟 #」。
    // 真实标题很少是光秃秃的 `## 安装` —— typora-Bloom-theme 写的是 `## 快速安装`，
    // 早先那版正则要求关键词紧接 #，于是把一个有完整安装说明的 README 判成「没有安装章节」。
    // 误报比漏报更伤：面板一旦冤枉过一次，人就不信它了。
    const sec = (words) => new RegExp(`^#{1,4}[^\\n]*(${words})`, 'im').test(readme)
    if (readme.length > 800) { ev.push(`README ${readme.length} 字符`); score += 2 }
    else gaps.push(`README 只有 ${readme.length} 字符，撑不起「这是什么、怎么装、怎么用」`)
    sec('install|安装|部署|上手') ? (score += 2, ev.push('有安装章节')) : gaps.push('README 没有安装章节')
    sec('usage|quick\\s*start|getting\\s*started|快速开始|快速上手|使用|用法|怎么用') ? (score += 2, ev.push('有快速开始/使用章节')) : gaps.push('README 没有快速开始')
    sec('api|配置|config|options|参数|选项|自定义') ? (score += 1.5, ev.push('有 API/配置章节')) : gaps.push('没有 API/配置参考')
    sec('faq|troubleshoot|常见问题|故障|排查|问题') ? (score += 1, ev.push('有 FAQ/故障排查')) : gaps.push('没有 FAQ/故障排查')
    if (hasFile(/^(AGENTS?\.md|SKILL\.md|llms\.txt)$/i)) { score += 0.5; ev.push('有 agent 可读文档（加分项）') }
    dims.push({ key: 'docs', name: '文档', score: clamp(score), evidence: ev, gaps, manual: ['死链全量体检'] })
  }

  // ⑦ 安全
  {
    const ev = [], gaps = []
    let score = 4 // 没发现问题不等于安全，但也不该默认按最差算
    hasFile(/^SECURITY\.md$/i) ? (score += 3, ev.push('有 SECURITY.md')) : gaps.push('没有 SECURITY.md')
    if (hasFile(/^\.env$/)) { score -= 4; gaps.push('⚠️ 仓库根目录有 .env —— 立刻检查是否含明文密钥') }
    if (hasFile(/^(\.gitignore)$/)) { score += 2; ev.push('有 .gitignore') } else gaps.push('没有 .gitignore')
    if (pkg?.dependencies && Object.keys(pkg.dependencies).length) ev.push(`${Object.keys(pkg.dependencies).length} 个运行时依赖`)
    dims.push({
      key: 'security', name: '安全', score: clamp(score), evidence: ev, gaps,
      manual: ['git history 明文密钥扫描', 'npm audit / 等价依赖审计'],
    })
  }

  // ⑧ 度量 —— 没有度量就没有反馈闭环
  {
    const ev = [], gaps = []
    let score = 0
    r.stargazers_count > 0 ? ev.push(`${r.stargazers_count} star`) : gaps.push('0 star —— 没有任何外部信号')
    if (r.stargazers_count >= 50) score += 4
    else if (r.stargazers_count >= 10) score += 2.5
    else if (r.stargazers_count >= 1) score += 1

    const manual = ['npm 下载量趋势', '官网埋点']

    // traffic 需要该仓库的 push 权限。作为公共服务，本引擎对别人的仓库永远没有
    // 这个权限 —— 所以它 401 是「我们看不到」，不是「项目没有度量」。
    // 原先把它记成 gap 并扣 3 分，等于每个被质检的项目都无谓损失 3 分，
    // 衡量的是我们的权限而不是项目本身。改为归入 manual，不扣分。
    const traffic = await gh(`/repos/${full}/traffic/views`, token)
    if (traffic.ok) {
      ev.push(`近两周 ${traffic.data.count} 次浏览 / ${traffic.data.uniques} 独立访客`)
      score += 2
    } else {
      manual.push('近两周 traffic（需仓库 push 权限，公共质检读不到 —— 请自己在 Insights → Traffic 看）')
    }

    // 替代信号：release 产物下载量。公开可读，不需要任何权限，
    // 而且比 traffic 更能说明「真的有人在用」。
    const downloads = releases.ok && Array.isArray(releases.data)
      ? releases.data.reduce((n, x) => n + (x.assets || []).reduce((m, a) => m + (a.download_count || 0), 0), 0)
      : 0
    if (downloads > 0) {
      ev.push(`最近 release 累计下载 ${downloads.toLocaleString('en-US')} 次`)
      score += downloads >= 1000 ? 2 : 1
    }

    if (r.forks_count > 0) { ev.push(`${r.forks_count} fork`); score += 1 }
    if (r.homepage) { score += 1; ev.push('有 homepage，可挂埋点') }
    dims.push({ key: 'metrics', name: '度量', score: clamp(score), evidence: ev, gaps, manual })
  }

  const score = clamp(dims.reduce((s, d) => s + d.score, 0) / dims.length)

  // 整改清单按「影响 ÷ 成本」排：分越低的维度影响越大，排前面
  const todos = dims
    .filter((d) => d.gaps.length)
    .sort((a, b) => a.score - b.score)
    .flatMap((d) => d.gaps.map((g) => ({ dim: d.name, dimScore: d.score, text: g })))

  return {
    project: full, type, score, band: bandOf(score).label,
    stars: r.stargazers_count, dims, todos,
    ts: new Date().toISOString(),
  }
}

/**
 * 把质检结果导成 Markdown 报告。
 *
 * 目标读者是**AI 编码助手**，不是人 —— 所以结构要能直接喂进去：先给结论和优先级，
 * 再给逐维度证据，最后附一段可以照抄的指令。报告本身要能独立成立，因为它会离开这个
 * 页面、被粘进别的对话框，那边没有任何上下文。
 *
 * 「哪里不行」到处都有，「该改成什么、先改哪个」才是这份报告的价值。
 */
export function reportMarkdown(a, { site = '' } = {}) {
  const L = []
  const pct = (n) => '█'.repeat(Math.round(n)) + '░'.repeat(10 - Math.round(n))

  L.push(`# 开源项目质检报告 · ${a.project}`)
  L.push('')
  L.push(`**${a.score} / 10** — ${a.band}`)
  L.push('')
  L.push(`项目类型 \`${a.type}\` · ${a.stars} star · 生成于 ${dayjs(a.ts).format('YYYY-MM-DD HH:mm')}`)
  L.push('')
  L.push('八维度标准来自 [project-maturity-audit](https://github.com/webkubor/scorecard/tree/main/skills/project-maturity-audit)：')
  L.push('评的不是「代码好不好」，是「陌生人会不会在 10 秒内 star、安装、信任它」。')
  L.push('')

  L.push('## 记分卡')
  L.push('')
  L.push('| 维度 | 得分 | | 最该补的一件事 |')
  L.push('|---|---:|---|---|')
  for (const d of a.dims) {
    L.push(`| ${d.name} | ${d.score} | \`${pct(d.score)}\` | ${d.gaps[0] || '—'} |`)
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
  L.push('每条结论都有实际查到的东西支撑，没有「有待完善」这种没法行动的话。')
  L.push('')
  for (const d of a.dims) {
    L.push(`### ${d.name} — ${d.score}/10`)
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
  L.push('复制整份报告，连同仓库一起给 Claude Code / Cursor / Copilot，然后说：')
  L.push('')
  L.push('```')
  L.push('照这份质检报告改进这个仓库。从整改清单第 1 条开始，一次做一条，')
  L.push('每条改完告诉我动了哪些文件、为什么这么改。')
  L.push('标着「自动判不了」的几项，你读过 README 之后给我你的判断。')
  L.push('```')
  L.push('')
  L.push('改完可以再跑一次质检对比分数 —— 质检历史会画出曲线。')
  if (site) {
    L.push('')
    L.push(`> 本报告由 [Scorecard 开源项目质检](${site}) 生成，任何公开仓库都能免费跑一次。`)
  }
  return L.join('\n')
}
