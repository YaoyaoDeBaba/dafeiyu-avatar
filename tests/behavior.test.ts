/**
 * behavior.test —— 行为表的合并与推导。
 *
 * 重点不是"能跑"，而是**坏输入不许把画面搞坏**：
 * 文件是用户手改的，写错一个字段（区间反了、概率 2、高度 -5）不该让工地鱼消失或飞出屏幕。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BEHAVIOR, mergeBehavior, moveDuration, pickIn, shouldWork } from '../src/render/behavior.js'

test('默认行为表自洽：区间左 ≤ 右、概率在 0~1', () => {
  const b = DEFAULT_BEHAVIOR
  for (const range of [b.workMs, b.idleMs, b.offsetXRange, b.offsetYRange] as Array<[number, number]>) {
    assert.ok(range[0] <= range[1], `区间反了：${range.join('~')}`)
  }
  assert.ok(b.workChance >= 0 && b.workChance <= 1)
  assert.ok(b.moveSpeed > 0)
  assert.ok(b.workClips.length > 0)
})

test('覆盖合并：只改一个字段，其余保持默认', () => {
  const merged = mergeBehavior(DEFAULT_BEHAVIOR, { workChance: 0.2 })
  assert.equal(merged.workChance, 0.2)
  assert.equal(merged.moveSpeed, DEFAULT_BEHAVIOR.moveSpeed)
  assert.deepEqual(merged.workClips, DEFAULT_BEHAVIOR.workClips)
})

test('覆盖合并：非法值一律回落到默认（不许把画面搞坏）', () => {
  const merged = mergeBehavior(DEFAULT_BEHAVIOR, {
    height: -5, // → 夹到下限 32
    workChance: 2, // → 夹到 1
    moveSpeed: Number.NaN, // → 默认
    workMs: [9000, 1000], // 反了 → 自动交换
    workClips: [], // 空数组 → 默认
    runClip: '', // 空串 → 默认
  })
  assert.equal(merged.height, 32)
  assert.equal(merged.workChance, 1)
  assert.equal(merged.moveSpeed, DEFAULT_BEHAVIOR.moveSpeed)
  assert.deepEqual(merged.workMs, [1000, 9000])
  assert.deepEqual(merged.workClips, DEFAULT_BEHAVIOR.workClips)
  assert.equal(merged.runClip, DEFAULT_BEHAVIOR.runClip)
})

test('覆盖合并：非对象输入直接返回默认', () => {
  for (const bad of [undefined, null, 0, 'x', []]) {
    assert.equal(mergeBehavior(DEFAULT_BEHAVIOR, bad), DEFAULT_BEHAVIOR)
  }
})

test('跑动时长 = 距离/速度，并夹在区间内', () => {
  const b = { ...DEFAULT_BEHAVIOR, moveSpeed: 100, minMoveMs: 500, maxMoveMs: 2000 }
  assert.equal(moveDuration(10, b), 500) // 太近：不瞬移，至少 500ms
  assert.equal(moveDuration(50, b), 500) // 50/100*1000 = 500
  assert.equal(moveDuration(100, b), 1000)
  assert.equal(moveDuration(1000, b), 2000) // 太远：封顶
  assert.equal(moveDuration(-100, b), 1000) // 方向不影响时长
})

test('区间取样与干活概率：random 可注入', () => {
  assert.equal(pickIn([10, 20], () => 0), 10)
  assert.equal(pickIn([10, 20], () => 1), 20)
  assert.equal(pickIn([10, 20], () => 0.5), 15)
  const b = { ...DEFAULT_BEHAVIOR, workChance: 0.3 }
  assert.equal(shouldWork(b, () => 0.29), true)
  assert.equal(shouldWork(b, () => 0.31), false)
})
