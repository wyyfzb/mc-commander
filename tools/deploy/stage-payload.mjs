#!/usr/bin/env node
/**
 * 发布载荷组装器（staging）——产物组成的**唯一声明处**。
 *
 * 为什么必须是白名单：排除清单默认放行，仓库里新增的开发文件会自动随包发出；
 * 而白名单是默认拒绝，未登记的文件一律 fail-closed。发布包是「可运行运行时的安装载荷」，
 * 判据是「谁消费它」——① 运行时进程 ② 安装过程 ③ 目标机运维者，三者都解释不了的就不进。
 *
 * 用法（发布流程与本地直传打包共用同一份实现）：
 *   node tools/deploy/stage-payload.mjs --out <目录> [--source worktree|head]
 *
 * 前置：依赖已安装（根 `npm ci`）。前端与契约包产物由本脚本现场构建（不信任既有 dist）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 载荷白名单：产物里允许出现的**全部**路径。
 * 判据是「谁消费它」——① 运行时进程 ② 安装过程 ③ 目标机运维者；三者都解释不了的就不进。
 *   - `.env.example`：安装脚本据此生成 `.env`（只能带模板，绝不能带真 `.env`）
 *   - `package.json`：运行时版本单一来源（utils/version.js 等读它）+ 安装依赖声明
 *   - `package-lock.json`：本脚本现场生成 ⇒ 用户侧安装可复现
 *   - `src/**`：运行时全部代码（唯一入口 src/index.js）
 *   - `public/**`：前端构建产物（面板 UI + PWA，安装时不再构建）
 *   - `mc-schemas/package.json`：服务端依赖目标的清单（只含运行期字段）
 *   - `mc-schemas/dist/index.js`：服务端 `require('@mc-commander/schemas')` 的实现
 */
export const PAYLOAD = {
  serverFiles: ['.env.example', 'package.json'],
  serverDirs: ['src'],
  publicFrom: 'apps/web/dist',
  schemasFiles: ['package.json', 'dist/index.js'],
  generatedFiles: ['package-lock.json'],
  schemasDirName: 'mc-schemas',
}

/** 载荷里允许的相对路径（前缀匹配用）；`mc-schemas/` 内部再按 schemasFiles 精确判定。 */
export function allowedPaths() {
  const allowed = [
    ...PAYLOAD.serverFiles,
    ...PAYLOAD.generatedFiles,
    ...PAYLOAD.serverDirs.map((d) => `${d}/`),
  ]
  return allowed
}

/**
 * 校验一份产物**文件**清单是否只含白名单内容（只传文件，不传目录）。返回违规路径数组。
 * 单独导出是为了能被测试直接调用（可离线造一棵含多余文件的树来验证它真的会红）。
 */
export function findViolations(relPaths) {
  const violations = []
  for (const rel of relPaths) {
    const ok =
      PAYLOAD.serverFiles.includes(rel) ||
      PAYLOAD.generatedFiles.includes(rel) ||
      PAYLOAD.serverDirs.some((d) => rel.startsWith(`${d}/`)) ||
      rel.startsWith('public/') ||
      PAYLOAD.schemasFiles.some((f) => rel === `${PAYLOAD.schemasDirName}/${f}`)
    if (!ok) violations.push(rel)
  }
  return violations
}

/** 契约包的运行期清单：只保留运行时需要的字段（去 scripts/devDependencies/exports.types/files）。 */
export function runtimePackageJson(pkg) {
  const keep = ['name', 'version', 'description', 'type', 'main', 'license', 'engines']
  const out = {}
  for (const k of keep) if (pkg[k] !== undefined) out[k] = pkg[k]
  // exports 只留运行期入口：types 指向 src/，而 src/ 不进产物，留着就是死指针
  out.exports = { '.': { default: pkg.main ?? './dist/index.js' } }
  return out
}

/**
 * lock 里所有 `resolved` 必须落在公共 registry 上。
 *
 * 判据是「用户机上能不能解析到」：打包机的 npm registry 是可变的（本机默认内网镜像），
 * 而 `npm ci` 严格按 lock 的 `resolved` 取包，不匹配用户配置的 registry 时不会替换。
 * 内网域名在用户机上不存在 ⇒ 装不上。故这里 fail-closed，而不是信任生成参数。
 */
export function findForeignResolved(lockText, allowedHost = 'registry.npmjs.org') {
  // 按条目判，不用全文正则抓 resolved：判据要的是「这一条是不是本地链接」，只有
  // 条目级才看得见 link 标志。
  //
  // 本地链接条目形如 {"resolved": "mc-schemas", "link": true}——指向产物内的 vendor
  // 目录，装机时随包就在盘上，不经 registry。它的 resolved 是裸相对路径、解析不出
  // host，按 host 比对会判成外域而中止打包。
  //
  // 解析成对象再遍历：lock 条目里可以出现嵌套对象（engines / dependencies 等），
  // 用 `[^{}]` 圈范围的正则会在嵌套时整体匹配失败，把带嵌套对象的坏条目静默漏掉。
  let lock
  try {
    lock = JSON.parse(lockText)
  } catch {
    return ['package-lock.json 不是合法 JSON']
  }
  const bad = []
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.link === true) continue
    const resolved = entry.resolved
    if (typeof resolved !== 'string') continue
    let host
    try {
      host = new URL(resolved).host
    } catch {
      bad.push(`${name}: ${resolved}`)
      continue
    }
    if (host !== allowedHost) bad.push(`${name}: ${resolved}`)
  }
  return bad
}

function assertPublicLock(dir) {
  const lockPath = path.join(dir, 'package-lock.json')
  const bad = findForeignResolved(fs.readFileSync(lockPath, 'utf8'))
  if (bad.length) {
    throw new Error(
      `载荷 lock 里有 ${bad.length} 条依赖指向非公共 registry（用户机上解析不到）：\n  ` +
        `${bad.slice(0, 5).join('\n  ')}${bad.length > 5 ? '\n  …' : ''}`,
    )
  }
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts })
}

function copyInto(dest, src) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyInto(to, from)
    else fs.copyFileSync(from, to)
  }
}

function walkRel(root, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(rel, ...walkRel(path.join(root, entry.name), rel))
    else out.push(rel)
  }
  return out
}

function parseArgs(argv) {
  const out = { out: null, source: 'worktree' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--source') out.source = argv[++i]
  }
  if (!out.out) throw new Error('缺少 --out <目录>')
  if (!['worktree', 'head'].includes(out.source)) throw new Error(`未知 --source：${out.source}`)
  return out
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const out = /** @type {string} */ (/** @type {unknown} */ (parsed.out))
  const { source } = parsed
  const staging = path.resolve(REPO, out)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  if (source === 'head') {
    // ① HEAD 必须已有本布局：否则后面 git archive 只会给出 pathspec 报错，读不出「该做什么」
    try {
      execFileSync('git', ['cat-file', '-e', 'HEAD:apps/server/package.json'], {
        cwd: REPO,
        stdio: 'ignore',
      })
    } catch {
      throw new Error(
        'HEAD 里没有 apps/server/package.json：布局改造尚未提交，head 模式不可用（改用默认的 --source worktree）',
      )
    }
    // ② 产物由工作区构建 ⇒ 前端与契约包源码必须与 HEAD 一致，否则发出的 bundle 不是 HEAD 的
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'apps/web', 'apps/schemas/src', 'apps/schemas/package.json'],
      { cwd: REPO, encoding: 'utf8' },
    )
      .split('\n')
      .filter((l) => l.trim() && !l.trimEnd().endsWith('.md'))
    if (dirty.length) {
      throw new Error(
        `--source head 但存在会影响构建的未提交改动（拦截，避免把工作区内容当成 HEAD 发出）：\n  ${dirty.join('\n  ')}`,
      )
    }
  }

  // ① 服务端：白名单逐项拷贝（不是「拷整包再删」——默认拒绝）
  const serverSrc = path.join(REPO, 'apps/server')
  if (source === 'head') {
    // 只发已提交的那份：白名单路径全部从 HEAD 取（避免发出未提交内容）
    const paths = [
      ...PAYLOAD.serverFiles.map((f) => `apps/server/${f}`),
      ...PAYLOAD.serverDirs.map((d) => `apps/server/${d}`),
    ]
    const archive = execFileSync('git', ['archive', 'HEAD', ...paths], {
      cwd: REPO,
      maxBuffer: 1 << 28,
    })
    execFileSync('tar', ['-x', '-C', staging, '--strip-components=2'], {
      cwd: REPO,
      input: archive,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
  } else {
    for (const f of PAYLOAD.serverFiles) {
      fs.copyFileSync(path.join(serverSrc, f), path.join(staging, f))
    }
    for (const d of PAYLOAD.serverDirs) {
      copyInto(path.join(staging, d), path.join(serverSrc, d))
    }
  }

  // ② 前端产物：现场构建（不信任既有 dist，避免打包带旧 bundle）后注入 public/
  sh('npm', ['run', 'build', '-w', 'apps/web'])
  copyInto(path.join(staging, 'public'), path.join(REPO, PAYLOAD.publicFrom))

  // ③ 契约包：现场构建 dist，再按白名单内联
  sh('npm', ['run', 'build', '-w', 'apps/schemas'])
  const schemasSrc = path.join(REPO, 'apps/schemas')
  const schemasOut = path.join(staging, PAYLOAD.schemasDirName)
  fs.mkdirSync(schemasOut, { recursive: true })
  const schemasManifest =
    source === 'head'
      ? execFileSync('git', ['show', 'HEAD:apps/schemas/package.json'], {
          cwd: REPO,
          encoding: 'utf8',
        })
      : fs.readFileSync(path.join(schemasSrc, 'package.json'), 'utf8')
  fs.writeFileSync(path.join(schemasOut, 'package.json'), schemasManifest)
  for (const f of PAYLOAD.schemasFiles) {
    if (f === 'package.json') continue // 上面已按来源写入
    const from = path.join(schemasSrc, f)
    fs.mkdirSync(path.dirname(path.join(schemasOut, f)), { recursive: true })
    fs.copyFileSync(from, path.join(schemasOut, f))
  }

  // ④ 依赖改写：workspace 链接 -> 产物内相对引用；契约包清单收敛为运行期字段
  const pkgPath = path.join(staging, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (pkg.dependencies['@mc-commander/schemas'] !== '*') {
    throw new Error(
      `契约包依赖应为 workspace 链接 "*"，实际 "${pkg.dependencies['@mc-commander/schemas']}"`,
    )
  }
  pkg.dependencies['@mc-commander/schemas'] = `file:./${PAYLOAD.schemasDirName}`
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  const vendorPkgPath = path.join(schemasOut, 'package.json')
  const vendorPkg = runtimePackageJson(JSON.parse(fs.readFileSync(vendorPkgPath, 'utf8')))
  fs.writeFileSync(vendorPkgPath, `${JSON.stringify(vendorPkg, null, 2)}\n`)

  // ⑤ 现场生成 lock：产物在用户机上是独立项目（没有 workspace 根），必须自备 lock
  //
  // registry 必须显式钉死：lock 里的 `resolved` 会照抄生成它的那台机器的 registry，
  // 而打包机的 registry 是可变的（本机 npm 默认走内网镜像）。内网镜像域名在用户机上
  // 解析不到，`npm ci` 会以 ENOTFOUND 直接失败——安装脚本在「安装 npm 依赖」一步中断，
  // 用户拿到的是一个装不上的发布包。钉到公共源后，用户若配了自己的镜像，npm 仍会把
  // 公共源地址改写成镜像地址（实测：lock 写 registry.npmjs.org，配 npmmirror 时走
  // cdn.npmmirror.com），故国内用户不受影响。
  for (const stale of [
    path.join(staging, 'package-lock.json'),
    path.join(schemasOut, 'package-lock.json'),
  ]) {
    fs.rmSync(stale, { force: true })
  }
  sh(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ],
    { cwd: staging },
  )
  assertPublicLock(staging)

  // ⑥ fail-closed：产物的**每个文件**必须落在白名单内（多一个都红）。
  // 只判文件、不判目录——目录是容器的容器，本身不进白名单清单。
  const files = walkRel(staging).filter((p) => fs.statSync(path.join(staging, p)).isFile())
  const violations = findViolations(files)
  if (violations.length) {
    throw new Error(`产物出现白名单外的文件（默认拒绝）：\n  ${violations.join('\n  ')}`)
  }

  const bytes = files.reduce((n, p) => n + fs.statSync(path.join(staging, p)).size, 0)
  console.log(
    `载荷组装完成（来源：${source}）：${files.length} 个文件 / ${(bytes / 1024 / 1024).toFixed(1)} MB` +
      `（src ${files.filter((f) => f.startsWith('src/')).length} · public ${files.filter((f) => f.startsWith('public/')).length}` +
      ` · ${PAYLOAD.schemasDirName} ${files.filter((f) => f.startsWith(`${PAYLOAD.schemasDirName}/`)).length}）`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
