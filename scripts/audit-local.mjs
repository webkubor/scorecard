#!/usr/bin/env bun
/**
 * 本地只读批量质检：直接调用工作树引擎，不访问部署服务/缓存数据库。
 * 凭证仅从 GH_TOKEN / GITHUB_TOKEN 环境变量读取，不打印、不落盘。
 * bun scripts/audit-local.mjs --input /tmp/public_repos.json --output /tmp/repo-audits.json --concurrency 3
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { auditProject } from '../server/audit.js'

/** 支持 gh repo list、REST repos 和 owner/repo 字符串清单，去重且拒绝非法目标。 */
export function parseRepos(input) {
  const rows = Array.isArray(input) ? input : input.repos
  if (!Array.isArray(rows)) throw new Error('input 必须是数组或 { repos: [...] }')
  return [...new Set(rows.map((row) => {
    const slug = typeof row === 'string' ? row : row.nameWithOwner || row.full_name || (row.owner?.login && row.name ? `${row.owner.login}/${row.name}` : '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('input 包含无效 owner/repo')
    return slug
  }))]
}

/** 限制并发；复用引擎的必需请求，不额外拉 metadata、源码或递归树。 */
export async function auditBatch(repos, { concurrency = 3, token, audit = auditProject, progress = () => {} } = {}) {
  const results = new Array(repos.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, repos.length) }, async () => {
    while (next < repos.length) {
      const index = next++
      const project = repos[index]
      const [owner, repo] = project.split('/')
      try { results[index] = await audit({ owner, repo, token }) }
      catch { results[index] = { project, score: null, error: '审计请求失败；请检查网络或 API 限额后重试' } }
      progress(project, index)
    }
  }))
  return results
}

async function main() {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--output', '--concurrency'].includes(args[i]) || !args[i + 1]) throw new Error('用法：--input <json> --output <json> [--concurrency 3]')
    options[args[i].slice(2)] = args[i + 1]
  }
  if (!options.input || !options.output) throw new Error('必须提供 --input 和 --output')
  if (resolve(options.input) === resolve(options.output)) throw new Error('output 不得覆盖 input')
  const concurrency = Number(options.concurrency || 3)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('concurrency 必须为 1–6')
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('请通过 GH_TOKEN 或 GITHUB_TOKEN 注入 GitHub 凭证')
  const repos = parseRepos(JSON.parse(await readFile(options.input, 'utf8')))
  const startedAt = new Date().toISOString()
  let completed = 0
  const results = await auditBatch(repos, {
    concurrency, token,
    progress: (project) => console.error(`[${++completed}/${repos.length}] ${project}`)
  })
  await writeFile(options.output, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), count: results.length, results }, null, 2) + '\n')
  console.error(`完成 ${results.length} 个仓库；结果已写入 ${options.output}`)
  if (results.some((result) => result.error)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('批量审计失败：请检查参数、输入 JSON、文件路径与凭证环境变量；未输出异常详情以避免泄露凭证。')
    process.exitCode = 1
  })
}
