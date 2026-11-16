/**
 * dsh-avatar-dafeiyu —— 大肥鱼-形象的**宿主侧**入口。
 *
 * 只做一件事：把三条只读路由挂到宿主的 `webServer`（软探测，挂不上不影响主链路）。
 * 素材目录与 schema 与大肥鱼本体共用（契约见 `host/manifest.ts` 的注释）：
 *   - 本体仍要能读素材发给手机（`cmd.avatar_manifest` / `cmd.avatar_sheet` 走协议，不走 HTTP）；
 *   - 本插件负责浏览器面（悬浮形象、设置面板、图集路由）。
 *
 * 纪律（与本体一致）：`apply()` 绝不向外抛异常——宿主加载 bundle 时抛出会让整个 profile 起不来。
 */
import path from 'node:path'
import { startAvatar, type AvatarHandle } from './host/start.js'

interface LooseContext {
  get?: (name: string, strict?: boolean) => unknown
  inject?: (names: string[], callback: (scoped: unknown) => void) => void
  effect?: (factory: () => (() => void) | void) => void
  on?: (event: string, listener: () => void) => void
}

/** `DSH_HOME`（或 `~/.dsh`）——与本体 `resolveDshHome` 同一套派生规则。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.DSH_HOME ?? '').trim()
  if (explicit !== '') return explicit
  const home = (env.USERPROFILE ?? env.HOME ?? '').trim()
  return home === '' ? path.join('.') : path.join(home, '.dsh')
}

export function apply(ctx: LooseContext): void {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      // eslint-disable-next-line no-console
      console.log(`[avatar] ${message}`, extra ?? '')
    } catch {
      /* 日志不许抛 */
    }
  }

  let handle: AvatarHandle | undefined
  try {
    handle = startAvatar(ctx as never, { dshHome: resolveDshHome(process.env), log })
  } catch (error) {
    handle = undefined
    log('形象素材路由起不来（不影响其它功能）', {
      message: String((error as Error)?.message ?? error).slice(0, 200),
    })
  }

  const stop = (): void => {
    try {
      handle?.stop()
    } catch {
      /* 停止不许抛 */
    }
  }

  // 生命周期：优先 effect（cordis 的标准写法），退而求其次挂 dispose 事件。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => stop)
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', stop)
    }
  } catch {
    /* ignore */
  }
}
