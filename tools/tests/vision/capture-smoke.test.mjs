/**
 * 截图工具冒烟：真起一次 capture（单路由），断言它端到端跑通并产出非空图。
 *
 * 为什么需要：capture.mjs 无任何自动覆盖，工具内部的路径引用断链（mock 后端搬走后仍指向旧位置）
 * 不会被 lint / typecheck / 单测 / e2e 任何一道门禁发现——症状是「截图报错退出」，而那正是
 * 视觉审查的前置步骤，等到要用时才发现。
 *
 * 断言口径取「产物是否真的存在且非空」而非「进程退出码」：README 记录的
 * 「小于 40KB 视为疑似空态」是审查惯例，这里用同一量级下限，避免页面白屏时假绿。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const TOOLS_DIR = join(import.meta.dirname, '..', '..')
const PROJECT_ROOT = join(TOOLS_DIR, '..')
/** 探针路由取 dashboard：它不依赖 onboarded 之外的夹具，是 e2e 与截图都用的稳定入口 */
const ROUTE = 'dashboard'
/** 与「疑似空态」口径同量级（文档记 40KB；取 20KB 留出不同 DPI/字体渲染的余量） */
const MIN_BYTES = 20_000

const outDir = mkdtempSync(join(tmpdir(), 'capture-smoke-'))

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true })
})

describe('截图工具（capture.mjs）', () => {
  it(`能起 mock 后端并产出非空截图（${ROUTE}）`, () => {
    // --strict：任一路由未产出或疑似空态即非 0 退出；这里只跑一条路由
    execFileSync(
      process.execPath,
      [join(TOOLS_DIR, 'vision', 'capture.mjs'), `--routes=${ROUTE}`, '--theme=dark', '--strict'],
      { cwd: PROJECT_ROOT, env: { ...process.env, VISION_OUT: outDir }, stdio: 'pipe' },
    )

    const manifests = execFileSync('ls', ['-t', outDir], { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter((d) => d.startsWith('capture_'))
    expect(manifests.length, '未产出 capture_* 目录').toBeGreaterThan(0)

    const manifest = JSON.parse(readFileSync(join(outDir, manifests[0], 'manifest.json'), 'utf-8'))
    expect(manifest.shots.length, 'manifest 无截图记录').toBeGreaterThan(0)

    const shot = manifest.shots[0]
    // mock 必须是本进程或既有实例，且不能为空态——断掉任一服务此项即失败
    expect(['started', 'reused']).toContain(manifest.servers.mock)
    expect(shot.suspect, '截图被判为疑似空态').toBe(false)
    expect(shot.bytes).toBeGreaterThan(MIN_BYTES)

    const png = join(outDir, manifests[0], shot.file)
    expect(existsSync(png), `截图文件缺失：${shot.file}`).toBe(true)
    expect(readFileSync(png).length).toBe(shot.bytes)
  }, 180_000)
})
