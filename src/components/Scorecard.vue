<script setup>
/**
 * Scorecard —— 落地页 + 报告页一体化。
 *
 * 三种状态在一页内流转：
 *   1) idle：超大输入框 + 几个示例 chip + "已查过 N 次" 信任状
 *   2) loading：进度文案 + 9 个维度逐项打勾（带 staggered 动画）
 *   3) report：大号分数 + SVG 雷达图 + 9 维度条形明细 + Markdown 报告导出
 *
 * 设计取舍：
 * - 全程免登录，前端从不接触任何 token
 * - 服务端可配一个只读 token（SCORECARD_GITHUB_TOKEN），把限额从匿名
 *   60/h/IP 提到 5000/h；不配也能跑，只是 PR/issues 维度拿不到数据、分数偏低
 * - 报告以 Markdown 交付，不做图片导出。图片好看但是死的，看完还得自己
 *   翻译成任务；Markdown 能直接粘进 Claude Code / Cursor 让它照着改，
 *   改完再回来测一次分数。顺带少一个 html2canvas 的 CDN 依赖。
 */
import { ref, computed, watch, onMounted } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  initialRepo: { type: String, default: '' },
  // 分享 URL 自动跑：?share=X&compare=Y&type=Z
  initialCompare: { type: Object, default: null }
})

// 品牌字样集中在这里。散成十几处字面量的话，改名必然漏掉几处，
// 于是同一个页面上并存两个品牌名 —— 拆仓前就是这个状态（GHAM / Scorecard 混用）。
const BRAND = 'Scorecard'
const BRAND_MARK = 'SCORECARD' // 视觉标记用大写
const BRAND_SLUG = 'scorecard' // 导出文件名用
const SITE_HOST = 'scorecard.webkubor.online'

// ---------- 场景（用户带着什么问题来的） ----------
//
// 之前落地页只有一个输入框，让用户自己判断「我该拿它干嘛」。实测这是最大的
// 可用性断点：输入框只说了工具能干什么，没说用户此刻该用它干什么。
//
// 这里不新增四个产品，只把「你是谁、你要干什么」显式化：选中场景后
//   · placeholder 换成该场景的典型输入
//   · 提示换成该场景真正关心的那几维
// 分数还是同一套分数、同一份报告 —— 场景不改判据，只改「先看哪儿」。
//
// priority 是给报告用的排序提示，不是维度权重：不同场景下整改清单的先后
// 应当不同（发版关心发布工程，开源关心门面），但分数口径绝不因场景而变 ——
// 否则同一个仓库在两个场景下分数不同，那才是真的不可信。
const SCENARIOS = [
  {
    key: 'just-published',
    label: '刚开源',
    hint: '第一次公开一个项目，先看看别人第一眼会看到什么',
    placeholder: 'github.com/owner/repo',
    focus: ['门面', '文档', 'AI 可读性'],
  },
  {
    key: 'before-release',
    label: '要发版',
    hint: '发版前补齐门面与工程化，该有的仪式不能少',
    placeholder: 'github.com/owner/repo',
    focus: ['发布工程', '质量护栏', '分发'],
  },
  {
    key: 'agent-handoff',
    label: '交给 Agent 改',
    hint: '让 coding agent 先看清现状，再决定动哪里',
    placeholder: 'github.com/owner/repo',
    focus: ['AI 可读性', '文档', '质量护栏'],
  },
  {
    key: 'compare',
    label: '两个项目比',
    hint: '哪个更值得抄，或者你和他差在哪',
    placeholder: 'github.com/owner/repo',
    focus: [],
  },
]

const scenario = ref('just-published')
const activeScenario = computed(() => SCENARIOS.find((s) => s.key === scenario.value) || SCENARIOS[0])

/** 该场景下最该先看的维度（按 focus 顺序，其余按原顺序补齐） */
const scenarioFocusDims = computed(() => {
  const focus = activeScenario.value.focus
  if (!focus.length) return []
  const all = sortedDims.value
  const picked = focus.map((name) => all.find((d) => d.name === name)).filter(Boolean)
  return picked
})

// ---------- state machine ----------
const stage = ref('idle') // idle | loading | report | error
const mode = ref('single') // single | compare —— 顶部 tab 控制
const input = ref('')
const parsedRepo = ref('') // owner/name
const report = ref(null)
const cached = ref(false)
const errorMsg = ref('')
const stats = ref({ total: 0, avg: 0 })
const trending = ref([])

const leaderboard = ref([])

// ---------- 对比模式 ----------
const inputA = ref('')
const inputB = ref('')
const compareReport = ref(null)
const compareCached = ref({ a: false, b: false })

function resetCompare() {
  inputA.value = ''
  inputB.value = ''
  compareReport.value = null
  compareCached.value = { a: false, b: false }
}

async function loadStats() {
  try {
    const res = await fetch('/api/scorecard/stats', { cache: 'no-store' })
    const j = await res.json().catch(() => ({}))
    stats.value = { total: j.total || 0, avg: j.avg || 0 }
  } catch {}
  try {
    const r = await fetch('/api/scorecard/trending', { cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    trending.value = (j.items || []).filter((t) => t.target && t.target.includes('/'))
  } catch {}
  try {
    const r = await fetch('/api/scorecard/leaderboard?limit=12', { cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    leaderboard.value = j.items || []
  } catch {}
}

// star 数缩写 —— 54218 在榜单里占太宽，挤掉项目名
function shortStars(n) {
  if (n == null) return '—'
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'
  return String(n)
}

// 九个维度各自在量什么。放在落地页上，是为了让人在输入之前就知道
// 「这个分数是怎么来的」—— 一个不解释判据的分数，不会有人当真。
const DIMENSION_GUIDE = [
  { name: '门面', q: 'description、topics、徽章有没有把「这是什么」说清楚' },
  { name: '分发', q: '陌生人能不能顺利装上：npm 包、release 产物、安装说明' },
  { name: '发布工程', q: 'semver tag、CHANGELOG、release 节奏' },
  { name: '质量护栏', q: 'CI 绿不绿、有没有测试与 lint' },
  { name: '社区卫生', q: 'CONTRIBUTING、issue 模板、老 issue 有没有人管' },
  { name: '文档', q: 'README 有没有快速开始、配置参考、故障排查' },
  { name: '安全', q: 'SECURITY.md、依赖治理、告警处理' },
  { name: '度量', q: 'star 增速、fork、流量趋势' },
  { name: 'AI 可读性', q: 'AI 爬虫与编码助手能否读懂：AGENTS.md / llms.txt / robots.txt 放行' }
]

// loading-stage 维度逐项打勾（server 是并发，所以这个是纯装饰动画，按 ~400ms 一档）
const loadingSteps = ref([
  { name: 'README 与 topics', done: false },
  { name: 'CI / workflows', done: false },
  { name: 'releases & tags', done: false },
  { name: 'Issues / PR 活跃度', done: false },
  { name: '社区配置（contributing / CoC）', done: false },
  { name: '安全与依赖治理', done: false },
  { name: 'Star 增速曲线', done: false },
  { name: 'AI 可读性（AGENTS.md / robots.txt）', done: false },
  { name: '加权汇总', done: false }
])
let loadingTimer = null

// ---------- 解析输入 ----------
function parseRepoInput(raw) {
  let s = (raw || '').trim()
  if (!s) return ''
  // 容错：去掉 https://github.com/ 前缀、尾部 /、.git
  s = s.replace(/^https?:\/\/github\.com\//i, '').replace(/^github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s
  // 只输了一个名字 —— 提示用户补全
  if (/^[\w.-]+$/.test(s)) return s + '/'
  return ''
}

const canSubmit = computed(() => {
  const r = parseRepoInput(input.value)
  return /^[\w.-]+\/[\w.-]+$/.test(r)
})

// 对比模式：两个目标形态必须一致（同 type）—— 防止用户拿 npm vs github 比
function inferredCompareType(s) {
  if (/^https?:\/\//i.test(s)) return 'page'
  if (/^(@[\w.-]+\/)?[\w.-]+$/.test(s)) return 'npm'
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return 'github'
  return null
}

const canSubmitCompare = computed(() => {
  const a = inputA.value.trim(), b = inputB.value.trim()
  if (!a || !b) return false
  const ta = inferredCompareType(a), tb = inferredCompareType(b)
  return ta && tb && ta === tb
})

// ---------- 进入 loading 动画 ----------
function startLoadingAnim() {
  loadingSteps.value.forEach((s) => (s.done = false))
  if (loadingTimer) clearInterval(loadingTimer)
  let i = 0
  loadingTimer = setInterval(() => {
    if (i < loadingSteps.value.length) {
      loadingSteps.value[i].done = true
      i++
    } else {
      clearInterval(loadingTimer)
      loadingTimer = null
    }
  }, 350)
}

// ---------- 真正调用 API ----------
async function generate() {
  const r = parseRepoInput(input.value)
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) return
  // 切回单目标模式时清掉对比模式的残留
  if (mode.value !== 'single') { mode.value = 'single'; resetCompare() }
  parsedRepo.value = r
  stage.value = 'loading'
  errorMsg.value = ''
  startLoadingAnim()

  // URL 同步进 hash，刷新能回来
  if (window.location.hash !== `#/report/${r}`) {
    history.replaceState(null, '', `#/report/${r}`)
  }

  try {
    const res = await fetch(`/api/scorecard?repo=${encodeURIComponent(r)}`, { cache: 'no-store' })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    // loading 动画走完再切到 report —— 即便服务端返回快也至少看到 1.5s 进度感
    setTimeout(() => {
      report.value = j.report
      cached.value = !!j.cached
      stage.value = 'report'
      // 复检历史与主报告并行拉，不阻塞渲染
      loadHistory(r)
    }, Math.max(0, 1600 - (loadingSteps.value.length * 350)))
  } catch (err) {
    errorMsg.value = err.message
    stage.value = 'error'
    if (loadingTimer) {
      clearInterval(loadingTimer)
      loadingTimer = null
    }
  }
}

// ---------- 复检历史 ----------
//
// 为什么要有它：整改清单告诉用户「该改什么」，但没有下一次对照，他就无法证明
// 「我改了有用」。这个项目最容易的失败方式就是变成一次性玩具 —— 算完就走，
// 再也不回来。history 接口给的是同一项目的历次评估，让「改完再跑一次」有意义。
const historyData = ref(null)
const historyLoading = ref(false)

async function loadHistory(target) {
  historyLoading.value = true
  historyData.value = null
  try {
    const res = await fetch(`/api/scorecard/history?target=${encodeURIComponent(target)}`, {
      cache: 'no-store',
    })
    const j = await res.json().catch(() => ({}))
    // 404 / 无历史都算正常情况，不当错误抛给用户看
    if (res.ok && j && j.points) historyData.value = j
  } catch {
    /* 拿不到历史不该影响主流程 */
  } finally {
    historyLoading.value = false
  }
}

/** 有过两次以上评估才谈得上「变化」 */
const historyDelta = computed(() => {
  const h = historyData.value
  if (!h || h.runs < 2 || h.totalDelta == null) return null
  return h.totalDelta
})

const historyChanges = computed(() => {
  const h = historyData.value
  if (!h || !Array.isArray(h.changes) || !h.changes.length) return []
  return h.changes.slice(0, 5)
})

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日`
}


function reset() {
  stage.value = 'idle'
  report.value = null
  input.value = ''
  history.replaceState(null, '', '#/report')
}

// ---------- 对比模式：真正调用 ----------
async function generateCompare() {
  if (!canSubmitCompare.value) return
  const a = inputA.value.trim()
  const b = inputB.value.trim()
  const type = inferredCompareType(a) || inferredCompareType(b)
  if (!type) { errorMsg.value = '无法识别两个目标的类型'; stage.value = 'error'; return }
  stage.value = 'loading'
  errorMsg.value = ''
  startLoadingAnim()

  try {
    const res = await fetch(`/api/scorecard/compare?type=${type}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, { cache: 'no-store' })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    compareReport.value = j
    compareCached.value = j.cached || { a: false, b: false }
    setTimeout(() => {
      stage.value = 'report'
    }, Math.max(0, 1600 - (loadingSteps.value.length * 350)))
  } catch (err) {
    errorMsg.value = err.message
    stage.value = 'error'
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null }
  }
}

function exitCompare() {
  stage.value = 'idle'
  resetCompare()
  history.replaceState(null, '', '#/report')
}

// 对比 Markdown 复制 —— 复用 /api/scorecard/compare.md
async function copyCompareMarkdown() {
  if (!compareReport.value) return
  const { a, b, type } = compareReport.value
  shareBusy.value = true
  shareMsg.value = '📝 正在生成对比 Markdown…'
  try {
    const res = await fetch(`/api/scorecard/compare.md?type=${type}&a=${encodeURIComponent(a.project)}&b=${encodeURIComponent(b.project)}`, {
      headers: { 'X-Visitor-Id': getVisitorId() },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`)
    const md = await res.text()
    await navigator.clipboard.writeText(md)
    shareMsg.value = '✅ 对比 Markdown 已复制'
    logShare('compare-copy-markdown')
  } catch (err) {
    shareMsg.value = `❌ ${err.message} —— 已在新标签打开`
    window.open(`/api/scorecard/compare.md?type=${compareReport.value.type}&a=${encodeURIComponent(compareReport.value.a.project)}&b=${encodeURIComponent(compareReport.value.b.project)}`, '_blank')
  } finally {
    shareBusy.value = false
    setTimeout(() => (shareMsg.value = ''), 3200)
  }
}

/**
 * 生成可分享的对比 URL。
 * 走 ?share=&compare=&type= 而不是 hash，IM 里贴更短、SEO / OG 也更好认。
 */
function compareShareUrl() {
  if (!compareReport.value) return ''
  const { a, b, type } = compareReport.value
  // 类型推断与生成时同源 —— 否则生成的链接前端一加载就跑错
  const inferred = inferredCompareType(a.project) || inferredCompareType(b.project) || type
  const qs = new URLSearchParams({
    share: a.project,
    compare: b.project,
    ...(inferred ? { type: inferred } : {}),
  }).toString()
  return `${window.location.origin}/?${qs}`
}

async function copyCompareLink() {
  const url = compareShareUrl()
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    shareMsg.value = '✅ 对比链接已复制 —— 粘贴到 IM 即可分享'
    logShare('compare-copy-link')
  } catch {
    shareMsg.value = '❌ 复制失败 —— 已选中可手动复制'
  }
  setTimeout(() => (shareMsg.value = ''), 2200)
}

// ---------- 雷达图 / 维度条 ----------
const DIMS_MAX = 10

// 只有拿到证据的维度才进雷达图。把「判不了」当 0 画，图上会凹一个缺口，
// 看起来像这一维很差 —— 而事实是我们没量到，不该用图形暗示一个结论。
const scoredDims = computed(() => (report.value?.dims || []).filter((d) => d.score != null))

const radarPolygon = computed(() => {
  const n = scoredDims.value.length
  if (!n) return ''
  const cx = 110, cy = 110, r = 88
  return scoredDims.value
    .map((d, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
      const rr = (d.score / DIMS_MAX) * r
      const x = cx + Math.cos(angle) * rr
      const y = cy + Math.sin(angle) * rr
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})

const radarAxes = computed(() => {
  const n = scoredDims.value.length
  if (!n) return []
  const cx = 110, cy = 110, r = 88
  return scoredDims.value.map((d, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      label: d.name
    }
  })
})

// ---------- 九维明细的展开态 ----------
//
// 低分维度自动展开是有意的产品决策（一眼看到最该补的地方），但不能因此变成
// 「关不掉」：`:open` 是 Vue 的 prop，父级每次 re-render 都会把它写回 DOM，
// 用户手动收起的状态不在 vnode 里，于是被覆盖 —— 表现就是「进得去出不来」。
//
// 解法：一旦用户碰过某个维度，就把「要不要展开」的裁决权从 `:open` 表达式
// 移交给状态，且**不再渲染 open 属性**（见模板处说明）。
const dimOpenState = ref(new Map()) // name -> boolean，只存用户明确表过态的维度

/** 用户是否已经手动表过态 —— 表过态就不再让 Vue 写 open 属性 */
function dimKnown(d) {
  return dimOpenState.value.has(d.name)
}

/** 用户表过态就以用户为准；没表过态则低分（<6）且可判定者默认展开 */
function isDimOpen(d) {
  if (dimOpenState.value.has(d.name)) return dimOpenState.value.get(d.name)
  return d.score != null && d.score < 6
}

function onDimToggle(d, e) {
  const open = e.target.open
  // 与当前判定一致 → 是 Vue patch 回写 DOM 触发的 toggle，不是用户手势
  if (open === isDimOpen(d)) return

  const states = new Map(dimOpenState.value)
  states.set(d.name, open)
  dimOpenState.value = states
}

function bandColor(score) {
  if (score >= 9) return '#7d9d8c' // --score-top
  if (score >= 6) return '#7c94ad' // --score-ok
  if (score >= 3) return '#c4a47c' // --score-warn
  return '#b08585'                 // --score-bad
}
function bandLabel(score) {
  if (score >= 9) return '⭐ 卓越'
  if (score >= 6) return '✓ 工程健康'
  if (score >= 3) return '⚠️ 待补强'
  return '✕ 起步阶段'
}

// 排序表：有结论的按分数升序在前，判不了的沉到最后
const sortedDims = computed(() => {
  const all = report.value?.dims || []
  const scored = all.filter((d) => d.score != null).sort((a, b) => a.score - b.score)
  const unknown = all.filter((d) => d.score == null)
  return [...scored, ...unknown]
})
const strengths = computed(() => sortedDims.value.filter((d) => d.score != null && d.score >= 8).reverse().slice(0, 2))
const improvements = computed(() => sortedDims.value.filter((d) => d.score != null && d.score < 6).slice(0, 2))
const prioritizedTodos = computed(() => report.value?.todos || [])

// ---------- 分享 ----------
const shareBusy = ref(false)
const shareMsg = ref('')
const cardRef = ref(null)

function logShare(kind) {
  // 上报一个 ops 记录，方便看传播数据
  fetch('/api/ops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': getVisitorId() },
    body: JSON.stringify({
      action: 'scorecard.share',
      target: parsedRepo.value,
      detail: kind,
      ts: new Date().toISOString()
    })
  }).catch(() => {})
}

function getVisitorId() {
  let id = localStorage.getItem('scorecard:visitor-id')
  if (!id) {
    id = 'v-' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem('scorecard:visitor-id', id)
  }
  return id
}

async function copyShareLink() {
  const url = window.location.origin + '/#/report/' + parsedRepo.value
  try {
    await navigator.clipboard.writeText(url)
    shareMsg.value = '✅ 链接已复制'
    logShare('copy-link')
  } catch {
    shareMsg.value = '❌ 复制失败，请手动复制地址栏 URL'
  }
  setTimeout(() => (shareMsg.value = ''), 2200)
}

// ---------- Agent 接入 ----------
//
// 第一用户是 coding agent，所以「让 agent 自己会用」的入口必须显眼。
// 但刻意不给「一键安装」按钮：各家 agent 的 skills 目录与加载机制都不一样，
// 往磁盘写文件的猜测一旦错了，比不装更糟。这里给命令、让用户自己决定。
const siteUrl = computed(() => (location.protocol === 'https:' ? 'https://' : '') + SITE_HOST)
const skillInstallCmd = computed(() => `curl -sL ${siteUrl.value}/skill.md -o <skills目录>/project-maturity-audit/SKILL.md`)
const skillCopied = ref(false)

async function copySkillCmd() {
  try {
    await navigator.clipboard.writeText(skillInstallCmd.value)
    skillCopied.value = true
    setTimeout(() => (skillCopied.value = false), 1800)
  } catch {
    shareMsg.value = '❌ 复制失败，请手动选中上面的命令'
    setTimeout(() => (shareMsg.value = ''), 2400)
  }
}

// 复制 Markdown 报告 —— 主要的分享形态。
//
// 服务端 /api/scorecard/report.md 直接吐一份写给 AI 助手看的报告：
// 记分卡 + 按影响排序的整改清单 + 逐维度证据 + 一段可照抄的指令。
// 拿到就能粘进 Claude Code / Cursor 让它照着改 —— 比一张长图能做的事多得多。
async function copyMarkdown() {
  if (!parsedRepo.value) return
  shareBusy.value = true
  shareMsg.value = '📝 正在生成 Markdown 报告…'
  try {
    const res = await fetch(`/api/scorecard/report.md?repo=${encodeURIComponent(parsedRepo.value)}`, {
      headers: { 'X-Visitor-Id': getVisitorId() },
      cache: 'no-store'
    })
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`)
    const md = await res.text()
    await navigator.clipboard.writeText(md)
    shareMsg.value = '✅ Markdown 已复制 —— 直接粘给 AI，让它照着改'
    logShare('copy-markdown')
  } catch (err) {
    // 剪贴板在非 https / 无权限时会失败，这时把报告开在新标签页让人手动复制
    shareMsg.value = `❌ ${err.message} —— 已在新标签打开，可手动复制`
    window.open(`/api/scorecard/report.md?repo=${encodeURIComponent(parsedRepo.value)}`, '_blank')
  } finally {
    shareBusy.value = false
    setTimeout(() => (shareMsg.value = ''), 3200)
  }
}

// 下载成 .md 文件 —— 有人习惯存档或丢进仓库当 issue 附件
async function downloadMarkdown() {
  if (!parsedRepo.value) return
  try {
    const res = await fetch(`/api/scorecard/report.md?repo=${encodeURIComponent(parsedRepo.value)}`, {
      headers: { 'X-Visitor-Id': getVisitorId() }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = await res.text()
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${BRAND_SLUG}-${parsedRepo.value.replace('/', '-')}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    shareMsg.value = '✅ 报告已下载'
    logShare('download-markdown')
  } catch (err) {
    shareMsg.value = `❌ ${err.message}`
  }
  setTimeout(() => (shareMsg.value = ''), 2500)
}

// ---------- 初始化 ----------
onMounted(() => {
  loadStats()
  // 单目标分享：#/report/<repo>
  if (props.initialRepo && /\/[\w.-]+/.test(props.initialRepo)) {
    input.value = props.initialRepo
    generate()
  }
  // 对比分享：?share=X&compare=Y&type=Z —— 直接进对比模式并跑
  if (props.initialCompare && props.initialCompare.a && props.initialCompare.b) {
    mode.value = 'compare'
    inputA.value = props.initialCompare.a
    inputB.value = props.initialCompare.b
    generateCompare()
  }
})
</script>

<template>
  <section class="sc-wrap">
    <!-- ========================================================== -->
    <!--  IDLE: hero 输入态                                          -->
    <!-- ========================================================== -->
    <div v-if="stage === 'idle'" class="sc-hero">
      <div class="sc-eyebrow">
        <Icon name="brand" :size="14" /> {{ BRAND_MARK }}
      </div>
      <h1 class="sc-h1">
        你的开源项目<br>
        <span class="grad">几秒钟</span>就能拿到 9 维度质检报告
      </h1>
      <p class="sc-sub">
        粘一个 GitHub URL —— 九维度雷达图 + 整改清单 + 一份可直接喂给 AI 的 Markdown 报告。
        免登录，公开仓库无 token 也能跑。
      </p>

      <!-- GEO 入口：独立路由，不占上面的单/对比两个 tab —— 它的表单形态完全不同 -->
      <button class="sc-geo-entry" type="button" @click="location.hash = '#/geo'">
        <Icon name="eye" :size="15" />
        <span class="sc-geo-entry-main">
          <strong>测品牌的 AI 可见性</strong>
          <em>GEO · 别人问 ChatGPT「XX 类产品有哪些」时，你在不在答案里</em>
        </span>
        <Icon name="arrow-right" :size="15" />
      </button>

      <!-- 场景选择：先说「你是谁、要干嘛」，再说输入框。
           不新增功能，只是把同一套判据按用户当下的问题重排先后。 -->
      <div class="sc-scenarios" role="radiogroup" aria-label="选择你的场景">
        <button
          v-for="s in SCENARIOS"
          :key="s.key"
          class="sc-scenario"
          :class="{ active: scenario === s.key }"
          type="button"
          role="radio"
          :aria-checked="scenario === s.key"
          @click="scenario = s.key; if (s.key === 'compare') mode = 'compare'; else if (mode === 'compare') mode = 'single'"
        >
          <span class="sc-scenario-label">{{ s.label }}</span>
          <span class="sc-scenario-hint">{{ s.hint }}</span>
        </button>
      </div>

      <!-- 模式 tab：单目标 vs 对比 -->
      <div class="sc-mode-tabs">
        <button
          class="sc-mode-tab"
          :class="{ active: mode === 'single' }"
          @click="mode = 'single'; scenario = 'just-published'; resetCompare()"
          type="button"
        >单目标质检</button>
        <button
          class="sc-mode-tab"
          :class="{ active: mode === 'compare' }"
          @click="mode = 'compare'; scenario = 'compare'; input = ''"
          type="button"
        >对比</button>
        <span class="sc-mode-hint" v-if="mode === 'compare'">A vs B，比如测试 env ↔ 线上 env</span>
      </div>

      <form v-if="mode === 'single'" class="sc-form" @submit.prevent="generate">
        <div class="sc-input-wrap">
          <Icon name="link" :size="16" class="sc-input-icon" />
          <input
            v-model="input"
            class="sc-input"
            type="text"
            placeholder="github.com/owner/repo  ·  npm 包名  ·  https://example.com"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter.prevent="generate"
          />          <button class="btn primary sc-go" :disabled="!canSubmit" type="submit">
            <Icon name="search" :size="14" />
            <span>查一下</span>
          </button>
        </div>
      </form>

      <form v-else class="sc-form sc-form-compare" @submit.prevent="generateCompare">
        <div class="sc-compare-pair">
          <div class="sc-input-wrap">
            <span class="sc-side-tag a">A</span>
            <input
              v-model="inputA"
              class="sc-input"
              type="text"
              placeholder="测试 env（如 https://staging.example.com）"
              spellcheck="false"
              autocomplete="off"
              @keydown.enter.prevent="generateCompare"
            />
          </div>
          <span class="sc-vs">↔</span>
          <div class="sc-input-wrap">
            <span class="sc-side-tag b">B</span>
            <input
              v-model="inputB"
              class="sc-input"
              type="text"
              placeholder="线上 env（如 https://example.com）"
              spellcheck="false"
              autocomplete="off"
              @keydown.enter.prevent="generateCompare"
            />
          </div>
          <button class="btn primary sc-go" :disabled="!canSubmitCompare" type="submit">
            <Icon name="compare" :size="14" />
            <span>对比</span>
          </button>
        </div>
      </form>

      <div class="sc-chips">
        <span class="muted">试一下：</span>
        <button class="sc-chip" @click="input = 'webkubor/typora-Bloom-theme'; generate()">webkubor/typora-Bloom-theme</button>
        <button class="sc-chip" @click="input = 'vitejs/vite'; generate()">vitejs/vite</button>
        <button class="sc-chip" @click="input = 'denoland/deno'; generate()">denoland/deno</button>
      </div>

      <div class="sc-trust">
        <span class="sc-trust-dot" />
        <span>共查过 <b>{{ stats.total || '—' }}</b> 次 · 平均分 <b>{{ stats.avg || '—' }}</b></span>
        <span class="muted">·  标准与 <a href="https://github.com/webkubor/scorecard/tree/main/skills/project-maturity-audit" target="_blank" rel="noopener">project-maturity-audit</a> 同源</span>
      </div>

      <!-- 参照榜 —— 一个孤零零的分数没有意义，得有标尺。
           放一批人人都认识的项目，让人看到「vite 6.6、我的 4.2」这个差距是具体的。 -->
      <section v-if="leaderboard.length" class="sc-board">
        <header class="sc-board-head">
          <h2 class="sc-board-title">
            <Icon name="star" :size="14" />
            <span>知名项目参照榜</span>
          </h2>
          <p class="sc-board-sub">同一套九维标准跑出来的分数 —— 点任意一行看它的完整报告</p>
        </header>

        <ol class="sc-board-list">
          <li
            v-for="(p, i) in leaderboard"
            :key="p.projectId"
            class="sc-board-row"
            :class="{ top: i < 3 }"
          >
            <button class="sc-board-btn" @click="input = p.projectId; generate()">
              <span class="sc-rank">{{ i + 1 }}</span>
              <span class="sc-board-name"><code>{{ p.projectId }}</code></span>
              <span class="sc-board-bar">
                <span
                  class="sc-board-bar-fill"
                  :style="{ width: (p.score / 10 * 100) + '%', background: bandColor(p.score) }"
                />
              </span>
              <span class="sc-board-score" :style="{ color: bandColor(p.score) }">{{ p.score }}</span>
              <span class="sc-board-stars">{{ shortStars(p.stars) }}★</span>
            </button>
          </li>
        </ol>
      </section>

      <!-- 九维说明 —— 不解释判据的分数没人会当真 -->
      <section class="sc-dims-guide">
        <h2 class="sc-board-title">
          <Icon name="check" :size="14" />
          <span>九个维度分别在量什么</span>
        </h2>
        <div class="sc-dims-grid">
          <div v-for="d in DIMENSION_GUIDE" :key="d.name" class="sc-dim-card">
            <div class="sc-dim-card-name">{{ d.name }}</div>
            <div class="sc-dim-card-q">{{ d.q }}</div>
          </div>
        </div>
        <p class="sc-dims-note">
          每一维只看客观证据 —— API 拿得到、文件在不在、状态码是多少。
          「10 秒能不能看懂 README」这类主观项判不了，报告里会标出来交给 AI 或人。
        </p>
      </section>

      <!-- 今日热门 —— 社会证明 -->
      <div v-if="trending.length" class="sc-trending">
        <div class="sc-trending-head">
          <Icon name="fire" :size="13" />
          <span>近 24h 大家在查</span>
        </div>
        <div class="sc-trending-list">
          <button
            v-for="t in trending"
            :key="t.target"
            class="sc-trending-chip"
            @click="input = t.target; generate()"
          >
            <code>{{ t.target }}</code>
            <span class="sc-trending-hits">{{ t.hits }} 次</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ========================================================== -->
    <!--  LOADING: 维度逐项打勾                                       -->
    <!-- ========================================================== -->
    <div v-else-if="stage === 'loading'" class="sc-loading">
      <h2 class="sc-h2">{{ parsedRepo }}</h2>
      <p class="sc-sub">正在调用 GitHub 拉数据…</p>
      <ul class="sc-steps">
        <li v-for="(s, i) in loadingSteps" :key="i" :class="{ done: s.done }">
          <span class="sc-step-icon">
            <Icon v-if="s.done" name="check" :size="11" />
            <span v-else>{{ i + 1 }}</span>
          </span>
          {{ s.name }}
        </li>
      </ul>
    </div>

    <!-- ========================================================== -->
    <!--  ERROR                                                      -->
    <!-- ========================================================== -->
    <div v-else-if="stage === 'error'" class="sc-loading">
      <h2 class="sc-h2"><Icon name="cross" :size="16" class="sc-err-icon" /> {{ errorMsg }}</h2>
      <p class="sc-sub">可能是仓库不存在、token 私有，或 GitHub 限速中。</p>
      <button class="btn primary" @click="reset">重新输入</button>
    </div>

    <!-- ========================================================== -->
    <!--  REPORT: 对比模式（diff 视图）                                 -->
    <!-- ========================================================== -->
    <div v-else-if="stage === 'report' && compareReport && compareReport.diff" class="sc-report sc-report-compare">
      <div class="sc-card">
        <div class="sc-card-head">
          <div class="sc-brand"><Icon name="brand" :size="16" /> {{ BRAND_MARK }}</div>
          <button class="btn ghost" @click="exitCompare">← 退出对比</button>
        </div>

        <div class="sc-compare-head">
          <div class="sc-compare-side a">
            <div class="sc-side-tag big a">A</div>
            <div class="sc-compare-project">{{ compareReport.a.project }}</div>
            <div class="sc-compare-score" :style="{ color: bandColor(compareReport.a.score) }">
              {{ compareReport.a.score }}<span class="sc-score-unit">/10</span>
            </div>
            <div class="sc-compare-band" :style="{ color: bandColor(compareReport.a.score) }">{{ compareReport.a.band }}</div>
            <div class="muted" v-if="compareCached.a">(缓存)</div>
          </div>
          <div class="sc-compare-vs">
            <div class="sc-compare-delta" :class="{ neg: compareReport.diff.totalDelta < 0 }">
              Δ = {{ compareReport.diff.totalDelta > 0 ? '+' : '' }}{{ compareReport.diff.totalDelta }}
            </div>
            <div class="muted">
              {{ compareReport.diff.totalDelta > 0 ? 'B 领先' : compareReport.diff.totalDelta < 0 ? 'B 落后' : '持平' }}
            </div>
            <div class="muted sc-compare-summary">
              A 独有 {{ compareReport.diff.summary.aOnlyGaps }} · B 独有 {{ compareReport.diff.summary.bOnlyGaps }}
            </div>
          </div>
          <div class="sc-compare-side b">
            <div class="sc-side-tag big b">B</div>
            <div class="sc-compare-project">{{ compareReport.b.project }}</div>
            <div class="sc-compare-score" :style="{ color: bandColor(compareReport.b.score) }">
              {{ compareReport.b.score }}<span class="sc-score-unit">/10</span>
            </div>
            <div class="sc-compare-band" :style="{ color: bandColor(compareReport.b.score) }">{{ compareReport.b.band }}</div>
            <div class="muted" v-if="compareCached.b">(缓存)</div>
          </div>
        </div>

        <div class="sc-compare-dims">
          <div class="sc-compare-dim-row" v-for="d in compareReport.diff.dims" :key="d.key">
            <div class="sc-compare-dim-name">{{ d.name }}</div>
            <div class="sc-compare-bar a">
              <span class="sc-compare-bar-fill" :style="{ width: ((d.aScore || 0) * 10) + '%', background: bandColor(d.aScore || 0) }" />
              <span class="sc-compare-bar-num">{{ d.aScore ?? '—' }}</span>
            </div>
            <div class="sc-compare-dim-vs">
              <span :class="['sc-compare-winner', d.winner]">{{ d.winner === 'a' ? '🅰️' : d.winner === 'b' ? '🅱️' : '🤝' }}</span>
              <span class="sc-compare-delta-num" :class="{ neg: d.delta < 0 }">{{ d.delta > 0 ? '+' : '' }}{{ d.delta }}</span>
            </div>
            <div class="sc-compare-bar b">
              <span class="sc-compare-bar-num">{{ d.bScore ?? '—' }}</span>
              <span class="sc-compare-bar-fill" :style="{ width: ((d.bScore || 0) * 10) + '%', background: bandColor(d.bScore || 0) }" />
            </div>
          </div>
        </div>

        <!-- B 独有、A 还没补的（这是 A 该立刻做的） -->
        <div v-if="compareReport.diff.dims.some(d => d.uniqueGaps?.b?.length)" class="sc-compare-actionable">
          <h3 class="sc-compare-section-title">A → B 还要补的（补上即追上 B）</h3>
          <ul class="sc-compare-gap-list">
            <li v-for="d in compareReport.diff.dims" :key="d.key + '-b'">
              <template v-for="g in d.uniqueGaps.b" :key="d.key + g">
                <span class="sc-compare-dim-tag" :style="{ borderColor: bandColor(d.aScore || 0) }">{{ d.name }}</span>
                <span>{{ g }}</span>
              </template>
            </li>
          </ul>
        </div>

        <!-- A 独有、B 还没补的 -->
        <div v-if="compareReport.diff.dims.some(d => d.uniqueGaps?.a?.length)" class="sc-compare-actionable">
          <h3 class="sc-compare-section-title">B → A 还要补的</h3>
          <ul class="sc-compare-gap-list">
            <li v-for="d in compareReport.diff.dims" :key="d.key + '-a'">
              <template v-for="g in d.uniqueGaps.a" :key="d.key + g">
                <span class="sc-compare-dim-tag" :style="{ borderColor: bandColor(d.bScore || 0) }">{{ d.name }}</span>
                <span>{{ g }}</span>
              </template>
            </li>
          </ul>
        </div>

        <div class="sc-compare-actions">
          <button class="btn primary" :disabled="shareBusy" @click="copyCompareMarkdown">
            <Icon name="copy" :size="14" />
            <span>复制对比 Markdown</span>
          </button>
          <button class="btn" @click="copyCompareLink">
            <Icon name="link" :size="14" />
            <span>复制对比链接</span>
          </button>
          <span class="muted" v-if="shareMsg">{{ shareMsg }}</span>
        </div>
      </div>
    </div>

    <!-- ========================================================== -->
    <!--  REPORT: 单目标雷达图 + 维度明细 + Markdown 导出                -->
    <!-- ========================================================== -->
    <div v-else-if="stage === 'report' && report" class="sc-report">
      <!-- 报告卡片 -->
      <div ref="cardRef" class="sc-card">
        <div class="sc-card-head">
          <div class="sc-brand"><Icon name="brand" :size="16" /> {{ BRAND_MARK }}</div>
          <div class="muted" v-if="cached">缓存结果</div>
        </div>

        <div class="sc-card-hero">
          <div class="sc-repo-name">{{ parsedRepo }}</div>
          <div class="sc-score-row">
            <div class="sc-big-score" :style="{ color: bandColor(report.score) }">
              {{ report.score }}<span class="sc-score-unit">/10</span>
            </div>
            <div class="sc-band" :style="{ color: bandColor(report.score) }">
              {{ bandLabel(report.score) }}
            </div>
            <div class="sc-stars muted">
              <Icon name="star" :size="13" /> {{ report.stars || 0 }} stars
              · 类型 {{ report.type }}
            </div>
            <!-- 有维度没量到就得说清楚：否则这个分数看起来像九维都核实过 -->
            <div v-if="report.scoredCount && report.scoredCount < 9" class="sc-partial-note">
              按 {{ report.scoredCount }}/9 维平均
              <span v-if="report.inconclusiveDims?.length">
                · {{ report.inconclusiveDims.join('、') }}读不到判据，未计入
              </span>
            </div>
          </div>
        </div>

        <!-- 雷达图（纯 SVG） -->
        <div class="sc-radar-wrap">
          <svg viewBox="0 0 220 220" class="sc-radar" aria-label="9维度雷达图">
            <!-- 同心圆刻度 -->
            <circle cx="110" cy="110" r="22" class="sc-radar-grid"/>
            <circle cx="110" cy="110" r="44" class="sc-radar-grid"/>
            <circle cx="110" cy="110" r="66" class="sc-radar-grid"/>
            <circle cx="110" cy="110" r="88" class="sc-radar-grid"/>

            <!-- 轴线 -->
            <line v-for="(a, i) in radarAxes" :key="i"
              x1="110" y1="110" :x2="a.x" :y2="a.y"
              class="sc-radar-axis" />

            <!-- 数据多边形 -->
            <polygon :points="radarPolygon" class="sc-radar-shape" />

            <!-- 数据点 -->
            <circle v-for="(d, i) in report.dims" :key="`pt-${i}`"
              :cx="110 + Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / scoredDims.length) * (d.score / DIMS_MAX) * 88"
              :cy="110 + Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / scoredDims.length) * (d.score / DIMS_MAX) * 88"
              r="2.5" class="sc-radar-pt" />

            <!-- 维度标签 -->
            <text v-for="(a, i) in radarAxes" :key="`tx-${i}`"
              :x="a.x" :y="a.y" text-anchor="middle"
              :dy="a.y < 110 ? -4 : a.y > 110 ? 12 : 4"
              class="sc-radar-label">{{ a.label }}</text>
          </svg>
        </div>

        <!-- 维度条形 -->
        <div class="sc-dims">
          <div
            v-for="d in sortedDims"
            :key="d.name"
            class="sc-dim-row"
            :class="{ unknown: d.score == null }"
            :title="d.score == null
              ? '本引擎读不到这一维的判据，未计入总分'
              : (d.unverifiable ? `其中 ${d.unverifiable} 分的判据核实不了，已从该维满分中剔除` : '')"
          >
            <span class="sc-dim-name">{{ d.name }}</span>
            <!-- 判不了的维度画一条虚线槽，不画填充 —— 填 0 会被读成「这维得 0 分」 -->
            <div class="sc-bar">
              <i
                v-if="d.score != null"
                :style="{ width: (d.score * 10) + '%', background: bandColor(d.score) }"
              />
            </div>
            <span
              v-if="d.score != null"
              class="sc-dim-score"
              :style="{ color: bandColor(d.score) }"
            >{{ d.score }}<em v-if="d.unverifiable" class="sc-dim-partial">*</em></span>
            <span v-else class="sc-dim-score sc-dim-unknown">判不了</span>
          </div>
        </div>

        <!-- 卡片页脚 -->
        <div class="sc-card-foot">
          <span>用 {{ BRAND }} 测你的开源项目 → </span>
          <span class="sc-card-link">{{ window?.location?.origin || SITE_HOST }}/#/report</span>
        </div>
      </div>

      <!-- 文案摘要（不截图） -->
      <div class="sc-summary">
        <div class="sc-summary-section">
          <h3 class="sc-summary-title">
            <Icon name="star" :size="14" class="sc-summary-icon ok" /> 你的强项
          </h3>
          <ul v-if="strengths.length">
            <li v-for="s in strengths" :key="s.name"><strong>{{ s.name }}</strong>：{{ (s.evidence[0] || '表现不错').slice(0, 60) }}</li>
          </ul>
          <p v-else class="muted">暂无突出维度，继续打磨。</p>
        </div>
        <div class="sc-summary-section">
          <h3 class="sc-summary-title">
            <Icon name="warning" :size="14" class="sc-summary-icon warn" /> 下一步该
          </h3>
          <ul v-if="improvements.length">
            <li v-for="d in improvements" :key="d.name">
              <strong>{{ d.name }}</strong>：{{ d.gaps[0] || '待补' }}
            </li>
          </ul>
          <p v-else class="muted">所有维度都 ≥ 6，棒。</p>
        </div>
      </div>

      <!-- 复检对照：同一个项目上次 vs 这次。第一次看没有这一块（没有「上次」）。 -->
      <section
        v-if="historyDelta !== null || historyChanges.length"
        class="sc-recheck"
        aria-labelledby="sc-recheck-title"
      >
        <div class="sc-findings-head">
          <div>
            <p class="sc-section-kicker">复检对照</p>
            <h3 id="sc-recheck-title">
              距上次
              <template v-if="historyData?.previous">{{ fmtDate(historyData.previous.ts) }}</template>
              <span
                v-if="historyDelta !== null"
                class="sc-recheck-delta"
                :class="historyDelta > 0 ? 'up' : historyDelta < 0 ? 'down' : 'flat'"
              >{{ historyDelta > 0 ? '+' : '' }}{{ historyDelta }}</span>
            </h3>
          </div>
          <span class="muted">改完再跑一次，就能看到这里动起来</span>
        </div>
        <ul v-if="historyChanges.length" class="sc-recheck-list">
          <li v-for="c in historyChanges" :key="c.key" class="sc-recheck-item">
            <span class="sc-recheck-dim">{{ c.name }}</span>
            <span class="sc-recheck-nums">{{ c.from }} → {{ c.to }}</span>
            <span class="sc-recheck-delta" :class="c.delta > 0 ? 'up' : 'down'">{{ c.delta > 0 ? '+' : '' }}{{ c.delta }}</span>
          </li>
        </ul>
      </section>

      <!-- 结果不能只存在于 Markdown 里。先让人看清要改什么，再决定要不要交给 AI。 -->
      <section class="sc-findings" aria-labelledby="sc-findings-title">
        <div class="sc-findings-head">
          <div>
            <p class="sc-section-kicker">优先处理</p>
            <h3 id="sc-findings-title">整改清单</h3>
          </div>
          <span class="sc-findings-count">{{ prioritizedTodos.length }} 项</span>
        </div>
        <ol v-if="prioritizedTodos.length" class="sc-todo-list">
          <li v-for="todo in prioritizedTodos" :key="`${todo.dim}-${todo.text}`" class="sc-todo-item">
            <span class="sc-todo-dim">{{ todo.dim }} · {{ todo.dimScore }}/10</span>
            <span>{{ todo.text }}</span>
          </li>
        </ol>
        <p v-else class="muted">当前已没有可自动判定的整改项。</p>
      </section>

      <section class="sc-evidence" aria-labelledby="sc-evidence-title">
        <div class="sc-findings-head">
          <div>
            <p class="sc-section-kicker">核验依据</p>
            <h3 id="sc-evidence-title">九维明细</h3>
          </div>
          <span class="muted">展开查看每项依据</span>
        </div>
        <!--
          展开态：`:open` 只在「用户还没表过态」时渲染。
          用户一旦手动开合过，就改为 null（Vue 不再写这个属性），此后由浏览器
          自己持有展开状态 —— 否则 Vue 每次 patch 都会把旧的判定值写回去，
          用户点了收不起来，就是「进得去出不来」那个 bug。
        -->
        <details
          v-for="d in sortedDims"
          :key="`evidence-${d.name}`"
          class="sc-evidence-item"
          :data-dim="d.name"
          :open="dimKnown(d) ? null : isDimOpen(d)"
          @toggle="(e) => onDimToggle(d, e)"
        >
          <summary>
            <span>{{ d.name }}</span>
            <span v-if="d.score != null" class="sc-evidence-score" :style="{ color: bandColor(d.score) }">{{ d.score }}/10</span>
            <span v-else class="sc-dim-unknown">判不了</span>
          </summary>
          <div class="sc-evidence-body">
            <div v-if="d.evidence?.length" class="sc-evidence-column">
              <h4>已验证</h4>
              <ul><li v-for="item in d.evidence" :key="item">{{ item }}</li></ul>
            </div>
            <div v-if="d.gaps?.length" class="sc-evidence-column is-gap">
              <h4>待补</h4>
              <ul><li v-for="item in d.gaps" :key="item">{{ item }}</li></ul>
            </div>
            <div v-if="d.manual?.length" class="sc-evidence-column">
              <h4>需要人工核验</h4>
              <ul><li v-for="item in d.manual" :key="item">{{ item }}</li></ul>
            </div>
          </div>
        </details>
      </section>

      <!-- 操作条 -->
      <div class="sc-share">
        <!-- Markdown 是后续交给 AI 的格式，不再承担「把结果展示给人」的职责。 -->
        <button class="btn primary" :disabled="shareBusy" @click="copyMarkdown">
          <Icon name="copy" :size="13" /> 交给 AI 修复（复制 Markdown）
        </button>
        <button class="btn" :disabled="shareBusy" @click="downloadMarkdown">
          <Icon name="download" :size="13" /> 下载 .md
        </button>
        <button class="btn ghost" @click="copyShareLink">
          <Icon name="link" :size="13" /> 复制链接
        </button>
        <a class="btn ghost" :href="`https://github.com/${parsedRepo}`" target="_blank" rel="noopener">
          <Icon name="github" :size="13" /> 在 GitHub 打开
        </a>
        <button class="btn ghost" @click="reset">换一个</button>
        <span v-if="shareMsg" class="sc-share-msg">{{ shareMsg }}</span>
      </div>

      <!-- Agent 接入：这是给 agent 的入口，不是给人看的说明。
           第一用户是 coding agent，所以「怎么让它自己会用」必须比「怎么让人看懂」更显眼。 -->
      <section class="sc-agent-entry" aria-labelledby="sc-agent-title">
        <div class="sc-agent-head">
          <p class="sc-section-kicker">Agent 接入</p>
          <h3 id="sc-agent-title">让 coding agent 自己会用这套判据</h3>
          <p class="sc-agent-desc">
            同一套九维判据另有一份 skill 形态，agent 装上之后就能按它审查仓库 ——
            和网页端分数同源，不会两套标准。
          </p>
        </div>
        <div class="sc-agent-cmd">
          <code>{{ skillInstallCmd }}</code>
          <button class="btn ghost sc-agent-copy" @click="copySkillCmd">
            <Icon name="copy" :size="13" /> {{ skillCopied ? '已复制' : '复制' }}
          </button>
        </div>
        <p class="sc-agent-foot muted">
          也可以直接给 agent 这个地址，让它自己取：<code>{{ siteUrl }}/skill.md</code>
        </p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.sc-wrap {
  max-width: 880px;
  margin: 0 auto;
  padding: 28px 16px;
}

/* ---------- HERO ---------- */
.sc-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 1.2px;
  color: var(--accent);
  background: rgba(124, 148, 173, 0.12);
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(124, 148, 173, 0.3);
}
.sc-h1 {
  font-size: 38px;
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: -0.8px;
  margin: 14px 0 10px;
}
.sc-h1 .grad {
  background: linear-gradient(115deg, #a9bccf 0%, var(--accent) 60%, #7d9d8c 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.sc-sub {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0 0 28px;
  line-height: 1.6;
}
.sc-form { margin-bottom: 18px; }

/* 模式 tabs（单目标 vs 对比） */
.sc-mode-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
/* GEO 入口 —— 独立成条而不是塞进上面的 tab 胶囊：它是另一个问题域，
   表单完全不同（品牌/域名/问题清单/竞品），混进同一组 tab 会让人以为是
   「单目标质检」的第四种输入格式。 */
.sc-geo-entry {
  display: flex; align-items: center; gap: 11px; width: 100%;
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 11px 14px; margin-bottom: 16px;
  cursor: pointer; text-align: left; transition: all 0.15s;
}
.sc-geo-entry:hover { border-color: var(--accent); background: var(--bg-elev-2); }
.sc-geo-entry-main { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.sc-geo-entry-main strong { font-size: 13.5px; color: var(--text); font-weight: 500; }
.sc-geo-entry-main em { font-style: normal; font-size: 11.5px; color: var(--text-dim); }
.sc-mode-tab {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.sc-mode-tab:hover { color: var(--text); border-color: var(--accent); }
.sc-mode-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.sc-mode-hint {
  font-size: 12px;
  color: var(--text-dim);
  margin-left: 6px;
}

/* 场景卡：四选一。两行——标题 + 场景化提示。
   选中态用左侧竖条而不是整块填充：四个卡片里只有一条竖线亮着，
   视线扫过去先落在「当前是哪一个」，而不是被四块底色搅乱。 */
.sc-scenarios {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
  gap: 8px;
  margin-bottom: 18px;
}
.sc-scenario {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: flex-start;
  text-align: left;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-left: 2px solid transparent;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.sc-scenario:hover {
  border-color: var(--accent);
  background: var(--bg-elev-2);
}
.sc-scenario.active {
  border-left-color: var(--accent);
  background: var(--bg-elev-2);
}
.sc-scenario:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sc-scenario-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.sc-scenario-hint {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-dim);
}
.sc-scenario.active .sc-scenario-hint { color: var(--text-dim); }


.sc-form-compare .sc-compare-pair {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto;
  align-items: center;
  gap: 10px;
}
.sc-form-compare .sc-compare-pair .sc-input-wrap { padding-left: 12px; }
.sc-side-tag {
  display: inline-block;
  width: 22px; height: 22px;
  text-align: center;
  border-radius: 6px;
  font-size: 11px; font-weight: 700;
  line-height: 22px;
  margin-right: 4px;
  flex-shrink: 0;
}
.sc-side-tag.a { background: rgba(176, 133, 133, 0.16); color: #b08585; }
.sc-side-tag.b { background: rgba(125, 157, 140, 0.18); color: #7d9d8c; }
.sc-side-tag.big { width: 36px; height: 36px; line-height: 36px; font-size: 16px; margin-right: 0; margin-bottom: 8px; }
.sc-vs { color: var(--text-dim); font-size: 16px; padding: 0 4px; }

/* 对比报告视图 */
.sc-compare-head {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 24px;
  padding: 8px 0 24px;
}
.sc-compare-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
}
.sc-compare-side.a .sc-compare-score { color: #b08585; }
.sc-compare-side.b .sc-compare-score { color: #7d9d8c; }
.sc-compare-project {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 13px;
  color: var(--text-dim);
  word-break: break-all;
}
.sc-compare-score {
  font-size: 56px; font-weight: 800;
  line-height: 1; letter-spacing: -2px;
}
.sc-compare-score .sc-score-unit { font-size: 18px; color: var(--text-dim); margin-left: 4px; }
.sc-compare-band { font-size: 14px; font-weight: 600; }
.sc-compare-vs {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.sc-compare-delta {
  font-size: 28px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, monospace;
  color: var(--accent);
}
.sc-compare-delta.neg { color: #b08585; }
.sc-compare-summary { font-size: 12px; }

.sc-compare-dims { margin-top: 16px; }
.sc-compare-dim-row {
  display: grid;
  grid-template-columns: 90px 1fr 70px 1fr;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.sc-compare-dim-row:first-child { border-top: 0; }
.sc-compare-dim-name { font-size: 13px; font-weight: 600; }
.sc-compare-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  background: var(--bg-elev);
  border-radius: 6px;
  overflow: hidden;
  position: relative;
}
.sc-compare-bar.a { justify-content: flex-end; }
.sc-compare-bar.b { justify-content: flex-start; }
.sc-compare-bar-fill {
  height: 100%;
  display: block;
  border-radius: 6px;
  opacity: 0.85;
}
.sc-compare-bar.a .sc-compare-bar-fill { border-radius: 6px 0 0 6px; }
.sc-compare-bar.b .sc-compare-bar-fill { border-radius: 0 6px 6px 0; }
.sc-compare-bar.a .sc-compare-bar-fill { margin-left: auto; }
.sc-compare-bar-num {
  position: absolute;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 700;
  padding: 0 8px;
  color: var(--text);
  z-index: 1;
}
.sc-compare-bar.a .sc-compare-bar-num { left: 8px; }
.sc-compare-bar.b .sc-compare-bar-num { right: 8px; }
.sc-compare-dim-vs {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 12px;
}
.sc-compare-winner { font-size: 16px; }
.sc-compare-delta-num {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-weight: 700;
  color: var(--accent);
}
.sc-compare-delta-num.neg { color: #b08585; }

.sc-compare-actionable {
  margin-top: 20px;
  padding: 14px;
  border-radius: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
}
.sc-compare-section-title { margin: 0 0 8px; font-size: 14px; }
.sc-compare-gap-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sc-compare-gap-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  line-height: 1.5;
}
.sc-compare-dim-tag {
  display: inline-block;
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  flex-shrink: 0;
  white-space: nowrap;
}
.sc-compare-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
}

@media (max-width: 720px) {
  .sc-compare-head { grid-template-columns: 1fr; gap: 16px; }
  .sc-compare-vs { order: 0; }
  .sc-compare-side.b { order: 2; }
  .sc-compare-dim-row { grid-template-columns: 1fr; gap: 6px; }
  .sc-form-compare .sc-compare-pair { grid-template-columns: 1fr; }
  .sc-vs { display: none; }
}

.sc-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 6px 6px 6px 16px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.sc-input-wrap:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(124, 148, 173, 0.18);
}
.sc-input-icon { color: var(--text-dim); flex-shrink: 0; }
.sc-input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: 0;
  color: var(--text);
  font-size: 15px;
  padding: 12px 4px;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.sc-input::placeholder { color: var(--text-dim); }
.sc-go {
  border-radius: 10px !important;
  padding: 10px 18px !important;
  display: inline-flex !important;
  align-items: center;
  gap: 6px;
}

.sc-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 18px;
}
.sc-chip {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  color: var(--text-muted);
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.sc-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.sc-trust {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-muted);
  flex-wrap: wrap;
}
.sc-trust-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 6px var(--success);
}

/* ---------- LOADING ---------- */
.sc-h2 {
  font-size: 22px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, monospace;
  margin: 0 0 6px;
}
.sc-loading { padding: 30px 0; }
.sc-steps {
  list-style: none;
  padding: 0;
  margin: 20px 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 24px;
}
.sc-steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-muted);
  padding: 6px 10px;
  border-radius: 8px;
  transition: background 0.2s, color 0.2s;
}
.sc-steps li.done {
  background: rgba(124, 148, 173, 0.1);
  color: var(--accent);
}
.sc-step-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--border);
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: var(--bg-elev-2);
}
.sc-steps li.done .sc-step-icon {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
}

/* ---------- REPORT ---------- */
.sc-report {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 报告卡片 */
.sc-card {
  background: linear-gradient(180deg, #161b22 0%, #0d1117 100%);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 28px;
  position: relative;
  overflow: hidden;
}
@media (min-width: 700px) {
  .sc-card {
    display: grid;
    grid-template-columns: minmax(210px, .65fr) minmax(0, 1.35fr);
    column-gap: 28px;
    align-items: center;
  }
  .sc-card-head,
  .sc-card-foot {
    grid-column: 1 / -1;
  }
  .sc-card-head { margin-bottom: 10px; }
  .sc-card-hero { margin: 0; }
  .sc-radar-wrap { display: none; }
  .sc-dims { margin: 0; }
  .sc-dim-row { grid-template-columns: 76px 1fr 30px; }
  .sc-card-foot { margin-top: 18px; }
}
.sc-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--accent), #7d9d8c, var(--accent));
}
.sc-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}
.sc-brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: var(--accent);
}
.sc-card-hero {
  text-align: center;
  margin-bottom: 18px;
}
.sc-repo-name {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 12px;
}
.sc-score-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.sc-big-score {
  font-size: 64px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -2px;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.sc-score-unit {
  font-size: 24px;
  font-weight: 500;
  color: var(--text-dim);
  margin-left: 4px;
}
.sc-band {
  font-size: 14px;
  font-weight: 600;
  margin-top: 4px;
}
.sc-stars {
  font-size: 11.5px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}

/* 雷达图 */
.sc-radar-wrap {
  display: flex;
  justify-content: center;
  margin: 8px 0 18px;
}
.sc-radar { width: 220px; height: 220px; }
.sc-radar-grid {
  fill: none;
  stroke: rgba(124, 148, 173, 0.18);
  stroke-width: 1;
}
.sc-radar-axis {
  stroke: rgba(124, 148, 173, 0.2);
  stroke-width: 1;
}
.sc-radar-shape {
  fill: rgba(124, 148, 173, 0.22);
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linejoin: round;
}
.sc-radar-pt { fill: var(--accent); }
.sc-radar-label {
  fill: var(--text-muted);
  font-size: 9px;
  font-family: ui-monospace, SFMono-Regular, monospace;
}

/* 维度条 */
.sc-dims {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.sc-dim-row {
  display: grid;
  grid-template-columns: 110px 1fr 30px;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.sc-dim-name {
  color: var(--text-muted);
  text-align: right;
}
.sc-bar {
  height: 8px;
  background: var(--bg-elev-2);
  border-radius: 999px;
  overflow: hidden;
}
.sc-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.5s ease;
}
.sc-dim-score {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-weight: 700;
  text-align: right;
}
/* 判不了：虚线空槽 + 灰字，和「得分很低」在视觉上区分开 */
.sc-partial-note {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.5;
}
.sc-dim-row.unknown .sc-bar {
  background: transparent;
  border: 1px dashed var(--border);
}
.sc-dim-unknown {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-dim);
  white-space: nowrap;
}
/* 星号：这一维有部分判据核实不了，分数是归一化来的 */
.sc-dim-partial {
  font-style: normal;
  color: var(--text-dim);
  margin-left: 1px;
}

.sc-card-foot {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 4px;
}
.sc-card-link {
  font-family: ui-monospace, SFMono-Regular, monospace;
  color: var(--accent);
}

/* 摘要 */
.sc-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.sc-summary-section {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}
.sc-summary h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
}
.sc-summary-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sc-summary-icon.ok { color: var(--score-top); }
.sc-summary-icon.warn { color: var(--score-warn); }
.sc-err-icon { color: var(--score-bad); vertical-align: -2px; }
.sc-summary ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.6;
}

/* 人读报告：先给可执行的整改，再提供完整的判据，不要求先复制 Markdown。 */
.sc-findings,
.sc-evidence {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
}
.sc-findings-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

/* 复检对照：涨用绿、跌用红，但两色都取自既有变量，不新增色相。 */
.sc-recheck {
  margin-bottom: 18px;
  padding: 14px 16px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.sc-recheck-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sc-recheck-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text);
}
.sc-recheck-dim { min-width: 76px; color: var(--text); }
.sc-recheck-nums { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.sc-recheck-delta {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sc-recheck-delta.up { color: var(--success); }
.sc-recheck-delta.down { color: #b08585; }
.sc-recheck-delta.flat { color: var(--text-dim); }
.sc-section-kicker {
  margin: 0 0 3px;
  color: var(--text-dim);
  font-size: 11px;
  letter-spacing: .08em;
}
.sc-findings h3,
.sc-evidence h3 {
  margin: 0;
  color: var(--text);
  font-size: 16px;
}
.sc-findings-count {
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
  white-space: nowrap;
}
.sc-todo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.sc-todo-item {
  display: grid;
  grid-template-columns: 108px 1fr;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border-soft);
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
}
.sc-todo-dim {
  color: var(--score-warn);
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  padding-top: 2px;
}
.sc-evidence {
  padding-bottom: 10px;
}
.sc-evidence-item {
  border-top: 1px solid var(--border-soft);
}
.sc-evidence-item summary {
  align-items: center;
  color: var(--text);
  cursor: pointer;
  display: flex;
  font-size: 13px;
  font-weight: 600;
  justify-content: space-between;
  list-style: none;
  padding: 12px 0;
}
.sc-evidence-item summary::-webkit-details-marker {
  display: none;
}
.sc-evidence-item summary::after {
  color: var(--text-dim);
  content: '+';
  font-size: 17px;
  font-weight: 400;
  margin-left: 10px;
}
.sc-evidence-item[open] summary::after {
  content: '−';
}
.sc-evidence-score {
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
}
.sc-evidence-body {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 0 0 16px;
}
.sc-evidence-column {
  border-left: 2px solid var(--border);
  min-width: 0;
  padding-left: 10px;
}
.sc-evidence-column.is-gap {
  border-left-color: var(--score-warn);
}
.sc-evidence-column h4 {
  color: var(--text-muted);
  font-size: 11px;
  margin: 0 0 5px;
}
.sc-evidence-column ul {
  color: var(--text);
  font-size: 12px;
  line-height: 1.55;
  margin: 0;
  padding-left: 16px;
}

/* 操作条 */
.sc-share {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
}

/* Agent 接入区：放在操作条之后。代码块等宽字体 + 可横向滚动，
   窄屏时不换行也不撑破布局。 */
.sc-agent-entry {
  margin-top: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
}
.sc-agent-head { margin-bottom: 10px; }
.sc-agent-desc {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.sc-agent-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}
.sc-agent-cmd code {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text);
  overflow-x: auto;
  white-space: nowrap;
}
.sc-agent-copy { flex: none; }
.sc-agent-foot {
  margin: 8px 0 0;
  font-size: 12px;
}
.sc-agent-foot code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-dim);
}
.sc-share-msg {
  font-size: 12px;
  color: var(--accent);
  margin-left: 4px;
}

/* placeholder to satisfy v-for-iter */
.stat-placeholder { display: none; }

/* 今日热门 */
.sc-trending {
  margin-top: 20px;
  padding: 14px;
  background: rgba(124, 148, 173, 0.05);
  border: 1px dashed rgba(124, 148, 173, 0.3);
  border-radius: 12px;
}
.sc-trending-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 8px;
}
.sc-trending-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sc-trending-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.sc-trending-chip:hover {
  border-color: var(--accent);
  background: rgba(124, 148, 173, 0.08);
}
.sc-trending-chip code {
  background: transparent;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  color: var(--text);
}
.sc-trending-hits {
  font-size: 10.5px;
  color: var(--accent);
  background: rgba(124, 148, 173, 0.18);
  padding: 1px 6px;
  border-radius: 999px;
}

/* ===== 参照榜 ===== */
.sc-board {
  margin-top: 34px;
  text-align: left;
}
.sc-board-head {
  margin-bottom: 12px;
}
.sc-board-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.sc-board-sub {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--text-dim);
}
.sc-board-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg-elev);
}
.sc-board-row + .sc-board-row {
  border-top: 1px solid var(--border-soft);
}
.sc-board-btn {
  display: grid;
  /* 排名 · 项目名 · 分数条 · 分数 · star —— 分数条吃掉剩余宽度 */
  grid-template-columns: 30px minmax(0, 1fr) minmax(60px, 2fr) 42px 58px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  background: transparent;
  border: 0;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}
.sc-board-btn:hover {
  background: rgba(124, 148, 173, 0.08);
}
.sc-rank {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
/* 前三名的序号提亮 —— 不用金银铜配色，那会跟分数色阶抢注意力 */
.sc-board-row.top .sc-rank {
  color: var(--accent);
}
.sc-board-name {
  min-width: 0;
}
.sc-board-name code {
  background: transparent;
  padding: 0;
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}
.sc-board-bar {
  position: relative;
  height: 5px;
  border-radius: 999px;
  background: var(--bg-elev-2);
  overflow: hidden;
}
.sc-board-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
}
.sc-board-score {
  font-size: 13px;
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.sc-board-stars {
  font-size: 11px;
  color: var(--text-dim);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ===== 九维说明 ===== */
.sc-dims-guide {
  margin-top: 34px;
  text-align: left;
}
.sc-dims-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.sc-dim-card {
  padding: 10px 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
}
.sc-dim-card-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 3px;
}
.sc-dim-card-q {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.sc-dims-note {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.6;
}

@media (max-width: 560px) {
  .sc-findings,
  .sc-evidence {
    padding: 14px;
  }
  .sc-todo-item {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .sc-evidence-body {
    grid-template-columns: 1fr;
  }
  /* 窄屏把分数条去掉：项目名和分数是必需信息，条只是辅助 */
  .sc-board-btn {
    grid-template-columns: 26px minmax(0, 1fr) 40px 52px;
  }
  .sc-board-bar {
    display: none;
  }
}
</style>
