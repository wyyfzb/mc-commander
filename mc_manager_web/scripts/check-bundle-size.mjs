#!/usr/bin/env node
/**
 * 首屏与路由首访 JS 体积门禁（gzip 口径）
 *
 * 为什么需要：路由级懒加载后，重依赖一旦被高频路由静态引用就会整块计入该路由
 * 首访体积（exceljs ~900KB 曾因此挂在玩家页），而 CI 此前无任何体积回归拦截。
 *
 * 口径：index.html 引用的入口闭包 + 各路由 chunk 的静态导入闭包，逐文件 gzip 求和。
 * 动态 import() 不计入（按需加载正是要保护的语义）；gzip 取 zlib level 9 最紧压缩，
 * 只要本地与 CI 同口径即可用于回归判定，不代表线上实际传输字节。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const distDir = path.resolve(import.meta.dirname, '../dist')
const assetsDir = path.join(distDir, 'assets')

// 预算 = 当前实测值 + 约 8% 余量，取整到 5KB；上调需在 PR 里说明理由
const BUDGETS = [
  { label: '首屏（index.html 引用闭包）', entry: null, limitKb: 235 },
  { label: '玩家页路由首访', entry: /^players-page-[\w-]+\.js$/, limitKb: 310 },
  { label: '审计页路由首访', entry: /^audit-page-[\w-]+\.js$/, limitKb: 245 },
]

const VERBOSE = process.argv.includes('--verbose')
const gzipCache = new Map()

function gzipKb(file) {
  if (!gzipCache.has(file)) {
    const raw = readFileSync(path.join(assetsDir, file))
    gzipCache.set(file, zlib.gzipSync(raw, { level: 9 }).length / 1024)
  }
  return gzipCache.get(file)
}

/** 静态导入说明符（`from"./x.js"` / 副作用导入 `import"./x.js"`）；动态 import("./x.js") 带括号，天然不匹配 */
const STATIC_IMPORT_RE = /(?:from|import)\s*["']\.\/([^"']+)["']/g

function staticImports(file) {
  const code = readFileSync(path.join(assetsDir, file), 'utf8')
  const names = new Set()
  for (const match of code.matchAll(STATIC_IMPORT_RE)) names.add(match[1])
  return [...names].filter((name) => name.endsWith('.js') && existsSync(path.join(assetsDir, name)))
}

/** 入口闭包：BFS 展开静态导入；动态导入不入队 */
function closure(entries) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(path.join(assetsDir, file))) continue
    seen.add(file)
    queue.push(...staticImports(file))
  }
  return [...seen].sort((a, b) => gzipKb(b) - gzipKb(a))
}

/** index.html 里的 module 脚本与 modulepreload（样式表/图标不计，CSS 另有设计 token 守门） */
function firstScreenEntries() {
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8')
  const refs = new Set()
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.add(match[1])
  for (const match of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) refs.add(match[1])
  return [...refs]
    .filter((ref) => ref.endsWith('.js'))
    .map((ref) => path.basename(ref))
}

function resolveEntry(budget) {
  if (budget.entry === null) return firstScreenEntries()
  const matched = readdirSync(assetsDir).filter((name) => budget.entry.test(name))
  if (matched.length === 0) {
    console.error(`✗ 未找到匹配 ${budget.entry} 的路由 chunk——构建产物命名已变更，请同步本脚本预算配置`)
    process.exit(1)
  }
  return matched
}

if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error(`✗ 未找到 ${path.join(distDir, 'index.html')}——请先执行 npm run build`)
  process.exit(1)
}

let failed = false
console.log('体积门禁（gzip 口径 · zlib level 9）')

for (const budget of BUDGETS) {
  const files = closure(resolveEntry(budget))
  const total = files.reduce((sum, file) => sum + gzipKb(file), 0)
  const over = total > budget.limitKb
  failed ||= over
  const mark = over ? '✗ 超预算' : '✓'
  console.log(
    `  ${mark} ${budget.label.padEnd(26, ' ')} ${String(files.length).padStart(3)} 文件  ` +
      `${total.toFixed(2).padStart(8)} KB / 预算 ${budget.limitKb.toFixed(2)} KB`,
  )
  if (VERBOSE || over) {
    for (const file of files.slice(0, over ? 10 : 5)) {
      console.log(`      ${file.padEnd(44, ' ')} ${gzipKb(file).toFixed(2).padStart(8)} KB`)
    }
  }
}

if (failed) {
  console.error(
    '\n✗ 首屏/路由首访体积超预算：优先检查新增依赖是否被高频路由静态引用（改动态 import 按需加载），' +
      '确属必要增长时在 PR 中说明理由并上调对应预算。',
  )
  process.exit(1)
}

console.log('\n✓ 体积门禁通过')
