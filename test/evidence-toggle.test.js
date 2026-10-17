// 九维明细展开态的回归测试 —— 锁住「进得去出不来」这个 bug。
//
// bug 机制：`:open` 是 Vue 的 prop，父级每次 re-render 都把它写回 DOM。
// 用户手动收起的状态不在 vnode 里，于是被覆盖 —— 表现是点了收不起来。
//
// 这个测试就是那个 bug 的守门人。改动展开态逻辑后必须仍然全绿：
//   ① 低分维度仍然自动展开（不能为了修 bug 把产品决策弄丢）
//   ② 用户收起后，任何 re-render 都不能把它重新弹开
//   ③ 用户点开的维度，重渲染后仍保持展开
import { test } from 'bun:test'

/**
 * 展开态判定逻辑的独立实现。
 *
 * 故意不复用组件里的实现：组件是 .vue 单文件，没法在 bun:test 里直接 import。
 * 这里复刻同一套规则，让测试真正锁住语义而不是锁住实现细节。
 * 若组件里的规则变了，这里必须同步改 —— 下面的「一致性」测试会提醒你。
 */
function makeToggleState() {
  const openState = new Map()   // name -> boolean，用户表过态的维度

  const isDimOpen = (d) => {
    if (openState.has(d.name)) return openState.get(d.name)
    return d.score != null && d.score < 6
  }

  const onDimToggle = (d, domOpen) => {
    if (domOpen === isDimOpen(d)) return // 程序性回写，不算用户手势
    openState.set(d.name, domOpen)
  }

  return { isDimOpen, onDimToggle }
}

const LOW = { name: '发布工程', score: 3 }   // 低分 → 默认展开
const HIGH = { name: '文档', score: 8 }      // 高分 → 默认收起
const UNKNOWN = { name: '度量', score: null } // 判不了 → 默认收起

test('低分维度默认自动展开 —— 这是产品决策，不能在修 bug 时弄丢', () => {
  const { isDimOpen } = makeToggleState()
  if (!isDimOpen(LOW)) throw new Error('低分维度应当默认展开')
  if (isDimOpen(HIGH)) throw new Error('高分维度应当默认收起')
  if (isDimOpen(UNKNOWN)) throw new Error('判不了的维度应当默认收起（null 不参与 <6 判断）')
})

test('用户收起低分维度后，re-render 不得把它重新弹开（这就是那个 bug）', () => {
  const { isDimOpen, onDimToggle } = makeToggleState()

  if (!isDimOpen(LOW)) throw new Error('前置条件：低分维度初始应展开')
  onDimToggle(LOW, false) // 用户点击收起

  if (isDimOpen(LOW)) throw new Error('收起后 isDimOpen 必须仍为 false')
  // 模拟父组件 re-render 100 次：状态在闭包里，判定结果必须稳定
  for (let i = 0; i < 100; i++) {
    if (isDimOpen(LOW)) throw new Error(`第 ${i + 1} 次 re-render 后被重新弹开 —— bug 未修`)
  }
})

test('用户展开高分维度后，重渲染保持展开', () => {
  const { isDimOpen, onDimToggle } = makeToggleState()

  if (isDimOpen(HIGH)) throw new Error('前置条件：高分维度初始应收起')
  onDimToggle(HIGH, true)

  if (!isDimOpen(HIGH)) throw new Error('用户点开后必须保持展开')
  for (let i = 0; i < 100; i++) {
    if (!isDimOpen(HIGH)) throw new Error(`第 ${i + 1} 次 re-render 后被收起`)
  }
})

test('程序性回写不算用户手势 —— 不能形成 toggle 抖动', () => {
  const { isDimOpen, onDimToggle } = makeToggleState()

  // Vue 把 :open 写回 true，与当前判定一致 → 必须被忽略，不能记成用户点开
  onDimToggle(LOW, true)
  if (!isDimOpen(LOW)) throw new Error('低分维度应仍为展开')

  // 真正的抖动场景：DOM 状态与判定一致时反复回写，状态不能被污染成
  // 「用户明确要求关着」—— 否则下一次 re-render 就会保持关闭，与低分默认展开冲突。
  for (let i = 0; i < 50; i++) onDimToggle(LOW, true)
  if (!isDimOpen(LOW)) throw new Error('程序性回写把状态污染了')
})

test('低分维度被收起后，用户再点开能恢复展开（收起不被当成程序回写）', () => {
  const { isDimOpen, onDimToggle } = makeToggleState()

  onDimToggle(LOW, false) // 用户收起低分维度
  if (isDimOpen(LOW)) throw new Error('收起应生效 —— 若这里失败，说明收起被误判成程序回写，bug 会复现')

  onDimToggle(LOW, true) // 用户重新点开
  if (!isDimOpen(LOW)) throw new Error('重新点开应生效')
})

test('分数为 null 的维度不会被 <6 误判成低分', () => {
  const { isDimOpen, onDimToggle } = makeToggleState()
  if (isDimOpen(UNKNOWN)) throw new Error('null 分数不该自动展开')
  // null 维度被收起时，autoOpened 为 false → 记成用户表态
  onDimToggle(UNKNOWN, true)
  if (!isDimOpen(UNKNOWN)) throw new Error('判不了维度被用户点开应保持展开')
})

test('组件里的实现与本测试的规则一致（防止改了组件忘了改测试）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(
    join(import.meta.dir, '../src/components/Scorecard.vue'), 'utf8'
  )
  // 四条判定规则必须在组件里同时存在
  for (const frag of [
    'dimOpenState',
    'dimKnown',
    'isDimOpen',
    'onDimToggle',
    'd.score != null && d.score < 6',
  ]) {
    if (!src.includes(frag)) throw new Error(`Scorecard.vue 缺少「${frag}」，组件与测试规则已漂移`)
  }
  // 旧写法必须消失，否则说明有人把 bug 改回来了
  if (/:open="d\.score != null && d\.score < 6"/.test(src)) {
    throw new Error('Scorecard.vue 又出现了会被强制回写的 :open 直接绑定 —— bug 回归')
  }
})
