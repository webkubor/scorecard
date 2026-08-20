#!/usr/bin/env node
/**
 * 给排行榜灌一批知名项目。
 *
 * 为什么需要：空排行榜没有说服力，也没法让人一眼看懂「6 分和 9 分差在哪」。
 * 灌一批人人都认识的项目当标尺 —— 看到 vite 8.9 分、自己项目 4 分，
 * 差距是具体的；只看一个孤零零的 4 分，没有意义。
 *
 * 顺带也是引擎的回归测试：这些项目类型、语言、规模跨度很大，
 * 跑一遍能暴露「某类项目算出 0 分」这种问题。
 *
 * usage:
 *   node scripts/seed-leaderboard.mjs                       # 打本地 :54445
 *   node scripts/seed-leaderboard.mjs --base https://...    # 打线上
 *   node scripts/seed-leaderboard.mjs --delay 3000          # 放慢，避免打满 GitHub 限额
 */

// 选取原则：认得出名字、类型分散（框架/运行时/语言/编辑器/AI/工具链）、
// 既有满分级也有明显偏科的，这样榜单本身就说明了八维在量什么。
const PROJECTS = [
  // 前端框架与工具链
  'vuejs/core',
  'facebook/react',
  'vitejs/vite',
  'sveltejs/svelte',
  'vercel/next.js',
  'tailwindlabs/tailwindcss',
  // 运行时与语言
  'denoland/deno',
  'oven-sh/bun',
  'nodejs/node',
  'rust-lang/rust',
  'golang/go',
  'python/cpython',
  // 编辑器与基础设施
  'microsoft/vscode',
  'neovim/neovim',
  'kubernetes/kubernetes',
  // AI
  'huggingface/transformers',
  'langchain-ai/langchain',
  'ollama/ollama',
  // 同名的那个：OpenSSF 官方 scorecard，量的是供应链安全，
  // 和本项目量的「陌生人会不会 star / 安装 / 信任」不是一回事。放进来正好对照。
  'ossf/scorecard'
]

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const BASE = arg('base', 'http://127.0.0.1:54445').replace(/\/$/, '')
const DELAY = Number(arg('delay', 1500))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ok = 0
let failed = 0
const results = []

console.log(`▸ 目标 ${BASE} · ${PROJECTS.length} 个项目 · 间隔 ${DELAY}ms\n`)

for (const repo of PROJECTS) {
  try {
    const res = await fetch(`${BASE}/api/scorecard?repo=${encodeURIComponent(repo)}`, {
      headers: { 'X-Visitor-Id': 'seed-script' }
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || j.error) {
      failed++
      console.log(`  ✕ ${repo.padEnd(30)} ${j.error || res.status}`)
    } else {
      ok++
      const r = j.report
      results.push({ repo, score: r.score, band: r.band })
      console.log(
        `  ✓ ${repo.padEnd(30)} ${String(r.score).padStart(4)} / 10  ${r.band}${j.cached ? '  (缓存)' : ''}`
      )
    }
  } catch (err) {
    failed++
    console.log(`  ✕ ${repo.padEnd(30)} ${err.message}`)
  }
  await sleep(DELAY)
}

console.log(`\n▸ 完成：成功 ${ok} · 失败 ${failed}`)
if (results.length) {
  results.sort((a, b) => b.score - a.score)
  console.log('\n▸ 榜单预览：')
  results.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.repo.padEnd(30)} ${r.score}`)
  })
}
if (failed) process.exitCode = 1
