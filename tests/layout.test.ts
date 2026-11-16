/**
 * layout.test —— 工地鱼摆放几何的判据。
 *
 * 这三条都是"算错会看见、但不会报错"的类型：
 *   - 翻转后锚点补偿错 ⇒ 人物横向跳一下；
 *   - 朝向阈值太灵敏 ⇒ 原地抖；
 *   - 层次比较反了 ⇒ 该挡的没挡。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { workerLeft, facingFor, depthFor } from '../src/render/layout.js'

test('朝右时：left = targetX - anchorX*w', () => {
  assert.equal(workerLeft(100, 0.5, 40, 1), 80)
  assert.equal(workerLeft(100, 0.25, 40, 1), 90)
})

test('朝左（scaleX(-1)）时：锚点镜像，left = targetX - (1-anchorX)*w', () => {
  // 锚点 0.25、宽 40：镜像后锚点在盒内 30px 处 ⇒ left = targetX - 30
  assert.equal(workerLeft(100, 0.25, 40, -1), 70)
  // 锚点在正中时，翻转不改变 left（这是最容易忽略的对称点）
  assert.equal(workerLeft(100, 0.5, 40, -1), 80)
  // 翻转前后 left 的差 = (1-2a)*w
  const a = 0.4
  const w = 50
  assert.equal(workerLeft(200, a, w, 1) - workerLeft(200, a, w, -1), Math.round((1 - 2 * a) * w))
})

test('朝向：位移 < 1px 不改朝向（防抖），向右 1、向左 -1', () => {
  assert.equal(facingFor(100, 100.4, -1), -1) // 抖动不动朝向
  assert.equal(facingFor(100, 99.6, 1), 1)
  assert.equal(facingFor(100, 104, -1), 1)
  assert.equal(facingFor(100, 96, 1), -1)
})

test('层次：脚底线更靠下在前；相等时算后（稳定）', () => {
  assert.equal(depthFor(300, 280), 'front')
  assert.equal(depthFor(260, 280), 'behind')
  assert.equal(depthFor(280, 280), 'behind')
})
