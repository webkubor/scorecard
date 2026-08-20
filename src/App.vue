<script setup>
/**
 * Scorecard —— 单页应用外壳。
 *
 * 这个 App.vue 刻意保持极小：一个 hash 路由 + 一个 Scorecard 组件。
 * 它从 github-accounts-manager 拆出来时丢掉的东西，正是它该丢的 ——
 * 登录 gate、账户列表、访客心跳、本机探测。这里没有任何私有数据，
 * 因此也不需要任何鉴权。
 *
 * 路由只有两条：
 *   #/                    → 落地页（空表单）
 *   #/report/<owner>/<repo> → 报告页（预填并自动查询）
 */
import { ref, onMounted } from 'vue'
import Scorecard from './components/Scorecard.vue'
import Icon from './components/Icon.vue'

const appVersion = __APP_VERSION__

// repo 名自带一个斜杠（owner/repo），所以要把 report 之后的所有段拼回来。
// 原仓这里用的是 parts[1]，#/report/webkubor/typora-Bloom-theme 只剩 'webkubor'，
// Scorecard 拿不到合法 repo，分享链接打开只有落地页 —— 拆仓时把这个修带过来了。
function parseHash() {
  const h = window.location.hash.replace(/^#/, '') || '/'
  const parts = h.split('/').filter(Boolean)
  if (parts[0] === 'report') return { name: 'report', query: parts.slice(1).join('/') }
  return { name: 'landing', query: '' }
}

const route = ref(parseHash())
window.addEventListener('hashchange', () => {
  route.value = parseHash()
})

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
      <!-- key 让落地页与报告页切换时组件重建，避免上一次的 stage 残留 -->
      <Scorecard :key="route.name + route.query" :initial-repo="route.query" />
    </main>

    <footer class="footer">
      <span>
        八维度标准与
        <a href="https://github.com/webkubor/scorecard/tree/main/skills/project-maturity-audit"
           target="_blank" rel="noopener">project-maturity-audit</a>
        同源 · 免登录 · 公开仓库无需 token
      </span>
    </footer>
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
