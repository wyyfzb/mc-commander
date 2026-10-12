#!/usr/bin/env node
/**
 * 目录结构门禁：把「东西该放哪」写成可执行判据，拦截乱放。
 *
 * 判定面 = git 已跟踪条目 ∪ 未被忽略的未跟踪条目，且**当前存在于工作树**——纯删除不算，
 * 于是「已删但未提交」的历史路径不会误报，而「新增没登记」当场转红。
 * 三条判据：
 *   ① 顶层条目必须在白名单内：新增顶层目录/文件要走一次显式登记（登记处就在本文件）；
 *   ② `apps/*` 内不得出现测试、不得出现非 README 的 Markdown——测试归 `tests/`，文档归 `docs/`；
 *   ③ 运行期与构建产物不得入库——包是交付物，不是数据落地处（无例外：契约包 `dist`
 *      同样是构建产物，服务端经 workspace 链接消费，谁消费谁先 `build`）。
 *
 * 用法：`node tools/check-layout.mjs`（位置无关，仓库根按 `.git` 向上发现）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function findRepoRoot(from) {
  let d = resolve(from)
  for (;;) {
    if (existsSync(join(d, '.git'))) return d
    const parent = dirname(d)
    if (parent === d) throw new Error(`向上未找到 .git，起点：${from}`)
    d = parent
  }
}

const ROOT = findRepoRoot(SCRIPT_DIR)

// 顶层白名单：文件按名登记，目录按名登记；新增一项就要在这里加一行（否则门禁会拦下来）
const TOP_LEVEL_FILES = new Set([
  'AGENTS.md',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'biome.jsonc',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitleaksignore',
  '.nvmrc',
  // workspace 根配置：engine-strict 等安装期约束只在这一处声明，包内不再各放一份
  '.npmrc',
  'release-please-config.json',
  '.release-please-manifest.json',
])
const TOP_LEVEL_DIRS = new Set(['apps', 'docs', 'tools', '.github'])

// 入库禁止的运行期与构建产物（目录名或文件名，包内任意深度）
const FORBIDDEN_ARTIFACT_DIRS = new Set([
  'node_modules',
  'coverage',
  'data',
  'servers',
  'backups',
  'dist',
  'var',
  'test-results',
  'playwright-report',
  '.vite',
  '.cache',
])
// `.env.example` 一类模板是入库的（它教人怎么配），真正的 env 文件不是
const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i
const FORBIDDEN_ARTIFACT_FILES = /^(\.env(\..+)?|.*\.(log|sqlite|sqlite3|db))$/i

function gitPaths(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

const candidates = [
  ...gitPaths(['ls-files', '-z']),
  ...gitPaths(['ls-files', '-z', '--others', '--exclude-standard']),
]
const tracked = new Set(
  candidates.map((p) => p.split(sep).join('/')).filter((p) => existsSync(join(ROOT, p))),
)

const violations = []

// ① 顶层条目白名单
const topLevel = new Set()
for (const p of tracked) {
  const seg = p.split('/')[0]
  topLevel.add(p.includes('/') ? seg : p)
}
for (const entry of topLevel) {
  if (TOP_LEVEL_FILES.has(entry) || TOP_LEVEL_DIRS.has(entry)) continue
  const isDir = existsSync(join(ROOT, entry)) && statSync(join(ROOT, entry)).isDirectory()
  violations.push(
    `顶层出现未登记条目「${entry}${isDir ? '/' : ''}」——确认落点后登记到 tools/check-layout.mjs`,
  )
}

// ② 源码面不得混入测试；包内不得放非 README 文档
const isUnderSrc = (p) => /^apps\/[^/]+\/src\//.test(p)
for (const p of tracked) {
  if (!p.startsWith('apps/')) continue
  const segments = p.split('/')
  const isTestCase = /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
  if (segments.includes('__tests__') || (isUnderSrc(p) && isTestCase)) {
    violations.push(`源码面不得混入测试：「${p}」——测试住同包 tests/（web 镜像到 tests/unit/）`)
    continue
  }
  if (/\.mdx?$/.test(p) && !/^apps\/[^/]+\/README\.md$/.test(p)) {
    violations.push(`包内不得放文档：「${p}」——公开文档归 docs/，说明文件只留包根 README.md`)
  }
  if (/^apps\/[^/]+\/\.gitignore$/.test(p)) {
    violations.push(
      `包内不得放 .gitignore：「${p}」——忽略规则统一住仓库根 .gitignore（包内补丁会让规则散成多份）`,
    )
  }
}

// ③ 运行期与构建产物不得入库
for (const p of tracked) {
  const segments = p.split('/')
  const badDir = segments.slice(0, -1).find((s) => FORBIDDEN_ARTIFACT_DIRS.has(s))
  if (badDir) {
    violations.push(`入库面不得含产物目录「${badDir}」：「${p}」`)
    continue
  }
  if (!ENV_TEMPLATE.test(segments.at(-1)) && FORBIDDEN_ARTIFACT_FILES.test(segments.at(-1))) {
    violations.push(`入库面不得含运行期文件：「${p}」`)
  }
}

if (violations.length > 0) {
  console.error(`✗ 目录结构门禁未通过（${violations.length} 项）`)
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log(
  `✓ 目录结构门禁通过：顶层 ${topLevel.size} 项、入库条目 ${tracked.size} 项（包内无测试与文档，无运行期产物）`,
)
