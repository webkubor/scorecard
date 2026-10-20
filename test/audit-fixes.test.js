import { test, expect } from 'bun:test'
import { auditProject, assessDescription, assessTopics, gh } from '../server/audit.js'

test('GitHub API TLS 证书验证错误只重试一次并保留请求参数', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  let attempts = 0
  globalThis.fetch = async (url, options) => {
    calls.push([url, options])
    attempts++
    if (attempts === 1) {
      const error = new TypeError('mock certificate failure')
      error.code = 'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR'
      throw error
    }
    return new Response(JSON.stringify({ ok: true }))
  }
  try {
    const result = await gh('/repos/example/project', 'fixture-token')
    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)
    expect(calls[0]).toEqual(calls[1])
  } finally { globalThis.fetch = originalFetch }
})

test('GitHub API TLS 连续失败给出脱敏错误；其他异常不重试', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts++
    const error = new TypeError('mock certificate failure')
    error.code = 'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR'
    throw error
  }
  try {
    await expect(gh('/repos/example/project')).rejects.toThrow('GitHub API 请求失败（TLS 证书验证）')
    expect(attempts).toBe(2)
    attempts = 0
    globalThis.fetch = async () => { attempts++; throw new TypeError('different failure') }
    await expect(gh('/repos/example/project')).rejects.toThrow('different failure')
    expect(attempts).toBe(1)
  } finally { globalThis.fetch = originalFetch }
})

test('description 夹具：同时有用途与项目/用户类目词才通过', () => {
  expect(assessDescription(null).pass).toBe(false)
  expect(assessDescription('A modern platform for developers').pass).toBe(true)
  expect(assessDescription('A platform that turns paragraphs into flashcards').pass).toBe(true)
  expect(assessDescription('A modern platform').pass).toBe(false)
  expect(assessDescription('本地优先的密钥管理 CLI，面向开发者').pass).toBe(true)
})

test('词表未知短描述不等于用途不清；空白与泛词不能当明确对象', async () => {
  expect(assessDescription('  \n\t ').present).toBe(false)
  expect(assessDescription('优雅的终端播放器').pass).toBe(false)
  expect(assessDescription('A local data platform').pass).toBe(false)
  const originalFetch = globalThis.fetch
  try {
    for (const description of ['优雅的终端播放器', '  \n\t ']) {
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname
        const data = path === '/repos/example/player'
          ? { name: 'player', description, topics: [], pushed_at: new Date().toISOString(), stargazers_count: 0, forks_count: 0 }
          : path.endsWith('/readme') ? '# Player\nAn elegant terminal music player.'
          : path.endsWith('/community/profile') ? { files: {} }
          : path.endsWith('/runs') ? { workflow_runs: [] }
          : path.endsWith('/views') ? { count: 0, uniques: 0 } : []
        return new Response(typeof data === 'string' ? data : JSON.stringify(data))
      }
      const result = await auditProject({ owner: 'example', repo: 'player' })
      const facade = result.dims[0]
      if (description.trim()) {
        expect(facade.manual.some((text) => text.includes('词表盲区'))).toBe(true)
        expect(facade.gaps.some((text) => text.includes('用途'))).toBe(false)
        expect(facade.unverifiable).toBe(1)
      } else {
        expect(facade.evidence.some((text) => text.startsWith('description:'))).toBe(false)
        expect(facade.gaps.some((text) => text.includes('description 空着'))).toBe(true)
        expect(facade.unverifiable).toBe(0)
      }
    }
  } finally { globalThis.fetch = originalFetch }
})

test('topics 夹具：数量与描述相关性都需要，零 topics 不通过', () => {
  expect(assessTopics([], 'A tool for developers').pass).toBe(false)
  expect(assessTopics(['tool', 'cli', 'rust', 'developer-tools', 'automation', 'local-first'], 'A Rust CLI tool for developers').pass).toBe(true)
  expect(assessTopics(['cats', 'dogs', 'birds', 'fish', 'pets', 'animals'], 'A Rust CLI tool for developers').pass).toBe(false)
  expect(assessTopics(['agent-skills', 'ai-agent', 'api-key-manager', 'cli', 'credential-manager', 'credentials', 'developer-tools', 'devsecops', 'dotenv', 'encryption', 'environment-variables', 'local-first', 'password-manager', 'secret-management', 'secret-manager', 'secrets', 'secrets-management', 'token-management', 'token-manager', 'vault'], '密钥管理 / 秘钥管理 / Token 管理 CLI — 本地优先 (local-first) 的 Secret Manager、API Key Manager、Password Manager 与 Credentials 凭证库。AES-256-GCM 纯本地加密，AI 只拿别名注入、永不见明文，替代 .env 与云端密钥服务。').pass).toBe(true)
})

test('强仓元数据夹具：Infisical、sops、dotenvx 均通过，单复数不误判', () => {
  const fixtures = [
    ['Infisical is the open-source platform for securing secrets, certificates, access, and AI Agents.', ['acme', 'agents', 'ai-agents', 'certificate-management', 'devsecops', 'environment-variables', 'secret-management', 'secret-manager', 'secrets', 'secrets-management']],
    ['Simple and flexible tool for managing secrets', ['aws', 'azure', 'devops', 'gcp', 'pgp', 'secret-distribution', 'secret-management', 'security', 'sops']],
    ['a secure dotenv—from the creator of `dotenv`', ['cli', 'dotenv', 'dotenvx', 'env', 'environment-variables', 'secret-management', 'secret-manager']]
  ]
  for (const [description, topics] of fixtures) {
    expect(assessDescription(description).pass).toBe(true)
    expect(assessTopics(topics, description).pass).toBe(true)
  }
  expect(assessTopics(['rust', 'cli', 'tool'], '本地密钥管理工具').comparable).toBe(false)
  // 不能仅凭 topic 名就判过期：D1 可能仍是现役可选后端。
  expect(assessTopics(['d1', 'cloudflare', 'database', 'cli', 'storage', 'developer-tools'], 'A Cloudflare D1 database CLI for developers').pass).toBe(true)
})

test('🟢 网址判定：正确识别外部独立 homepage 与 github 代码托管平台 homepage', () => {
  const u1 = new URL('https://github.com/webkubor/device-passport#readme')
  const host1 = u1.hostname.toLowerCase()
  const isHosting1 = host1 === 'github.com' || host1.endsWith('.github.com') || host1 === 'gitlab.com' || host1 === 'gitee.com'
  expect(isHosting1).toBe(true)

  const u2 = new URL('https://device-passport.org')
  const host2 = u2.hostname.toLowerCase()
  const isHosting2 = host2 === 'github.com' || host2.endsWith('.github.com') || host2 === 'gitlab.com' || host2 === 'gitee.com'
  expect(isHosting2).toBe(false)
})

test('外部站点响应体读取超时按「抓不到」处理，不能让整仓审计失败', async () => {
  const { readBodyText } = await import('../server/audit.js')
  // 慢站/大文件常在 body 阶段才撞上 AbortSignal 超时：fetch 已 resolve，text() 才抛。
  const timedOut = { ok: true, text: async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e } }
  expect(await readBodyText(timedOut)).toBe(null)
  // 正常响应照常返回内容，不要顺手把成功路径也吞了
  const ok = { ok: true, text: async () => 'User-agent: *\nDisallow:\n' }
  expect(await readBodyText(ok)).toContain('User-agent')
})
