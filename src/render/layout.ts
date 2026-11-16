/**
 * render/layout —— 工地鱼在屏幕上的摆放几何（纯函数，可在 Node 里直接测）。
 *
 * 两个都容易算错，所以从 widget 里抽出来：
 *
 * 1. **翻转后的左边界**：`transform: scaleX(-1)` 以盒子中心镜像，
 *    格子里的锚点从 `anchorX` 变成 `1-anchorX`。要让"锚点仍落在 targetX"，
 *    左边界必须从 `targetX - anchorX*w` 换成 `targetX - (1-anchorX)*w`，
 *    否则往左走的瞬间人会横向跳 `(1-2*anchorX)*w` 像素。
 *
 * 2. **前后层**：拿两者"脚底线"的屏幕 y 比，谁更靠下谁在前。
 */

/** 让锚点落在 targetX 时，容器应该放的 left（px）。 */
export function workerLeft(targetX: number, anchorX: number, width: number, facing: 1 | -1): number {
  const effective = facing === 1 ? anchorX : 1 - anchorX
  return targetX - effective * width
}

/** 左右移动 → 朝向。位移小于 1px 视为"没动"，保持原朝向（避免抖）。 */
export function facingFor(prevX: number, nextX: number, current: 1 | -1): 1 | -1 {
  const dx = nextX - prevX
  if (Math.abs(dx) < 1) return current
  return dx > 0 ? 1 : -1
}

/** 前后层：worker 的脚底线比母体更靠下 ⇒ 在母体前面。 */
export function depthFor(workerGroundY: number, mainGroundY: number): 'front' | 'behind' {
  return workerGroundY > mainGroundY ? 'front' : 'behind'
}
