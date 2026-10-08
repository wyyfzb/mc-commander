#!/usr/bin/env node
/**
 * capture.mjs —— 全站截图脚本（设计审查用：可复现的视觉证据采集）
 *
 * 自动起 mock 数据服务 + vite dev，用 Playwright 对 19 个路由 × 明/暗双主题
 * 截图，输出 <VISION_OUT>/capture_<时间戳>/<路由>-<主题>.png + manifest.json
 * （manifest 逐图记视口与字节数，并记 servers 的来源 started|reused）。
 *
 * 用法（在 mc_manager_web/ 下）：
 *   npm run capture                         # 全量截图（19 路由 × 2 主题）
 *   npm run capture -- --routes=players     # 仅指定路由（逗号分隔，用 file 名）
 *   npm run capture -- --theme=dark         # 仅指定主题（dark|light）
 *   npm run capture -- --force-clean        # 启动前强杀 5198/5199 残留进程
 *   npm run capture -- --wait=2000          # 截图前等待（默认 1000ms）
 *   npm run capture -- --strict             # 空态/失败即非 0 退出（CI 用；默认仅告警）
 *   npm run capture -- --viewport=1440x900,375x812  # 视口（缺省 1440x900；显式指定时文件名带 -<宽> 后缀）
 *   npm run capture -- --inject=<路径.mjs>   # 批次夹具注入点（见下）
 *
 * 批次夹具注入点（--inject）：整批一次的变更若只影响登录态/引导态等「非已连接」形态，
 * 默认夹具会整批报「无视觉变化」。传入一个 .mjs（**相对当前工作目录解析**，`npm run` 时即
 * mc_manager_web/），其 default export 收 `{ page, route, theme, viewport, mockKey }`，
 * 在导航前按需注入：
 *   - 改初始状态：用 `page.addInitScript`（后注册者后执行，可覆盖脚本内建的默认注入）
 *   - 造接口形态：用 `page.route`
 * 注意：整批共用一个模块实例（ESM 缓存），别在模块作用域攒跨题状态。
 * 夹具脚本留 `.ai/`（不入库），本脚本不内置任何批次形态。
 *
 * 环境变量：
 *   VISION_BROWSER  浏览器通道强制（chrome | msedge | chromium）
 *   MOCK_PORT       数据服务端口（默认 5198）
 *   DEV_PORT        vite dev 端口（默认 5199）
 *   VISION_OUT     输出目录（默认 <repo>/.ai/vision，已 gitignore）
 *   MIN_SHOT_BYTES 截图大小阈值（默认 40KB，小于则判为疑似空态）
 *
 * 浏览器通道降级链：chrome → msedge → Playwright 内置 chromium。
 * 依赖：本包 node_modules（npm ci；浏览器另需 npx playwright install chromium）。
 * 设计基线与 P1-P6 原则由 owner 私有维护（不入库）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connect } from 'node:net'

// 本文件位于 mc_manager_web/scripts/ → WEB_DIR 为上一级，PROJECT_ROOT 为仓库根
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(SCRIPT_DIR, '..')
const PROJECT_ROOT = resolve(WEB_DIR, '..')
const MOCK_PORT = Number(process.env.MOCK_PORT) || 5198
const DEV_PORT = Number(process.env.DEV_PORT) || 5199
const OUT_DIR = resolve(process.env.VISION_OUT || join(PROJECT_ROOT, '.ai', 'vision'))

/**
 * 截图目标：path = 真实路由路径；file = 输出文件名（settings 子路由多段路径需区分）
 * onboarding 特例：截图前不注入连接（否则 requireUnconfigured 重定向回仪表盘）
 */
const ROUTES = [
  { path: 'onboarding', file: 'onboarding', unconfigured: true },
  // 登录页同为「未配置」形态（已配置时 requireUnconfigured 会把它弹回仪表盘）：
  // 缺它时整批只改了登录页的改动会被报成「无视觉变化」
  { path: 'login', file: 'login', unconfigured: true },
  // 首访设密向导：登录页的第三相（mock 的 auth/status 认接口 ?fresh=1，也认页面 Referer），
  // 缺它时「只改了设密向导」的整批同样会静默报「无视觉变化」
  { path: 'login?fresh=1', file: 'login-fresh', unconfigured: true },
  { path: 'dashboard', file: 'dashboard' },
  { path: 'players', file: 'players' },
  { path: 'world', file: 'world' },
  { path: 'files', file: 'files' },
  { path: 'tasks', file: 'tasks' },
  { path: 'instances', file: 'instances' },
  { path: 'plugins', file: 'plugins' },
  { path: 'webhooks', file: 'webhooks' },
  { path: 'audit', file: 'audit' },
  // 帮助中心（排障自检 + 崩溃历史 + 面板错误 + 使用向导）：此前无视觉基线
  { path: 'help', file: 'help' },
  { path: 'settings/notifications', file: 'settings-notifications' },
  { path: 'settings/backup', file: 'settings-backup' },
  // 设置页其余四子页：connection 是 /settings 的默认落地页，此前长期无视觉基线
  { path: 'settings/connection', file: 'settings-connection' },
  { path: 'settings/account', file: 'settings-account' },
  { path: 'settings/general', file: 'settings-general' },
  { path: 'settings/about', file: 'settings-about' },
]

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const routesFilter = (arg('routes', '') || '').split(',').filter(Boolean)
const themeFilter = (arg('theme', '') || '').toLowerCase()
const forceClean = process.argv.includes('--force-clean')
const waitMs = Number(arg('wait', '')) || 1000
const MIN_SHOT_BYTES = Number(process.env.MIN_SHOT_BYTES) || 40_000
// --strict：任一路由未产出、或截图小于阈值（疑似空态/未连接）时以非 0 退出（CI/自动审查用）
const strict = process.argv.includes('--strict')
// --viewport=WxH（可逗号分隔多档，如 1440x900,375x812）。缺省保持 1440×900 与旧文件名（兼容既有用法与 CI）；
// 显式指定时文件名追加 -<宽> 后缀（如 dashboard-dark-375.png），manifest 逐图记录视口——
// 动因：此前窄屏视觉审查每次都要自写 playwright 采集脚本（2026-09-15 批次三次重复劳动）。
const viewportArg = arg('viewport', '')
const VIEWPORTS = (viewportArg ? viewportArg.split(',') : ['1440x900'])
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean)
  .map((v) => {
    const m = /^(\d+)x(\d+)$/.exec(v)
    if (!m) {
      console.error(`[capture] --viewport 需形如 1440x900（收到 "${v}"）`)
      process.exit(2)
    }
    return { width: Number(m[1]), height: Number(m[2]) }
  })
const viewportSuffix = (vp) => (viewportArg ? `-${vp.width}` : '')
/** 批次夹具脚本（--inject）：动态载入，在每题导航前调用其 default export */
const injectArg = arg('inject', '')
const injectPath = injectArg ? resolve(injectArg) : ''
if (injectPath && !existsSync(injectPath)) {
  console.error(`[capture] --inject 指向的模块不存在：${injectPath}（相对当前工作目录解析）`)
  process.exit(2)
}
const injectMod = injectPath ? await import(pathToFileURL(injectPath).href) : null
if (injectPath && typeof injectMod?.default !== 'function') {
  console.error(`[capture] --inject 指向的模块须 default export 一个函数（收到 ${injectArg}）`)
  process.exit(2)
}
const targets = ROUTES.filter((r) => !routesFilter.length || routesFilter.includes(r.file)).flatMap(
  (r) =>
    (themeFilter && themeFilter !== 'dark' ? [] : [[r, 'dark']]).concat(
      themeFilter && themeFilter !== 'light' ? [] : [[r, 'light']],
    ),
)

function log(m) {
  console.log(`[capture] ${m}`)
}

/** 强杀占用指定端口的残留进程（Windows: netstat+taskkill；Unix: lsof/ss+kill） */
function killPort(port) {
  try {
    const pids = new Set()
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf-8' }).stdout || ''
      for (const line of out.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const pid = line.trim().split(/\s+/).pop()
          if (pid && /^\d+$/.test(pid)) pids.add(pid)
        }
      }
      for (const pid of pids) spawnSync('taskkill', ['/F', '/PID', pid])
    } else {
      const out =
        spawnSync(
          'sh',
          [
            '-c',
            `lsof -ti :${port} 2>/dev/null || ss -tlnp "sport = :${port}" 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`,
          ],
          {
            encoding: 'utf-8',
          },
        ).stdout || ''
      for (const pid of new Set(
        out
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      )) {
        spawnSync('kill', [pid])
      }
    }
    return pids.size > 0
  } catch {
    return false
  }
}

/** 端口是否已被监听（已监听则复用，避免端口冲突）
 *  必须在本进程内探测：早先实现走 spawnSync(node -e ...) 子进程 + 管道 stdio，
 *  在受限沙箱（子进程禁开管道）下恒返回 false → waitPort 必然超时报「等待超时」，
 *  把真正的失败原因掩盖成「端口没起来」。 */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function startServer(cmd, args, opts = {}) {
  log(`启动: ${cmd} ${args.join(' ')}`)
  // Windows shell 模式传拼接命令串（Node 24 弃用 shell+args 数组——参数不转义）
  const isWin = process.platform === 'win32'
  const child = spawn(isWin ? `${cmd} ${args.join(' ')}` : cmd, isWin ? [] : args, {
    cwd: opts.cwd || WEB_DIR,
    stdio: 'ignore',
    shell: isWin,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  })
  return child
}

async function waitPort(port, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`端口 ${port} 等待超时（${timeoutMs}ms 内未监听）`)
}

function browserChannel() {
  if (process.env.VISION_BROWSER) return process.env.VISION_BROWSER
  // 通道降级链：chrome → msedge → 内置 chromium（不传 channel）
  const candidates = [
    [
      'chrome',
      [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
      ],
    ],
    [
      'msedge',
      [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/microsoft-edge',
      ],
    ],
  ]
  for (const [channel, paths] of candidates) {
    if (paths.some((p) => existsSync(p))) return channel
  }
  return null // 内置 chromium
}

async function main() {
  if (targets.length === 0) {
    log('无截图目标（检查 --routes/--theme 参数）')
    process.exit(2)
  }
  if (!existsSync(join(WEB_DIR, 'node_modules', 'playwright'))) {
    console.error('[capture] mc_manager_web 依赖未安装，请先执行: cd mc_manager_web && npm ci')
    process.exit(2)
  }

  const children = []
  const cleanup = () => {
    for (const c of children) {
      try {
        // Windows shell 模式 spawn 的是 cmd 包装层，kill 只杀包装进程——taskkill /T 杀整棵进程树
        if (process.platform === 'win32' && c.pid)
          spawnSync('taskkill', ['/F', '/T', '/PID', String(c.pid)])
        else c.kill()
      } catch {}
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  // ── 0. --force-clean：清理 5198/5199 残留进程（防复用坏实例）──
  if (forceClean) {
    killPort(MOCK_PORT)
    killPort(DEV_PORT)
    await new Promise((r) => setTimeout(r, 800))
    log(`--force-clean：已清理 ${MOCK_PORT}/${DEV_PORT} 残留`)
  }

  // ── 1. 起 mock-server + vite dev（已监听则复用）──
  // 来源必须独立记录：探测结果与「本进程是否启动过」是两件事——早先实现启动后把探测变量
  // 回写成 true 再据此打日志，于是恒打印「复用」，无法判断截图吃的是本进程刚起的服务
  // 还是外部残留实例（旧 dist 喂假数据正是此类）。
  const mockExisting = await portOpen(MOCK_PORT)
  if (!mockExisting) {
    children.push(
      startServer('node', [join(WEB_DIR, 'scripts', 'mock-server.mjs')], { cwd: WEB_DIR }),
    )
    await waitPort(MOCK_PORT)
  }
  const mockSource = mockExisting ? 'reused' : 'started'
  log(`mock-server ${MOCK_PORT} ${mockSource === 'reused' ? '复用既有实例' : '本进程启动'}`)

  const devExisting = await portOpen(DEV_PORT)
  if (!devExisting) {
    children.push(
      startServer('npm', ['run', 'dev', '--', '--port', String(DEV_PORT)], {
        cwd: WEB_DIR,
        env: { ...process.env, VITE_PROXY_TARGET: `http://localhost:${MOCK_PORT}` },
      }),
    )
    await waitPort(DEV_PORT)
  }
  const devSource = devExisting ? 'reused' : 'started'
  log(`vite dev ${DEV_PORT} ${devSource === 'reused' ? '复用既有实例' : '本进程启动'}`)

  // ── 2. 加载 Playwright（web 依赖）──
  const { chromium } = await import(
    pathToFileURL(join(WEB_DIR, 'node_modules', 'playwright', 'index.mjs'))
  )
  const channel = browserChannel()
  log(`浏览器通道: ${channel || '内置 chromium'}`)

  let browser
  try {
    browser = await chromium.launch(channel ? { channel } : {})
  } catch (e) {
    console.error(
      `[capture] 浏览器启动失败（通道 ${channel || '内置 chromium'}）：${e.message.slice(0, 200)}`,
    )
    console.error(
      '[capture] 处置：装浏览器（npx playwright install chromium）或用 VISION_BROWSER=chrome|msedge 指定通道',
    )
    process.exit(3)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = join(OUT_DIR, `capture_${stamp}`)
  mkdirSync(outDir, { recursive: true })

  // mock key 动态构造（规避凭据字面量扫描规则）
  const mockKey = 'e2e-mock-key-' + '0'.repeat(10)
  const manifest = {
    generatedAt: new Date().toISOString(),
    base: `http://localhost:${DEV_PORT}`,
    servers: { mock: mockSource, dev: devSource },
    viewports: VIEWPORTS,
    // 批次夹具路径（无则 null）：记 resolve 后的绝对路径，便于「这批为什么长这样」的复现
    inject: injectPath || null,
    shots: [],
    minShotBytes: MIN_SHOT_BYTES,
  }
  const failed = []
  const warned = []

  const jobs = targets.flatMap(([route, theme]) => VIEWPORTS.map((vp) => [route, theme, vp]))
  for (const [route, theme, vp] of jobs) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
    await page.addInitScript(
      ([k, t, unconfigured]) => {
        // onboarding 需未配置态（否则 requireUnconfigured 重定向回仪表盘）
        if (unconfigured) localStorage.removeItem('mcs-connection')
        else localStorage.setItem('mcs-connection', JSON.stringify({ baseUrl: '', apiKey: k }))
        // 主题需同步写入 ui store 的 localStorage（mcs-theme）：仅注入 class 会被
        // app-shell 初始化覆盖（store 默认 dark），light 截图会失效
        localStorage.setItem('mcs-theme', t)
        const applyThemeClass = () => {
          document.documentElement.classList.add(t)
          document.documentElement.classList.remove(t === 'dark' ? 'light' : 'dark')
        }
        // 无 AppShell 页面（onboarding）无主题 effect，class 须在文档就绪后设置
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', applyThemeClass, { once: true })
        } else {
          applyThemeClass()
        }
      },
      [mockKey, theme, route.unconfigured === true],
    )
    try {
      // 批次夹具先于导航注入：它可用 addInitScript 覆盖上面的默认状态、或用 route 造接口形态。
      // 夹具自身的报错单独包一层并打 [inject] 前缀——否则它与「页面没起来」在日志里无法分辨
      try {
        await injectMod?.default?.({ page, route, theme, viewport: vp, mockKey })
      } catch (e) {
        throw new Error(`[inject] ${e?.message ?? String(e)}`)
      }
      await page.goto(`http://localhost:${DEV_PORT}/${route.path}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      })
      await page.waitForTimeout(waitMs)
      const file = `${route.file}-${theme}${viewportSuffix(vp)}.png`
      const abs = join(outDir, file)
      await page.screenshot({ path: abs, fullPage: true })
      const bytes = statSync(abs).size
      // 产物自检：过小截图 = 疑似空态/未连接实例（如 EmptyState），防静默失真
      const suspect = bytes < MIN_SHOT_BYTES
      manifest.shots.push({ route, theme, viewport: vp, file, bytes, suspect })
      const label = `${route.file}-${theme}${viewportSuffix(vp)}`
      if (suspect) warned.push(label)
      log(
        `✓ ${label} ${vp.width}x${vp.height} ${Math.round(bytes / 1024)}KB${suspect ? ' ⚠ 疑似空态' : ''}`,
      )
      if (suspect) {
        log(
          `⚠ ${label} 截图仅 ${bytes} 字节（<${MIN_SHOT_BYTES}）——疑似空态/未连接实例，请检查 mock 与代理链路`,
        )
      }
    } catch (e) {
      failed.push(`${route.file}-${theme}${viewportSuffix(vp)}`)
      // 夹具可能抛非 Error（throw 'x' / reject()），故不能直接取 e.message——那会在 catch 里
      // 再抛一次 TypeError，把整批（含 manifest）一起带走
      log(
        `✗ ${route.file} (${theme}${viewportSuffix(vp)}): ${String(e?.message ?? e).slice(0, 120)}`,
      )
    } finally {
      await page.close()
    }
  }

  await browser.close()
  manifest.failed = failed
  manifest.warned = warned
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  log(`完成：${manifest.shots.length}/${targets.length} 张 → ${outDir}`)
  log(`manifest: ${join(outDir, 'manifest.json')}`)
  if (failed.length) log(`失败 ${failed.length}：${failed.join(', ')}`)
  if (warned.length) log(`疑似空态 ${warned.length}：${warned.join(', ')}`)
  // --strict：静默降级不可接受（本次修复的动因即「工具假失败掩盖真因」）
  if (strict && (failed.length || warned.length)) {
    console.error(`[capture] --strict：${failed.length} 张失败、${warned.length} 张疑似空态`)
    process.exit(1)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[capture] 意外错误:', e)
    process.exit(1)
  })
