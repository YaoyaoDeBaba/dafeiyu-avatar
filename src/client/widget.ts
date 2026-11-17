/**
 * avatar-widget — 聊天页的虚拟形象小窗（0.21：双层交叉切换，杜绝闪白）。
 *
 * 闪白的原因不是“图没预加载”，而是单层元素换 background-image 时，浏览器要重新
 * 光栅化这一层（尤其大图 + drop-shadow），中间会有一帧空白。修法：两块同尺寸的
 * 图层，新动作先画在后台层，下一帧再把前后层对调——旧帧一直在，绝不会白。
 *
 * 其余行为不变：默认右上、可拖动并记位置、双击复位、点按逗它（蹭得累）、
 * 待机/干活/交付三个动作池随机播放。
 *
 * ## 2026-11-13：播片节奏搬去 `src/avatar/playback.ts`（修"一抽一抽 + 总重现前几帧"）
 *
 * 这里原来有两套时钟：`clipUntil` 按**墙钟**判"这一片播完了"，`frame` 按 `setInterval`
 * 的拍子推进画面。主线程被页面上的别的模块占住掉一拍（或窗口被遮挡被 throttle）时，
 * 墙钟照样走到点、而帧才画了几张 ⇒ 立刻换片 ⇒ 换片把索引归零 ⇒ **永远只能看到每个动作
 * 的前几帧**，且掉拍越厉害重启越频繁。现在"播完"只看**画了多少帧**（`frames × loops`），
 * 掉拍只会让同一个动作播得慢一点，不跳帧、不回第 0 帧。`ClipPacer` 是纯逻辑，可单测。
 */
import { ClipPacer, type AvatarPool, type ClipSpec, type FrameView } from '../render/playback.js'
import { workerLeft, facingFor, depthFor, swarmCount, WORK_SWARM_MAX } from '../render/layout.js'
import { DEFAULT_BEHAVIOR, mergeBehavior, moveDuration, pickIn, shouldWork, type SwarmBehavior } from '../render/behavior.js'
import { resolveHostUrl } from './host-url.js'

type AvatarStateView = {
  id: string
  label: string
  cols: number
  rows: number
  frames: number
  cellWidth: number
  cellHeight: number
  file: string
  /** 锚点（0~1，y 以格子顶部为 0）；缺省 0.5 / 0.955（历史素材的口径）。 */
  anchorX?: number
  anchorY?: number
}

const BASE = '/api/dsh-remote-dafeiyu/avatar'
const FPS = 24
/**
 * 状态轮询周期（2026-11-17：2500 → 5000）。
 *
 * 这个请求只回答"宿主有没有任务在跑"——秒级精度没有意义，而它原来是一天 24000 发。
 * 5 秒 + 后台不轮询（见 `isHidden`），常驻开销降到原来的 1/4 以下。
 */
const POLL_MS = 5_000
const WIDGET_WIDTH = 132
/** 舞台高度：与 CSS 的 aspect-ratio: 3/4 保持一致。 */
const STAGE_HEIGHT = Math.round((WIDGET_WIDTH * 4) / 3)
/** 锚点落在舞台里的固定位置（脚底靠下、左右居中）——所有动作都对齐到这里。 */
const ANCHOR_SCREEN_X = WIDGET_WIDTH / 2
const ANCHOR_SCREEN_Y = STAGE_HEIGHT - 8
const POS_KEY = 'drc.avatarWidgetPos'
const DRAG_SLOP = 4

/**
 * 每个池子是"候选清单"，抽签时 **按 manifest 里实际存在与否过滤**（pickClip 里已有 available 判断）。
 * 所以这里可以放心写还没有的 id：素材没装就自动跳过，装了就能播——扩容不需要改代码。
 */
const STATE_POOLS: Record<'idle' | 'think' | 'talk', Array<{ id: string; weight: number; loops?: number }>> = {
  idle: [
    { id: 'idle', weight: 40, loops: 2 },
    { id: 'nap', weight: 16, loops: 2 },
    { id: 'eat', weight: 10, loops: 1 },
    { id: 'bubble', weight: 12, loops: 1 },
    { id: 'sad', weight: 8, loops: 1 },
    { id: 'greet', weight: 7, loops: 1 },
    { id: 'think', weight: 7, loops: 1 },
  ],
  think: [
    { id: 'think', weight: 40, loops: 1 },
    { id: 'eat', weight: 12, loops: 1 },
    { id: 'sneak', weight: 8, loops: 1 },
    { id: 'shock', weight: 10, loops: 1 },
    { id: 'angry', weight: 10, loops: 1 },
    { id: 'bubble', weight: 8, loops: 1 },
    { id: 'boss_point', weight: 7, loops: 1 },
    { id: 'boss_whistle', weight: 5, loops: 1 },
  ],
  talk: [
    { id: 'talk', weight: 38, loops: 1 },
    { id: 'dance', weight: 12, loops: 1 },
    { id: 'tsundere', weight: 10, loops: 1 },
    { id: 'greet', weight: 10, loops: 1 },
    { id: 'angry', weight: 9, loops: 1 },
    { id: 'shock', weight: 8, loops: 1 },
    { id: 'boss_point', weight: 8, loops: 1 },
    { id: 'boss_whistle', weight: 5, loops: 1 },
  ],
}
/** 任务开始的瞬间强制播一次"包工头"，播完自动回池子（不常驻）。 */
const BOSS_CLIPS = ['boss_point', 'boss_whistle']
const BOSS_COOLDOWN_MS = 30_000
const POKE_CLIP = 'tsundere'
const POKE_MS = 1800
/** 子代理工地鱼：任务在跑时出现在母体周围，跑动 ↔ 干活交替。 */
const WORK_SWARM_SIZE = 2
const WORK_SWARM_CLIPS = ['worker_screw', 'worker_brick', 'worker_look']
const WORK_SWARM_HEIGHT = 96

export interface AvatarWidgetDeps {
  getCurrentSession: () => string | undefined | null
  /** 点击菜单项：派活助手 / 小云雀 / 肥鱼识图 / 转生 / 分身（入口都收在形象身上）。 */
  onMenuAction?: (id: 'subagents' | 'xyq' | 'vision' | 'rebirth' | 'branch' | 'sprite') => void
}

export function mountAvatarWidget(deps: AvatarWidgetDeps): () => void {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || !doc.body) return () => {}
  const previous = (globalThis as Record<string, unknown>).__dafeiyuAvatarCleanup
  if (typeof previous === 'function') {
    try {
      ;(previous as () => void)()
    } catch {
      /* 旧实例已经拆过 */
    }
  }
  for (const stale of Array.from(doc.querySelectorAll('#dafeiyu-avatar-widget'))) {
    try {
      stale.remove()
    } catch {
      /* ignore */
    }
  }

  const styleId = 'dafeiyu-avatar-widget-style'
  const existing = doc.getElementById(styleId)
  if (existing) existing.remove()
  const style = doc.createElement('style')
  style.id = styleId
  style.textContent = `
#dafeiyu-avatar-widget { position: fixed; left: 24px; top: 96px; width: ${WIDGET_WIDTH}px; z-index: 2147482999;
  display: flex; flex-direction: column; align-items: center; gap: 2px; }
#dafeiyu-avatar-widget[hidden] { display: none !important; }
#dafeiyu-avatar-widget .stage { position: relative; width: ${WIDGET_WIDTH}px; aspect-ratio: 3 / 4;
  border-radius: 12px; cursor: grab; touch-action: none; filter: drop-shadow(0 6px 16px rgba(0,0,0,.25)); }
#dafeiyu-avatar-widget .stage.dragging { cursor: grabbing; }
#dafeiyu-avatar-widget .layer { position: absolute; inset: 0; overflow: hidden;
  pointer-events: none; will-change: opacity; }
#dafeiyu-avatar-widget .cell { position: absolute; left: 0; top: 0;
  background-repeat: no-repeat; pointer-events: none; }
#dafeiyu-avatar-menu { position: absolute; top: calc(100% + 4px); right: 0; width: 168px; padding: 6px;
  display: flex; flex-direction: column; gap: 2px; border-radius: 10px;
  border: 1px solid #1f3b63; background: #0d1117;
  box-shadow: 0 10px 28px rgba(0,0,0,.5); z-index: 3; }
#dafeiyu-avatar-menu[hidden] { display: none !important; }
#dafeiyu-avatar-menu button { display: flex; gap: 8px; align-items: center; width: 100%;
  padding: 7px 9px; border: 0; border-radius: 7px; background: transparent; text-align: left;
  color: #8ab4ff; font-size: 13px; cursor: pointer; }
#dafeiyu-avatar-menu button:hover { background: rgba(75,123,236,.22); color: #cfe0ff; }
`
  doc.head.appendChild(style)

  const wrap = doc.createElement('div')
  wrap.id = 'dafeiyu-avatar-widget'
  wrap.hidden = true
  const stage = doc.createElement('div')
  stage.className = 'stage'
  const layers = [doc.createElement('div'), doc.createElement('div')]
  for (const layer of layers) layer.className = 'layer'
  layers[0]!.style.opacity = '1'
  layers[1]!.style.opacity = '0'
  // 每层里再放一个「单元格」：它只有一格大小，背景是整张 sheet —— 于是相邻格
  // 永远落在它外面（被 layer 的 overflow:hidden 裁掉），不会串帧。
  const cells = layers.map((layer) => {
    const cell = doc.createElement('div')
    cell.className = 'cell'
    layer.appendChild(cell)
    return cell
  })
  let active = 0
  stage.append(layers[0]!, layers[1]!)
  const menu = doc.createElement('div')
  menu.id = 'dafeiyu-avatar-menu'
  menu.hidden = true
  let menuOpen = false
  const toggleMenu = (next?: boolean): void => {
    menuOpen = next ?? !menuOpen
    menu.hidden = !menuOpen
  }
  const addMenuButton = (icon: string, label: string, onClick: () => void): void => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.textContent = `${icon} ${label}`
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      toggleMenu(false)
      onClick()
    })
    menu.appendChild(button)
  }
  addMenuButton('🐝', '派活助手', () => {
    deps.onMenuAction?.('subagents')
    // 用户主动打开派活助手 ⇒ 立刻重算工地鱼个数（不等下一次 SSE / 也不靠轮询）
    refreshWorkersNow()
  })
  addMenuButton('☁️', '小云雀', () => deps.onMenuAction?.('xyq'))
  addMenuButton('🐳', '肥鱼识图', () => deps.onMenuAction?.('vision'))
  addMenuButton('🐟', '一键转生', () => deps.onMenuAction?.('rebirth'))
  addMenuButton('🧬', '一键分身', () => deps.onMenuAction?.('branch'))
  addMenuButton('🎞', '序列帧工具', () => deps.onMenuAction?.('sprite'))
  addMenuButton('😤', '戳一下', () => {
    const spec = specOf(POKE_CLIP, 1)
    if (spec === undefined) return
    // 戳一下是一次性反应：播完这一遍会自动回到当前池子继续（pacer.force 不动 pool）。
    if (pacer.force(spec)) pokeUntil = Date.now() + POKE_MS
  })
  wrap.append(stage, menu)
  doc.body.appendChild(wrap)

  const onDocClick = (event: Event): void => {
    if (!menuOpen) return
    const target = event.target as Node | null
    if (target && wrap.contains(target)) return
    toggleMenu(false)
  }
  doc.addEventListener('click', onDocClick)
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') toggleMenu(false)
  }
  doc.addEventListener('keydown', onKey as EventListener)

  let states: AvatarStateView[] = []
  let current: AvatarStateView | undefined
  let playing = true
  let timer: ReturnType<typeof setInterval> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let lastStatus: 'running' | 'idle' | undefined
  let talkUntil = 0
  let disposed = false
  let placed = false
  let drag: { x: number; y: number; left: number; top: number; moved: boolean } | undefined
  let pokeUntil = 0
  let bossCooldownUntil = 0
  let lastClipId: string | undefined
  let manifestVersion = 0

  /**
   * 页面是不是在后台（2026-11-17 性能修复）。
   *
   * 原来这颗悬浮形象是 **24fps 画 + 2.5 秒轮询，永不暂停**：DSH 开着一天，就是一天
   * 24 次/秒的样式写（`paintWorkers` 每拍改 `backgroundPosition`）+ 每 8 拍一次强制 reflow
   * （那里读 `rectOf(wrap)`），外加 24000 次/天的状态轮询。桌面端（Electron）不像浏览器那样
   * 把后台定时器压到 1Hz，所以**必须自己停**——没人看的画面不值得烧 CPU。
   *
   * 判据口径：`document.hidden` 优先，退到 `visibilityState === 'hidden'`；
   * 假 DOM（测试夹具）里两者都没有 ⇒ 一律当"可见"，行为与改之前完全一致。
   */
  const isHidden = (): boolean => {
    try {
      const d = (globalThis as { document?: { hidden?: boolean; visibilityState?: string } }).document
      if (d?.hidden === true) return true
      return d?.visibilityState === 'hidden'
    } catch {
      return false
    }
  }

  const assetStatus = new Map<string, 'loading' | 'ready' | 'failed'>()
  const assetUrl = (state: AvatarStateView): string =>
    resolveHostUrl(`${BASE}/sheet?id=${encodeURIComponent(state.id)}${manifestVersion > 0 ? `&v=${manifestVersion}` : ''}`)
  const ready = (state: AvatarStateView): boolean => assetStatus.get(state.file) === 'ready'

  /**
   * 预加载一张 sheet。
   *
   * 就绪与否由 `assetStatus` 记账，播片那边每拍问一次 `ready()`——**不再回调里切片**：
   * 回调里直接 `switchTo` 会绕过"素材没就绪就继续放旧片"的保护，是"抽"的老来源之一。
   */
  const ensureAsset = (state: AvatarStateView): void => {
    const known = assetStatus.get(state.file)
    if (known === 'ready' || known === 'failed') return
    assetStatus.set(state.file, 'loading')
    const img = new Image()
    img.onload = () => {
      const done = (): void => {
        assetStatus.set(state.file, 'ready')
      }
      if (typeof img.decode === 'function') img.decode().then(done).catch(done)
      else done()
    }
    img.onerror = () => assetStatus.set(state.file, 'failed')
    img.src = assetUrl(state)
  }

  const viewport = (): { w: number; h: number } => {
    const w = doc.documentElement?.clientWidth || (globalThis as { innerWidth?: number }).innerWidth || 1280
    const h = doc.documentElement?.clientHeight || (globalThis as { innerHeight?: number }).innerHeight || 800
    return { w, h }
  }

  const spriteHeight = (): number => STAGE_HEIGHT

  const anchorOf = (state: AvatarStateView): { x: number; y: number } => ({
    x: typeof state.anchorX === 'number' ? state.anchorX : 0.5,
    y: typeof state.anchorY === 'number' ? state.anchorY : 0.955,
  })

  /**
   * 所有动作共用一个「格像素 → 屏幕像素」比例（取最大的那格刚好放进舞台）。
   * 这样换动作时角色的大小不会跟着格子尺寸跳。
   */
  let displayScale = 1
  const recomputeScale = (): void => {
    let maxW = 0
    let maxH = 0
    for (const state of states) {
      maxW = Math.max(maxW, state.cellWidth)
      maxH = Math.max(maxH, state.cellHeight)
    }
    displayScale = maxW > 0 && maxH > 0 ? Math.min(WIDGET_WIDTH / maxW, STAGE_HEIGHT / maxH) : 1
  }

  const clamp = (x: number, y: number): { x: number; y: number } => {
    const { w, h } = viewport()
    return {
      x: Math.min(Math.max(8, x), Math.max(8, w - WIDGET_WIDTH - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, h - spriteHeight() - 40)),
    }
  }

  const place = (x: number, y: number, persist: boolean): void => {
    const p = clamp(x, y)
    wrap.style.left = p.x + 'px'
    wrap.style.top = p.y + 'px'
    placed = true
    if (persist) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(p))
      } catch {
        /* ignore */
      }
    }
  }

  const defaultPosition = (): { x: number; y: number } => {
    const { w } = viewport()
    return { x: w - WIDGET_WIDTH - 24, y: 96 }
  }

  const restoreOrDefault = (): void => {
    let saved: { x?: unknown; y?: unknown } | null = null
    try {
      const raw = localStorage.getItem(POS_KEY)
      saved = raw ? (JSON.parse(raw) as { x?: unknown; y?: unknown }) : null
    } catch {
      saved = null
    }
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(Number(saved.x), Number(saved.y), false)
    else {
      const p = defaultPosition()
      place(p.x, p.y, false)
    }
  }

  /** 把一帧画到当前可见格上（**只画**，不推进进度——进度归 `ClipPacer`）。 */
  const drawFrame = (view: FrameView): void => {
    const state = current
    if (state === undefined) return
    const cellW = state.cellWidth > 0 ? state.cellWidth : 1
    const cellH = state.cellHeight > 0 ? state.cellHeight : 1
    const scale = displayScale
    const cell = cells[active]
    if (cell === undefined) return
    cell.style.backgroundPosition = `${-view.col * cellW * scale}px ${-view.row * cellH * scale}px`
  }

  /**
   * 双层切换：新动作先画在后台层并抬到最上层，**等下一帧**再把旧层隐藏。
   * 这样即使新层这一帧还没被浏览器合成，旧帧仍然完整可见，不会闪白。
   */
  let swapping = false
  let pendingHide: HTMLDivElement | undefined
  /** 上一次切换还没等到 rAF 就把旧层收掉（页面被遮挡时 rAF 可能一整段时间不跑，不能让它卡住换片）。 */
  const finishSwap = (): void => {
    if (pendingHide !== undefined) {
      pendingHide.style.opacity = '0'
      pendingHide.style.zIndex = '1'
      pendingHide = undefined
    }
    swapping = false
  }

  const switchTo = (state: AvatarStateView): void => {
    // 上一次换片的 rAF 还没来（同一拍里连切，或 rAF 被 throttle）：先收尾再切。
    // **不能像以前那样 `return`**——那会把 current/active 留在旧动作上，
    // 而进度已经归零，画面就成了"新片的第 0 帧 + 旧片的格子几何"。
    if (swapping) finishSwap()
    const previousIndex = active
    const next = 1 - active
    const layer = layers[next]!
    const cell = cells[next]!
    const previousLayer = layers[previousIndex]!
    // 单元格只有「一格」大小，背景却是整张 sheet：相邻格永远在它外面，被裁掉。
    const scale = displayScale
    const cellW = state.cellWidth > 0 ? state.cellWidth : 1
    const cellH = state.cellHeight > 0 ? state.cellHeight : 1
    const anchor = anchorOf(state)
    cell.style.width = `${cellW * scale}px`
    cell.style.height = `${cellH * scale}px`
    // 单元格左上角 = 锚点落点 - 锚点在格内的偏移
    cell.style.left = `${ANCHOR_SCREEN_X - anchor.x * cellW * scale}px`
    cell.style.top = `${ANCHOR_SCREEN_Y - anchor.y * cellH * scale}px`
    cell.style.backgroundImage = `url(${assetUrl(state)})`
    cell.style.backgroundSize = `${state.cols * cellW * scale}px ${state.rows * cellH * scale}px`
    cell.style.backgroundPosition = '0px 0px'
    layer.style.zIndex = '2'
    layer.style.opacity = '1'
    active = next
    current = state
    swapping = true
    pendingHide = previousLayer
    requestAnimationFrame(finishSwap)
  }

  const available = (id: string): boolean => states.some((state) => state.id === id)

  const pickClip = (pool: Array<{ id: string; weight: number; loops?: number }>): { id: string; loops: number } | undefined => {
    const options = pool.filter((entry) => available(entry.id))
    if (options.length === 0) return undefined
    const fresh = options.filter((entry) => entry.id !== lastClipId)
    const use = fresh.length > 0 ? fresh : options
    const total = use.reduce((sum, entry) => sum + entry.weight, 0)
    let roll = Math.random() * total
    for (const entry of use) {
      roll -= entry.weight
      if (roll <= 0) return { id: entry.id, loops: entry.loops ?? 1 }
    }
    const last = use[use.length - 1]!
    return { id: last.id, loops: last.loops ?? 1 }
  }

  /** manifest 的一行动作 + 池子给的 loops → 一条播片规格。 */
  const specOf = (id: string, loops: number): ClipSpec | undefined => {
    const state = states.find((row) => row.id === id)
    if (state === undefined) return undefined
    return { id: state.id, cols: state.cols, rows: state.rows, frames: state.frames, loops }
  }

  /**
   * 播片节奏（纯逻辑，见 `src/avatar/playback.ts`）。
   *
   * 三个依赖都是**软**的：挑不到片、素材没就绪都只影响"这一拍画什么"，
   * 绝不让进度归零——这正是"越忙越抽"那条反馈链断掉的地方。
   */
  const pacer = new ClipPacer({
    pick: (pool: AvatarPool) => {
      const clip = pickClip(STATE_POOLS[pool])
      if (clip === undefined) return undefined
      lastClipId = clip.id
      return specOf(clip.id, clip.loops)
    },
    available: (spec: ClipSpec) => {
      const state = states.find((row) => row.id === spec.id)
      if (state === undefined) return false
      if (ready(state)) return true
      ensureAsset(state)
      return false
    },
    onSwitch: (spec: ClipSpec) => {
      const state = states.find((row) => row.id === spec.id)
      if (state !== undefined) switchTo(state)
    },
  })

  /** 一拍：问 pacer 要下一帧，有就画。 */
  const paint = (): void => {
    const view = pacer.tick()
    if (view !== undefined) drawFrame(view)
  }

  /**
   * 目标池变化时调这里。
   *
   * `setPool` 同池是 no-op ⇒ 每 2.5s 一次的状态轮询（以及任何别的高频事件）**不可能**
   * 打断正在播的片。
   */
  const enterState = (next: AvatarPool): void => {
    pacer.setPool(next)
  }

  const targetId = (): AvatarPool => {
    const status = (globalThis as Record<string, unknown>).__dafeiyuAvatarStatus as string | undefined
    if (status === 'running') return 'think'
    if (Date.now() < talkUntil) return 'talk'
    return 'idle'
  }

  /* ───────────────── 子代理工地鱼集群 ───────────────── */

  /**
   * 位置模型：工人存的是**相对母体锚点的偏移**（offsetX/offsetY），不是屏幕绝对坐标。
   *
   * 为什么这么定（2026-11-16 修）：早先用"spawn 时的绝对基准 + 随机偏移"，
   * 跟随把绝对坐标挪走之后，下一轮 wander 又按旧基准算 ⇒ 人会被拉回原点。
   * 改成偏移量以后：母体动 ⇒ 所有工人自动跟着动（偏移不变）；wander 只改偏移。
   */
  interface SwarmWorker {
    node: HTMLDivElement
    /** 相对母体锚点（舞台内 ANCHOR_SCREEN_X/Y）的偏移，px。 */
    offsetX: number
    offsetY: number
    facing: 1 | -1
    /** 正在干活（螺丝/砌砖/张望）——此时**不许平移**。 */
    working: boolean
    workTimer?: ReturnType<typeof setTimeout>
    /** 跑动到位的那一刻（到位后决定干活还是站着）。 */
    arriveTimer?: ReturnType<typeof setTimeout>
    /** 站定期间的下一次决策。 */
    stepTimer?: ReturnType<typeof setTimeout>
    /** 跟随母体期间的"急行"截止时刻：这段时间用短过渡，否则会严重滞后。 */
    rushUntil: number
    /** 当前是因为"跟着母体跑"才在播跑动（母体停下就要切回站定）。 */
    followRun?: boolean
    frame: number
    anchorX: number
    anchorY: number
    width: number
    height: number
    meta?: { cols: number; rows: number; frames: number }
  }

  const swarm: SwarmWorker[] = []
  let lastMainRect: { left: number; top: number; width: number; height: number } | undefined
  let followTick = 0

  /** 宿主/用户在控制台改 `window.__dafeiyuAvatarConfig.workers` 即可开关这些行为。 */
  interface SwarmConfig {
    enabled: boolean
    count: number
    flip: boolean
    depth: boolean
    follow: boolean
    /** 是否按"在跑的子代理数"决定个数（关掉 = 退回固定 count 个） */
    followSubagents: boolean
  }
  const swarmConfig = (): SwarmConfig => {
    const raw = (globalThis as Record<string, unknown>).__dafeiyuAvatarConfig as
      | { workers?: Partial<SwarmConfig>; behaviors?: unknown }
      | undefined
    const cfg = raw?.workers ?? {}
    return {
      enabled: cfg.enabled !== false,
      count: typeof cfg.count === 'number' ? Math.max(1, Math.min(4, Math.round(cfg.count))) : WORK_SWARM_SIZE,
      flip: cfg.flip !== false,
      depth: cfg.depth !== false,
      follow: cfg.follow !== false,
      followSubagents: cfg.followSubagents !== false,
    }
  }

  /* ── 行为表（三层覆盖：默认 ← avatar-config.json ← window 覆盖） ── */

  let fileBehavior: unknown = undefined
  let behaviorLoaded = false

  /** 当前生效的行为表。窗口覆盖每次现读（控制台改完立刻生效，不用重启）。 */
  const currentBehavior = (): SwarmBehavior => {
    const raw = (globalThis as Record<string, unknown>).__dafeiyuAvatarConfig as { behaviors?: unknown } | undefined
    let merged = mergeBehavior(DEFAULT_BEHAVIOR, fileBehavior)
    if (raw?.behaviors !== undefined) merged = mergeBehavior(merged, raw.behaviors)
    return merged
  }

  /**
   * 读一次 `<avatarDir>/avatar-config.json`（**只取一次，不是轮询**）。
   * 宿主没有这条路由（版本旧）或文件不存在都静默走默认值。
   */
  const loadBehaviorFile = (): void => {
    if (behaviorLoaded) return
    behaviorLoaded = true
    void (async () => {
      try {
        const response = await fetch(resolveHostUrl(`${BASE}/config`), { signal: AbortSignal.timeout(3000) })
        if (!response.ok) return
        const answer = (await response.json()) as { config?: unknown }
        if (answer.config !== undefined && answer.config !== null) fileBehavior = answer.config
      } catch {
        /* 走默认 */
      }
    })()
  }

  /** 取元素矩形；假 DOM（单测环境）没有 getBoundingClientRect 时回落成 0 矩形。 */
  const rectOf = (element: HTMLElement): { left: number; top: number; width: number; height: number } => {
    try {
      if (typeof element.getBoundingClientRect === 'function') {
        const rect = element.getBoundingClientRect()
        if (rect) return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    } catch {
      /* ignore */
    }
    return { left: 0, top: 0, width: 0, height: 0 }
  }

  /** 母体锚点在屏幕上的坐标（舞台内的锚点位置固定，跟着 wrap 走）。 */
  const mainAnchor = (): { x: number; y: number } => {
    const rect = rectOf(stage)
    return { x: rect.left + ANCHOR_SCREEN_X, y: rect.top + ANCHOR_SCREEN_Y }
  }

  /** 把 offset/facing 落成具体像素；翻转时用 workerLeft 补偿锚点镜像。 */
  const applyWorkerGeometry = (worker: SwarmWorker): void => {
    const cfg = swarmConfig()
    const anchor = mainAnchor()
    const targetX = anchor.x + worker.offsetX
    const targetY = anchor.y + worker.offsetY
    const facing: 1 | -1 = cfg.flip ? worker.facing : 1
    // 干活时**不许有 left 过渡**（否则上一次跑动的 2.6s 还在拖，看起来像原地漂移）；
    // 跟随母体期间用短过渡；其余时候是正常的"跑过去"。
    const rushing = Date.now() < worker.rushUntil
    worker.node.style.transition = worker.working
      ? 'opacity .4s ease'
      : rushing
        ? 'left .35s linear, top .35s linear, opacity .4s ease'
        : 'left 2.6s linear, top .3s ease, opacity .4s ease'
    worker.node.style.left = `${workerLeft(targetX, worker.anchorX, worker.width, facing)}px`
    worker.node.style.top = `${targetY - worker.anchorY * worker.height}px`
    // 翻转是瞬时的（不参与过渡）
    worker.node.style.transform = facing === -1 ? 'scaleX(-1)' : ''
    worker.node.style.zIndex = cfg.depth
      ? depthFor(targetY, anchor.y) === 'front'
        ? '2147483000'
        : '2147482997'
      : '2147482998'
  }

  const setWorkerClip = (worker: SwarmWorker, id: string): void => {
    const state = states.find((row) => row.id === id)
    if (state === undefined) return
    worker.node.style.backgroundImage = `url("${assetUrl(state)}")`
    worker.node.style.backgroundSize = `${state.cols * 100}% ${state.rows * 100}%`
    // 容器必须按"格子宽高比"定尺寸，否则每个动作的格子比例不同 → 小人被拉伸
    const width =
      state.cellWidth > 0 && state.cellHeight > 0
        ? Math.round((currentBehavior().height * state.cellWidth) / state.cellHeight)
        : Math.round(currentBehavior().height * 0.75)
    worker.height = currentBehavior().height
    worker.width = width
    worker.node.style.height = `${worker.height}px`
    worker.node.style.width = `${width}px`
    // 锚点逐条不同（各动画的格子/脚底位置不一样），换片要重新贴一次
    worker.anchorX = typeof state.anchorX === 'number' ? state.anchorX : 0.5
    worker.anchorY = typeof state.anchorY === 'number' ? state.anchorY : 0.992
    worker.frame = 0
    worker.meta = { cols: state.cols, rows: state.rows, frames: state.frames }
    applyWorkerGeometry(worker)
  }

  /** 读元素"当前视觉位置"的 left（过渡进行中的瞬时值），读不到就当没有。 */
  const visualLeft = (worker: SwarmWorker): number | undefined => {
    try {
      const computed = (globalThis as { getComputedStyle?: (element: Element) => CSSStyleDeclaration }).getComputedStyle?.(
        worker.node,
      )
      if (computed === undefined) return undefined
      const value = Number.parseFloat(computed.left)
      return Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 跑动：**按距离算时长**，跑完自动落到"站定/干活"。
   *
   * 这条是"原地跑步"的修法：跑动动作只在**真的在动**的那段时间播，
   * 到位之后立刻换成 `idleClip`（张望）——所以不会再出现"动画在跑、人不动"。
   */
  const runTo = (worker: SwarmWorker, targetOffsetX: number): void => {
    if (!worker.node.isConnected) return
    const distance = targetOffsetX - worker.offsetX
    const behavior = currentBehavior()
    if (Math.abs(distance) < 2) {
      // 太近就别"跑"了，直接站着，下一轮再说
      standStill(worker)
      return
    }
    if (worker.workTimer) clearTimeout(worker.workTimer)
    worker.workTimer = undefined
    worker.working = false
    worker.facing = facingFor(worker.offsetX, targetOffsetX, worker.facing)
    worker.offsetX = targetOffsetX
    setWorkerClip(worker, behavior.runClip)
    // 过渡时长与距离匹配（moveDuration），跑多远就走多久
    const duration = moveDuration(distance, behavior)
    worker.node.style.transition = `left ${duration}ms linear, top .3s ease, opacity .4s ease`
    applyWorkerGeometry(worker)
    worker.arriveTimer = setTimeout(() => {
      if (!worker.node.isConnected) return
      if (shouldWork(currentBehavior())) startWork(worker)
      else standStill(worker)
    }, duration)
  }

  /** 站定：播"张望"这类不动动作，隔一会儿再决定下一步。 */
  const standStill = (worker: SwarmWorker): void => {
    if (!worker.node.isConnected || worker.working) return
    const behavior = currentBehavior()
    setWorkerClip(worker, behavior.idleClip)
    scheduleNext(worker, behavior)
  }

  /** 下一次行为：歇一会儿，然后要么干活、要么跑到新位置。 */
  const scheduleNext = (worker: SwarmWorker, behavior = currentBehavior()): void => {
    if (worker.stepTimer) clearTimeout(worker.stepTimer)
    worker.stepTimer = setTimeout(() => {
      worker.stepTimer = undefined
      if (!worker.node.isConnected) return
      if (worker.working) return
      if (shouldWork(behavior)) {
        startWork(worker)
        return
      }
      const [low, high] = behavior.offsetXRange
      const magnitude = pickIn([low, high])
      const target = (Math.random() < 0.5 ? -1 : 1) * magnitude
      runTo(worker, target)
    }, pickIn(behavior.idleMs))
  }

  /** 原地干活：期间**完全不动**（先把当前视觉位置落定，再贴一次且 left 无过渡）。 */
  const startWork = (worker: SwarmWorker): void => {
    if (worker.working || !worker.node.isConnected) return
    const behavior = currentBehavior()
    // 上一次"跑动"的过渡可能还没走完：先按当前视觉位置反推 offset，
    // 否则切到电钻/搬砖时人还在继续滑（用户报的"原地漂移"就是这个）。
    const left = visualLeft(worker)
    if (left !== undefined) {
      const anchor = mainAnchor()
      const effective = worker.facing === 1 ? worker.anchorX : 1 - worker.anchorX
      worker.offsetX = left + effective * worker.width - anchor.x
    }
    if (worker.arriveTimer) clearTimeout(worker.arriveTimer)
    worker.arriveTimer = undefined
    worker.working = true
    const pool = behavior.workClips.filter((id) => states.some((row) => row.id === id))
    const clip = pool[Math.floor(Math.random() * pool.length)] ?? behavior.idleClip
    setWorkerClip(worker, clip)
    worker.workTimer = setTimeout(() => {
      if (!worker.node.isConnected) return
      worker.working = false
      worker.workTimer = undefined
      // 干完立刻跑开（否则会出现"站着播跑动"的原地走路）
      setWorkerClip(worker, behavior.runClip)
      scheduleNext(worker, behavior)
    }, pickIn(behavior.workMs))
  }


  const spawnWorker = (): void => {
    const cfg = swarmConfig()
    if (!cfg.enabled) return
    const dir = swarm.length % 2 === 0 ? -1 : 1
    const node = doc.createElement('div')
    node.style.cssText =
      'position:fixed;background-repeat:no-repeat;background-position:0 0;pointer-events:none;' +
      'z-index:2147482998;opacity:0;will-change:left,top;'
    doc.body.appendChild(node)

    const worker: SwarmWorker = {
      node,
      // 先出现在母体附近（约 20px），再"跑"到工作位置——这样第一段动画就是真跑动，
      // 不会出现"刚生成就原地跑步"（0.3.2 修）。
      offsetX: dir * 20,
      offsetY: pickIn(currentBehavior().offsetYRange),
      facing: dir === -1 ? -1 : 1,
      working: false,
      rushUntil: 0,
      frame: 0,
      anchorX: 0.5,
      anchorY: 0.992,
      width: Math.round(currentBehavior().height * 0.75),
      height: currentBehavior().height,
    }
    swarm.push(worker)
    // 站定姿态起步（不是跑动姿态）
    setWorkerClip(worker, currentBehavior().idleClip)
    requestAnimationFrame(() => {
      node.style.opacity = '0.95'
    })

    // 行为链：跑出去 → 到位后（干活 | 站定）→ 隔一会儿再来一轮。
    // 不再用一个并行的 wander 定时器（两套调度会互相打架，也会让"跑动/站定"错位）。
    worker.stepTimer = setTimeout(() => {
      worker.stepTimer = undefined
      if (!node.isConnected) return
      runTo(worker, dir * pickIn(currentBehavior().offsetXRange))
    }, 120)
  }

  /** 淡出后移除（任务结束那一瞬不突兀）。 */
  const retireWorker = (worker: SwarmWorker): void => {
    if (worker.workTimer) clearTimeout(worker.workTimer)
    worker.workTimer = undefined
    if (worker.arriveTimer) clearTimeout(worker.arriveTimer)
    worker.arriveTimer = undefined
    if (worker.stepTimer) clearTimeout(worker.stepTimer)
    worker.stepTimer = undefined
    try {
      worker.node.style.opacity = '0'
      setTimeout(() => {
        try {
          worker.node.remove()
        } catch {
          /* ignore */
        }
      }, 320)
    } catch {
      /* ignore */
    }
  }

  /**
   * 对账：屏幕上工地鱼的个数 = `desired`（按"在跑的子代理数"算，封顶 4）。
   * 多退（淡出）少补，不做全量重建——重建会让还在干活的工人闪一下。
   */
  const syncWorkers = (desired: number): void => {
    const cfg = swarmConfig()
    const target = cfg.enabled ? Math.max(0, Math.min(WORK_SWARM_MAX, Math.floor(desired))) : 0
    while (swarm.length > target) {
      const worker = swarm.pop()
      if (worker) retireWorker(worker)
    }
    if (target === 0) return
    // 素材没到齐就等下一次轮询，避免生成一堆空白块
    if (states.length === 0) return
    while (swarm.length < target) spawnWorker()
  }

  /* ───────────────── 在跑的子代理数 ───────────────── */

  /**
   * **不做轮询**（历史上"每 2.5s 拉一次全量列表"把 DSH 拖慢过）。
   *
   * 数据来源优先级：
   *   1. SSE `GET /api/dsh-remote-dafeiyu/subagents/stream` —— 帧里带轻量快照
   *      `{ s: { 父会话id: [总数, 在跑数] } }`，宿主按变化推送并去重，稳态零请求；
   *   2. 兜底：进入 running 时**补一次** `GET /subagents?sessionId=`（30s 节流），
   *      因为 SSE 只在"有变化"时推，刚连上可能还没有帧；
   *   3. 都拿不到 → `undefined`，由 `swarmCount` 回落到固定个数。
   */
  const SUBAGENTS_BASE = '/api/dsh-remote-dafeiyu/subagents'
  let subagentStream: EventSource | undefined
  let runningSubagents: number | undefined
  let subagentFetchAt = 0

  const applySnapshot = (raw: string): void => {
    const session = deps.getCurrentSession?.()
    if (session === undefined || session === null) return
    try {
      const parsed = JSON.parse(raw) as { s?: Record<string, [number, number]> }
      const map = parsed.s
      if (map === undefined || map === null) return
      // 快照里**没有这个会话**：宿主的追踪表里没它（≠"有 0 个子代理"）。
      // 与宿主面板的判断保持一致——没键就不动，避免把已知的 n 抹成 0 再撤掉工人。
      if (!Object.prototype.hasOwnProperty.call(map, session)) return
      const row = map[session]
      if (!Array.isArray(row)) return
      runningSubagents = typeof row[1] === 'number' && Number.isFinite(row[1]) ? Math.max(0, row[1]) : 0
      // 帧到了就立刻对账，不等下一次 2.5s 的状态轮询（否则会有明显的滞后感）
      const cfg = swarmConfig()
      syncWorkers(cfg.followSubagents ? swarmCount(runningSubagents, 0) : cfg.count)
    } catch {
      /* 帧体不是我们认得的形状：保持上一次的值 */
    }
  }

  const ensureSubagentStream = (): void => {
    if (subagentStream !== undefined) return
    const Ctor = (globalThis as { EventSource?: typeof EventSource }).EventSource
    if (typeof Ctor !== 'function') return
    try {
      const stream = new Ctor(resolveHostUrl(`${SUBAGENTS_BASE}/stream`))
      stream.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        // 老宿主的帧体只有 "change"：那就补一次全量（仍受 30s 节流）
        if (event.data === 'change') {
          const session = deps.getCurrentSession?.()
          if (session !== undefined && session !== null) void fetchRunningOnce(session)
          return
        }
        applySnapshot(event.data)
      }
      // EventSource 自己会重连；这里只在"断了"时补一次全量，避免长期没有帧导致计数僵死
      stream.onerror = () => {
        const session = deps.getCurrentSession?.()
        if (session !== undefined && session !== null) setTimeout(() => void fetchRunningOnce(session), 5000)
      }
      subagentStream = stream
    } catch {
      subagentStream = undefined
    }
  }

  const closeSubagentStream = (): void => {
    try {
      subagentStream?.close()
    } catch {
      /* ignore */
    }
    subagentStream = undefined
  }

  const fetchRunningOnce = async (sessionId: string): Promise<void> => {
    const now = Date.now()
    if (now - subagentFetchAt < 30_000) return
    subagentFetchAt = now
    try {
      const response = await fetch(resolveHostUrl(`${SUBAGENTS_BASE}?sessionId=${encodeURIComponent(sessionId)}`), {
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) return
      const answer = (await response.json()) as { ok?: boolean; items?: Array<{ status?: string }> }
      if (answer.ok !== true || !Array.isArray(answer.items)) return
      runningSubagents = answer.items.filter((row) => row.status === 'running').length
    } catch {
      /* 拿不到就保持 undefined → 不显示工地鱼 */
    }
  }

  /**
   * 手动刷新一次工地鱼数量（**用户主动动作**，绕过 30s 节流）。
   *
   * 触发点：
   *   1. 点小窗菜单里的「派活助手」；
   *   2. 宿主/其它代码派发 `dafeiyu:subagents-opened`（面板被打开）；
   *   3. 控制台调 `window.__dafeiyuAvatarRefresh()`。
   * 都只发**一次**请求，不做定时轮询。
   */
  const refreshWorkersNow = (): void => {
    const session = deps.getCurrentSession?.()
    if (session === undefined || session === null) return
    subagentFetchAt = 0
    void (async () => {
      await fetchRunningOnce(session)
      const cfg = swarmConfig()
      syncWorkers(cfg.followSubagents ? swarmCount(runningSubagents, 0) : cfg.count)
    })()
  }

  ;(globalThis as Record<string, unknown>).__dafeiyuAvatarRefresh = refreshWorkersNow
  const onSubagentsOpened = (): void => refreshWorkersNow()
  try {
    globalThis.addEventListener('dafeiyu:subagents-opened', onSubagentsOpened)
  } catch {
    /* ignore */
  }


  /**
   * 工地鱼与主舞台共用一个 24fps 节拍：
   * 推进帧 + 每 8 拍（≈0.33s）同步一次"母体位移"。
   *
   * 跟随规则（按用户反馈定的）：母体一动 ⇒ 工人立刻切回**跑路**并跟着走；
   * 母体停下后，wander 循环会自然把它们带回"干活 ↔ 跑动"的节奏。
   */
  const paintWorkers = (): void => {
    for (const worker of swarm) {
      const meta = worker.meta
      if (meta === undefined) continue
      worker.frame = (worker.frame + 1) % Math.max(1, meta.frames)
      const col = worker.frame % meta.cols
      const row = Math.floor(worker.frame / meta.cols) % meta.rows
      const px = meta.cols > 1 ? (col / (meta.cols - 1)) * 100 : 0
      const py = meta.rows > 1 ? (row / (meta.rows - 1)) * 100 : 0
      worker.node.style.backgroundPosition = `${px}% ${py}%`
    }

    followTick = (followTick + 1) % 8
    if (followTick !== 0 || swarm.length === 0) return

    const rect = rectOf(wrap)
    const previous = lastMainRect
    const cfg = swarmConfig()
    const moved =
      previous !== undefined &&
      (Math.abs(rect.left - previous.left) > 0.5 || Math.abs(rect.top - previous.top) > 0.5)
    lastMainRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }

    // 母体停下：被"跟着跑"打断的工人切回站定，避免停下后还在原地跑步
    if (!moved) {
      for (const worker of swarm) {
        if (worker.followRun === true && worker.working !== true) {
          worker.followRun = false
          standStill(worker)
        }
      }
      return
    }

    if (cfg.follow) {
      const behavior = currentBehavior()
      for (const worker of swarm) {
        // 跟随期间用短过渡（否则 2.6s 的线性过渡会严重滞后）
        worker.rushUntil = Date.now() + 600
        // 跟着走 = 跑路：打断干活，切回跑动
        if (worker.working) {
          if (worker.workTimer) clearTimeout(worker.workTimer)
          worker.workTimer = undefined
          worker.working = false
          worker.followRun = true
          setWorkerClip(worker, behavior.runClip)
          continue
        }
        applyWorkerGeometry(worker)
      }
    } else if (cfg.depth) {
      const ground = mainAnchor().y
      for (const worker of swarm) {
        const targetY = ground + worker.offsetY
        worker.node.style.zIndex = depthFor(targetY, ground) === 'front' ? '2147483000' : '2147482997'
      }
    }
  }




  const refresh = (): void => {
    if (disposed) return
    for (const stale of Array.from(doc.querySelectorAll('#dafeiyu-avatar-widget'))) {
      if (stale !== wrap) {
        try {
          stale.remove()
        } catch {
          /* ignore */
        }
      }
    }
    const session = deps.getCurrentSession?.()
    if (!session) {
      wrap.hidden = true
      // 没有会话：母体藏起来，工人也别留在屏幕上
      syncWorkers(0)
      return
    }
    void (async () => {
      try {
        const response = await fetch(resolveHostUrl(`${BASE}/state?sessionId=${encodeURIComponent(session)}`), {
          signal: AbortSignal.timeout(4000),
        })
        const answer = (await response.json()) as { status?: string }
        const status = answer.status === 'running' ? 'running' : 'idle'
        if (lastStatus === 'running' && status === 'idle') talkUntil = Date.now() + 2000
        const justStarted = lastStatus !== 'running' && status === 'running'
        lastStatus = status
        ;(globalThis as Record<string, unknown>).__dafeiyuAvatarStatus = status
        // 任务开始的这一拍：强制播一次"包工头"（指点/吹哨），播完自动回池子。
        // 冷却 30s，避免连续轮询把包工头反复顶上来。
        if (justStarted && Date.now() > bossCooldownUntil) {
          const bossId = BOSS_CLIPS[Math.floor(Math.random() * BOSS_CLIPS.length)]
          const bossSpec = bossId === undefined ? undefined : specOf(bossId, 1)
          if (bossSpec !== undefined && pacer.force(bossSpec)) {
            pokeUntil = Date.now() + POKE_MS
            bossCooldownUntil = Date.now() + BOSS_COOLDOWN_MS
          }
        }
        /*
         * 工地鱼数量：**SSE 常开**（不再随 running/idle 开关）。
         *
         * 2026-11-17 修（用户报"只有打开派活助手才出现工地鱼"）：
         * 原先是 status 变 idle 就 `runningSubagents = undefined` + 关流，
         * 于是每次状态抖一下就丢掉计数；再想恢复时又被 30s 节流挡住，
         * 期间 syncWorkers(0) 把工人全部撤掉 —— 表现就是"关掉面板工人就没了"。
         * 现在：流常开、计数只由帧/主动拉更新，父代理状态不再参与工地鱼数量的决定。
         */
        ensureSubagentStream()
        if (justStarted) {
          // 进入 running 这一拍强制补一次（不受 30s 节流）：刚连上可能还没有帧
          subagentFetchAt = 0
          void fetchRunningOnce(session)
        } else if (runningSubagents === undefined) {
          void fetchRunningOnce(session)
        }
        const swarmCfg = swarmConfig()
        // 拿不到"在跑的子代理数"就**一个都不出**；能拿到就严格按它（封顶 4）。
        syncWorkers(swarmCfg.followSubagents ? swarmCount(runningSubagents, 0) : swarmCfg.count)
        if (Date.now() < pokeUntil) {
          wrap.hidden = false
          return
        }
        enterState(targetId())
      } catch {
        // 轮询失败**不改变**目标池：以前这里 `enterState('idle')`，于是宿主一忙、这条
        // 4s 超时一响，正在播的片就被切掉重来（"一抽一抽"的第二个来源）。
        // 播片自己会继续（pacer 与轮询无关），等下一次轮询成功再纠正池子。
      }
      wrap.hidden = false
    })()
  }

  // 行为表只取一次（不是轮询）：<avatarDir>/avatar-config.json，没有就用默认值
  loadBehaviorFile()
  void (async () => {
    try {
      const response = await fetch(resolveHostUrl(`${BASE}/manifest?t=${Date.now()}`), {
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      })
      const answer = (await response.json()) as {
        ok?: boolean
        manifest?: { version?: number; states?: AvatarStateView[] } | null
      }
      if (answer.ok === true && answer.manifest && Array.isArray(answer.manifest.states) && answer.manifest.states.length > 0) {
        states = answer.manifest.states
        manifestVersion = typeof answer.manifest.version === 'number' ? answer.manifest.version : 0
        recomputeScale()
        // 预加载全部素材（换动作时才不会白）；开播交给 pacer 的第一拍，
        // 不再在这里直接 switchTo——那会绕过"素材没就绪就等着"的保护。
        for (const state of states) ensureAsset(state)
      }
    } catch {
      /* 没素材就整块隐藏 */
    }
  })()

  const onDown = (event: PointerEvent): void => {
    if (event.button !== undefined && event.button !== 0) return
    drag = { x: event.clientX, y: event.clientY, left: parseFloat(wrap.style.left) || 0, top: parseFloat(wrap.style.top) || 0, moved: false }
    stage.classList.add('dragging')
    try {
      stage.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }
  const onMove = (event: PointerEvent): void => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) drag.moved = true
    if (drag.moved) place(drag.left + dx, drag.top + dy, false)
  }
  const onUp = (): void => {
    if (!drag) return
    const moved = drag.moved
    drag = undefined
    stage.classList.remove('dragging')
    if (moved) {
      place(parseFloat(wrap.style.left) || 0, parseFloat(wrap.style.top) || 0, true)
    } else {
      toggleMenu()
    }
  }
  const onDouble = (): void => {
    const p = defaultPosition()
    place(p.x, p.y, true)
  }
  const onResize = (): void => {
    if (placed) place(parseFloat(wrap.style.left) || 0, parseFloat(wrap.style.top) || 0, false)
  }

  stage.addEventListener('pointerdown', onDown)
  stage.addEventListener('pointermove', onMove)
  stage.addEventListener('pointerup', onUp)
  stage.addEventListener('pointercancel', onUp)
  stage.addEventListener('dblclick', onDouble)
  ;(globalThis as { addEventListener?: (type: string, listener: () => void) => void }).addEventListener?.('resize', onResize)

  // 一个 24fps 的节拍就够：换片由"帧画满了"驱动（pacer），不再要第二个 400ms 的墙钟定时器。
  // 掉拍（主线程被别的模块占用 / 窗口被 throttle）只会让动画播得慢一点。
  timer = setInterval(() => {
    // 后台不画：动画没人看，别烧 CPU（见 isHidden 那段）。
    if (disposed || isHidden()) return
    if (playing) paint()
    paintWorkers()
  }, Math.round(1000 / FPS))
  pollTimer = setInterval(() => {
    if (disposed || isHidden()) return
    refresh()
  }, POLL_MS)
  // 切回前台立刻补一拍：状态可能是后台那几分钟里变的，别等 5 秒。
  const onVisibility = (): void => {
    if (disposed || isHidden()) return
    refresh()
  }
  try {
    doc.addEventListener('visibilitychange', onVisibility)
  } catch {
    /* 没有这个事件的老 DOM 就算了：轮询自己会补上 */
  }
  refresh()

  const dispose = (): void => {
    disposed = true
    closeSubagentStream()
    try {
      doc.removeEventListener('visibilitychange', onVisibility)
    } catch {
      /* ignore */
    }
    try {
      globalThis.removeEventListener('dafeiyu:subagents-opened', onSubagentsOpened)
    } catch {
      /* ignore */
    }
    try {
      delete (globalThis as Record<string, unknown>).__dafeiyuAvatarRefresh
    } catch {
      /* ignore */
    }
    drag = undefined
    if (timer) clearInterval(timer)
    if (pollTimer) clearInterval(pollTimer)
    for (const worker of swarm.splice(0)) {
      try {
        worker.node.remove()
      } catch {
        /* ignore */
      }
    }
    try {
      doc.removeEventListener('click', onDocClick)
      doc.removeEventListener('keydown', onKey as EventListener)
      wrap.remove()
      style.remove()
    } catch {
      /* ignore */
    }
  }
  ;(globalThis as Record<string, unknown>).__dafeiyuAvatarCleanup = dispose
  return dispose
}
