import { test, expect, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditProject } from '../server/audit.js'
import { auditPackage } from '../server/audit-npm.js'
import { auditPage } from '../server/audit-page.js'

/*
 * 引擎错误必须带 errorStatus，且 API 层绝不能把它以 502 暴露：
 * 本服务部署在 Cloudflare 后面，代理会把 502 响应体整个换成自己的错误页，
 * 真实原因（仓库不存在 / 被限流 / 上游超时）到不了用户眼前。
 * 这里用 mock 掉的网络层把每类错误钉死，防止回归。
 */

function withMockFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = original })
}

test('GitHub 引擎：上游 404/403/500 分别映射为 errorStatus 404/429/503', async () => {
  const cases = [
    { status: 404, expected: 404 },
    { status: 403, expected: 429 },
    { status: 422, expected: 400 },
    { status: 500, expected: 503 },
  ]
  for (const { status, expected } of cases) {
    await withMockFetch(
      async () => new Response(JSON.stringify({ message: 'fixture' }), { status }),
      async () => {
        const report = await auditProject({ owner: 'example', repo: 'project' })
        expect(report.error).toBe(`仓库读取失败 HTTP ${status}`)
        expect(report.errorStatus).toBe(expected)
        expect(report.score).toBeNull()
      }
    )
  }
})

test('npm 引擎：registry 404 → 404；网络故障（status 0）→ 503', async () => {
  await withMockFetch(
    async (url) => new Response('{}', { status: url.includes('registry') ? 404 : 200 }),
    async () => {
      const report = await auditPackage({ pkg: 'not-a-real-package-xyz' })
      expect(report.error).toBe('registry HTTP 404')
      expect(report.errorStatus).toBe(404)
    }
  )
  await withMockFetch(
    async () => { throw new TypeError('fetch failed') },
    async () => {
      const report = await auditPackage({ pkg: 'any-package' })
      expect(report.error).toBe('registry HTTP fetch failed')
      expect(report.errorStatus).toBe(503)
    }
  )
})

test('page 引擎：主页面 DNS 失败 / HTTP 404 / HTTP 500 都归「目标不可用」，不用 502', async () => {
  await withMockFetch(
    async () => { throw new TypeError('getaddrinfo ENOTFOUND dead.example.com') },
    async () => {
      const report = await auditPage({ url: 'https://dead.example.com' })
      expect(report.error).toContain('主页面 HTTP getaddrinfo')
      expect(report.errorStatus).toBe(404)
    }
  )
  for (const status of [404, 500]) {
    await withMockFetch(
      async (url) => new Response('<html><body>x</body></html>', {
        status: url.includes('dead.example') ? status : 404,
      }),
      async () => {
        const report = await auditPage({ url: 'https://dead.example.com' })
        expect(report.error).toBe(`主页面 HTTP ${status}`)
        expect(report.errorStatus).toBe(404)
      }
    )
  }
})

test('API 层：引擎错误按 errorStatus 出 HTTP 状态码，绝不出 502', async () => {
  process.env.SCORECARD_DATA_DIR = mkdtempSync(join(tmpdir(), 'scorecard-error-status-'))
  const { app } = await import('../server/index.js')

  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    const res = await app.request('/api/scorecard?repo=example/not-exist&fresh=1')
    expect(res.status).toBe(404)
    expect(res.status).not.toBe(502)
    const j = await res.json()
    expect(j.error).toBe('仓库读取失败 HTTP 404')
  } finally {
    globalThis.fetch = original
  }

  // 引擎抛异常（而非返回 error 报告）也要被 getOrAudit 收住，给出可读信息
  try {
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    const res = await app.request('/api/scorecard?repo=example/network-down&fresh=1')
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(502)
    const j = await res.json()
    expect(j.error).toContain('审计引擎异常')
  } finally {
    globalThis.fetch = original
  }
})
