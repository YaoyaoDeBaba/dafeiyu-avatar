/**
 * dsh-avatar-dafeiyu —— 浏览器半边入口。
 *
 * ⚠️ `export const name` **必须等于包名**：`@deepseek-ai/dsh-client-modules` 按 loader entry 名
 * 索引这一半，名字对不上就静默不挂载（不报错、不崩，最难查）。本仓库历史上栽过一次。
 *
 * 这一半只挂悬浮形象（聊天页左下角）。设置页里的形象面板由宿主页面按需引用
 * `./panel.ts` 的 `buildAvatarPanel()`（见 README「设置面板怎么接」），不在这里自动注册。
 */
import { resolveHostUrl } from './host-url.js'
import { mountAvatarWidget } from './widget.js'
import { registerAvatarRoom } from './room.js'

export const name = 'dsh-avatar-dafeiyu'

/** `slots` 是这一代会话界面的稳定服务名（官方插件同款写法）。 */
export const inject = ['slots']

interface ClientContext {
  get?<T>(name: string, optional?: true): T | undefined
  slots?: unknown
}

function swallow(message: string, error: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[avatar] ${message}`, error)
  } catch {
    /* 日志不许抛 */
  }
}

/** 当前选中的会话 id（软探测：服务晚到就返回 undefined，形象保持隐藏）。 */
function resolveCurrentSession(ctx: ClientContext): () => string | undefined {
  const service = (serviceName: string): unknown => {
    try {
      const direct = (ctx as Record<string, unknown>)[serviceName]
      if (direct) return direct
    } catch {
      /* 未声明的服务：属性访问会抛，走 ctx.get */
    }
    try {
      return ctx.get?.(serviceName, true)
    } catch {
      return undefined
    }
  }
  return () => {
    const ui = service('uiSession') as { current?: { getSnapshot?: () => unknown; value?: unknown } } | undefined
    try {
      const binding = ui?.current
      const snap = binding?.getSnapshot ? binding.getSnapshot() : binding?.value
      const key =
        typeof snap === 'object' && snap !== null
          ? ((snap as { key?: unknown; sessionId?: unknown }).key ?? (snap as { sessionId?: unknown }).sessionId)
          : undefined
      if (typeof key === 'string' && key !== '') return key
    } catch {
      /* 界面服务还没起来：继续试下一条 */
    }
    const sessions = service('sessions') as { list?: { getSnapshot?: () => { current?: unknown } } } | undefined
    try {
      const current = sessions?.list?.getSnapshot?.()?.current
      if (typeof current === 'string' && current !== '') return current
    } catch {
      /* 同上 */
    }
    return undefined
  }
}

export function apply(ctx: ClientContext): (() => void) | void {
  let cleanup: (() => void) | undefined
  try {
    cleanup = mountAvatarWidget({
      getCurrentSession: resolveCurrentSession(ctx),
      onMenuAction: (id) => {
        // 独立包没有本体那些面板（子代理/识图/转生/序列帧工具），
        // 菜单项只保留"打开形象素材目录说明页"这一类安全动作。
        if (id === 'sprite') {
          ;(globalThis as { open?: (url: string, target?: string) => unknown }).open?.(
            resolveHostUrl('/api/dsh-remote-dafeiyu/avatar/manifest'),
            '_blank',
          )
        }
      },
    })
  } catch (error) {
    swallow('avatar widget mount failed (swallowed)', error)
  }

  // 设置页「形象」房间（大肥鱼 .84 的房间注册制）。
  // 宿主版本旧、没有注册表时 registerAvatarRoom() 静默返回 undefined —— 不算故障。
  let room: { stop: () => void } | undefined
  void registerAvatarRoom()
    .then((handle) => {
      room = handle
    })
    .catch((error: unknown) => swallow('avatar room register failed (swallowed)', error))

  return () => {
    try {
      cleanup?.()
    } catch {
      /* cleanup 不许抛 */
    }
    try {
      room?.stop()
    } catch {
      /* unregister 不许抛 */
    }
  }
}
