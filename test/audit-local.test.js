import { test, expect } from 'bun:test'
import { parseRepos, auditBatch } from '../scripts/audit-local.mjs'

test('本地批审兼容 gh 清单与 REST 格式，去重且拒绝非法目标', () => {
  expect(parseRepos(['a/one', { nameWithOwner: 'a/one' }, { full_name: 'b/two' }, { owner: { login: 'c' }, name: 'three' }])).toEqual(['a/one', 'b/two', 'c/three'])
  expect(() => parseRepos(['https://github.com/a/one'])).toThrow()
})

test('批审遵守并发上限，每仓仅调用一次引擎，结果顺序稳定', async () => {
  let active = 0
  let maximum = 0
  const calls = []
  const results = await auditBatch(['a/one', 'b/two', 'c/three', 'd/four'], {
    concurrency: 2,
    token: 'fixture-only',
    audit: async ({ owner, repo }) => {
      active++
      maximum = Math.max(maximum, active)
      calls.push(`${owner}/${repo}`)
      await new Promise((done) => setTimeout(done, 1))
      active--
      return { project: `${owner}/${repo}`, score: 5 }
    }
  })
  expect(maximum).toBe(2)
  expect(calls.length).toBe(4)
  expect(results.map((r) => r.project)).toEqual(['a/one', 'b/two', 'c/three', 'd/four'])
})

test('异常不回显凭证，单仓失败不阻塞其余仓', async () => {
  const results = await auditBatch(['a/fail', 'b/pass'], {
    audit: async ({ repo }) => {
      if (repo === 'fail') throw new Error('sensitive fixture token')
      return { score: 10 }
    }
  })
  expect(JSON.stringify(results).includes('sensitive')).toBe(false)
  expect(results[0].score).toBe(null)
  expect(results[1].score).toBe(10)
})
