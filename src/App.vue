<script setup>
/**
 * Scorecard —— 单页应用外壳。
 *
 * 这个 App.vue 刻意保持极小：一个 hash 路由 + 一个 Scorecard 组件。
 * 它从 github-accounts-manager 拆出来时丢掉的东西，正是它该丢的 ——
 * 登录 gate、账户列表、访客心跳、本机探测。这里没有任何私有数据，
 * 因此也不需要任何鉴权。
 *
 * 路由三条：
 *   #/                                       → 落地页（空表单）
 *   #/report/<owner>/<repo>                  → 单目标报告页（预填并自动查询）
 *   #/compare?type=&share=&compare=          → 对比页（预填并自动跑）
 * 另一种（更短，分享友好）：?share=X&compare=Y&type=Z 直接挂在根 URL 上，
 * 后端 SPA fallback 都认 —— 同一个效果，IM 里贴得更短。
 */
import { ref, onMounted } from 'vue'
import Scorecard from './components/Scorecard.vue'
import Icon from './components/Icon.vue'
import { useVersionCheck } from 'vite-plugin-refresh-guard/vue'
import UpdatePrompt from 'vite-plugin-refresh-guard/vue/UpdatePrompt.vue'

const appVersion = __APP_VERSION__

// 部署了新版本怎么切换：轮询 version.json 检测新版本，toast 提示后自动刷新。
const { hasUpdate, mode, applyUpdate } = useVersionCheck(__REFRESH_GUARD_VERSION__, {
  mode: 'toast-auto',
  interval: 5 * 60 * 1000,
  checkOnVisible: true,
})

/**
 * 解析当前 URL 的入参。
 * - hash 形式：#/report/<repo>   或   #/compare?type=&share=&compare=
 * - search 形式（更短，分享友好）：?share=X&compare=Y&type=Z
 *
 * repo 名自带一个斜杠（owner/repo），所以要把 report 之后的所有段拼回来。
 * 原仓这里用的是 parts[1]，#/report/webkubor/typora-Bloom-theme 只剩 'webkubor'，
 * Scorecard 拿不到合法 repo，分享链接打开只有落地页 —— 拆仓时把这个修带过来了。
 */
function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/'
  const search = new URLSearchParams(window.location.search)

  // 分享 URL：根 URL 上挂 ?share=&compare= —— IM 里更短
  const shareA = search.get('share') || search.get('a')
  const shareB = search.get('compare') || search.get('b')
  const shareType = search.get('type')
  if (shareA && shareB) {
    return { name: 'compare', compare: { a: shareA, b: shareB, type: shareType || '' }, repo: '' }
  }

  // hash 路由
  const parts = hash.split('/').filter(Boolean)
  if (parts[0] === 'report') return { name: 'report', repo: parts.slice(1).join('/'), compare: null }
  if (parts[0] === 'compare') {
    const q = new URLSearchParams(hash.split('?')[1] || '')
    return {
      name: 'compare',
      compare: {
        a: q.get('share') || q.get('a') || '',
        b: q.get('compare') || q.get('b') || '',
        type: q.get('type') || '',
      },
      repo: '',
    }
  }
  return { name: 'landing', repo: '', compare: null }
}

const route = ref(parseRoute())
window.addEventListener('hashchange', () => {
  route.value = parseRoute()
})
window.addEventListener('popstate', () => { route.value = parseRoute() })

const stats = ref(null)
onMounted(async () => {
  try {
    const r = await fetch('/api/scorecard/stats')
    if (r.ok) stats.value = await r.json()
  } catch {}
})
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-brand">
        <Icon name="brand" :size="18" />
        <span class="brand-name">Scorecard</span>
        <span class="brand-ver">v{{ appVersion }}</span>
      </div>
      <a
        class="topbar-link"
        href="https://github.com/webkubor/scorecard"
        target="_blank"
        rel="noopener"
      >
        <Icon name="github" :size="15" />
        <span>源码</span>
      </a>
    </header>

    <main class="main">
      <!-- key 让落地页与报告页 / 对比页切换时组件重建，避免上一次的 stage 残留 -->
      <Scorecard
        :key="route.name + (route.repo || '') + (route.compare?.a || '') + (route.compare?.b || '')"
        :initial-repo="route.repo"
        :initial-compare="route.compare"
      />
    </main>

    <footer class="footer">
      <span>
        九维度标准与
        <a href="https://github.com/webkubor/scorecard/tree/main/skills/project-maturity-audit"
           target="_blank" rel="noopener">project-maturity-audit</a>
        同源 · 免登录 · 公开仓库无需 token
      </span>
    </footer>
    <UpdatePrompt :visible="hasUpdate" :mode="mode" :changelog-html="'<p>有新版本可用，即将自动刷新。</p>'" @refresh="applyUpdate" />
  </div>
</template>

<style scoped>
.topbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand-name {
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.3px;
}
.brand-ver {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}
.topbar-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
  text-decoration: none;
}
.topbar-link:hover {
  color: var(--text);
}
</style>
