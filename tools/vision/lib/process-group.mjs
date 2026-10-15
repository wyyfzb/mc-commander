/**
 * 子进程整组回收。
 *
 * 判据：只杀直接子进程不够——实际服务常是孙进程（`npm run dev` → sh → vite）。杀 npm 后 vite
 * 会留成 ppid=1 的孤儿并继续占着端口（实测 capture 退出后 5199 仍在 LISTEN，下一次运行即撞上
 * 残留实例）。POSIX 侧用 detached 让子进程自成进程组（PGID == pid），回收时 kill 负 pid 收掉整组；
 * Windows 无进程组语义，按 pid 收整棵进程树。
 */
import { spawn, spawnSync } from 'node:child_process'

/** 起子进程并让其自成进程组，供 killGroup 整组回收 */
export function spawnGrouped(cmd, args, opts = {}) {
  return spawn(cmd, args, {
    ...opts,
    detached: process.platform !== 'win32',
  })
}

/** 回收子进程及其全部后代；组已不存在（子进程自己先退了）返回 false，不算错误 */
export function killGroup(child) {
  if (!child?.pid) return false
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)])
    } else {
      // 负 pid = 整个进程组；此处用 SIGKILL：被回收的是本次运行起的临时服务，无需优雅退出，
      // 且 SIGTERM 可被忽略而让端口迟迟不释放
      process.kill(-child.pid, 'SIGKILL')
    }
    return true
  } catch {
    return false
  }
}
