/**
 * 进程树终止：两个平台分支与三条兜底路径。
 *
 * 这个模块只有 16 行可执行代码，但它是实例启停、Forge 安装、用户取消共用的唯一
 * 终止实现——漏掉一条分支的症状是 MC 子 JVM 变成孤儿，继续占端口写世界数据。
 *
 * 平台分支互斥（win32 走 taskkill、POSIX 走进程组信号），在任一真实平台上跑都只能
 * 覆盖其中一支。故这里显式覆盖 `process.platform`，让另一支在同一台机器上也可执行：
 * 否则覆盖率随运行环境漂移，云端与本地会得到两个不同的数字。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from 'child_process';
import { killProcessTree } from '../src/utils/process-tree.js';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** 造一个最小子进程句柄：只要 kill 可断言即可 */
function fakeProc(pid = 1234) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.kill = vi.fn(() => true);
  return proc;
}

beforeEach(() => {
  spawnSync.mockReset();
  vi.restoreAllMocks();
});

afterEach(() => {
  // 平台是进程级全局值：漏还原会让同 worker 后续文件按错误的平台跑
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('win32：taskkill /F /T 终止整棵树', () => {
  beforeEach(() => setPlatform('win32'));

  it('带 pid 的句柄 → taskkill 递归终止，再补一次单进程 SIGKILL', () => {
    const proc = fakeProc(4321);

    killProcessTree(proc);

    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '4321'], {
      stdio: 'ignore',
    });
    // 兜底仍在：taskkill 失败（进程已退出/权限不足）时主进程也必被杀
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('pid 来自选项（接管实例无句柄）→ 照样 taskkill', () => {
    killProcessTree(null, { pid: 777 });

    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], {
      stdio: 'ignore',
    });
  });

  it('pid 优先于句柄：两者都给出时以显式 pid 为准', () => {
    killProcessTree(fakeProc(111), { pid: 222 });

    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '222'], {
      stdio: 'ignore',
    });
  });

  it('taskkill 自身抛错不向外传播（进程已退出是常态）', () => {
    spawnSync.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    const proc = fakeProc(4321);

    expect(() => killProcessTree(proc)).not.toThrow();
    // 抛出后兜底仍要执行
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('未 detached 的句柄在 win32 上不影响判定（平台分支优先于 detached）', () => {
    const proc = fakeProc(4321);

    killProcessTree(proc, { detached: false });

    expect(spawnSync).toHaveBeenCalled();
  });
});

describe('POSIX：按进程组终止', () => {
  beforeEach(() => setPlatform('linux'));

  it('detached 的子进程 → kill(-pid) 终止整个进程组', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const proc = fakeProc(555);

    killProcessTree(proc, { detached: true });

    // 负 pid 即进程组：这是「连子 JVM 一起杀」的关键，杀掉根不够
    expect(killSpy).toHaveBeenCalledWith(-555, 'SIGKILL');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    // POSIX 上不走 taskkill
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('未 detached → 不发进程组信号（无进程组语义，kill(-pid) 只会 ESRCH）', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const proc = fakeProc(555);

    killProcessTree(proc, { detached: false });

    expect(killSpy).not.toHaveBeenCalled();
    // 但仍要杀主进程本身
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('进程组已不存在（ESRCH）不向外传播', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const proc = fakeProc(555);

    expect(() => killProcessTree(proc, { detached: true })).not.toThrow();
    expect(killSpy).toHaveBeenCalledWith(-555, 'SIGKILL');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('macOS 与 Linux 走同一分支（判据是「非 win32」而不是「是 linux」）', () => {
    setPlatform('darwin');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killProcessTree(fakeProc(999), { detached: true });

    expect(killSpy).toHaveBeenCalledWith(-999, 'SIGKILL');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe('兜底：没有可终止的目标', () => {
  it('pid 缺失且无句柄 → 什么都不做，不抛错', () => {
    expect(() => killProcessTree(null)).not.toThrow();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('句柄的 pid 缺失 → 跳过进程树，但仍尝试单进程 kill', () => {
    const proc = fakeProc();
    proc.pid = undefined;

    killProcessTree(proc);

    expect(spawnSync).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('proc.kill 抛错不向外传播（进程已退出是常态）', () => {
    const proc = fakeProc(1234);
    proc.kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });

    expect(() => killProcessTree(proc)).not.toThrow();
  });

  it('显式传 null pid 时回落到句柄上的 pid', () => {
    setPlatform('win32');
    const proc = fakeProc(888);

    killProcessTree(proc, { pid: null });

    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '888'], {
      stdio: 'ignore',
    });
  });
});
