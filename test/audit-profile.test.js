import { test, expect, afterEach } from 'bun:test'
import dayjs from 'dayjs'
import {
  auditProfile,
  reportMarkdown,
  normalizeProfileTarget,
  parseContributions,
  parsePinnedRepos,
  analyzeProfileReadme,
} from '../server/audit-profile.js'

// ---------- 纯函数 ----------

test('normalizeProfileTarget：@user / github.com 前缀都归一成裸 login，非法输入 null', () => {
  expect(normalizeProfileTarget('@webkubor')).toBe('webkubor')
  expect(normalizeProfileTarget('https://github.com/webkubor/')).toBe('webkubor')
  expect(normalizeProfileTarget('github.com/webkubor')).toBe('webkubor')
  expect(normalizeProfileTarget('webkubor')).toBe('webkubor')
  expect(normalizeProfileTarget('owner/repo')).toBe(null)
  expect(normalizeProfileTarget('')).toBe(null)
  expect(normalizeProfileTarget('not a user!!')).toBe(null)
})

test('parseContributions：算出总贡献 / 活跃天数 / 当前与最长 streak', () => {
  const d = (offset) => dayjs().subtract(offset, 'day').format('YYYY-MM-DD')
  const td = (date, level) =>
    `<td tabindex="0" data-date="${date}" id="c-${date}" data-level="${level}" role="gridcell" class="ContributionCalendar-day"></td>`
  const tip = (date, n) =>
    `<tool-tip for="c-${date}">${n} contribution${n === 1 ? '' : 's'} on ${date}.</tool-tip>`
  const html = [
    td(d(0), 2), tip(d(0), 4),      // 今天 4 次
    td(d(1), 1), tip(d(1), 2),      // 昨天 2 次 → 当前 streak 2
    td(d(2), 0),                    // 前天断档
    td(d(10), 1), tip(d(10), 1),    // 历史上一段 4 连
    td(d(11), 1), tip(d(11), 1),
    td(d(12), 1), tip(d(12), 1),
    td(d(13), 1), tip(d(13), 1),
  ].join('')
  const r = parseContributions(html)
  expect(r.total).toBe(10)
  expect(r.activeDays).toBe(6)
  expect(r.currentStreak).toBe(2)
  expect(r.longestStreak).toBe(4)
})

test('parseContributions：认不出结构返回 null（GitHub 改版时不猜）', () => {
  expect(parseContributions('<html><body>无日历</body></html>')).toBe(null)
  expect(parseContributions('')).toBe(null)
})

test('parsePinnedRepos：抓置顶 owner/repo，跳过 stargazers 子链接，认不出返回 null', () => {
  const html = [
    '<li class="pinned-item-list-item-content">',
    '<a href="/fixture/alpha">alpha</a><a href="/fixture/alpha/stargazers">★</a>',
    '</li>',
    '<li class="pinned-item-list-item-content">',
    '<a href="/fixture/beta">beta</a>',
    '</li>',
  ].join('')
  expect(parsePinnedRepos(html)).toEqual(['fixture/alpha', 'fixture/beta'])
  expect(parsePinnedRepos('<div>没有置顶区块</div>')).toBe(null)
})

test('analyzeProfileReadme：按服务特征识别可视化组件与站外链接', () => {
  const md = [
    '# Hi',
    '![stats](https://github-readme-stats.vercel.app/api?username=f)',
    '![streak](https://streak-stats.demolab.com/?user=f)',
    '![skills](https://skillicons.dev/icons?i=js,ts)',
    '![badge](https://img.shields.io/badge/x-y-blue) ![badge2](https://img.shields.io/badge/z-w-green)',
    '![snake](github-contribution-grid-snake.svg)',
    'contact: mailto:me@example.com · [blog](https://example.com)',
  ].join('\n')
  const v = analyzeProfileReadme(md)
  expect(v.stats).toBe(true)
  expect(v.streak).toBe(true)
  expect(v.skillIcons).toBe(true)
  expect(v.snake).toBe(true)
  expect(v.badges).toBe(2)
  expect(v.contact).toBe(true)
  expect(v.externalLinks).toContain('example.com')
  expect(v.externalLinks).not.toContain('img.shields.io')
})

// ---------- 引擎整体（mock 网络） ----------
//
// gh() 与 fetchPage 都走全局 fetch，统一在入口拦截，不碰真实网络。

const realFetch = globalThis.fetch

function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    for (const [re, res] of routes) {
      if (re.test(u)) {
        const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          text: async () => body,
          json: async () => JSON.parse(body),
          url: u,
          redirected: false,
        }
      }
    }
    return { ok: false, status: 404, text: async () => '', json: async () => null, url: u, redirected: false }
  }
}

afterEach(() => { globalThis.fetch = realFetch })

const README = [
  '# Fixture',
  '## About',
  "I'm a full-stack developer building tools for developers.",
  '## Skills',
  '![stats](https://github-readme-stats.vercel.app/api?username=fixture)',
  '![streak](https://streak-stats.demolab.com/?user=fixture)',
  '![skills](https://skillicons.dev/icons?i=js,ts)',
  '![trophy](https://github-profile-trophy.vercel.app/?username=fixture)',
  '![graph](https://github-readme-activity-graph.vercel.app/graph?username=fixture)',
  '![snake](github-contribution-grid-snake.svg)',
  '![visitors](https://visitcount.itsvg.in/api?id=fixture)',
  '![b1](https://img.shields.io/badge/a-b) ![b2](https://img.shields.io/badge/c-d)',
  'contact me: mailto:fixture@example.com · [blog](https://example.com) · [docs](https://docs.example.com)',
].join('\n')

function contribPage(activeOffsets) {
  const td = (date, level) =>
    `<td data-date="${date}" data-level="${level}" class="ContributionCalendar-day"></td>`
  const tip = (date, n) => `<tool-tip>${n} contributions on ${date}.</tool-tip>`
  return activeOffsets
    .map((o) => td(dayjs().subtract(o, 'day').format('YYYY-MM-DD'), 1))
    .join('') + activeOffsets
    .map((o) => tip(dayjs().subtract(o, 'day').format('YYYY-MM-DD'), 5))
    .join('')
}

function userRoutes({ type = 'User' } = {}) {
  return [
    [/api\.github\.com\/users\/fixture$/, { status: 200, body: {
      login: 'fixture', type, name: 'Fixture User',
      company: 'Example Inc', location: 'Hangzhou', blog: 'https://example.com',
      email: 'fixture@example.com', twitter_username: 'fixture', hireable: true,
      bio: 'Full-stack engineer building developer tools and open source',
      followers: 100, following: 5, public_repos: 3, created_at: '2020-01-01T00:00:00Z',
    } }],
    [/api\.github\.com\/users\/fixture\/repos/, { status: 200, body: [
      { name: type === 'Organization' ? '.github' : 'fixture', fork: false, stargazers_count: 60, forks_count: 12, language: 'JavaScript', description: 'profile readme', pushed_at: new Date().toISOString() },
      { name: 'alpha', fork: false, stargazers_count: 30, forks_count: 5, language: 'TypeScript', description: 'tool one', pushed_at: new Date().toISOString() },
      { name: 'beta', fork: false, stargazers_count: 5, forks_count: 1, language: 'Go', description: '', pushed_at: new Date().toISOString() },
      { name: 'forked-one', fork: true, stargazers_count: 0, forks_count: 0, language: null, description: '', pushed_at: '2025-01-01T00:00:00Z' },
    ] }],
    type === 'Organization'
      ? [/api\.github\.com\/repos\/fixture\/\.github\/contents\/profile\/README\.md/, { status: 200, body: README }]
      : [/api\.github\.com\/repos\/fixture\/fixture\/readme/, { status: 200, body: README }],
    [/api\.github\.com\/users\/fixture\/events/, { status: 200, body: [
      { type: 'PullRequestEvent', repo: { name: 'other/project' }, created_at: new Date().toISOString() },
    ] }],
    [/^https:\/\/github\.com\/fixture$/, { status: 200, body: '<li class="pinned-item-list-item-content"><a href="/fixture/alpha">alpha</a></li>' }],
    [/github\.com\/users\/fixture\/contributions/, { status: 200, body: contribPage([0, 1, 2, 3, 10, 11, 40]) }],
    [/example\.com/, { status: 200, body: '<html>ok</html>' }],
  ]
}

test('auditProfile：七维齐出、可视化高分、证据齐备、报告可渲染', async () => {
  mockFetch(userRoutes())
  const r = await auditProfile({ user: '@fixture' })
  expect(r.error).toBeUndefined()
  expect(r.project).toBe('fixture')
  expect(r.dims.length).toBe(7)
  expect(r.dims.map((d) => d.key)).toEqual(['identity', 'readme', 'visuals', 'activity', 'portfolio', 'impact', 'reach'])
  for (const d of r.dims) {
    expect(Array.isArray(d.evidence)).toBe(true)
    expect(d.score == null || (d.score >= 0 && d.score <= 10)).toBe(true)
  }
  const visuals = r.dims.find((d) => d.key === 'visuals')
  expect(visuals.score).toBeGreaterThanOrEqual(8)
  expect(visuals.evidence.some((e) => e.includes('stats'))).toBe(true)
  expect(r.contributions).toBe(35)
  const md = reportMarkdown(r)
  expect(md).toContain('# GitHub 个人首页质检报告 · @fixture')
  expect(md).toContain('## 记分卡')
  expect(md).toContain('把我的 GitHub 个人首页改成一份能拿出手的简历')
})

test('auditProfile：无 profile README 时首页自述 0 分且给出可行动 gap', async () => {
  const routes = userRoutes().map(([re, res]) =>
    /\/readme/.test(re.source) ? [re, { status: 404, body: '' }] : [re, res])
  mockFetch(routes)
  const r = await auditProfile({ user: 'fixture' })
  expect(r.error).toBeUndefined()
  const readme = r.dims.find((d) => d.key === 'readme')
  expect(readme.score).toBe(0)
  expect(readme.gaps.some((g) => g.includes('fixture/fixture'))).toBe(true)
})

test('auditProfile：组织账号走 .github/profile，hireable 与贡献图剔除不扣分', async () => {
  mockFetch(userRoutes({ type: 'Organization' }))
  const r = await auditProfile({ user: 'fixture' })
  expect(r.error).toBeUndefined()
  expect(r.accountType).toBe('Organization')
  const identity = r.dims.find((d) => d.key === 'identity')
  expect(identity.unverifiable).toBe(2)
  const activity = r.dims.find((d) => d.key === 'activity')
  expect(activity.unverifiable).toBe(6.5)
  expect(r.profileReadme).toBe(true)
})

test('auditProfile：用户不存在 → errorStatus 404（绝不 502）', async () => {
  mockFetch([[/api\.github\.com\/users\/ghost/, { status: 404, body: { message: 'Not Found' } }]])
  const r = await auditProfile({ user: 'ghost' })
  expect(r.error).toContain('HTTP 404')
  expect(r.errorStatus).toBe(404)
})

test('auditProfile：贡献页抓不到时活跃度按 unverifiable 剔除，不当零贡献', async () => {
  const routes = userRoutes().filter(([re]) => !/contributions/.test(re.source))
  mockFetch(routes)
  const r = await auditProfile({ user: 'fixture' })
  const activity = r.dims.find((d) => d.key === 'activity')
  expect(activity.unverifiable).toBe(6.5)
  expect(activity.score).not.toBe(0)
})
