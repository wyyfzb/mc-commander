/**
 * 归档快照：清点 + 挂载
 *
 * 承重点：卸载实例会删掉备份表记录、快照目录按设计留在 `backupsDir/<原实例 id>/`——
 * 此后 UI 完全看不到它们（列表只读备份表），且会随保留期孤儿清扫被删。
 * 「挂载」把快照登记回备份表，**只建索引、不动磁盘**（不复制、不移动、不删除）。
 *
 * 真实文件系统（系统临时目录）+ 桩 DB：目录判定/体积估算/跳过逻辑全部实测，
 * 工作区的 backups/ 与 servers/ 全程零参与。
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ filePaths: [], created: [] }));

// 只替身 DB：InstanceModel.getById（组内 instanceExists）与 BackupModel 的
// listFilePaths/create（索引比对与登记）。其余全走真实 fs。
vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});

vi.mock('../db/index.js', () => ({
  InstanceModel: { getById: vi.fn(() => null) },
  BackupModel: {
    listFilePaths: vi.fn(() => h.filePaths),
    create: vi.fn((data) => {
      h.created.push(data);
      return { id: h.created.length, ...data };
    }),
  },
}));

import {
  attachArchivedSnapshots,
  listArchivedSnapshots,
} from '../services/backup-snapshot.service.js';
import { InstanceModel, BackupModel } from '../db/index.js';
import config from '../config.js';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createBackupRoutes } from '../routes/backups.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { errorHandler } from '../middleware/error_handler.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-backup-archive-'));
const BACKUPS_DIR = path.join(TMP_ROOT, 'backups');
const ORIGINAL = { backupsDir: config.backupsDir };
config.backupsDir = BACKUPS_DIR;

const mk = (p) => fs.mkdirSync(p, { recursive: true });

/** 造一份「看起来可用」的快照：快照 = 实例目录镜像，level.dat 在 <level-name>/ 直接层 */
function makeSnapshot(dir, { worldName = 'world', sizeBytes = 0 } = {}) {
  mk(path.join(dir, worldName));
  fs.writeFileSync(path.join(dir, worldName, 'level.dat'), 'LEVELDATA');
  if (sizeBytes > 0) {
    // 体积断言用：写个可见大小的文件（estimateDirSize 按目录树累加）
    fs.writeFileSync(path.join(dir, worldName, 'region.mca'), Buffer.alloc(sizeBytes));
  }
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n');
}

/** 造一份「认不出世界数据」的快照（目录里没有 level.dat） */
function makeInvalidSnapshot(dir) {
  mk(path.join(dir, 'not-world'));
  fs.writeFileSync(path.join(dir, 'not-world', 'readme.txt'), 'x');
}

afterAll(() => {
  Object.assign(config, ORIGINAL);
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.filePaths = [];
  h.created = [];
  InstanceModel.getById.mockReturnValue(null);
  BackupModel.listFilePaths.mockImplementation(() => h.filePaths);
  // create 的默认实现（clearAllMocks 不清 implementation，个别用例会临时覆写
  // ——唯一索引冲突、DB 故障——必须在这里复位，否则会泄进后续用例）
  BackupModel.create.mockImplementation((data) => {
    h.created.push(data);
    return { id: h.created.length, ...data };
  });
  fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
  mk(BACKUPS_DIR);
});

afterEach(() => {
  fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
});

describe('listArchivedSnapshots · 未索引快照清点', () => {
  it('backupsDir 不存在 → 空清单（不抛）', () => {
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    expect(listArchivedSnapshots()).toEqual([]);
  });

  it('未索引的快照计入，且区分「可用份数」与「总份数」', () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    makeSnapshot(path.join(archiveDir, 'snap-a'));
    makeSnapshot(path.join(archiveDir, 'snap-b'));
    makeInvalidSnapshot(path.join(archiveDir, 'snap-broken'));

    const groups = listArchivedSnapshots();
    expect(groups).toHaveLength(1);
    expect(groups[0].archiveId).toBe('paper-1a2b3c4d');
    expect(groups[0].snapshotCount).toBe(3);
    expect(groups[0].usableCount).toBe(2);
    expect(groups[0].instanceExists).toBe(false);
    expect(Number.isNaN(Date.parse(groups[0].latestMtime))).toBe(false);
  });

  it('已索引的快照不计入（挂载过就不再出现）', () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    const snapA = path.join(archiveDir, 'snap-a');
    const snapB = path.join(archiveDir, 'snap-b');
    makeSnapshot(snapA);
    makeSnapshot(snapB);
    h.filePaths = [snapA];

    const groups = listArchivedSnapshots();
    expect(groups).toHaveLength(1);
    expect(groups[0].snapshotCount).toBe(1);
  });

  it('全部已索引 → 该组不出现（不留空组）', () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    const snap = path.join(archiveDir, 'snap-a');
    makeSnapshot(snap);
    h.filePaths = [snap];
    expect(listArchivedSnapshots()).toEqual([]);
  });

  it('非实例 id 形态的目录不进射程（panel 命名空间与人工放置目录）', () => {
    mk(path.join(BACKUPS_DIR, 'panel'));
    makeSnapshot(path.join(BACKUPS_DIR, 'panel', 'snap-x'));
    makeSnapshot(path.join(BACKUPS_DIR, '我的备份', 'snap-y'));
    expect(listArchivedSnapshots()).toEqual([]);
  });

  it('同名实例仍在 → instanceExists=true（UI 据此换文案）', () => {
    makeSnapshot(path.join(BACKUPS_DIR, 'paper-1a2b3c4d', 'snap-a'));
    InstanceModel.getById.mockImplementation((id) => (id === 'paper-1a2b3c4d' ? { id } : null));
    expect(listArchivedSnapshots()[0].instanceExists).toBe(true);
  });

  it('按最近快照时间倒序（新的在前）', () => {
    makeSnapshot(path.join(BACKUPS_DIR, 'paper-11111111', 'snap-old'));
    makeSnapshot(path.join(BACKUPS_DIR, 'paper-22222222', 'snap-new'));
    const t = (d) => (Date.now() - d * 1000) / 1000;
    fs.utimesSync(path.join(BACKUPS_DIR, 'paper-11111111', 'snap-old'), t(3600), t(3600));
    fs.utimesSync(path.join(BACKUPS_DIR, 'paper-22222222', 'snap-new'), t(10), t(10));

    expect(listArchivedSnapshots().map((g) => g.archiveId))
      .toEqual(['paper-22222222', 'paper-11111111']);
  });

  it('备份表不可读 → 空清单（宁可这次不给入口，也不给出会插重复行的入口）', () => {
    makeSnapshot(path.join(BACKUPS_DIR, 'paper-1a2b3c4d', 'snap-a'));
    BackupModel.listFilePaths.mockImplementation(() => {
      throw new Error('db locked');
    });
    expect(listArchivedSnapshots()).toEqual([]);
  });
});

describe('attachArchivedSnapshots · 挂载（只建索引）', () => {
  it('把可用快照登记为目标实例的备份，且不动磁盘内容', async () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    const snapA = path.join(archiveDir, 'snap-a');
    makeSnapshot(snapA, { sizeBytes: 1024 });
    makeSnapshot(path.join(archiveDir, 'snap-b'));

    const result = await attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d');

    expect(result).toEqual({ attached: 2, skipped: 0 });
    expect(h.created).toHaveLength(2);
    const first = h.created[0];
    expect(first.instanceId).toBe('fabric-99999999');
    expect(first.name).toBe('snap-a');
    expect(first.status).toBe('completed');
    expect(first.worldName).toBe('world');
    expect(first.filePath).toBe(snapA);
    expect(first.description).toContain('paper-1a2b3c4d');
    // 挂载标记（v13 列）：恢复时的归属校验靠它区分「常规行 / 跨实例挂载行」，
    // 缺了它跨实例挂载出来的条目一恢复就是 403
    expect(first.sourceArchiveId).toBe('paper-1a2b3c4d');
    // 体积按目录树累加（1024 字节的 region.mca 在内），不是目录项大小
    expect(first.size).toBeGreaterThanOrEqual(1024);

    // 只建索引：原目录与内容原样留在归档位置
    expect(fs.existsSync(path.join(snapA, 'world', 'level.dat'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'snap-b'))).toBe(true);
  });

  it('认不出世界数据的快照跳过（挂上去也恢复不了）', async () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    makeSnapshot(path.join(archiveDir, 'snap-ok'));
    makeInvalidSnapshot(path.join(archiveDir, 'snap-broken'));

    const result = await attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d');
    expect(result).toEqual({ attached: 1, skipped: 1 });
    expect(h.created.map((c) => c.name)).toEqual(['snap-ok']);
  });

  it('幂等：已挂载过的快照计 skipped，不会插重复行', async () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    const snap = path.join(archiveDir, 'snap-a');
    makeSnapshot(snap);
    const first = await attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d');
    expect(first.attached).toBe(1);

    // 模拟登记生效：索引里出现该路径（真实链路是 DB 回读）
    h.filePaths = [...h.filePaths, snap];
    const second = await attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d');
    expect(second).toEqual({ attached: 0, skipped: 1 });
    expect(h.created).toHaveLength(1);
  });

  it('归档标识不合法（路径穿越/形态不符）→ 拒绝，不碰磁盘', async () => {
    for (const bad of ['../etc', 'paper-1a2b3c4d/../..', 'panel', 'PAPER-1A2B3C4D', '']) {
      await expect(attachArchivedSnapshots('fabric-99999999', bad)).rejects.toThrow('Invalid archive id');
    }
    expect(h.created).toHaveLength(0);
  });

  it('归档目录不存在 → 明确报错（路由层映射 404）', async () => {
    await expect(attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'))
      .rejects.toThrow('Archive directory not found');
  });

  it('目录里没有子目录（空归档）→ 0 挂载 0 跳过', async () => {
    mk(path.join(BACKUPS_DIR, 'paper-1a2b3c4d'));
    fs.writeFileSync(path.join(BACKUPS_DIR, 'paper-1a2b3c4d', 'README.txt'), 'x');
    expect(await attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'))
      .toEqual({ attached: 0, skipped: 0 });
  });

  it('备份表不可读 → 抛错（不插第二批重复行）', async () => {
    makeSnapshot(path.join(BACKUPS_DIR, 'paper-1a2b3c4d', 'snap-a'));
    BackupModel.listFilePaths.mockImplementation(() => {
      throw new Error('db locked');
    });
    await expect(attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'))
      .rejects.toThrow('Backup index unavailable');
    expect(h.created).toHaveLength(0);
  });

  it('归档目录是软链/联结点 → 按不存在拒绝（清点侧也不显示链接，两侧口径一致）', async () => {
    const realDir = path.join(TMP_ROOT, 'outside-archive');
    makeSnapshot(path.join(realDir, 'snap-a'));
    const linkDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    try {
      // Windows 上目录符号链接需要开发者模式/管理员，硬链接(junction)不需要
      fs.symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      // 无权限建链的环境（部分 Windows 无开发者模式）：跳过该平台断言
      if (err.code === 'EPERM' || err.code === 'EACCES') return;
      throw err;
    }

    expect(listArchivedSnapshots().map((g) => g.archiveId)).not.toContain('paper-1a2b3c4d');
    await expect(attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'))
      .rejects.toThrow('Archive directory not found');
    expect(h.created).toHaveLength(0);
  });

  it('归档标识指向文件而非目录 → 按不存在拒绝（不落 500）', async () => {
    fs.writeFileSync(path.join(BACKUPS_DIR, 'paper-1a2b3c4d'), 'not a dir');
    await expect(attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'))
      .rejects.toThrow('Archive directory not found');
  });

  it('并发挂载同一归档：UNIQUE(file_path) 拦下重复登记，第二次计 skipped（不抛错、不双份行）', async () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    const snap = path.join(archiveDir, 'snap-a');
    makeSnapshot(snap);
    // 模拟真实 DB 的唯一索引：同路径第二次插入抛 UNIQUE 约束错
    const realCreate = BackupModel.create.getMockImplementation();
    BackupModel.create.mockImplementation((data) => {
      if (h.created.some((c) => c.filePath === data.filePath)) {
        throw new Error('UNIQUE constraint failed: backups.file_path');
      }
      return realCreate(data);
    });

    const [a, b] = await Promise.all([
      attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'),
      attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'),
    ]);

    expect(a.attached + b.attached).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect(h.created).toHaveLength(1);
  });

  it('登记时的非 UNIQUE 错误（如磁盘/DB 故障）向上抛，不被当作「跳过」吞掉', async () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    makeSnapshot(path.join(archiveDir, 'snap-a'));
    BackupModel.create.mockImplementation(() => {
      throw new Error('database is locked');
    });

    // 吞掉会让路由回 200「没有可挂载的快照」，而真实原因（DB 故障）被掩盖
    await expect(attachArchivedSnapshots('fabric-99999999', 'paper-1a2b3c4d'))
      .rejects.toThrow('database is locked');
  });
});

// ── 路由层：契约出参、404 映射与审计留痕（服务层已在上方单独覆盖） ─────────────
describe('归档快照路由', () => {
  const stubManager = Object.assign(new EventEmitter(), {
    instances: new Map(),
    getInstance: (id) => (id === 'fabric-99999999' ? { id } : null),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createBackupRoutes(stubManager));
  app.use(errorHandler);

  it('GET /backups/archived：200 + 契约形状，且不下发磁盘路径', async () => {
    makeSnapshot(path.join(BACKUPS_DIR, 'paper-1a2b3c4d', 'snap-a'));

    const res = await request(app).get('/api/v1/backups/archived');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(expect.objectContaining({
      archiveId: 'paper-1a2b3c4d',
      instanceExists: false,
      snapshotCount: 1,
      usableCount: 1,
    }));
    // 契约面固定五项：不夹带磁盘路径（与备份详情同口径）
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      'archiveId', 'instanceExists', 'latestMtime', 'snapshotCount', 'usableCount',
    ]);
  });

  it('POST /backups/archived 之外的路径不受影响：空归档标识 → 400（契约层拦截）', async () => {
    const res = await request(app)
      .post('/api/v1/instances/fabric-99999999/backups/attach')
      .send({ archiveId: '' });
    expect(res.status).toBe(400);
  });

  it('挂载：200 + 回报挂载与跳过份数 + 留审计（targetType=backup_archive）', async () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    makeSnapshot(path.join(archiveDir, 'snap-a'));
    makeInvalidSnapshot(path.join(archiveDir, 'snap-broken'));

    const res = await request(app)
      .post('/api/v1/instances/fabric-99999999/backups/attach')
      .send({ archiveId: 'paper-1a2b3c4d' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ attached: 1, skipped: 1 });
    expect(res.body.message).toContain('已挂载 1 份');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'fabric-99999999',
      action: AuditActions.BACKUP_CREATE,
      targetType: 'backup_archive',
      targetId: 'paper-1a2b3c4d',
    }));
  });

  it('重复挂载（无可挂载项）：200 且文案据实，不写审计', async () => {
    const archiveDir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    const snapA = path.join(archiveDir, 'snap-a');
    makeSnapshot(snapA);
    h.filePaths = [snapA];
    recordAudit.mockClear();

    const res = await request(app)
      .post('/api/v1/instances/fabric-99999999/backups/attach')
      .send({ archiveId: 'paper-1a2b3c4d' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ attached: 0, skipped: 1 });
    expect(res.body.message).toContain('没有可挂载的快照');
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('目标实例不存在 → 404；归档目录不存在 → 404', async () => {
    const missing = await request(app)
      .post('/api/v1/instances/ghost-00000000/backups/attach')
      .send({ archiveId: 'paper-1a2b3c4d' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(40401);

    const noArchive = await request(app)
      .post('/api/v1/instances/fabric-99999999/backups/attach')
      .send({ archiveId: 'paper-1a2b3c4d' });
    expect(noArchive.status).toBe(404);
    expect(noArchive.body.code).toBe(40402);
  });

  it('归档标识不合法 → 400（形态白名单在路由层映射为校验错误）', async () => {
    const res = await request(app)
      .post('/api/v1/instances/fabric-99999999/backups/attach')
      .send({ archiveId: '../../etc' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('备份索引不可读 → 503/50303（服务端依赖故障，不是 500 泛化）', async () => {
    makeSnapshot(path.join(BACKUPS_DIR, 'paper-1a2b3c4d', 'snap-a'));
    BackupModel.listFilePaths.mockImplementation(() => {
      throw new Error('db locked');
    });
    const res = await request(app)
      .post('/api/v1/instances/fabric-99999999/backups/attach')
      .send({ archiveId: 'paper-1a2b3c4d' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(50303);
  });

  it('归档路径上出现文件（ENOTDIR）→ 404 而非 500', async () => {
    fs.writeFileSync(path.join(BACKUPS_DIR, 'paper-1a2b3c4d'), 'not a dir');
    const res = await request(app)
      .post('/api/v1/instances/fabric-99999999/backups/attach')
      .send({ archiveId: 'paper-1a2b3c4d' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40402);
  });
});
