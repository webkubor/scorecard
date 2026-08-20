<script setup>
/**
 * Scorecard —— 落地页 + 报告页一体化。
 *
 * 三种状态在一页内流转：
 *   1) idle：超大输入框 + 几个示例 chip + "已查过 N 次" 信任状
 *   2) loading：进度文案 + 8 个维度逐项打勾（带 staggered 动画）
 *   3) report：大号分数 + SVG 雷达图 + 8 维度条形明细 + Markdown 报告导出
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
  initialRepo: { type: String, default: '' }
})

// 品牌字样集中在这里。散成十几处字面量的话，改名必然漏掉几处，
// 于是同一个页面上并存两个品牌名 —— 拆仓前就是这个状态（GHAM / Scorecard 混用）。
const BRAND = 'Scorecard'
const BRAND_MARK = 'SCORECARD' // 视觉标记用大写
const BRAND_SLUG = 'scorecard' // 导出文件名用
const SITE_HOST = 'scorecard.webkubor.online'

// ---------- state machine ----------
const stage = ref('idle') // idle | loading | report | error
const input = ref('')
const parsedRepo = ref('') // owner/name
const report = ref(null)
const cached = ref(false)
const errorMsg = ref('')
const stats = ref({ total: 0, avg: 0 })
const trending = ref([])

const leaderboard = ref([])

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

// 八个维度各自在量什么。放在落地页上，是为了让人在输入之前就知道
// 「这个分数是怎么来的」—— 一个不解释判据的分数，不会有人当真。
const DIMENSION_GUIDE = [
  { name: '门面', q: 'description、topics、徽章有没有把「这是什么」说清楚' },
  { name: '分发', q: '陌生人能不能顺利装上：npm 包、release 产物、安装说明' },
  { name: '发布工程', q: 'semver tag、CHANGELOG、release 节奏' },
  { name: '质量护栏', q: 'CI 绿不绿、有没有测试与 lint' },
  { name: '社区卫生', q: 'CONTRIBUTING、issue 模板、老 issue 有没有人管' },
  { name: '文档', q: 'README 有没有快速开始、配置参考、故障排查' },
  { name: '安全', q: 'SECURITY.md、依赖治理、告警处理' },
  { name: '度量', q: 'star 增速、fork、流量趋势' }
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

function reset() {
  stage.value = 'idle'
  report.value = null
  input.value = ''
  history.replaceState(null, '', '#/report')
}

// ---------- 雷达图 / 维度条 ----------
const DIMS_MAX = 10

const radarPolygon = computed(() => {
  if (!report.value?.dims) return ''
  const n = report.value.dims.length
  if (!n) return ''
  const cx = 110, cy = 110, r = 88
  return report.value.dims
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
  if (!report.value?.dims) return []
  const n = report.value.dims.length
  const cx = 110, cy = 110, r = 88
  return report.value.dims.map((d, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      label: d.name
    }
  })
})

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

const sortedDims = computed(() => {
  if (!report.value?.dims) return []
  return [...report.value.dims].sort((a, b) => a.score - b.score)
})
const strengths = computed(() => sortedDims.value.filter((d) => d.score >= 8).reverse().slice(0, 2))
const improvements = computed(() => sortedDims.value.filter((d) => d.score < 6).slice(0, 2))

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
  if (props.initialRepo && /\/[\w.-]+/.test(props.initialRepo)) {
    input.value = props.initialRepo
    generate()
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
        <span class="grad">几秒钟</span>就能拿到 8 维度质检报告
      </h1>
      <p class="sc-sub">
        粘一个 GitHub URL —— 八维度雷达图 + 整改清单 + 一份可直接喂给 AI 的 Markdown 报告。
        免登录，公开仓库无 token 也能跑。
      </p>

      <form class="sc-form" @submit.prevent="generate">
        <div class="sc-input-wrap">
          <Icon name="link" :size="16" class="sc-input-icon" />
          <input
            v-model="input"
            class="sc-input"
            type="text"
            placeholder="github.com/owner/repo  或  owner/repo"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter.prevent="generate"
          />
          <button class="btn primary sc-go" :disabled="!canSubmit" type="submit">
            <Icon name="search" :size="14" />
            <span>查一下</span>
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
          <p class="sc-board-sub">同一套八维标准跑出来的分数 —— 点任意一行看它的完整报告</p>
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

      <!-- 八维说明 —— 不解释判据的分数没人会当真 -->
      <section class="sc-dims-guide">
        <h2 class="sc-board-title">
          <Icon name="check" :size="14" />
          <span>八个维度分别在量什么</span>
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
    <!--  REPORT: 雷达图 + 维度明细 + Markdown 导出                         -->
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
          </div>
        </div>

        <!-- 雷达图（纯 SVG） -->
        <div class="sc-radar-wrap">
          <svg viewBox="0 0 220 220" class="sc-radar" aria-label="8维度雷达图">
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
              :cx="110 + Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / report.dims.length) * (d.score / DIMS_MAX) * 88"
              :cy="110 + Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / report.dims.length) * (d.score / DIMS_MAX) * 88"
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
          <div v-for="d in sortedDims" :key="d.name" class="sc-dim-row">
            <span class="sc-dim-name">{{ d.name }}</span>
            <div class="sc-bar"><i :style="{ width: (d.score * 10) + '%', background: bandColor(d.score) }"/></div>
            <span class="sc-dim-score" :style="{ color: bandColor(d.score) }">{{ d.score }}</span>
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

      <!-- 操作条 -->
      <div class="sc-share">
        <!-- 主操作是「复制 Markdown」：它是唯一能让别人真的把项目改好的形态 ——
             粘给 AI 就能照着改，改完再回来测一次分数。 -->
        <button class="btn primary" :disabled="shareBusy" @click="copyMarkdown">
          <Icon name="copy" :size="13" /> 复制 Markdown（可直接喂给 AI）
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

/* ===== 八维说明 ===== */
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
  /* 窄屏把分数条去掉：项目名和分数是必需信息，条只是辅助 */
  .sc-board-btn {
    grid-template-columns: 26px minmax(0, 1fr) 40px 52px;
  }
  .sc-board-bar {
    display: none;
  }
}
</style>