import { describe, it, expect } from 'vitest';

// ---------- spawnProcess 取消语义（真实子进程，不 mock child_process） ----------
// 与 backup-cancel.test.js 分工：那里 mock 了 child_process 以驱动编排分支
// （取消记账/回滚落盘），但 mock 的 kill 同步 emit close，覆盖不到真实时序；
// 本文件用 node 子进程直测 abort 语义——运行中 abort 必须杀进程并以
// code='CANCELLED' 拒绝，预先 aborted 的 signal 走「进程刚起即补杀」分支。
import { spawnProcess } from '../services/backup.service.js';

const SLEEP_CMD = ['-e', 'setTimeout(() => {}, 30000)'];

describe('spawnProcess 取消语义', () => {
  it('运行中 abort → kill 子进程并以 CANCELLED 拒绝', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const done = spawnProcess('node', SLEEP_CMD, {
      signal: controller.signal,
      timeout: 60000,
    }).catch((e) => e);
    // 等子进程真正起来再取消（未起来时走的是补杀分支，由下一条用例覆盖）
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const err = await done;
    expect(err.code).toBe('CANCELLED');
    // 30s 的睡眠进程被立即终止（远小于 timeout 与睡眠时长）
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('signal 预先 aborted → 进程刚起即被杀（补杀分支）', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const err = await spawnProcess('node', SLEEP_CMD, {
      signal: controller.signal,
      timeout: 60000,
    }).catch((e) => e);
    expect(err.code).toBe('CANCELLED');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('无 signal 时正常退出不受影响（取消通道不改变既有语义）', async () => {
    const code = await spawnProcess('node', ['-e', 'process.exit(0)'], { timeout: 30000 });
    expect(code).toBe(0);
  });

  it('无 signal 时非白名单退出码照旧拒绝（okCodes 语义未被取消通道影响）', async () => {
    const err = await spawnProcess('node', ['-e', 'process.exit(3)'], { timeout: 30000 }).catch(
      (e) => e,
    );
    expect(err.message).toBe('Exit code 3');
  });
});
