import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/db/backup.model.js', () => ({
  BackupModel: {
    findAll: vi.fn(() => ({ total: 0 })),
    create: vi.fn(),
    update: vi.fn(),
    resetStaleInProgress: vi.fn(),
  },
}));

vi.mock('../src/db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    updateLastRunStatus: vi.fn(),
  },
}));

import { EventEmitter } from 'events';
import config from '../src/config.js';
import { AppError, ErrorCodes } from '../src/utils/response.js';
import {
  BackupService,
  hasWorldData,
  verifyHardlinkDedup,
} from '../src/services/backup.service.js';
import { ScheduledTaskModel } from '../src/db/scheduled_task.model.js';

describe('BackupService.createBackup - 世界目录缺失', () => {
  /* 断言锁性质而不是字符串：文案会随措辞调整，而这条缺陷的实质是
     ① 抛的是可分类的 AppError（不是裸 Error 被全局处理器降级成 500）
     ② 用户能看懂并知道下一步做什么
     两条性质各自承重——只锁中文串的话，改回英文裸错也能靠改断言「修绿」。 */
  it('emit backupFailed 事件并抛错（定时备份路径需用户可见）', async () => {
    const manager = new EventEmitter();
    manager.getInstance = vi.fn(() => null);
    const failedEvents = [];
    manager.on('instance:backupFailed', (d) => failedEvents.push(d));

    const service = new BackupService(manager);

    const err = await service.createBackup('nonexistent-instance', { name: 'x' }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCodes.BACKUP_WORLD_NOT_FOUND.code);
    expect(err.status).toBe(409);

    // 关键：世界目录缺失（setup 阶段同步抛错）也必须发 backupFailed 事件，
    // 定时备份路径若仅记日志，用户会对灾备失效无感知
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].instanceId).toBe('nonexistent-instance');
    expect(failedEvents[0].phase).toBe('setup');
    // 事件里带的是同一句话：定时任务路径没有 HTTP 响应，用户只从这个字段看到原因
    expect(failedEvents[0].error).toBe(err.message);
  });

  it('文案给动作而不只是说明（用户看完知道点什么），且不预设代码判不出的原因', async () => {
    const service = new BackupService(null);
    const err = await service.createBackup('nonexistent-instance', { name: 'x' }).then(
      () => null,
      (e) => e,
    );
    // 没有世界时用户有两条路，两条都要给
    expect(err.message).toContain('启动一次服务器生成世界');
    expect(err.message).toContain('直接升级');
    // 「从未启动过」代码验证不了（要看日志/DB 时间）；目录建了但 level.dat 没写成
    // 是同一句话覆盖不到的另一种成因，说错会挡掉真正要抢救的人
    expect(err.message).not.toContain('从未启动过');
  });

  it('世界目录在但 level.dat 缺失（首启中断）同样按「没有可备份的世界数据」拒绝，不谎称从未启动过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noworld-'));
    const instanceId = 'inst-halfworld';
    // 目录建了、也有文件，唯独没有 level.dat：MC 首启中断就是这个形态
    fs.mkdirSync(path.join(root, instanceId, 'world', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, instanceId, 'world', 'session.lock'), '');
    fs.writeFileSync(path.join(root, instanceId, 'world', 'data', 'chunks.dat'), '');
    const originalServersDir = config.serversDir;
    config.serversDir = root;
    try {
      const service = new BackupService(null);
      const err = await service.createBackup(instanceId, { name: 'x' }).then(
        () => null,
        (e) => e,
      );
      expect(err?.message).toContain('没有可备份的世界数据');
      // 文案只断言代码能验证的事实：不能出现「从未启动过」这种代码判不出的原因
      expect(err?.message).not.toContain('从未启动过');
    } finally {
      config.serversDir = originalServersDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/* 「有没有世界」是备份前置校验与升级前置备份共用的判据，判错的代价是**静默**的：
   判 false ⇒ 跳过一次本该做的备份；判 true ⇒ 备份一个空壳。两种都要锁。
   判据刻意不按 level-name 定位——世界目录名可被用户改、也可从别处拷进来。 */
describe('hasWorldData - 世界数据判据', () => {
  let root;
  let originalServersDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hasworld-'));
    originalServersDir = config.serversDir;
    config.serversDir = root;
  });

  afterEach(() => {
    config.serversDir = originalServersDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function mkdirWithLevelDat(id, subdir, withLevelDat) {
    const dir = path.join(root, id, subdir);
    fs.mkdirSync(dir, { recursive: true });
    if (withLevelDat) fs.writeFileSync(path.join(dir, 'level.dat'), 'nbt');
    return dir;
  }

  it('子目录直接层有 level.dat ⇒ true', () => {
    mkdirWithLevelDat('a', 'world', true);
    expect(hasWorldData('a')).toBe(true);
  });

  it('子目录在但直接层没有 level.dat ⇒ false（首启中断的形态，不能算有世界）', () => {
    mkdirWithLevelDat('b', 'world', false);
    expect(hasWorldData('b')).toBe(false);
  });

  /* 这条是判据「不按 level-name 定位」的理由所在：用户改过世界目录名、或把世界从
     别处拷进来时，配置里的 level-name 与实际目录对不上。按名字认会判成没有世界，
     进而静默跳过备份——灾备缺口，且用户永远不知道。 */
  it('世界目录名与 level-name 不一致 ⇒ 仍判 true（不按配置名定位）', () => {
    mkdirWithLevelDat('c', 'world', true);
    // 实例配置指向一个根本不存在的名字，判据不该受它影响
    const inst = { properties: { 'level-name': 'old-world' } };
    expect(hasWorldData('c', inst)).toBe(true);
  });

  it('level-name 含越界段（../evil）⇒ 既不抛错也不影响判定', () => {
    mkdirWithLevelDat('d', 'world', true);
    const inst = { properties: { 'level-name': '../evil' } };
    expect(hasWorldData('d', inst)).toBe(true);
  });

  it('level.dat 在更深一层（world/sub/level.dat）不算有世界（只认直接层）', () => {
    mkdirWithLevelDat('e', 'world/sub', true);
    expect(hasWorldData('e')).toBe(false);
  });

  it('实例目录不存在 ⇒ false（不抛错）', () => {
    expect(hasWorldData('ghost-instance')).toBe(false);
  });

  it('实例目录下只有文件、没有子目录 ⇒ false', () => {
    fs.mkdirSync(path.join(root, 'f'), { recursive: true });
    fs.writeFileSync(path.join(root, 'f', 'level.dat'), 'x'); // 根下直接放，不算
    expect(hasWorldData('f')).toBe(false);
  });
});

// executeBackup 以真实成败回写任务 lastRunStatus——createBackup
// fire-and-forget 的 resolve 早于快照完成，任务状态必须由快照完成/失败点回写
describe('BackupService.executeBackup - 定时任务结果回写', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeService() {
    const manager = new EventEmitter();
    manager.getInstance = vi.fn(() => null);
    const service = new BackupService(manager);
    vi.spyOn(service, '_restoreSaveOn').mockResolvedValue();
    vi.spyOn(service, 'cleanupOldBackups').mockResolvedValue(0);
    return service;
  }

  it('成功：快照完成 + 校验通过 → updateLastRunStatus(taskId, success)', async () => {
    const service = makeService();
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bu-exec-'));
    try {
      vi.spyOn(service, '_createSnapshot').mockImplementation(async (_id, dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'level.dat'), 'x');
      });
      vi.spyOn(service, '_verifySnapshot').mockResolvedValue();

      await service.executeBackup('s1', 999, snapshotDir, { taskId: 42 });

      expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(
        42,
        'success',
        null,
        expect.any(Number),
      );
    } finally {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });

  it('失败：_createSnapshot 抛错 → updateLastRunStatus(taskId, failed)', async () => {
    const service = makeService();
    vi.spyOn(service, '_createSnapshot').mockRejectedValue(new Error('rsync failed'));

    await expect(
      service.executeBackup('s1', 999, '/nonexistent-dir', { taskId: 42 }),
    ).rejects.toThrow('rsync failed');

    expect(ScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(
      42,
      'failed',
      'rsync failed',
      expect.any(Number),
    );
  });

  it('taskId 为空（手动备份）不回写任务状态', async () => {
    const service = makeService();
    vi.spyOn(service, '_createSnapshot').mockRejectedValue(new Error('boom'));

    await expect(service.executeBackup('s1', 999, '/nonexistent-dir')).rejects.toThrow('boom');

    expect(ScheduledTaskModel.updateLastRunStatus).not.toHaveBeenCalled();
  });
});

// macOS 快照降级链的探测件：verifyHardlinkDedup 用 inode 比对判断
// --link-dest 去重是否真生效（openrsync 兼容性未知，探测结果驱动警告）。
// 本机（win32 NTFS / linux ext4）硬链接可用，可真实构造去重/拷贝两形态
describe('verifyHardlinkDedup 硬链接去重探测', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-dedup-probe-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('快照文件与基线共享 inode（fs.link）→ true（去重生效）', () => {
    const base = path.join(root, 'base');
    const snap = path.join(root, 'snap');
    fs.mkdirSync(path.join(base, 'world'), { recursive: true });
    fs.mkdirSync(path.join(snap, 'world'), { recursive: true });
    fs.writeFileSync(path.join(base, 'world', 'level.dat'), 'worlddata');
    fs.linkSync(path.join(base, 'world', 'level.dat'), path.join(snap, 'world', 'level.dat'));

    expect(verifyHardlinkDedup(base, snap)).toBe(true);
  });

  it('快照为独立拷贝（copyFileSync）→ false（去重未生效）', () => {
    const base = path.join(root, 'base');
    const snap = path.join(root, 'snap');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(base, 'level.dat'), 'worlddata');
    fs.copyFileSync(path.join(base, 'level.dat'), path.join(snap, 'level.dat'));
    // 函数只对「内容未变」样本判 inode，故须让两侧 mtime 严格相等。copyFileSync 是否
    // 保留 mtime 随平台而异（win32 保留、Linux 刷新为新值），而 utimesSync 传 Date 会
    // 截断到整秒、传秒数值又有亚毫秒舍入——两侧统一取整到同一整秒才确定相等，这也正是
    // rsync -t「保留时间但不硬链接」的真实形态。不对齐时样本被判内容已变而跳过，返回 null。
    const stamp = new Date(
      Math.floor(fs.statSync(path.join(base, 'level.dat')).mtimeMs / 1000) * 1000,
    );
    fs.utimesSync(path.join(base, 'level.dat'), stamp, stamp);
    fs.utimesSync(path.join(snap, 'level.dat'), stamp, stamp);

    expect(verifyHardlinkDedup(base, snap)).toBe(false);
  });

  it('两侧无同相对路径文件 → null（无法判定，不误报）', () => {
    const base = path.join(root, 'base');
    const snap = path.join(root, 'snap');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(snap, { recursive: true });
    expect(verifyHardlinkDedup(base, snap)).toBeNull();
  });

  it('基线为空目录/不存在 → null（不抛错，首份快照场景）', () => {
    expect(verifyHardlinkDedup(path.join(root, 'nope'), path.join(root, 'snap'))).toBeNull();
  });
});
