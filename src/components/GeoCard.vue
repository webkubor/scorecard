<script setup>
/**
 * GEO —— AI 搜索可见性视图。
 *
 * 刻意独立于 Scorecard.vue，不做进去：那一支已经 1900 行，且它假设「一个输入框
 * 决定一种 type」。GEO 不适用 —— 它要品牌名、域名、问题清单、竞品四个字段，
 * 而且问题清单可以很长。让它塞进单输入框的判据里（`^owner/repo$` 之类）只会
 * 逼出一堆特例分支。
 *
 * 三处刻意与前三路不同：
 * 1) 先问「你配了哪路 provider」。没配 key 就直接告诉用户，并给 offline 出口 ——
 *    不能让用户填完一表格才告诉他跑不了。
 * 2) 离线报告要显眼标「假数据」。这是唯一一条 GEO 特有的硬要求：前三路的数字
 *    都是真的，GEO 的 fixture 数字是编的，混进汇报就是事故。
 * 3) 趋势读 /api/geo/trend，与本次查询分开。趋势要看历史，实时查一次没有意义。
 */
import { ref, computed, onMounted } from 'vue'
import Icon from './Icon.vue'

const providers = ref(null)
const stage = ref('idle')          // idle | loading | report | error
const report = ref(null)
const errorMsg = ref('')
const trend = ref(null)
const showMd = ref(false)

const form = ref({
  brand: '', domain: '', questions: '', competitors: '', provider: '',
})

const questionList = computed(() =>
  form.value.questions.split('\n').map((s) => s.trim()).filter(Boolean)
)
const competitorList = computed(() =>
  form.value.competitors.split(',').map((s) => s.trim()).filter(Boolean)
)

// 没配 key 时不能让用户填完一表格才发现跑不了。
const readyProviders = computed(() =>
  (providers.value?.providers || []).filter((p) => p.ready)
)
const noKey = computed(() => providers.value && readyProviders.value.length === 0)

const canSubmit = computed(() =>
  form.value.brand.trim() && questionList.value.length > 0
)

function qs() {
  return new URLSearchParams({
    type: 'geo',
    brand: form.value.brand.trim(),
    domain: form.value.domain.trim(),
    q: questionList.value.join(','),
    competitors: competitorList.value.join(','),
    provider: form.value.provider,
  }).toString()
}

async function loadTrend() {
  if (!form.value.brand.trim()) return
  try {
    const r = await fetch(`/api/geo/trend?brand=${encodeURIComponent(form.value.brand.trim())}`, { cache: 'no-store' })
    if (r.ok) trend.value = await r.json()
  } catch { /* 趋势拉不到不该让主流程失败 —— 报告本身已经拿到了 */ }
}

async function generate() {
  stage.value = 'loading'
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/scorecard?${qs()}`, { cache: 'no-store' })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    report.value = j.report
    stage.value = 'report'
    await loadTrend()
  } catch (err) {
    errorMsg.value = err.message
    stage.value = 'error'
  }
}

function reset() {
  stage.value = 'idle'
  report.value = null
  errorMsg.value = ''
  trend.value = null
}

const mdUrl = computed(() =>
  report.value ? `/api/scorecard/report.md?${qs()}` : ''
)

const scoreColor = computed(() => colorOf(report.value?.score))

// 每根条按自己的分上色，不是按总分 —— 竞品份额 3.3 画成绿色，
// 等于把「四分之三的答案里没有你」显示成一路绿灯。
function colorOf(s) {
  if (s == null) return 'var(--text-dim)'
  if (s >= 8) return 'var(--score-top)'
  if (s >= 5) return 'var(--score-ok)'
  if (s >= 2) return 'var(--score-warn)'
  return 'var(--score-bad)'
}

// 分享链接带回来：#/geo?brand=museav&q=...
// 带回参数就跑 —— 否则「分享一个结论」变成「分享一个空表单」，链接的用途就没了。
// 离线报告跑一次几毫秒无所谓；真实调用是用户自己的意图，URL 里有就是明确的意图。
const hashParams = new URLSearchParams((window.location.hash.split('?')[1] || ''))
const fromShare = hashParams.get('brand') && hashParams.get('q')
if (hashParams.get('brand')) {
  form.value.brand = hashParams.get('brand') || ''
  form.value.domain = hashParams.get('domain') || ''
  form.value.questions = (hashParams.get('q') || '').split(',').filter(Boolean).join('\n')
  form.value.competitors = hashParams.get('competitors') || ''
  form.value.provider = hashParams.get('provider') || ''
}

onMounted(async () => {
  try {
    const r = await fetch('/api/geo/providers', { cache: 'no-store' })
    if (r.ok) providers.value = await r.json()
  } catch { providers.value = null }

  // 「自动」必须真的自动。后端默认 anthropic，所以留空会直接报「没配 key」——
  // 一台没配 key 的机器上，「自动」等于「必失败」。这里按就绪情况落地成具体值，
  // 一个都没就绪就落到 offline：宁可给一份标明是假数据的报告，也别给一个错误。
  if (!form.value.provider) {
    form.value.provider = readyProviders.value[0]?.id || 'offline'
  }
  if (fromShare) generate()
})
</script>

<template>
  <div class="geo">
    <!-- 无 key 时的前置提示：不给用户「填完才发现跑不了」的体验。
         报告态不再重复这条 —— 那里已经有「这份是离线样例」在讲同一件事，
         两条警告叠在一起只会让人以为出了两个问题。 -->
    <div v-if="noKey && stage !== 'report'" class="geo-notice warn">
      <Icon name="warning" :size="15" />
      <div>
        <strong>本机没配任何 LLM key</strong>
        <p>
          GEO 要花钱调 LLM，所以线上实例故意不配 key（只读历史，零花费）。
          想跑真实数据，在环境变量里配其一再重启：
          <code v-for="p in providers.providers" :key="p.id">{{ p.keyEnv }}</code>
        </p>
        <p class="dim">也可以先用下面的「离线样例」看报告长什么样 —— 但那份是假数据，不能当结论用。</p>
      </div>
    </div>

    <div v-else-if="providers?.online && stage !== 'report'" class="geo-notice ok">
      <Icon name="check" :size="15" />
      <div>
        <strong>可用的 provider</strong>
        <span v-for="p in readyProviders" :key="p.id" class="geo-tag">{{ p.id }} · {{ p.model }}</span>
        <span class="dim">每次查询都会调用付费 API</span>
      </div>
    </div>

    <!-- 表单 -->
    <form v-if="stage !== 'report'" class="geo-form" @submit.prevent="generate">
      <label class="geo-field">
        <span class="geo-label">品牌名 <em>*</em></span>
        <input v-model="form.brand" class="geo-input" placeholder="museav" autocomplete="off" spellcheck="false" />
      </label>

      <label class="geo-field">
        <span class="geo-label">自有域名</span>
        <input v-model="form.domain" class="geo-input" placeholder="museav.com" autocomplete="off" spellcheck="false" />
        <span class="geo-hint">
          有它才能判「引用率」（你的域名有没有进 AI 的来源列表）。留空则这一维标「无法核实」——
          引用是转化路径，比提及更值得看。
        </span>
      </label>

      <label class="geo-field">
        <span class="geo-label">用户会问的问题 <em>*</em>（一行一个）</span>
        <textarea
          v-model="form.questions"
          class="geo-input geo-textarea"
          rows="4"
          spellcheck="false"
          placeholder="有哪些好用的 AI 视频生成工具&#10;有哪些能批量做小红书内容的工具"
        />
        <span class="geo-hint">
          必须是<strong>品类问题</strong>，不是品牌词。问「museav 怎么样」测不出东西 ——
          模型会顺着你的问题去提它，数字好看但一文不值。
        </span>
      </label>

      <label class="geo-field">
        <span class="geo-label">竞品（逗号分隔）</span>
        <input v-model="form.competitors" class="geo-input" placeholder="runway, pika" autocomplete="off" spellcheck="false" />
        <span class="geo-hint">
          没竞品则「份额」维标无法核实 —— 单看提及率会被「品类很小」的错觉骗过去。
        </span>
      </label>

      <label class="geo-field">
        <span class="geo-label">provider</span>
        <select v-model="form.provider" class="geo-input">
          <option value="">自动（第一个就绪的）</option>
          <option v-for="p in providers?.providers || []" :key="p.id" :value="p.id">
            {{ p.id }} · {{ p.model }}{{ p.ready ? '' : '（未配 key）' }}
          </option>
          <option value="offline">离线样例（假数据）</option>
        </select>
      </label>

      <button class="btn primary geo-go" :disabled="!canSubmit" type="submit">
        <Icon name="search" :size="14" />
        <span>查可见性</span>
      </button>
      <p v-if="!canSubmit" class="geo-hint dim">品牌名和问题清单是必填的</p>
    </form>

    <!-- 加载 -->
    <div v-else-if="stage === 'loading'" class="geo-loading">
      <div class="geo-spinner"></div>
      <p>正在向各 provider 提问…</p>
      <p class="dim">每个问题一次付费调用，慢是正常的</p>
    </div>

    <!-- 错误 -->
    <div v-else-if="stage === 'error'" class="geo-notice bad">
      <Icon name="warning" :size="15" />
      <div><strong>跑不出来</strong><p>{{ errorMsg }}</p></div>
    </div>

    <!-- 报告 -->
    <div v-else-if="stage === 'report' && report" class="geo-report">
      <div v-if="report.offline" class="geo-notice warn">
        <Icon name="warning" :size="15" />
        <div>
          <strong>这份是离线样例（假数据）</strong>
          <p>用来让你看报告长什么样。数字不是你的真实可见性，不能拿去汇报。</p>
        </div>
      </div>

      <div class="geo-head">
        <div>
          <h2>{{ report.project }}</h2>
          <p class="dim">
            {{ report.questions.length }} 个问题
            <template v-if="report.competitors.length"> · 对比 {{ report.competitors.join(' / ') }}</template>
            · provider <code>{{ report.provider }}</code>
          </p>
        </div>
        <div class="geo-score">
          <div class="geo-score-num" :style="{ color: scoreColor }">{{ report.score.toFixed(1) }}</div>
          <div class="geo-band">{{ report.band }}</div>
        </div>
      </div>
      <p v-if="report.bandHint" class="geo-hint">{{ report.bandHint }}</p>

      <!-- 维度 -->
      <div class="geo-dims">
        <div v-for="d in report.dims" :key="d.key" class="geo-dim">
          <div class="geo-dim-head">
            <span class="geo-dim-name">{{ d.name }}</span>
            <span class="geo-dim-score">
              <template v-if="d.score != null">{{ d.score.toFixed(1) }}</template>
              <em v-else class="geo-unverifiable">无法核实</em>
            </span>
          </div>
          <div class="geo-bar">
            <div class="geo-bar-fill" :style="{ width: (d.score ?? 0) * 10 + '%', background: colorOf(d.score) }"></div>
          </div>
          <ul class="geo-evi">
            <li v-for="(e, i) in d.evidence" :key="'e' + i">{{ e }}</li>
            <li v-for="(g, i) in d.gaps" :key="'g' + i" class="warn-line">⚠️ {{ g }}</li>
            <li v-for="(m, i) in d.manual" :key="'m' + i" class="dim">ℹ️ {{ m }}</li>
          </ul>
        </div>
      </div>

      <!-- 趋势 -->
      <div v-if="trend" class="geo-trend">
        <h3>趋势</h3>
        <p class="dim">{{ trend.note }}</p>
        <div v-if="trend.live.length >= 2" class="geo-delta" :class="trend.delta >= 0 ? 'up' : 'down'">
          {{ trend.delta >= 0 ? '▲' : '▼' }} {{ Math.abs(trend.delta).toFixed(1) }}
          <span class="dim">（{{ trend.live[0].ts.slice(0, 10) }} → {{ trend.live[trend.live.length - 1].ts.slice(0, 10) }}）</span>
        </div>
        <div v-if="trend.offline.length" class="geo-trend-offline">
          另有 {{ trend.offline.length }} 个离线样例点，已单独归类 —— 不可与真实数据放进同一条曲线比较。
        </div>
      </div>

      <div class="geo-actions">
        <a class="btn small" :href="mdUrl" target="_blank" rel="noopener">
          <Icon name="copy" :size="13" /><span>Markdown 报告</span>
        </a>
        <button class="btn small ghost" type="button" @click="reset">
          <span>换一组问题</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.geo { max-width: 780px; margin: 0 auto; }

/* 提示条 */
.geo-notice {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 12px 14px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: var(--bg-elev);
  margin-bottom: 20px; font-size: 13px; line-height: 1.6;
}
.geo-notice.warn { border-color: var(--warn); }
.geo-notice.ok { border-color: var(--success); }
.geo-notice.bad { border-color: var(--danger); }
.geo-notice strong { display: block; margin-bottom: 2px; }
.geo-notice p { margin: 2px 0; color: var(--text-muted); }
.geo-notice code {
  font-family: var(--mono, monospace); font-size: 11px;
  background: var(--bg-elev-2); padding: 1px 5px; border-radius: 4px;
  margin-right: 4px; display: inline-block;
}
.geo-tag {
  display: inline-block; font-size: 12px; padding: 1px 8px; margin-right: 6px;
  border: 1px solid var(--success); border-radius: 10px; color: var(--success);
}

/* 表单 */
.geo-form { display: flex; flex-direction: column; gap: 16px; }
.geo-field { display: flex; flex-direction: column; gap: 5px; }
.geo-label { font-size: 12px; color: var(--text-muted); font-weight: 500; }
.geo-label em { color: var(--danger); font-style: normal; }
.geo-input {
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text);
  padding: 8px 11px; font-size: 14px; font-family: inherit; width: 100%;
}
.geo-input:focus { outline: none; border-color: var(--accent); }
.geo-textarea { resize: vertical; font-family: var(--mono, monospace); font-size: 13px; }
.geo-hint { font-size: 11.5px; color: var(--text-dim); line-height: 1.55; }
.geo-hint.dim, .dim { color: var(--text-dim); }
.geo-go { align-self: flex-start; padding: 9px 20px; }

/* 加载 */
.geo-loading { text-align: center; padding: 48px 0; font-size: 13px; }
.geo-spinner {
  width: 26px; height: 26px; margin: 0 auto 14px;
  border: 2px solid var(--border); border-top-color: var(--accent);
  border-radius: 50%; animation: geo-spin 0.8s linear infinite;
}
@keyframes geo-spin { to { transform: rotate(360deg); } }

/* 报告头 */
.geo-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 6px; }
.geo-head h2 { margin: 0 0 3px; font-size: 20px; }
.geo-head p { margin: 0; font-size: 12px; }
.geo-score { text-align: right; }
.geo-score-num { font-size: 34px; font-weight: 600; line-height: 1; }
.geo-band { font-size: 12px; color: var(--text-muted); margin-top: 3px; }

/* 维度 */
.geo-dims { display: flex; flex-direction: column; gap: 16px; margin: 22px 0; }
.geo-dim-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
.geo-dim-name { font-size: 14px; font-weight: 500; }
.geo-dim-score { font-size: 13px; color: var(--text-muted); }
.geo-unverifiable { font-style: normal; color: var(--text-dim); font-size: 12px; }
.geo-bar { height: 5px; background: var(--bg-elev-2); border-radius: 3px; overflow: hidden; }
.geo-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.geo-evi { list-style: none; padding: 0; margin: 7px 0 0; font-size: 12px; line-height: 1.6; }
.geo-evi li { color: var(--text-muted); padding-left: 12px; position: relative; }
.geo-evi li::before { content: '·'; position: absolute; left: 3px; }
.geo-evi li.warn-line { color: var(--warn); }
.geo-evi li.dim { color: var(--text-dim); }

/* 趋势 */
.geo-trend { border-top: 1px solid var(--border-soft); padding-top: 16px; margin: 20px 0; }
.geo-trend h3 { margin: 0 0 6px; font-size: 14px; font-weight: 500; }
.geo-trend p { margin: 0 0 8px; font-size: 12px; }
.geo-delta { font-size: 22px; font-weight: 600; }
.geo-delta.up { color: var(--success); }
.geo-delta.down { color: var(--danger); }
.geo-delta .dim { font-size: 12px; font-weight: 400; }
.geo-trend-offline { font-size: 11.5px; color: var(--text-dim); margin-top: 6px; }

/* 操作 */
.geo-actions { display: flex; gap: 8px; margin-top: 18px; }
</style>