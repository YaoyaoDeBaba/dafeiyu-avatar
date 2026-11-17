/**
 * render/behavior —— 工地鱼的"行为表"（纯逻辑，可单测、可外置覆盖）。
 *
 * 为什么要外置：手感类参数（跑多快、停多久、干活概率、游走半径）会反复调，
 * 埋在代码里每调一次就得改代码 + 重新构建 + 重启宿主。现在三层覆盖：
 *
 *   DEFAULT_BEHAVIOR（本文件的默认值）
 *     ← <avatarDir>/avatar-config.json（宿主路由 GET /avatar/config，改文件即生效）
 *     ← window.__dafeiyuAvatarConfig.behaviors（控制台临时调，优先级最高）
 *
 * 所有时间单位都是毫秒，距离单位是 px。
 */

export interface SwarmBehavior {
  /** 工地鱼显示高度（px）。宽度按格子宽高比自动算。 */
  height: number
  /** 移动速度（px/s）：跑动距离 ÷ 速度 = 动画时长，保证"跑多远走多久"。 */
  moveSpeed: number
  /** 单次移动的最短/最长时长（ms），防止极短距离瞬移、极远距离拖太久。 */
  minMoveMs: number
  maxMoveMs: number
  /** 停下来干活的时长区间（ms）。 */
  workMs: [number, number]
  /** 到点后"停下来干活"的概率（0~1），其余是继续跑。 */
  workChance: number
  /** 两次行为之间的静止间隔（ms）。 */
  idleMs: [number, number]
  /** 游走时相对母体锚点的水平偏移区间（px），负数在左、正数在右。 */
  offsetXRange: [number, number]
  /** 垂直偏移区间（px，相对母体脚底线，往下为正）。 */
  offsetYRange: [number, number]
  /** 干活动作池（会在 manifest 里过滤掉没有的）。 */
  workClips: string[]
  /** 跑动动作。 */
  runClip: string
  /** 站着不动时播的动作（避免"原地跑步"）。 */
  idleClip: string
}

export const DEFAULT_BEHAVIOR: SwarmBehavior = {
  height: 96,
  moveSpeed: 34,
  minMoveMs: 1400,
  maxMoveMs: 3200,
  workMs: [3500, 6000],
  workChance: 0.55,
  idleMs: [1600, 3400],
  offsetXRange: [44, 114],
  offsetYRange: [4, 14],
  workClips: ['worker_screw', 'worker_brick', 'worker_look'],
  runClip: 'worker_run',
  idleClip: 'worker_look',
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const pair = (value: unknown, fallback: [number, number]): [number, number] => {
  if (!Array.isArray(value) || value.length < 2) return fallback
  const low = num(value[0], fallback[0])
  const high = num(value[1], fallback[1])
  return low <= high ? [low, high] : [high, low]
}

/** 覆盖合并：只认已知字段，区间会纠正顺序，非法值回落默认。 */
export function mergeBehavior(base: SwarmBehavior, patch: unknown): SwarmBehavior {
  // 数组也是 object：当成"没有配置"处理（原样返回，保持引用不变）
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const raw = patch as Record<string, unknown>
  const clips = Array.isArray(raw.workClips)
    ? raw.workClips.filter((id): id is string => typeof id === 'string' && id !== '')
    : base.workClips
  return {
    height: Math.max(32, Math.min(220, num(raw.height, base.height))),
    moveSpeed: Math.max(1, num(raw.moveSpeed, base.moveSpeed)),
    minMoveMs: Math.max(0, num(raw.minMoveMs, base.minMoveMs)),
    maxMoveMs: Math.max(0, num(raw.maxMoveMs, base.maxMoveMs)),
    workMs: pair(raw.workMs, base.workMs),
    workChance: Math.max(0, Math.min(1, num(raw.workChance, base.workChance))),
    idleMs: pair(raw.idleMs, base.idleMs),
    offsetXRange: pair(raw.offsetXRange, base.offsetXRange),
    offsetYRange: pair(raw.offsetYRange, base.offsetYRange),
    workClips: clips.length > 0 ? clips : base.workClips,
    runClip: typeof raw.runClip === 'string' && raw.runClip !== '' ? raw.runClip : base.runClip,
    idleClip: typeof raw.idleClip === 'string' && raw.idleClip !== '' ? raw.idleClip : base.idleClip,
  }
}

/** 距离 → 跑动时长：慢到 minMoveMs、快到 maxMoveMs 之间线性缩放。 */
export function moveDuration(distance: number, behavior: SwarmBehavior): number {
  const raw = (Math.abs(distance) / behavior.moveSpeed) * 1000
  return Math.round(Math.max(behavior.minMoveMs, Math.min(behavior.maxMoveMs, raw)))
}

/** 区间里取一个值（random 可注入，便于单测）。 */
export function pickIn(range: [number, number], random: () => number = Math.random): number {
  return Math.round(range[0] + (range[1] - range[0]) * random())
}

/** 该不该停下来干活。 */
export function shouldWork(behavior: SwarmBehavior, random: () => number = Math.random): boolean {
  return random() < behavior.workChance
}
