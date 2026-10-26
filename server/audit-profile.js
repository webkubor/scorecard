/**
 * GitHub 个人首页审计引擎 —— 独立判据集，与仓库 / npm / 网页 / GEO 四路互不通用。
 *
 * 为什么单独一路：仓库引擎评的是「一个项目陌生人会不会 star」，而个人首页
 * （github.com/<user>）评的是「一个人的门面」—— 招聘方、合作方、AI 助手搜到
 * 这个名字时，10 秒内能对这个人形成什么判断。GitHub 首页正在变成开发者的简历：
 * profile README 是简历正文，贡献图是工作轨迹，置顶仓库是代表作品集。
 * 把这套判据塞进仓库引擎（比如拿 owner 的资料给仓库打分）会让「微软的仓库」
 * 被拿去和「个人开发者」比资历，两边都失真。
 *
 * 七维（每维满分 10）：
 *   ① 身份门面 identity  — name / bio / company / location / hireable（users API 元数据）
 *   ② 首页自述 readme    — profile README（用户是 <u>/<u> 仓库；组织是 .github/profile）在不在、结构够不够撑起一份简历
 *   ③ 可视化   visuals   — stats 卡 / streak / 技能图标 / trophy / 活跃曲线 / 贪吃蛇 / 访客计数（README 源码的 URL 特征）
 *   ④ 活跃度   activity  — 贡献图（users/<u>/contributions 页抓取）/ streak / 最近 push / 公共事件
 *   ⑤ 作品集   portfolio — 原创仓库数 / 总 star / 代表作 / fork 占比 / 语言广度 / 描述覆盖
 *   ⑥ 影响力   impact    — followers / 被 fork / 账号年龄 / 跨仓库协作 PR
 *   ⑦ 链接触达 reach     — blog 配置与可达 / README 外链 / email / twitter / 联系方式
 *
 * 数据面（全部公开可读，无需登录）：
 *   · users API 元数据 + repos 列表 + events + profile README —— 走 gh()，与仓库引擎同一条通道
 *   · github.com/<u> 主页 HTML —— 置顶仓库（pinned-item-list-item-content）
 *   · github.com/users/<u>/contributions —— 贡献日历。个人主页本身已改客户端渲染，
 *     登录态外 HTML 里没有日历；这个经典端点仍然服务端渲染整年 SVG 表格。
 *
 * 与其它引擎同一条纪律：每条结论带 evidence；查不到的判据 unverifiable 并从该维
 * 满分中剔除，不当「不满足」扣分；错误现场带 errorStatus（绝不 502/504）。
 */

import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import { gh } from './audit.js'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const UA = 'scorecard-audit (+https://scorecard.webkubor.online)'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const clamp = (n) => Math.max(0, Math.min(10, Math.round(n * 10) / 10))

/** 模块本地归一化，与其它引擎的口径独立：查不到的分值剔除出分母，再折回 10 分制 */
function normalizeDim(score, unv) {
  const denom = 10 - unv
  if (denom < 2) return null
  return clamp((score / denom) * 10)
}

function bandOf(score) {
  if (score >= 9) return { label: '简历级个人主页', hint: '身份、作品、可视化、活跃度都在线 —— 招聘方 10 秒内能看懂你是谁' }
  if (score >= 6) return { label: '有模有样、可视化可补', hint: '基础资料在，README 视觉层还没发挥首页的表达力' }
  if (score >= 3) return { label: '资料不全的草稿', hint: '' }
  return { label: '还是一块白板', hint: '' }
}

/** README 里的自我介绍信号 —— 首页简历至少要回答「我是谁 / 在做什么」 */
const SELF_INTRO_RE = /i'?m|i am|me myself|我是|我在|做.{0,6}的|focus on|working on|interested in/i

/**
 * 入参容错：@user / github.com/user / https://github.com/user/ 都认，统一成裸 login。
 * 与仓库入口的 owner/repo、npm 的包名形态都不同，不会互相抢目标。
 */
export function normalizeProfileTarget(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  s = s
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '')
  // GitHub login：字母数字与连字符，最长 39。放宽点收 . 和 _，引擎以 API 返回为准
  return /^[\w.-]{1,39}$/.test(s) ? s : null
}

/**
 * 解析贡献日历页（github.com/users/<u>/contributions）。
 *
 * 日格是 <td ... data-date="YYYY-MM-DD" ... data-level="N" ...>，具体数值在同 id 的
 * <tool-tip> 里（"21 contributions on October 20th."）。两处都要抓：
 *   · level>0 → 活跃日 / streak（level 是 GitHub 官方分级，不受 tooltip 文案变化影响）
 *   · tooltip 计数 → 年度总贡献（level 只有 4 档，分不出 5 次和 50 次）
 * 返回 null 表示页面结构没认出来（GitHub 改版 / 页面被墙），调用方按 unverifiable 处理。
 */
export function parseContributions(html) {
  const text = String(html || '')
  if (!text) return null
  const days = []
  const tdRe = /<td\b([^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*)>/g
  let m
  while ((m = tdRe.exec(text)) !== null) {
    const level = Number(/data-level="(\d+)"/.exec(m[1])?.[1] || 0)
    days.push({ date: m[2], level })
  }
  if (!days.length) return null
  const counts = []
  const tipRe = />(\d[\d,]*) contributions? on [^<]+</g
  while ((m = tipRe.exec(text)) !== null) counts.push(Number(m[1].replace(/,/g, '')))
  const total = counts.reduce((a, b) => a + b, 0)
  const active = days.filter((d) => d.level > 0).map((d) => d.date).sort()
  // streak 按连续自然日算。日历尾部是「今天」，从最后一天往回数当前连续；
  // 全程最长一段用一遍线性扫描。重复日期（跨年窗口边缘）去重。
  const uniq = [...new Set(active)]
  const streakOf = (list) => {
    let best = 0
    let run = 0
    let prev = null
    for (const d of list) {
      run = prev && dayjs(d).diff(dayjs(prev), 'day') === 1 ? run + 1 : 1
      best = Math.max(best, run)
      prev = d
    }
    return best
  }
  const current = (() => {
    let run = 0
    let cursor = dayjs().format('YYYY-MM-DD')
    const set = new Set(uniq)
    // 今天还没提交不算断签 —— 从昨天或今天起往回数第一段连续活跃
    if (!set.has(cursor)) cursor = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
    while (set.has(cursor)) {
      run++
      cursor = dayjs(cursor).subtract(1, 'day').format('YYYY-MM-DD')
    }
    return run
  })()
  return {
    total,
    activeDays: uniq.length,
    currentStreak: current,
    longestStreak: streakOf(uniq),
    windowDays: days.length,
  }
}

/**
 * 从个人主页 HTML 抓置顶仓库。登录态外的页面仍服务端渲染 pinned 列表，
 * 每个条目一个 pinned-item-list-item-content 块；条目里的首个 /owner/repo
 * 链接就是仓库本体（stargazers / forks 等子链接靠两段以上路径排除）。
 * 认不出结构时返回 null —— pinned 需要 GraphQL token 才能从 API 拿，
 * 网页结构变了就整项 unverifiable，不猜。
 */
export function parsePinnedRepos(html) {
  const text = String(html || '')
  if (!text || !text.includes('pinned-item-list-item-content')) return null
  const blocks = text.split('pinned-item-list-item-content').slice(1)
  const out = []
  for (const block of blocks) {
    const href = /<a\b[^>]*href="\/([\w.-]+)\/([\w.-]+)"/.exec(block)
    if (!href) continue
    // gist 型置顶条目指向 gist.github.com，不匹配上面的 /owner/repo 形态，自然被跳过
    out.push(`${href[1]}/${href[2]}`)
  }
  return [...new Set(out)]
}

/** README 可视化组件识别 —— 全部按服务域名 / 路径特征，只认事实不认观感 */
export function analyzeProfileReadme(readme) {
  const md = String(readme || '')
  const markdownBadges = md.match(/!\[[^\]]*\]\(https:\/\/img\.shields\.io[^)]*\)/g) || []
  const htmlImages = md.match(/<img\b[^>]*>/gi) || []
  const htmlBadges = htmlImages.filter((tag) => /src\s*=\s*["']https:\/\/img\.shields\.io\//i.test(tag))
  return {
    length: md.length,
    headings: (md.match(/^#{1,4}\s+\S/mg) || []).length,
    links: (md.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g) || []).length,
    images: (md.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length + htmlImages.length,
    badges: markdownBadges.length + htmlBadges.length,
    externalLinks: [...md.matchAll(/\]\((https?:\/\/([^)]+))\)/g)]
      .map((mm) => { try { return new URL(mm[1]).hostname } catch { return '' } })
      .filter((h) => h && h !== 'github.com' && !h.endsWith('.github.com') && h !== 'img.shields.io' && h !== 'gist.github.com'),
    stats: /github-readme-stats\.vercel\.app/.test(md),
    streak: /streak-stats\.demolab\.com|github-readme-streak-stats/.test(md),
    skillIcons: /skillicons\.dev|top-langs|devicons/i.test(md),
    trophy: /github-profile-trophy|trophy\.so\//.test(md),
    activityGraph: /github-readme-activity-graph|activity-graph\.herokuapp|github-contributions\.vercel\.app/.test(md),
    snake: /snake/i.test(md),
    visitor: /visitcount\.itsvg\.in|visitor-badge|komarev\.com|profile-views|visitorcount/i.test(md),
    contact: /mailto:|<contact|联系方式|联系我|contact me|找我/i.test(md),
  }
}

/** 读外部站点，失败返回 null（量具盲区，不是目标的错） */
async function fetchPage(url, { timeout = 10000 } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    })
    const text = await res.text().catch(() => null)
    return { ok: res.ok, status: res.status, text, finalUrl: res.url || url }
  } catch {
    return null
  }
}

/**
 * 跑一次个人首页审计。
 * @param {{user:string, token?:string}} opts
 */
export async function auditProfile({ user, token }) {
  const login = normalizeProfileTarget(user)
  if (!login) return { error: 'GitHub 用户名格式不合法（例：webkubor / @webkubor / github.com/webkubor）', errorStatus: 400, score: null }

  // users API 是唯一权威：404 = 用户不存在，别在网页端点上猜
  const userRes = await gh(`/users/${login}`, token)
  if (!userRes.ok) {
    const s = userRes.status
    const errorStatus = s === 404 || s === 410 ? 404 : s === 403 || s === 429 ? 429 : s < 500 ? 400 : 503
    return { error: `用户读取失败 HTTP ${s}`, errorStatus, score: null }
  }
  const u = userRes.data
  const isOrg = u.type === 'Organization'

  // profile README 的位置按账号类型分：个人是 <u>/<u> 仓库，组织是 .github/profile/README.md
  const [reposRes, readmeRes, eventsRes, profilePage, contributionsPage] = await Promise.all([
    gh(`/users/${login}/repos?per_page=100&sort=pushed`, token),
    isOrg
      ? gh(`/repos/${login}/.github/contents/profile/README.md`, token, { raw: true })
      : gh(`/repos/${login}/${login}/readme`, token, { raw: true }),
    gh(`/users/${login}/events/public?per_page=30`, token),
    fetchPage(`https://github.com/${login}`),
    isOrg ? Promise.resolve(null) : fetchPage(`https://github.com/users/${login}/contributions`),
  ])

  const repos = reposRes.ok && Array.isArray(reposRes.data) ? reposRes.data : []
  const readme = readmeRes.ok ? String(readmeRes.data || '') : ''
  const hasReadme = readmeRes.ok
  const events = eventsRes.ok && Array.isArray(eventsRes.data) ? eventsRes.data : []
  const readmeInfo = analyzeProfileReadme(readme)
  const contrib = !isOrg && contributionsPage ? parseContributions(contributionsPage.text) : null
  const pinned = profilePage ? parsePinnedRepos(profilePage.text) : null
  // profile README 仓库本身就在 repos 列表里，别为 pushed_at 多打一次 API
  const readmeRepo = repos.find((r) => r.name?.toLowerCase() === (isOrg ? '.github' : login).toLowerCase())

  const original = repos.filter((r) => !r.fork)
  const forks = repos.filter((r) => r.fork)
  const totalStars = original.reduce((n, r) => n + (r.stargazers_count || 0), 0)
  const totalForked = original.reduce((n, r) => n + (r.forks_count || 0), 0)
  const topRepos = original.slice().sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0)).slice(0, 3)
  const described = original.filter((r) => r.description && r.description.trim()).length
  const languages = [...new Set(repos.map((r) => r.language).filter(Boolean))]
  const lastPush = repos.length ? repos.map((r) => r.pushed_at).sort().reverse()[0] : null
  const lastEventAt = events.length ? events[0].created_at : null
  // 跨仓库协作：给别人的仓库提 PR / review —— 「参与开源」而不只是「自建仓库」
  const externalPr = events.filter((e) =>
    /PullRequest(Event|ReviewEvent)/.test(e.type) && !(e.repo?.name || '').toLowerCase().startsWith(`${login.toLowerCase()}/`))

  const dims = []

  // ① 身份门面 —— users API 元数据。头像是否自定义（API 只给同一个 CDN URL，
  // 区分不出默认 identicon）进 manual，不猜分。
  {
    const ev = [], gaps = [], manual = []
    let score = 0.5
    let unv = 0

    const name = String(u.name || '').trim()
    name ? ev.push(`name: "${name}"`) : gaps.push('name 没填 —— 搜到这条资料的人不知道怎么称呼你')
    if (name) score += 1
    if (name && name.toLowerCase() !== login.toLowerCase()) { ev.push('name 与登录名不同（更像真名/笔名，可被搜索）'); score += 0.5 }

    const bio = String(u.bio || '').trim()
    if (!bio) gaps.push('bio 空着 —— 简历的第一行没有')
    else {
      ev.push(`bio: "${bio.slice(0, 60)}${bio.length > 60 ? '…' : ''}"（${bio.length} 字符）`)
      score += 1.5
      if (bio.length >= 40) { score += 1 } else gaps.push(`bio 只有 ${bio.length} 字符，一句话说不清你是做什么的`)
      if (/engineer|developer|designer|builder|creator|student|researcher|架构|工程师|开发者|设计师|产品|学生|研究员|独立开发/i.test(bio)) {
        ev.push('bio 有角色/方向词（engineer / 开发者 / 设计师 …）')
        score += 1
      } else {
        manual.push('bio 未检出角色/方向词 —— 可能是词表盲区，需人工核对（这 1 分不剔除，写清楚角色是可核实的事实）')
      }
    }

    u.company ? (ev.push(`company: ${u.company}`), (score += 1.5)) : gaps.push('company 没填（在职/自由职业都可写）')
    u.location ? (ev.push(`location: ${u.location}`), (score += 1)) : gaps.push('location 没填 —— 同城机会会略过你')
    if (isOrg) {
      unv += 2
      manual.push('组织账号没有 hireable 字段 —— 这 2 分已从满分中剔除')
    } else {
      u.hireable ? (ev.push('hireable: true —— 主动标了「在看机会」'), (score += 2)) : gaps.push('hireable 没开 —— 想被机会找上门的话，这是免费的一键开关')
    }
    manual.push('头像是否自定义、主页 banner 是否上传（API 区分不出默认 identicon，需人工看一眼）')

    dims.push({ key: 'identity', name: '身份门面', score: normalizeDim(score, unv), unverifiable: unv, evidence: ev, gaps, manual })
  }

  // ② 首页自述 —— profile README 是个人首页的正文。没有它是这一维最实的 gap：
  // 创建 <u>/<u> 仓库是 GitHub 官方的首页机制，查不到就是没做，不是判不了。
  {
    const ev = [], gaps = [], manual = []
    let score = 0
    if (!hasReadme) {
      gaps.push(`没有 profile README${isOrg ? '（组织应在 .github 仓库建 profile/README.md）' : ` —— 建一个 ${login}/${login} 仓库并加 README.md，GitHub 会把它渲染成你的首页`}，首页只剩一栏仓库列表`)
    } else {
      ev.push(`profile README 存在（${readme.length} 字符${isOrg ? ' · 组织 .github/profile' : ` · ${login}/${login} 仓库` }）`)
      score += 3.5
      readmeInfo.length >= 300
        ? (score += 1.5)
        : gaps.push(`README 只有 ${readmeInfo.length} 字符 —— 撑不起一份简历的自我介绍`)
      readmeInfo.headings >= 2
        ? (ev.push(`markdown 标题 ${readmeInfo.headings} 个，有章节结构`), (score += 1))
        : gaps.push('README 没有标题结构 —— 一整屏文字没有分区')
      SELF_INTRO_RE.test(readme)
        ? (score += 1)
        : gaps.push('README 里找不到自我介绍（我是谁 / 在做什么）')
      readmeInfo.contact
        ? (ev.push('README 有联系方式/联系入口'), (score += 1))
        : gaps.push('README 没有联系方式 —— 想找你的人没有下一步动作')
      const readmeFresh = readmeRepo?.pushed_at ? dayjs().diff(dayjs(readmeRepo.pushed_at), 'day') : null
      if (readmeFresh != null) {
        readmeFresh <= 180
          ? (ev.push(`README 仓库${dayjs(readmeRepo.pushed_at).fromNow()}有更新`), (score += 1))
          : gaps.push(`README 仓库${dayjs(readmeRepo.pushed_at).fromNow()}没动过 —— 简历过期了`)
      }
      manual.push('README 文案的真实说服力（语气、案例、量化成果）需人或 AI 通读判断')
    }

    dims.push({ key: 'readme', name: '首页自述', score: normalizeDim(score, 0), unverifiable: 0, evidence: ev, gaps, manual })
  }

  // ③ 可视化 —— 首页能不能一眼记住。判据全是 README 源码里可见的组件服务特征，
  // 主题配色/排版观感进 manual。这一维回答的正是「首页只是一栏字，还是一张海报」。
  {
    const ev = [], gaps = [], manual = []
    let score = 0.5
    if (!hasReadme) {
      // README 本身缺失时，可视化无从谈起 —— 已在②记 gap，这里同样 0.5 起步并说明
      gaps.push('没有 profile README，可视化组件无处安放')
    } else {
      const v = readmeInfo
      v.stats ? (ev.push('GitHub stats 统计卡（star / commit 总量）'), (score += 2)) : gaps.push('没有 stats 统计卡 —— 首页看不到你的总量成绩')
      v.streak ? (ev.push('streak 连续打卡卡'), (score += 1.5)) : gaps.push('没有 streak 连续打卡卡 —— 勤奋轨迹不可见')
      v.skillIcons ? (ev.push('技能/语言图标（skillicons / top-langs）'), (score += 1.5)) : gaps.push('没有技能/语言图标 —— 技术栈要靠文字猜')
      v.badges >= 3 ? (ev.push(`shields.io 徽章 ${v.badges} 个`), (score += 1)) : gaps.push(`shields.io 徽章 ${v.badges} 个 —— 少于 3 个不成视觉块`)
      if (v.trophy) { ev.push('trophy 成就卡'); score += 1 } else gaps.push('没有 trophy 成就卡')
      if (v.activityGraph) { ev.push('贡献活跃曲线图'); score += 1 } else gaps.push('没有贡献活跃曲线图')
      if (v.snake) { ev.push('贪吃蛇推格子动画'); score += 1 } else gaps.push('没有贪吃蛇动画（贡献图变动画，首页最出圈的一招）')
      v.visitor ? (ev.push('访客计数'), (score += 0.5)) : gaps.push('没有访客计数')
      v.images >= 2 ? ev.push(`图片/动图共 ${v.images} 处`) : gaps.push(`图片/动图只有 ${v.images} 处 —— 纯文字首页留不住第二眼`)
      manual.push('组件主题配色与排版是否协调（需人工看渲染效果）', '外链图片是否都能渲染（死图需人工核）')
    }
    dims.push({ key: 'visuals', name: '可视化', score: normalizeDim(score, 0), unverifiable: 0, evidence: ev, gaps, manual })
  }

  // ④ 活跃度 —— 贡献图 + 最近动态。贡献图来自经典 contributions 端点；
  // 抓不到（改版/网络）时贡献三项 unverifiable，不当作「零贡献」。
  {
    const ev = [], gaps = [], manual = []
    let score = 0
    let unv = 0
    if (isOrg) {
      unv += 6.5
      manual.push('组织账号没有个人贡献图 —— 贡献/streak/活跃天数这 6.5 分已从满分中剔除')
    } else if (contrib) {
      ev.push(`近一年 ${contrib.total} 次贡献 · 活跃 ${contrib.activeDays} 天`)
      if (contrib.total >= 800) score += 3
      else if (contrib.total >= 200) score += 2
      else if (contrib.total >= 30) score += 1
      else if (contrib.total > 0) score += 0.5
      else gaps.push(`近一年 ${contrib.total} 次贡献 —— 贡献图全白`)

      if (contrib.currentStreak >= 7) { ev.push(`当前连续 ${contrib.currentStreak} 天有贡献`); score += 1.5 }
      else if (contrib.currentStreak >= 3) { ev.push(`当前连续 ${contrib.currentStreak} 天有贡献`); score += 1 }
      else if (contrib.currentStreak >= 1) score += 0.5
      else gaps.push('当前没有连续贡献（今天与昨天都是 0）')

      contrib.longestStreak >= 30 ? (ev.push(`最长连续 ${contrib.longestStreak} 天`), (score += 1)) : gaps.push(`最长连续只有 ${contrib.longestStreak} 天 —— 没形成过稳定节奏`)
      contrib.activeDays >= 100 ? (score += 1) : gaps.push(`一年里只有 ${contrib.activeDays} 天活跃（窗口 ${contrib.windowDays} 天）`)
    } else {
      unv += 6.5
      manual.push('贡献日历页抓取失败（GitHub 改版或网络原因）—— 贡献/streak/活跃天数这 6.5 分已从满分中剔除')
    }

    if (!reposRes.ok) {
      unv += 2
      manual.push('仓库列表读取失败，最近 push 判不了 —— 这 2 分已从满分中剔除')
    } else if (lastPush) {
      const days = dayjs().diff(dayjs(lastPush), 'day')
      if (days <= 30) { ev.push(`最近一次 push ${dayjs(lastPush).fromNow()}`); score += 2 }
      else if (days <= 90) { ev.push(`最近一次 push ${dayjs(lastPush).fromNow()}`); score += 1 }
      else if (days <= 180) score += 0.5
      else gaps.push(`最近一次公开 push 在${dayjs(lastPush).fromNow()}`)
    }

    if (!eventsRes.ok) {
      unv += 1.5
      manual.push('公共事件读取失败 —— 这 1.5 分已从满分中剔除')
    } else if (lastEventAt) {
      const days = dayjs().diff(dayjs(lastEventAt), 'day')
      days <= 14 ? (ev.push(`最近公共活动 ${dayjs(lastEventAt).fromNow()}`), (score += 1.5)) : gaps.push(`最近一次公共活动在${dayjs(lastEventAt).fromNow()}`)
    } else {
      score += 1.5 // 查到了且没有任何事件：事件接口只保留 90 天，半年不活动的人这里本来就是空
      gaps.push('近 90 天公共事件一条都没有')
    }

    dims.push({ key: 'activity', name: '活跃度', score: normalizeDim(score, unv), unverifiable: unv, evidence: ev, gaps, manual })
  }

  // ⑤ 作品集 —— repos 列表（按 push 排序取 100）。star 是作品被认可的外部信号，
  // 但刻意不把「没 star」当成道德问题：个人练手仓库的描述覆盖率与语言广度同样计分。
  {
    const ev = [], gaps = [], manual = []
    let score = 0
    let unv = 0
    if (!reposRes.ok) {
      unv += 10
      manual.push('仓库列表读取失败 —— 该维不计入总分')
    } else {
      if (original.length >= 10) { ev.push(`原创公开仓库 ${original.length} 个`); score += 2 }
      else if (original.length >= 5) { ev.push(`原创公开仓库 ${original.length} 个`); score += 1.5 }
      else if (original.length >= 1) { ev.push(`原创公开仓库 ${original.length} 个`); score += 0.5 }
      else gaps.push('没有任何原创公开仓库 —— 首页作品集是空的')

      if (totalStars >= 100) { ev.push(`原创仓库累计 ${totalStars} star`); score += 2 }
      else if (totalStars >= 10) { ev.push(`原创仓库累计 ${totalStars} star`); score += 1 }
      else if (totalStars >= 1) { ev.push(`原创仓库累计 ${totalStars} star`); score += 0.5 }
      else gaps.push(`原创仓库累计 0 star —— 没有任何外部认可信号（取样最近 push 的 ${repos.length} 个）`)

      const top = topRepos[0]
      if (top?.stargazers_count >= 30) { ev.push(`代表作 ${top.full_name}（${top.stargazers_count}★）`); score += 2 }
      else if (top?.stargazers_count >= 5) { ev.push(`代表作 ${top.full_name}（${top.stargazers_count}★）`); score += 1 }
      else gaps.push(top ? `最高 star 的仓库 ${top.full_name} 只有 ${top.stargazers_count}★` : '没有可比的代表作')

      const forkRatio = repos.length ? forks.length / repos.length : 0
      if (!repos.length) { /* 上面已经记过 gap */ }
      else if (forkRatio <= 0.5) { ev.push(`fork 占比 ${(forkRatio * 100).toFixed(0)}%`); score += 1 }
      else gaps.push(`公开仓库里 ${(forkRatio * 100).toFixed(0)}% 是 fork —— 首页作品集被别人的项目占满`)

      languages.length >= 3 ? (ev.push(`技术栈覆盖 ${languages.length} 种语言：${languages.slice(0, 5).join('、')}`), (score += 1.5)) : gaps.push(`只看到 ${languages.length} 种语言 —— 技术面窄或仓库都没标语言`)

      const descRate = original.length ? described / original.length : 0
      descRate >= 0.5 ? (ev.push(`仓库描述覆盖率 ${(descRate * 100).toFixed(0)}%`), (score += 1.5)) : gaps.push(`原创仓库只有 ${(descRate * 100).toFixed(0)}% 写了描述 —— 作品集里一堆无名条目`)
      manual.push('置顶仓库是否挑了最能打的（见「影响力/证据」或自行到首页核对）')
    }
    dims.push({ key: 'portfolio', name: '作品集', score: normalizeDim(score, unv), unverifiable: unv, evidence: ev, gaps, manual })
  }

  // ⑥ 影响力 —— followers / 被 fork / 资历。外部协作 PR 单列：给别人的仓库提 PR
  // 是「被开源社区接纳」的直接证据，比粉丝数更难造假。
  {
    const ev = [], gaps = [], manual = []
    let score = 1
    const followers = u.followers || 0
    if (followers >= 1000) { ev.push(`${followers} followers`); score += 3 }
    else if (followers >= 200) { ev.push(`${followers} followers`); score += 2 }
    else if (followers >= 50) { ev.push(`${followers} followers`); score += 1.5 }
    else if (followers >= 10) { ev.push(`${followers} followers`); score += 0.75 }
    else if (followers >= 1) score += 0.25
    else gaps.push('0 follower —— 还没有任何外部关注')

    if (followers >= (u.following || 0) || (u.following || 0) <= 50) { ev.push(`following ${u.following || 0}`); score += 1 }
    else gaps.push(`following ${u.following} 远大于 followers ${followers} —— 关注换回关堆出来的数字`)

    if (!reposRes.ok) {
      manual.push('仓库列表读取失败，被 fork 总量判不了')
    } else if (totalForked >= 10) { ev.push(`作品累计被 fork ${totalForked} 次`); score += 2 }
    else if (totalForked >= 1) { ev.push(`作品累计被 fork ${totalForked} 次`); score += 1 }
    else gaps.push('作品还没有被 fork 过')

    const ageYears = dayjs().diff(dayjs(u.created_at), 'year', true)
    ageYears >= 1 ? (ev.push(`账号 ${Math.floor(ageYears)} 年（${dayjs(u.created_at).format('YYYY')} 注册）`), (score += 1)) : gaps.push('账号注册不满一年')

    if (!eventsRes.ok) {
      manual.push('公共事件读取失败，跨仓库协作判不了')
    } else if (externalPr.length) {
      ev.push(`近 90 天给 ${new Set(externalPr.map((e) => e.repo?.name)).size} 个外部仓库提过 PR/review`)
      score += 1.5
    } else {
      gaps.push('近 90 天没有给外部仓库提过 PR —— 只在自己的仓库里活动')
    }
    manual.push('GitHub Sponsors 是否开通（页面对未设置者 404，语义不稳，不自动判）')

    dims.push({ key: 'impact', name: '影响力', score: normalizeDim(score, 0), unverifiable: 0, evidence: ev, gaps, manual })
  }

  // ⑦ 链接触达 —— 想找你的人能不能走出 GitHub。blog「配了但打不开」与「没配」
  // 分开记；抓取超时是量具问题，unverifiable 不扣分。
  {
    const ev = [], gaps = [], manual = []
    let score = 1.5
    let unv = 0
    let blogUrl = String(u.blog || '').trim()
    if (blogUrl && !/^https?:\/\//i.test(blogUrl)) blogUrl = 'https://' + blogUrl
    if (blogUrl && /^https?:\/\/[\w.-]+\.[a-z]{2,}/i.test(blogUrl)) {
      ev.push(`blog: ${blogUrl}`)
      score += 2.5
      const site = await fetchPage(blogUrl, { timeout: 8000 })
      if (!site) {
        unv += 2
        manual.push('blog 站点抓取失败（超时/网络）—— 可达性这 2 分已从满分中剔除')
      } else if (site.ok) {
        ev.push(`blog 可达（HTTP ${site.status}）`)
        score += 2
      } else {
        gaps.push(`blog 配了但打不开（HTTP ${site.status}）—— 简历上的死链比没有更伤`)
      }
    } else {
      gaps.push('blog 没配 —— 首页之外没有你的落脚点')
    }

    const social = []
    if (u.twitter_username) social.push(`twitter/@${u.twitter_username}`)
    if (u.email) social.push(`email ${u.email}`)
    social.length ? (ev.push(social.join(' · ')), (score += 1.5)) : gaps.push('没有公开 email / twitter —— 招聘方没有直接触达渠道')

    if (hasReadme) {
      readmeInfo.externalLinks.length >= 2
        ? (ev.push(`README 指向站外 ${new Set(readmeInfo.externalLinks).size} 个域名`), (score += 1.5))
        : gaps.push(`README 站外链接只有 ${new Set(readmeInfo.externalLinks).size} 个域名`)
    } else {
      unv += 1.5
      manual.push('没有 profile README，README 外链判不了 —— 这 1.5 分已从满分中剔除')
    }
    manual.push('README 里的链接是否都能打开（死链体检需逐个访问）')

    dims.push({ key: 'reach', name: '链接触达', score: normalizeDim(score, unv), unverifiable: unv, evidence: ev, gaps, manual })
  }

  // 置顶仓库是抓取加分项：结构认出来就进证据（给人核对），认不出来不扣分
  if (pinned && pinned.length) {
    const dim = dims.find((d) => d.key === 'portfolio')
    dim?.evidence.push(`置顶仓库 ${pinned.length} 个：${pinned.slice(0, 6).join('、')}`)
  }

  const scored = dims.filter((d) => d.score != null)
  const inconclusive = dims.filter((d) => d.score == null).map((d) => d.name)
  if (!scored.length) {
    return { error: '七个维度都无从核实（用户资料与仓库列表都读不到）', errorStatus: 503, score: null, project: login, dims, scoredCount: 0, inconclusiveDims: inconclusive }
  }
  const score = clamp(scored.reduce((s, d) => s + d.score, 0) / scored.length)
  const todos = scored
    .filter((d) => d.gaps.length)
    .sort((a, b) => a.score - b.score)
    .flatMap((d) => d.gaps.map((g) => ({ dim: d.name, dimScore: d.score, text: g })))

  return {
    project: login,
    profileUrl: `https://github.com/${login}`,
    accountType: isOrg ? 'Organization' : 'User',
    type: 'github-profile',
    score,
    band: bandOf(score).label,
    bandHint: bandOf(score).hint,
    stars: totalStars,
    followers: u.followers || 0,
    publicRepos: u.public_repos || 0,
    contributions: contrib ? contrib.total : null,
    currentStreak: contrib ? contrib.currentStreak : null,
    profileReadme: hasReadme,
    hireable: isOrg ? null : !!u.hireable,
    dims,
    todos,
    scoredCount: scored.length,
    inconclusiveDims: inconclusive,
    ts: new Date().toISOString(),
  }
}

/**
 * Markdown 报告 —— 与其它引擎同一骨架（结论 → 记分卡 → 整改清单 → 证据 → 可照抄指令），
 * 文案换成「把 GitHub 首页当简历改」的上下文。
 */
export function reportMarkdown(a, { site = '' } = {}) {
  const L = []
  const pct = (n) => '█'.repeat(Math.round(n)) + '░'.repeat(10 - Math.round(n))

  L.push(`# GitHub 个人首页质检报告 · @${a.project}`)
  L.push('')
  L.push(`**${a.score} / 10** — ${a.band}`)
  if (a.bandHint) L.push(`*${a.bandHint}*`)
  L.push('')
  L.push(`主页 ${a.profileUrl || `https://github.com/${a.project}`} · 账号类型 ${a.accountType || 'User'} · ${a.followers ?? '?'} followers · 原创作品累计 ${a.stars ?? 0}★${a.contributions != null ? ` · 近一年 ${a.contributions} 次贡献` : ''} · 生成于 ${dayjs(a.ts).format('YYYY-MM-DD HH:mm')}`)
  if (a.scoredCount != null && a.scoredCount < 7) {
    L.push('')
    L.push(`> 本次只有 ${a.scoredCount} 个维度拿到了可核实的证据，总分是这几维的平均。`)
    if (a.inconclusiveDims?.length) {
      L.push(`> 未计入：${a.inconclusiveDims.join('、')} —— 不是这些维度不合格，是本引擎读不到判据。`)
    }
  }
  L.push('')
  L.push('七维标准独立于仓库 / npm / 网页 / GEO 四路 —— 个人首页评的不是「项目好不好」，')
  L.push('是「别人打开 github.com/<你> 的 10 秒里，能对**你**形成什么判断」。')
  L.push('')

  L.push('## 记分卡')
  L.push('')
  L.push('| 维度 | 得分 | | 最该补的一件事 |')
  L.push('|---|---:|---|---|')
  for (const d of a.dims) {
    if (d.score == null) {
      L.push(`| ${d.name} | — | \`判不了\` | 本引擎读不到这一维的判据，未计入总分 |`)
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
  L.push('每条结论都有实际查到的东西支撑，没有「有待完善」这种没法行动的话。')
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
  L.push('复制整份报告，连同你的 GitHub 首页给 Claude Code / Cursor / Copilot，然后说：')
  L.push('')
  L.push('```')
  L.push('照这份质检报告把我的 GitHub 个人首页改成一份能拿出手的简历。')
  L.push(`profile README 在 ${a.accountType === 'Organization' ? '.github 仓库的 profile/README.md' : `${a.project}/${a.project} 仓库`}，`)
  L.push('从整改清单第 1 条开始，一次做一条，每条改完告诉我动了什么、为什么这么改。')
  L.push('标着「自动判不了」的几项（头像、配色、文案说服力），你看了渲染效果后给我判断。')
  L.push('```')
  L.push('')
  L.push('改完可以再跑一次质检对比分数 —— 质检历史会画出曲线。')
  if (site) {
    L.push('')
    L.push(`> 本报告由 [Scorecard 开源项目质检](${site}) 生成，任何公开 GitHub 首页都能免费跑一次。`)
  }
  return L.join('\n')
}
