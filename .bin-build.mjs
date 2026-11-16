/**
 * 一键构建：tsc（宿主侧 + 类型检查客户端）→ esbuild（宿主 bundle + 浏览器半 shell）。
 *
 * 与本体仓库 `scripts/bundle-plugin.mjs` 同源，只保留形象需要的部分。
 * 两条硬约束（写错的表现都是"看起来装好了、就是不工作"）：
 *   1. `client.cjs` 必须裹在 `window.__ModuleLoader__.load({ id, factory })` 里，
 *      且 `id` **等于包名**——`@deepseek-ai/dsh-client-modules` 按 loader entry 名索引；
 *   2. 宿主侧 externals 只放宿主注入的东西（`cordis`、`@deepseek-ai/*`），打进包会双实例。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = here
const OUT_DIR = path.join(ROOT, 'dist', 'bundle')
const OUT_FILE = path.join(OUT_DIR, 'index.js')
const CLIENT_OUT = path.join(OUT_DIR, 'client.cjs')
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const BUNDLE_ID = PKG.name

const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
console.log('[build] tsc (host + tests)')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit', cwd: ROOT })
console.log('[build] tsc --noEmit (client typecheck)')
execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.client.json'], { stdio: 'inherit', cwd: ROOT })

const { default: esbuild } = await import(
  pathToFileURL(createRequire(path.join(ROOT, 'package.json')).resolve('esbuild')).href
)

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'index.ts')],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  external: ['cordis', '@deepseek-ai/*'],
  logLevel: 'warning',
})

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'client', 'main.ts')],
  outfile: CLIENT_OUT,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome120',
  sourcemap: false,
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  logLevel: 'warning',
  banner: {
    js:
      `window.__ModuleLoader__.load({\n` +
      `  id: ${JSON.stringify(BUNDLE_ID)},\n` +
      `  factory: (require) => {\n` +
      `    var module = { exports: {} };\n` +
      `    var exports = module.exports;\n`,
  },
  footer: {
    js: `\n    return module.exports;\n  },\n});\n`,
  },
})

const clientText = readFileSync(CLIENT_OUT, 'utf8')
const shape = [
  [clientText.startsWith('window.__ModuleLoader__.load({'), '外壳开头不是 __ModuleLoader__.load'],
  [clientText.includes(`id: ${JSON.stringify(BUNDLE_ID)}`), `外壳里的 id 不是 ${BUNDLE_ID}`],
  [clientText.trimEnd().endsWith('});'), '外壳结尾没闭合'],
]
for (const [ok, message] of shape) {
  if (!ok) {
    console.error(`[build] ${message}：client.cjs 外壳拼错，装上去会让 web boot 失败`)
    process.exit(1)
  }
}

console.log(
  `[build] index.js ${(statSync(OUT_FILE).size / 1024).toFixed(0)} KB、client.cjs ${(statSync(CLIENT_OUT).size / 1024).toFixed(0)} KB（id=${BUNDLE_ID}）`,
)
