import { test, expect } from 'bun:test'
import { auditProject } from '../server/audit.js'

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
