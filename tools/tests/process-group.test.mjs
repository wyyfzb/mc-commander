/**
 * 子进程回收必须覆盖后代——服务常是孙进程（`npm run dev` → sh → vite），只杀直接子进程会把
 * 实际服务留成 ppid=1 的孤儿并继续占用端口，下一次运行即撞上残留实例。
 *
 * 本用例真起进程验证：子进程再拉一个孙进程，killGroup 后孙进程必须消失。
 */
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { killGroup, spawnGrouped } from '../vision/lib/process-group.mjs'

let child = null

afterEach(() => {
  if (child) {
    killGroup(child)
    child = null
  }
})

/** 进程是否还活着（信号 0 只做存在性检查，不真的发信号） */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等某个条件成立，超时即返回 false（避免固定 sleep 造成偶发假红） */
async function until(fn, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/** 子进程：再拉一个存活 60s 的孙进程，并把它的 pid 打到 stdout */
const CHILD_SCRIPT = `
const { spawn } = require('node:child_process')
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
console.log(grand.pid)
setInterval(() => {}, 1000)
`

describe('子进程整组回收', () => {
  it('killGroup 连孙进程一并收掉（只杀直接子进程会把它留成孤儿）', async () => {
    child = spawnGrouped(process.execPath, ['-e', CHILD_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const grandPid = await new Promise((resolve, reject) => {
      let buf = ''
      child.stdout.on('data', (d) => {
        buf += d
        const m = /^(\d+)/.exec(buf.trim())
        if (m) resolve(Number(m[1]))
      })
      child.once('error', reject)
      setTimeout(() => reject(new Error('未在 5s 内取到孙进程 pid')), 5000)
    })

    expect(alive(grandPid), '孙进程本应存活（否则用例无判据）').toBe(true)
    killGroup(child)
    // 进程组已不存在时 killGroup 返回 false 属正常；这里只判孙进程是否真的消失
    expect(await until(() => !alive(grandPid)), `孙进程 ${grandPid} 未被回收`).toBe(true)
  }, 15_000)

  it('进程已退出时回收不抛错', async () => {
    child = spawnGrouped(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    await new Promise((r) => child.once('exit', r))
    expect(() => killGroup(child)).not.toThrow()
  }, 10_000)
})
