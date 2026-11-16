/**
 * client/room —— 向大肥鱼宿主「房间管理器」领一间房（设置页里的「形象」tab）。
 *
 * 背景（2026-11-16 · 大肥鱼 .84）：设置页改成房间注册制，旧的
 * "容器 id + data-filled 标记" 方案已废弃。宿主负责建 tab、切 tab、收房；
 * 本模块负责：`register({ id:'avatar', label:'形象', mount })` + 装修 + **干净地清理**。
 *
 * 三条纪律：
 *   1. 拿不到宿主注册表 = 宿主版本旧 → **静默放弃**，不许 console.error；
 *   2. `mount` 返回的清理函数必须真的干净：清 `setInterval`、摘节点、摘监听；
 *      验收里有一条专门盯"切走 tab 后定时器归零"；
 *   3. `mount` 里自己兜住错误 —— 抛出去只会让宿主显示"这个模块起不来"，
 *      但我们更想在自己那一栏里说清楚原因（素材没装 / 读盘失败）。
 */
import { resolveHostUrl } from './host-url.js'

const BASE = '/api/dsh-remote-dafeiyu/avatar'
const FPS = 24

export interface AvatarStateView {
  id: string
  label: string
  cols: number
  rows: number
  frames: number
  cellWidth: number
  cellHeight: number
  file: string
  anchorX?: number
  anchorY?: number
}

interface RoomHost {
  register(room: {
    id: string
    label: string
    order?: number
    mount: (container: HTMLElement) => (() => void) | void
    onShow?: () => void
    onHide?: () => void
  }): () => void
}

/** 等宿主把注册表挂出来（本体的 client 可能比我们晚加载）。拿不到就静默放弃。 */
function waitForRooms(ms: number): Promise<RoomHost | undefined> {
  const scope = globalThis as unknown as { __dafeiyuRooms?: RoomHost }
  if (scope.__dafeiyuRooms) return Promise.resolve(scope.__dafeiyuRooms)
  return new Promise((resolve) => {
    const finish = (): void => {
      try {
        globalThis.removeEventListener('dafeiyu:rooms-ready', finish)
      } catch {
        /* ignore */
      }
      resolve(scope.__dafeiyuRooms)
    }
    try {
      globalThis.addEventListener('dafeiyu:rooms-ready', finish)
    } catch {
      resolve(undefined)
      return
    }
    setTimeout(finish, ms)
  })
}

const BTN =
  'padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);' +
  'background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;'

function el(tag: string, css: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.style.cssText = css
  if (text !== undefined) node.textContent = text
  return node
}

/** 一间房的完整生命周期：建 UI → 播 → 清理。返回的 dispose 由宿主在切走/卸载时调用。 */
function mountRoom(container: HTMLElement): () => void {
  // 自证用的计数器：验收要求"切走 tab 后定时器归零"，宿主侧可以直接读它。
  const scope = globalThis as unknown as { __dafeiyuAvatarRoomStats?: { mounted: number; disposed: number; timerAlive: boolean } }
  scope.__dafeiyuAvatarRoomStats = scope.__dafeiyuAvatarRoomStats ?? { mounted: 0, disposed: 0, timerAlive: false }
  const stats = scope.__dafeiyuAvatarRoomStats
  stats.mounted += 1
  stats.timerAlive = false

  container.classList.add('avatar-room')
  container.style.cssText = 'display:flex;flex-direction:column;gap:12px;'

  const hint = el('p', 'margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)', '正在读取素材…')
  const bar = el('div', 'display:flex;gap:8px;flex-wrap:wrap;')
  const stageWrap = el('div', 'display:flex;justify-content:center;')
  const controls = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;')
  const playBtn = el('button', BTN, '暂停')
  const anchorBtn = el('button', BTN, '显示锚点')
  const statusText = el('span', 'font-size:12px;color:var(--dsw-alias-label-tertiary)')
  const stage = el('div', 'position:relative;width:100%;max-width:520px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background-repeat:no-repeat;background-position:0% 0%;')
  const overlay = el('div', 'position:absolute;inset:0;pointer-events:none;')

  stage.appendChild(overlay)
  stageWrap.appendChild(stage)
  controls.append(playBtn, anchorBtn, statusText)
  container.append(hint, bar, stageWrap, controls)

  let states: AvatarStateView[] = []
  let version = 0
  let activeId = 'idle'
  let playing = true
  let showAnchor = false
  let frame = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const current = (): AvatarStateView | undefined => states.find((row) => row.id === activeId) ?? states[0]

  const paint = (): void => {
    const state = current()
    if (state === undefined) return
    const col = frame % state.cols
    const row = Math.floor(frame / state.cols) % state.rows
    const px = state.cols > 1 ? (col / (state.cols - 1)) * 100 : 0
    const py = state.rows > 1 ? (row / (state.rows - 1)) * 100 : 0
    stage.style.backgroundPosition = `${px}% ${py}%`
    frame = (frame + 1) % Math.max(1, state.frames)
  }

  const drawAnchor = (): void => {
    overlay.replaceChildren()
    const state = current()
    if (!state || !showAnchor) return
    const ax = typeof state.anchorX === 'number' ? state.anchorX : 0.5
    const ay = typeof state.anchorY === 'number' ? state.anchorY : 0.955
    const hLine = el('div', 'position:absolute;left:0;right:0;height:2px;background:rgba(255,64,64,.9);transform:translateY(-50%)')
    hLine.style.top = `${ay * 100}%`
    const vLine = el('div', 'position:absolute;top:0;bottom:0;width:2px;background:rgba(64,200,255,.9);transform:translateX(-50%)')
    vLine.style.left = `${ax * 100}%`
    const tag = el('div', 'position:absolute;left:6px;top:6px;font-size:11px;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff', `锚点 x=${ax.toFixed(3)} y=${ay.toFixed(3)}`)
    overlay.append(hLine, vLine, tag)
  }

  const applyStage = (): void => {
    const state = current()
    if (state === undefined) return
    const url = `${BASE}/sheet?id=${encodeURIComponent(state.id)}${version > 0 ? `&v=${version}` : ''}`
    stage.style.backgroundImage = `url("${resolveHostUrl(url)}")`
    stage.style.backgroundSize = `${state.cols * 100}% ${state.rows * 100}%`
    const aspect = state.cellWidth > 0 && state.cellHeight > 0 ? state.cellWidth / state.cellHeight : 3 / 4
    stage.style.aspectRatio = String(aspect)
    frame = 0
    paint()
    drawAnchor()
    statusText.textContent = `${state.frames} 帧 · ${FPS}fps · ${playing ? '循环中' : '已暂停'} · 红线=脚底基线 蓝线=中心`
  }

  const restartTimer = (): void => {
    if (timer) clearInterval(timer)
    timer = undefined
    if (disposed || !playing || states.length === 0) return
    timer = setInterval(() => {
      if (playing) paint()
    }, Math.round(1000 / FPS))
    stats.timerAlive = true
  }

  const renderButtons = (): void => {
    bar.replaceChildren()
    for (const state of states) {
      const btn = el('button', state.id === activeId ? `${BTN}background:var(--dsw-alias-bg-secondary);font-weight:600;` : BTN, state.label)
      btn.addEventListener('click', () => {
        activeId = state.id
        renderButtons()
        applyStage()
      })
      bar.appendChild(btn)
    }
  }

  playBtn.addEventListener('click', () => {
    playing = !playing
    playBtn.textContent = playing ? '暂停' : '播放'
    restartTimer()
    applyStage()
  })
  anchorBtn.addEventListener('click', () => {
    showAnchor = !showAnchor
    anchorBtn.textContent = showAnchor ? '隐藏锚点' : '显示锚点'
    drawAnchor()
  })

  void (async () => {
    try {
      const response = await fetch(resolveHostUrl(`${BASE}/manifest?t=${Date.now()}`), { cache: 'no-store' })
      const answer = (await response.json()) as {
        ok?: boolean
        message?: string
        manifest?: { version?: number; states?: AvatarStateView[] } | null
      }
      if (disposed) return
      const manifest = answer.manifest
      if (answer.ok === true && manifest && Array.isArray(manifest.states) && manifest.states.length > 0) {
        states = manifest.states
        version = typeof manifest.version === 'number' ? manifest.version : 0
        if (!states.some((row) => row.id === activeId)) activeId = states[0]!.id
        hint.textContent = `虚拟形象素材（共 ${states.length} 个动作）：24fps 循环，换动作直接点下面的按钮。`
        renderButtons()
        applyStage()
        restartTimer()
      } else {
        hint.textContent = String(answer.message ?? '虚拟形象素材未安装：把 manifest.json 与图集放进 storages/dsh-remote-dafeiyu/avatar/ 即可。')
      }
    } catch (error) {
      if (!disposed) hint.textContent = `读取素材失败：${String((error as Error)?.message ?? error)}`
    }
  })()

  return () => {
    disposed = true
    if (timer) clearInterval(timer)
    timer = undefined
    stats.disposed += 1
    stats.timerAlive = false
    overlay.replaceChildren()
    bar.replaceChildren()
    container.replaceChildren()
  }
}

/**
 * 注册「形象」房间。拿不到宿主注册表就静默返回 undefined（宿主版本旧，不算故障）。
 * 返回 `{ stop }`：把房间撤下来（插件卸载时用）。
 */
export async function registerAvatarRoom(ms = 1500): Promise<{ stop: () => void } | undefined> {
  const host = await waitForRooms(ms)
  if (host === undefined) return undefined
  try {
    const unregister = host.register({
      id: 'avatar',
      label: '形象',
      order: 10,
      mount: (container) => mountRoom(container),
    })
    return { stop: unregister }
  } catch {
    return undefined
  }
}
