/**
 * 子进程树终止（单一实现：实例启停、部署的 Forge 安装与首启、用户取消都走这里）。
 *
 * MC 1.18+/26.x 官方 server.jar 是 Bundler 结构：java 主进程（BundlerMain 引导器）
 * 经 ProcessBuilder 派生真正运行的服务器 JVM，只杀主进程会让 JVM 成为孤儿继续
 * 占用端口、写世界数据（Linux 上被 init 收养；Windows 上 libuv job object 的
 * JOB_OBJECT_KILL_ON_JOB_CLOSE 因宿主进程仍存活而不触发）。旧版（1.17-）server.jar
 * 直接运行服务器主类、无派生进程，整树终止对其同样有效，保持新旧版本兼容。
 */
import { spawnSync } from 'child_process';

/**
 * 终止整棵进程树，并在最后补一次单进程 SIGKILL。
 * @param {import('child_process').ChildProcess|null} proc 子进程句柄（可缺省，如接管实例）
 * @param {{ pid?: number|null, detached?: boolean }} [opts]
 *   pid：子进程句柄之外的 pid 来源（接管实例从 pid 文件读出，无句柄）；
 *   detached：该子进程是否以 detached:true 启动。POSIX 上 detached 使主进程成为
 *   进程组组长（pid 即 PGID），可按组终止；未 detached 的（如 Forge 安装器）无
 *   进程组语义，若强行 kill(-pid) 只会得到 ESRCH，故由调用方如实声明。
 */
export function killProcessTree(proc, { pid = null, detached = false } = {}) {
  const target = pid ?? proc?.pid ?? null;
  if (target) {
    if (process.platform === 'win32') {
      // taskkill /T 从根进程向下递归遍历，根必须先存活才能定位整棵树
      // （先杀根会让 taskkill 报「找不到进程」而无法递归），故此处不先单杀根
      try {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(target)], { stdio: 'ignore' });
      } catch {
        /* 进程已退出 */
      }
    } else if (detached) {
      try {
        process.kill(-target, 'SIGKILL');
      } catch {
        /* 进程组已不存在 */
      }
    }
  }
  // 单进程 SIGKILL 兜底：进程树终止失败 / pid 缺失 / 未 detached 时仍杀主进程本身
  if (proc) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 进程已退出 */
    }
  }
}
