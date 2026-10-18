#!/usr/bin/env node
/**
 * 零依赖语法检查 —— 替代 linter 的最小版本。
 *
 * 为什么不用 ESLint / Biome：这个项目的卖点之一是「单 bun 进程、零重依赖」，
 * 目前只有 3 个运行时依赖。为一个 lint 关卡拉进几十个传递依赖不划算。
 *
 * 这里只做一件 linter 真正不可替代的事：**语法必须过关**。
 * 风格问题（引号、分号、缩进）不影响正确性，也不值得为它装依赖；
 * 而一个语法错误会让整个服务起不来，这个必须在 CI 里拦住。
 *
 * 另外顺手守两条本项目特有的红线，它们的代价比风格问题大得多：
 *   ① 明文密钥不得进仓库（service_role / ghp_ / sbp_ 这类）
 *   ② 引擎里不得出现 `score = 0` 式的「查不到就当不满足」写法
 *
 *   node scripts/check-syntax.mjs [--strict]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = process.argv.includes('--strict')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', '.wrangler'])
const JS_EXT = new Set(['.js', '.mjs'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(ROOT)
const jsFiles = files.filter((f) => JS_EXT.has(extname(f)))

let problems = 0

// ① 语法检查 —— 用 node --check，零依赖
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) {
    problems++
    console.log(`❌ 语法错误 ${relative(ROOT, f)}`)
    console.log((r.stderr || '').split('\n').slice(0, 4).map((l) => `   ${l}`).join('\n'))
  }
}

// ② 明文密钥扫描 —— 只看会进版本库的文件
//
// 这条比风格问题重要得多：2026-10-13 就发生过 service_role 明文躺在仓库里，
// 后来才收口成走 kyvault。扫描规则只认密钥的**确定前缀**，避免把普通长字符串误报。
const SECRET_PATTERNS = [
  { re: /ghp_[A-Za-z0-9]{30,}/, what: 'GitHub 经典 PAT' },
  { re: /github_pat_[A-Za-z0-9_]{50,}/, what: 'GitHub fine-grained PAT' },
  { re: /sbp_[A-Za-z0-9]{40,}/, what: 'Supabase PAT' },
  { re: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, what: 'JWT（可能是 service_role）' },
  { re: /sk-[A-Za-z0-9]{32,}/, what: 'OpenAI 风格 key' },
]
const TEXT_EXT = new Set(['.js', '.mjs', '.ts', '.vue', '.json', '.md', '.yml', '.yaml', '.txt', '.sql', '.sh'])
for (const f of files) {
  if (!TEXT_EXT.has(extname(f))) continue
  const rel = relative(ROOT, f)
  // 本脚本自己含这些正则，跳过（否则自我命中）
  if (rel === 'scripts/check-syntax.mjs') continue
  const text = readFileSync(f, 'utf8')
  for (const { re, what } of SECRET_PATTERNS) {
    if (re.test(text)) {
      problems++
      console.log(`❌ 明文密钥疑似 ${rel} —— ${what}`)
      console.log('   密钥一律走 kyvault（secret://...），见 AGENTS.md')
    }
  }
}

// ③ 引擎纪律：查不到的维度不得直接记 0 分
for (const f of ['server/audit.js', 'server/audit-npm.js', 'server/audit-page.js']) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  // `score = 0` 出现在按「文件不存在」分支里，通常意味着把「查不到」写成了「不合格」
  const hits = [...text.matchAll(/if\s*\(!?[\w.]*(?:ok|exists|found)[\w.]*\)[^\n]{0,40}score\s*=\s*0/g)]
  if (hits.length) {
    problems++
    console.log(`⚠️  ${f}：疑似把「查不到」记成 0 分（${hits.length} 处）`)
    console.log('   查不到的判据应累加 unverifiable 并走 normalizeDim，不是扣分')
  }
}

console.log(`\n检查了 ${jsFiles.length} 个 JS 文件`)
if (!problems) {
  console.log('✅ 语法与红线检查通过')
  process.exit(0)
}
console.log(`\n❌ ${problems} 个问题`)
process.exit(STRICT ? 1 : 0)
