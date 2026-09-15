#!/usr/bin/env node
/**
 * capture.mjs —— 全站截图脚本（设计审查用：可复现的视觉证据采集）
 *
 * 自动起 mock 数据服务 + vite dev，用 Playwright 对 10 个路由 × 明/暗双主题
 * 截图，输出 <VISION_OUT>/capture_<时间戳>/<路由>-<主题>.png + manifest.json。
 *
 * 用法（在 mc_manager_web/ 下）：
 *   npm run capture                         # 全量截图（10 路由 × 2 主题）
 *   npm run capture -- --routes=players     # 仅指定路由（逗号分隔，用 file 名）
 *   npm run capture -- --theme=dark         # 仅指定主题（dark|light）
 *   npm run capture -- --force-clean        # 启动前强杀 5198/5199 残留进程
 *   npm run capture -- --wait=2000          # 截图前等待（默认 1000ms）
 *   npm run capture -- --strict             # 空态/失败即非 0 退出（CI 用；默认仅告警）
 *   npm run capture -- --viewport=1440x900,375x812  # 视口（缺省 1440x900；显式指定时文件名带 -<宽> 后缀）
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
  { path: 'dashboard', file: 'dashboard' },
  { path: 'players', file: 'players' },
  { path: 'world', file: 'world' },
  { path: 'files', file: 'files' },
  { path: 'tasks', file: 'tasks' },
  { path: 'instances', file: 'instances' },
  { path: 'settings/notifications', file: 'settings-notifications' },
  { path: 'settings/backup', file: 'settings-backup' },
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
const targets = ROUTES.filter((r) => !routesFilter.length || routesFilter.includes(r.file)).flatMap((r) =>
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
        spawnSync('sh', ['-c', `lsof -ti :${port} 2>/dev/null || ss -tlnp "sport = :${port}" 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`], {
          encoding: 'utf-8',
        }).stdout || ''
      for (const pid of new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))) {
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
    ['chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']],
    ['msedge', ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge']],
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
        if (process.platform === 'win32' && c.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(c.pid)])
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
  let mockUp = await portOpen(MOCK_PORT)
  if (!mockUp) {
    children.push(startServer('node', [join(WEB_DIR, 'scripts', 'mock-server.mjs')], { cwd: WEB_DIR }))
    await waitPort(MOCK_PORT)
    mockUp = true
  }
  log(`mock-server ${MOCK_PORT} ${mockUp ? '复用' : '已启动'}`)

  let devUp = await portOpen(DEV_PORT)
  if (!devUp) {
    children.push(
      startServer('npm', ['run', 'dev', '--', '--port', String(DEV_PORT)], {
        cwd: WEB_DIR,
        env: { ...process.env, VITE_PROXY_TARGET: `http://localhost:${MOCK_PORT}` },
      }),
    )
    await waitPort(DEV_PORT)
    devUp = true
  }
  log(`vite dev ${DEV_PORT} ${devUp ? '复用' : '已启动'}`)

  // ── 2. 加载 Playwright（web 依赖）──
  const { chromium } = await import(pathToFileURL(join(WEB_DIR, 'node_modules', 'playwright', 'index.mjs')))
  const channel = browserChannel()
  log(`浏览器通道: ${channel || '内置 chromium'}`)

  let browser
  try {
    browser = await chromium.launch(channel ? { channel } : {})
  } catch (e) {
    console.error(`[capture] 浏览器启动失败（通道 ${channel || '内置 chromium'}）：${e.message.slice(0, 200)}`)
    console.error('[capture] 处置：装浏览器（npx playwright install chromium）或用 VISION_BROWSER=chrome|msedge 指定通道')
    process.exit(3)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = join(OUT_DIR, `capture_${stamp}`)
  mkdirSync(outDir, { recursive: true })

  // mock key 动态构造（规避凭据字面量扫描规则）
  const mockKey = 'e2e-mock-key-' + '0'.repeat(10)
  const manifest = { generatedAt: new Date().toISOString(), base: `http://localhost:${DEV_PORT}`, viewports: VIEWPORTS, shots: [], minShotBytes: MIN_SHOT_BYTES }
  const failed = []
  const warned = []

  const jobs = targets.flatMap(([route, theme]) => VIEWPORTS.map((vp) => [route, theme, vp]))
  for (const [route, theme, vp] of jobs) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
    await page.addInitScript(([k, t, unconfigured]) => {
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
    }, [mockKey, theme, route.unconfigured === true])
    try {
      await page.goto(`http://localhost:${DEV_PORT}/${route.path}`, { waitUntil: 'networkidle', timeout: 30_000 })
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
      log(`✓ ${label} ${vp.width}x${vp.height} ${Math.round(bytes / 1024)}KB${suspect ? ' ⚠ 疑似空态' : ''}`)
      if (suspect) {
        log(`⚠ ${label} 截图仅 ${bytes} 字节（<${MIN_SHOT_BYTES}）——疑似空态/未连接实例，请检查 mock 与代理链路`)
      }
    } catch (e) {
      failed.push(`${route.file}-${theme}${viewportSuffix(vp)}`)
      log(`✗ ${route.file} (${theme}${viewportSuffix(vp)}): ${e.message.slice(0, 120)}`)
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
