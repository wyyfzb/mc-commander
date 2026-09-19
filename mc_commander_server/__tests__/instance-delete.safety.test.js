import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// 卸载实例的数据安全取证（真实文件系统 + 系统临时目录）
//
// 路由级契约用例（status.endpoints.test.js）把 fs 与备份清单清点都替身化了，
// 无法证明「实例目录真的没了、备份目录与内容真的还在」。本文件把
// serversDir/backupsDir 整体指向 mkdtemp 出来的临时目录后跑真实 fs：
// 工作区的 data/、servers/、backups/ 与 .env 全程只读、零参与。

vi.mock('../db/index.js', () => ({
  InstanceModel: { delete: vi.fn() },
  BackupModel: {
    deleteByInstance: vi.fn(),
    resetStaleInProgress: vi.fn(),
    findAll: vi.fn(() => ({ backups: [], total: 0 })),
  },
}));

vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});

import { createStatusRoutes } from '../routes/status.js';
import { InstanceModel, BackupModel } from '../db/index.js';
import { recordAudit } from '../utils/audit.js';
import { errorHandler } from '../middleware/error_handler.js';
import config from '../config.js';

const ID = 'paper-a1b2c3d4';
const NAME = '测试实例';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-uninstall-safety-'));
const SERVERS_DIR = path.join(TMP_ROOT, 'servers');
const BACKUPS_DIR = path.join(TMP_ROOT, 'backups');
const INSTANCE_PATH = path.join(SERVERS_DIR, ID);
const BACKUP_PATH = path.join(BACKUPS_DIR, ID);

const ORIGINAL_DIRS = {
  serversDir: config.serversDir,
  backupsDir: config.backupsDir,
  dataDir: config.dataDir,
};
config.serversDir = SERVERS_DIR;
config.backupsDir = BACKUPS_DIR;
config.dataDir = path.join(TMP_ROOT, 'data');

afterAll(() => {
  Object.assign(config, ORIGINAL_DIRS);
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** 目录树取证快照：相对路径 + 文件内容 SHA256，用于断言「拒绝路径盘面逐字节不变」 */
function snapshotTree(root) {
  const entries = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push(`d ${path.relative(root, full)}`);
        walk(full);
      } else {
        entries.push(
          `f ${path.relative(root, full)} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`,
        );
      }
    }
  };
  walk(root);
  return entries;
}

/** 造一个「实例目录 + 单份备份快照」的真实盘面 */
function seedInstanceWithSnapshot(snapshotName = '每日备份-2026-09-01T04-00-00-000Z') {
  fs.mkdirSync(path.join(INSTANCE_PATH, 'world'), { recursive: true });
  fs.writeFileSync(
    path.join(INSTANCE_PATH, 'instance.json'),
    JSON.stringify({ id: ID, name: NAME }),
  );
  fs.writeFileSync(path.join(INSTANCE_PATH, 'world', 'level.dat'), 'world-bytes');
  fs.mkdirSync(path.join(BACKUP_PATH, snapshotName, 'world'), { recursive: true });
  fs.writeFileSync(path.join(BACKUP_PATH, snapshotName, 'world', 'level.dat'), 'snapshot-bytes');
  return snapshotName;
}

/** nameOverride 用于模拟升级前库里已存的带首尾空白实例名（绕过已归一化的写入侧） */
function makeApp(nameOverride = NAME) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createStatusRoutes({
      instances: new Map(),
      getInstance: () => ({
        id: ID,
        name: nameOverride,
        serverPath: INSTANCE_PATH,
        isRunning: false,
        cancelRestart: vi.fn(),
        process: null,
      }),
    }),
  );
  app.use(errorHandler);
  return app;
}

describe('DELETE /api/instances/:id · 真实盘面取证', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    BackupModel.findAll.mockReturnValue({ backups: [], total: 0 });
    fs.rmSync(SERVERS_DIR, { recursive: true, force: true });
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    fs.mkdirSync(SERVERS_DIR, { recursive: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    app = makeApp();
  });

  it('有备份：实例目录真被删除（含 instance.json），备份目录与其内容原样保留并在响应中回报', async () => {
    const snapshotName = seedInstanceWithSnapshot();

    const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName: NAME });

    expect(res.status).toBe(200);
    // 反向对照：实例目录真的没了（残留 instance.json 会让重启从 JSON「复活」实例）
    expect(fs.existsSync(INSTANCE_PATH)).toBe(false);
    // 备份目录真的还在，且内容逐字节保留
    expect(fs.existsSync(BACKUP_PATH)).toBe(true);
    expect(
      fs.readFileSync(path.join(BACKUP_PATH, snapshotName, 'world', 'level.dat'), 'utf-8'),
    ).toBe('snapshot-bytes');
    expect(res.body.data).toEqual({ retainedBackupCount: 1, retainedBackupNames: [snapshotName] });
    // backupsDir 本身绝不在删除射程内
    expect(fs.existsSync(BACKUPS_DIR)).toBe(true);
    expect(InstanceModel.delete).toHaveBeenCalledWith(ID);
    expect(BackupModel.deleteByInstance).toHaveBeenCalledWith(ID);
  });

  it('零备份 + acknowledgeIrreversible：实例目录删除，响应急报 0 份保留', async () => {
    fs.mkdirSync(INSTANCE_PATH, { recursive: true });
    fs.writeFileSync(path.join(INSTANCE_PATH, 'instance.json'), '{}');

    const res = await request(app)
      .delete(`/api/instances/${ID}`)
      .send({ confirmName: NAME, acknowledgeIrreversible: true });

    expect(res.status).toBe(200);
    expect(fs.existsSync(INSTANCE_PATH)).toBe(false);
    expect(res.body.data).toEqual({ retainedBackupCount: 0, retainedBackupNames: [] });
  });

  it('备份目录不存在时视为空清单：无 ack → 409，有 ack → 放行（不抛 ENOENT）', async () => {
    fs.mkdirSync(INSTANCE_PATH, { recursive: true });
    fs.rmSync(BACKUP_PATH, { recursive: true, force: true });

    const denied = await request(app).delete(`/api/instances/${ID}`).send({ confirmName: NAME });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe(40914);
    expect(fs.existsSync(INSTANCE_PATH)).toBe(true);

    const allowed = await request(app)
      .delete(`/api/instances/${ID}`)
      .send({ confirmName: NAME, acknowledgeIrreversible: true });
    expect(allowed.status).toBe(200);
    expect(fs.existsSync(INSTANCE_PATH)).toBe(false);
  });

  it('确认不符：盘面逐字节不变（不删文件、不改 DB、不写审计、不停机）', async () => {
    seedInstanceWithSnapshot();
    const before = snapshotTree(TMP_ROOT);

    const res = await request(app)
      .delete(`/api/instances/${ID}`)
      .send({ confirmName: '另一个名字' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40016);
    expect(snapshotTree(TMP_ROOT)).toEqual(before);
    expect(InstanceModel.delete).not.toHaveBeenCalled();
    expect(BackupModel.deleteByInstance).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('零备份且未确认不可恢复：盘面逐字节不变（不删文件、不改 DB、不写审计）', async () => {
    fs.mkdirSync(INSTANCE_PATH, { recursive: true });
    fs.writeFileSync(path.join(INSTANCE_PATH, 'server.jar'), 'jar-bytes');
    const before = snapshotTree(TMP_ROOT);

    const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName: NAME });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40914);
    expect(snapshotTree(TMP_ROOT)).toEqual(before);
    expect(InstanceModel.delete).not.toHaveBeenCalled();
    expect(BackupModel.deleteByInstance).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('审计先于文件操作：意图审计写入时刻实例目录仍在盘上，随后补结果审计', async () => {
    seedInstanceWithSnapshot();
    const seen = [];
    recordAudit.mockImplementation((entry) => {
      seen.push({
        phase: entry.detail?.phase,
        dirPresent: fs.existsSync(INSTANCE_PATH),
        backupPresent: fs.existsSync(BACKUP_PATH),
      });
    });

    const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName: NAME });

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { phase: 'intent', dirPresent: true, backupPresent: true },
      { phase: 'completed', dirPresent: false, backupPresent: true },
    ]);
  });

  it('竞态幂等：实例目录已不存在时仍成功，备份目录不受影响', async () => {
    const snapshotName = seedInstanceWithSnapshot();
    fs.rmSync(INSTANCE_PATH, { recursive: true, force: true });

    const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName: NAME });

    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(BACKUP_PATH, snapshotName))).toBe(true);
    expect(res.body.data.retainedBackupCount).toBe(1);
  });

  // 升级前库里可能已存着带首尾空白的实例名（写入侧归一化只对新数据生效）：
  // 删除侧按原样比对会让这类实例永久删不掉，故两侧都要 trim
  describe('旧数据：实例名带首尾空白', () => {
    const LEGACY_NAME = '测试实例 ';

    beforeEach(() => {
      app = makeApp(LEGACY_NAME);
    });

    it.each([
      ['界面所见的原名（带空格）', LEGACY_NAME],
      ['trim 后的名字', LEGACY_NAME.trim()],
      ['再补一层空白', `  ${LEGACY_NAME}  `],
    ])('confirmName 为%s → 成功卸载且实例目录真的删除', async (_label, confirmName) => {
      seedInstanceWithSnapshot();

      const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName });

      expect(res.status).toBe(200);
      expect(fs.existsSync(INSTANCE_PATH)).toBe(false);
      expect(res.body.data.retainedBackupCount).toBe(1);
    });

    it('不匹配的名字仍然拒绝：盘面逐字节不变', async () => {
      seedInstanceWithSnapshot();
      const before = snapshotTree(TMP_ROOT);

      const res = await request(app)
        .delete(`/api/instances/${ID}`)
        .send({ confirmName: '测试实例x' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40016);
      expect(snapshotTree(TMP_ROOT)).toEqual(before);
    });

    it('confirmName 为纯空白 → 400（归一化后为空，与有名字的实例不匹配）', async () => {
      seedInstanceWithSnapshot();

      const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40016);
      expect(fs.existsSync(INSTANCE_PATH)).toBe(true);
    });
  });

  // 升级前库里还可能存着空名旧行（写入侧当时放行 ''）：这类实例只能靠空/空白入参确认，
  // 若把确认值当「必填非空」收紧，它们同样永远删不掉。
  // 但空名让「输入实例名」这道闸门空转（空串天然匹配、不承载任何信息），故这类实例
  // 额外要求 acknowledgeIrreversible=true（与「没有任何备份」同一档显式确认）
  describe('旧数据：实例名为空串', () => {
    beforeEach(() => {
      app = makeApp('');
    });

    it.each([
      ['空串', ''],
      ['纯空白', '   '],
    ])('confirmName 为%s 但未声明不可恢复 → 409 且盘面逐字节不变', async (_label, confirmName) => {
      seedInstanceWithSnapshot();
      const before = snapshotTree(TMP_ROOT);

      const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(40916);
      expect(snapshotTree(TMP_ROOT)).toEqual(before);
    });

    it.each([
      ['空串', ''],
      ['纯空白', '   '],
    ])(
      'confirmName 为%s 且声明不可恢复 → 成功卸载且实例目录真的删除',
      async (_label, confirmName) => {
        seedInstanceWithSnapshot();

        const res = await request(app)
          .delete(`/api/instances/${ID}`)
          .send({ confirmName, acknowledgeIrreversible: true });

        expect(res.status).toBe(200);
        expect(fs.existsSync(INSTANCE_PATH)).toBe(false);
        expect(res.body.data.retainedBackupCount).toBe(1);
      },
    );

    it('传任意非空名字 → 400 且盘面逐字节不变', async () => {
      seedInstanceWithSnapshot();
      const before = snapshotTree(TMP_ROOT);

      const res = await request(app)
        .delete(`/api/instances/${ID}`)
        .send({ confirmName: '随便什么' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40016);
      expect(snapshotTree(TMP_ROOT)).toEqual(before);
    });
  });

  // 反向对照：放宽「空串可比对」不得变成提权——有名字的实例传空串必须仍被拒绝
  describe('反向对照：空串确认只对空名实例成立', () => {
    it('普通实例（有名字）传空串/纯空白 → 400 且盘面逐字节不变', async () => {
      seedInstanceWithSnapshot();
      const before = snapshotTree(TMP_ROOT);

      for (const confirmName of ['', '   ']) {
        const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName });
        expect(res.status, JSON.stringify(confirmName)).toBe(400);
        expect(res.body.code).toBe(40016);
      }
      expect(snapshotTree(TMP_ROOT)).toEqual(before);
    });

    it.each([
      ['number', 42],
      ['array', []],
      ['object', {}],
      ['null', null],
    ])('confirmName 为 %s → 400（类型收口不被放宽影响）', async (_label, confirmName) => {
      seedInstanceWithSnapshot();

      const res = await request(app).delete(`/api/instances/${ID}`).send({ confirmName });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40016);
      expect(fs.existsSync(INSTANCE_PATH)).toBe(true);
    });
  });
});
