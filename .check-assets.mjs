/**
 * check-assets —— 校验形象素材（manifest.json + 图集），不需要浏览器。
 *
 * 为什么要有它：素材是**外部产物**（序列帧工具导出），schema 对了但内容错了的典型形态是
 *   - `anchorY` 用了 y-from-bottom 口径（0=格子底）⇒ 形象整体上下漂；
 *   - `cellWidth/cellHeight` 与图集真实尺寸不符 ⇒ 端上按错误的格子切帧，动作串帧；
 *   - `file` 里带路径 / 文件缺失 ⇒ 路由 404，端上一直等素材；
 *   - `frames` 与 `cols×rows` 不符 ⇒ 播到空帧。
 *
 * 用法：
 *   node check-assets.mjs [素材目录]
 *   素材目录缺省：$DSH_AVATAR_DIR → <DSH_HOME>/storages/dsh-remote-dafeiyu/avatar
 * 目录不存在 ⇒ 打印"素材未安装，跳过"并 exit 0（CI 上没有素材，不该红）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ARG = process.argv[2]

function resolveDir() {
  if (ARG && ARG.trim() !== '') return path.resolve(ARG)
  const explicit = (process.env.DSH_AVATAR_DIR ?? '').trim()
  if (explicit !== '') return path.resolve(explicit)
  const home = (process.env.DSH_HOME ?? '').trim() || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  return path.join(home, 'storages', 'dsh-remote-dafeiyu', 'avatar')
}

/** 只读 WebP 头拿宽高（VP8 / VP8L / VP8X 三种容器），不引入图像库。 */
function webpSize(file) {
  const buf = readFileSync(file)
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return undefined
  let offset = 12
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (fourcc === 'VP8X') {
      const w = buf.readUIntLE(body + 4, 3) + 1
      const h = buf.readUIntLE(body + 7, 3) + 1
      return { width: w, height: h, kind: 'VP8X' }
    }
    if (fourcc === 'VP8 ') {
      if (buf[body + 3] !== 0x9d || buf[body + 4] !== 0x01 || buf[body + 5] !== 0x2a) return undefined
      return { width: buf.readUInt16LE(body + 6) & 0x3fff, height: buf.readUInt16LE(body + 8) & 0x3fff, kind: 'VP8' }
    }
    if (fourcc === 'VP8L') {
      if (buf[body] !== 0x2f) return undefined
      const bits = buf.readUInt32LE(body + 1)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, kind: 'VP8L' }
    }
    offset = body + size + (size % 2)
  }
  return undefined
}

const dir = resolveDir()
const errors = []
const warnings = []

function fail(message) {
  errors.push(message)
}
function warn(message) {
  warnings.push(message)
}

console.log(`[check-assets] 素材目录：${dir}`)

let exists = false
try {
  exists = statSync(dir).isDirectory()
} catch {
  exists = false
}
if (!exists) {
  console.log('[check-assets] 素材未安装，跳过（CI 上没有素材属正常）')
  process.exit(0)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
} catch (error) {
  console.error(`[check-assets] ✖ 读不到 manifest.json：${String(error?.message ?? error)}`)
  process.exit(1)
}

if (typeof manifest?.version !== 'number') warn('manifest.version 缺失（端上会回落 1）')
const states = Array.isArray(manifest?.states) ? manifest.states : []
if (states.length === 0) fail('manifest.states 为空')

const seen = new Set()
const rows = []
let anchorYLow = 0
for (const [index, raw] of states.entries()) {
  const at = `states[${index}]`
  if (!raw || typeof raw !== 'object') {
    fail(`${at} 不是对象`)
    continue
  }
  const id = typeof raw.id === 'string' ? raw.id : ''
  const file = typeof raw.file === 'string' ? raw.file : ''
  if (id === '') fail(`${at} 缺 id`)
  if (seen.has(id)) fail(`${at} id 重复：${id}`)
  seen.add(id)
  if (file === '') fail(`${at}（${id}）缺 file`)
  if (file !== '' && path.basename(file) !== file) fail(`${at}（${id}）file 不许带路径：${file}`)

  const cols = Number(raw.cols)
  const rows_ = Number(raw.rows)
  const frames = Number(raw.frames)
  const cellWidth = Number(raw.cellWidth)
  const cellHeight = Number(raw.cellHeight)
  if (!(cols > 0 && rows_ > 0 && frames > 0)) fail(`${at}（${id}）cols/rows/frames 必须为正数`)
  if (!(cellWidth > 0 && cellHeight > 0)) fail(`${at}（${id}）cellWidth/cellHeight 必须为正数`)

  const anchorX = raw.anchorX
  const anchorY = raw.anchorY
  if (anchorX !== undefined && !(typeof anchorX === 'number' && anchorX >= 0 && anchorX <= 1)) {
    fail(`${at}（${id}）anchorX 越界：${String(anchorX)}`)
  }
  if (anchorY !== undefined) {
    if (!(typeof anchorY === 'number' && anchorY >= 0 && anchorY <= 1)) fail(`${at}（${id}）anchorY 越界：${String(anchorY)}`)
    // 口径哨兵：形象 manifest 是 y-from-top，脚底基线应当接近 1（0.9x）。
    // 若大量条目落在 0.0x，多半是把序列帧 meta 的 y-from-bottom 直接粘过来了。
    else if (anchorY < 0.5) anchorYLow += 1
  }

  const filePath = path.join(dir, file)
  let size
  try {
    size = statSync(filePath)
  } catch {
    fail(`${at}（${id}）图集不存在：${file}`)
    continue
  }
  if (size.size === 0) fail(`${at}（${id}）图集是空文件：${file}`)

  const dims = webpSize(filePath)
  if (dims === undefined) {
    warn(`${at}（${id}）读不出图集尺寸（不是 webp？）：${file}`)
  } else if (cols > 0 && rows_ > 0 && cellWidth > 0 && cellHeight > 0) {
    const wantW = cols * cellWidth
    const wantH = rows_ * cellHeight
    if (Math.abs(dims.width - wantW) > 1 || Math.abs(dims.height - wantH) > 1) {
      fail(
        `${at}（${id}）图集尺寸与格子不符：实际 ${dims.width}×${dims.height}，期望 ${wantW}×${wantH}` +
          `（${cols}×${rows_} 格 × ${cellWidth}×${cellHeight}）`,
      )
    }
  }
  if (cols > 0 && rows_ > 0 && frames > 0 && frames !== cols * rows_) {
    warn(`${at}（${id}）frames=${frames} 与 cols×rows=${cols * rows_} 不符（播到空帧或多播）`)
  }
  rows.push({ id, file, cols, rows: rows_, frames, cellWidth, cellHeight, w: dims?.width, h: dims?.height, anchorX, anchorY })
}

if (anchorYLow > 0 && anchorYLow >= Math.ceil(states.length / 2)) {
  fail(
    `anchorY 口径疑似用错：${anchorYLow}/${states.length} 条的 anchorY < 0.5。` +
      '形象 manifest 要求 **y-from-top**（0=格子顶，脚底基线≈0.99）；序列帧 meta 是 y-from-bottom，别直接粘。',
  )
}

const digest = createHash('sha1')
  .update(rows.map((r) => `${r.id}:${r.w}x${r.h}:${r.frames}`).join('|'))
  .digest('hex')
  .slice(0, 8)

console.log(`[check-assets] ${rows.length} 条状态，指纹 ${digest}`)
for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(12)} ${String(r.cols).padStart(2)}×${String(r.rows).padStart(2)} 帧=${String(r.frames).padStart(2)}` +
      `  格 ${r.cellWidth}×${r.cellHeight}  图 ${r.w ?? '?'}×${r.h ?? '?'}` +
      `  锚 ${typeof r.anchorX === 'number' ? r.anchorX.toFixed(3) : '-'}/${typeof r.anchorY === 'number' ? r.anchorY.toFixed(3) : '-'}`,
  )
}

if (warnings.length > 0) {
  console.log('[check-assets] 警告：')
  for (const message of warnings) console.log(`  ⚠ ${message}`)
}
if (errors.length > 0) {
  console.error('[check-assets] ✖ 发现 %d 个问题：', errors.length)
  for (const message of errors) console.error(`  - ${message}`)
  process.exit(1)
}
console.log('[check-assets] ✔ 素材校验通过')
