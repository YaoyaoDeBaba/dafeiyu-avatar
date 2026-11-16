/**
 * host/http —— 只读路由要的三个小工具（从大肥鱼本体的 `pill/routes.ts` 摘出来）。
 *
 * 为什么复制而不是依赖本体：这个包要能独立安装，不该把本体拖成 runtime 依赖。
 * 判据与本体保持一致（2026-10-06 那版）：
 *   - `Host` 必须环回（挡 DNS 重绑定）；
 *   - `Origin` 缺席放过（同源 GET 常常不带），存在则必须是环回 http(s) 或 `dsh-app:`。
 * 改这里的判据 = 改安全姿态，两个包要一起改。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const HOST_ORIGIN_SCHEMES = new Set(['dsh-app:'])

/** 去掉端口与 IPv6 方括号，只留主机名。 */
function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return trimmed
    const rest = trimmed.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return trimmed
    return trimmed.slice(0, end + 1)
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon !== -1 && !trimmed.slice(0, colon).includes(':') && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon)
  }
  return trimmed
}

export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOf(host))
}

/** Origin 存在时它必须像"这台宿主自己"：环回的 http(s)，或白名单里的宿主自定义 scheme。 */
function originLooksLikeTheHostItself(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (HOST_ORIGIN_SCHEMES.has(url.protocol)) return true
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/** 只读路由用：Origin 缺席是合法的（同源 GET 常常不带，宿主转发时还会删掉）。 */
export function originIsLoopbackOrAbsent(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  return originLooksLikeTheHostItself(origin)
}

export function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request?.headers?.origin
  if (origin === undefined || origin.trim() === '' || !originLooksLikeTheHostItself(origin)) return
  // 夹具里的 response 可能只有 `writeHead/end`：CORS 是增强项，缺这个能力就安静跳过。
  if (typeof response.setHeader !== 'function') return
  try {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'content-type, x-drc-pair')
    response.setHeader('Access-Control-Max-Age', '600')
  } catch {
    /* ignore */
  }
}

export function preflight(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'OPTIONS') return false
  applyCors(request, response)
  response.writeHead(204, { 'Access-Control-Max-Age': '600', 'Content-Length': '0' })
  response.end()
  return true
}
