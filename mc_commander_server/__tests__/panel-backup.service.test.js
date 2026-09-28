import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// dataDir/backupsDir 指向临时目录，避免读写真实 data/ 与 backups/
vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-panel-backup-'));
  return {
    default: {
      // .env 伴生副本的来源路径也锚定临时目录（真实 config 指向服务端 .env）
      envFilePath: path.join(tmpRoot, '.env'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      panelBackup: {
        enabled: true,
        cron: '0 4 * * *',
        retention: { maxBackups: 3, maxAgeDays: 30 },
      },
    },
  };
});

import Database from 'better-sqlite3';
import config from '../config.js';
import { initDatabase } from '../db/database.js';
import {
  getPanelBackupDir,
  createPanelSnapshot,
  cleanupPanelSnapshots,
  runPanelBackupCycle,
  getLatestSnapshotTime,
} from '../services/panel-backup.service.js';

function fakeSnapshotName(iso) {
  return `panel-${iso.replace(/[:.]/g, '-')}.db`;
}

/** 快照名 → .env 伴生副本名（与 service 的配对约定同一表达式） */
function fakeSidecarName(snapshotName) {
  return snapshotName.replace(/\.db$/, '.env');
}

/** 目录内路径拼装 + 边界自检：测试内动态生成文件名的统一入口（杜绝越界拼写） */
function inDir(dir, name) {
  const target = path.resolve(dir, name);
  if (!target.startsWith(dir + path.sep)) throw new Error(`越界文件名: ${name}`);
  return target;
}

/** 清空快照与伴生副本（不误伤人工放置的非命名空间文件） */
function cleanPanelBackupDir() {
  const dir = getPanelBackupDir();
  for (const f of fs.readdirSync(dir)) {
    // .db-wal/.db-shm：只读打开 WAL 模式快照时 SQLite 产生的副文件，一并清理
    if (
      f.startsWith('panel-') &&
      (f.endsWith('.db') || f.endsWith('.env') || f.endsWith('.db-wal') || f.endsWith('.db-shm'))
    ) {
      fs.rmSync(inDir(dir, f), { force: true });
    }
  }
}

// 动态生成 N 天前的文件名内嵌时间戳（保持过去时序，避免硬编码日期随时间失效）
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe('PanelBackupService', () => {
  let db;

  beforeAll(() => {
    db = initDatabase();
  });

  afterAll(() => {
    db.close();
    fs.rmSync(path.dirname(config.dataDir), { recursive: true, force: true });
  });

  describe('createPanelSnapshot', () => {
    it('快照文件落 backups/panel/ 且内容可查询（数据一致）', async () => {
      db.prepare(
        "INSERT INTO instances (id, name) VALUES ('panel-bu-test', '面板备份测试实例')",
      ).run();

      const result = await createPanelSnapshot();

      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(result.filePath.startsWith(path.join(config.backupsDir, 'panel'))).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);

      // 快照是独立完整 DB：能打开并查到快照时刻的数据
      const snapDb = new Database(result.filePath, { readonly: true });
      const row = snapDb.prepare("SELECT name FROM instances WHERE id = 'panel-bu-test'").get();
      expect(row.name).toBe('面板备份测试实例');
      snapDb.close();
    });

    it('在线语义：快照后源库继续可写，新快照包含增量数据', async () => {
      const first = await createPanelSnapshot();

      db.prepare("INSERT INTO instances (id, name) VALUES ('panel-bu-test-2', '增量实例')").run();

      // 文件名时间戳为毫秒精度：等过 1ms 保证两次快照文件名不同
      // （生产触发源为每日 cron，无同毫秒并发场景）
      await new Promise((r) => setTimeout(r, 2));

      const second = await createPanelSnapshot();
      expect(second.filePath).not.toBe(first.filePath);

      const snap1 = new Database(first.filePath, { readonly: true });
      const snap2 = new Database(second.filePath, { readonly: true });
      expect(
        snap1.prepare("SELECT COUNT(*) AS c FROM instances WHERE id = 'panel-bu-test-2'").get().c,
      ).toBe(0);
      expect(
        snap2.prepare("SELECT COUNT(*) AS c FROM instances WHERE id = 'panel-bu-test-2'").get().c,
      ).toBe(1);
      snap1.close();
      snap2.close();
    });
  });

  describe('cleanupPanelSnapshots', () => {
    // 清理测试隔离：每用例前清空真快照与副本（前面 describe 的产物会干扰数量断言）
    beforeEach(() => {
      cleanPanelBackupDir();
    });

    it('数量上限：超出部分最旧先删', () => {
      const dir = getPanelBackupDir();
      // 文件名内嵌毫秒时间戳：先固定再创建/断言共用，避免 isoDaysAgo 重复调用毫秒抖动
      const [name5, name4, name3, name2, name1] = [5, 4, 3, 2, 1].map((d) =>
        fakeSnapshotName(isoDaysAgo(d)),
      );
      for (const n of [name5, name4, name3, name2, name1]) fs.writeFileSync(inDir(dir, n), 'x');

      const deleted = cleanupPanelSnapshots({ maxBackups: 3, maxAgeDays: 365 });

      expect(deleted).toBe(2);
      const remaining = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('panel-') && f.endsWith('.db'));
      expect(remaining.length).toBe(3);
      expect(remaining).toContain(name1);
      expect(remaining).not.toContain(name5);
      expect(remaining).not.toContain(name4);
    });

    it('数量上限：被删快照的 .env 伴生副本同去留', () => {
      const dir = getPanelBackupDir();
      const [name5, name4, name3, name2, name1] = [5, 4, 3, 2, 1].map((d) =>
        fakeSnapshotName(isoDaysAgo(d)),
      );
      for (const n of [name5, name4, name3, name2, name1]) {
        fs.writeFileSync(inDir(dir, n), 'x');
        fs.writeFileSync(inDir(dir, fakeSidecarName(n)), 'env');
      }

      cleanupPanelSnapshots({ maxBackups: 3, maxAgeDays: 365 });

      expect(fs.existsSync(inDir(dir, fakeSidecarName(name5)))).toBe(false);
      expect(fs.existsSync(inDir(dir, fakeSidecarName(name4)))).toBe(false);
      expect(fs.existsSync(inDir(dir, fakeSidecarName(name1)))).toBe(true);
    });

    it('天数上限：mtime 过期的快照删除（mtime 即创建时刻语义）', () => {
      const dir = getPanelBackupDir();
      const oldPath = inDir(dir, fakeSnapshotName(isoDaysAgo(40)));
      fs.writeFileSync(oldPath, 'x');
      // mtime 回拨 40 天（> maxAgeDays 30）
      const aged = new Date(Date.now() - 40 * 86_400_000);
      fs.utimesSync(oldPath, aged, aged);

      cleanupPanelSnapshots({ maxBackups: 100, maxAgeDays: 30 });

      expect(fs.existsSync(oldPath)).toBe(false);
    });

    it('不误伤非快照命名的文件', () => {
      const dir = getPanelBackupDir();
      const foreign = path.join(dir, 'readme.txt');
      fs.writeFileSync(foreign, 'manual note');

      cleanupPanelSnapshots({ maxBackups: 1, maxAgeDays: 30 });

      expect(fs.existsSync(foreign)).toBe(true);
    });

    it('孤儿副本清扫：快照已被手工删除的 .env 伴生副本被清理', () => {
      const dir = getPanelBackupDir();
      const orphan = inDir(dir, fakeSidecarName(fakeSnapshotName(isoDaysAgo(2))));
      fs.writeFileSync(orphan, 'orphan-env');

      cleanupPanelSnapshots({ maxBackups: 10, maxAgeDays: 30 });

      expect(fs.existsSync(orphan)).toBe(false);
    });
  });

  describe('env 伴生副本（.env 纳入灾备）', () => {
    const envPath = () => config.envFilePath;

    afterEach(() => {
      // 还原 .env 形态（文件/目录）与残留副本，避免泄漏到其它 describe
      fs.rmSync(envPath(), { force: true, recursive: true });
      cleanPanelBackupDir();
    });

    it('当 .env 存在：与快照成对落盘且内容一致', async () => {
      fs.writeFileSync(envPath(), 'API_KEY_HASH=mock-hash\nSETUP_TOKEN=mock-one-time-token\n');

      const result = await createPanelSnapshot();

      expect(result.envFilePath).toBe(result.filePath.replace(/\.db$/, '.env'));
      expect(fs.readFileSync(result.envFilePath, 'utf8')).toBe(
        'API_KEY_HASH=mock-hash\nSETUP_TOKEN=mock-one-time-token\n',
      );
    });

    // 副本权限镜像源 .env（0600 凭据纪律）；chmod 在 Windows 上为近似 no-op，
    // POSIX 位在该平台无意义，按平台跳过（非「平台基线」掩盖：断言语义本身只在 POSIX 可表达）
    it.skipIf(process.platform === 'win32')('副本权限镜像源 .env（0600 凭据纪律）', async () => {
      fs.writeFileSync(envPath(), 'API_KEY_HASH=mock-hash\n');
      fs.chmodSync(envPath(), 0o600);

      const result = await createPanelSnapshot();

      expect(fs.statSync(result.envFilePath).mode & 0o777).toBe(0o600);
    });

    it('当 .env 不存在（纯环境变量部署）：跳过副本，envFilePath 为 null', async () => {
      fs.rmSync(envPath(), { force: true });

      const result = await createPanelSnapshot();

      expect(result.envFilePath).toBeNull();
      expect(fs.existsSync(result.filePath.replace(/\.db$/, '.env'))).toBe(false);
    });

    it('副本写入失败：连同快照一并回滚，不留「有 db 无 env」的残缺恢复点', async () => {
      // 用同名目录顶替 .env 文件，使 copyFileSync 稳定抛错（跨平台可控）
      fs.mkdirSync(envPath(), { recursive: true });

      await expect(createPanelSnapshot()).rejects.toThrow();

      const dir = getPanelBackupDir();
      const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('panel-'));
      expect(leftovers).toHaveLength(0);
    });
  });

  describe('getLatestSnapshotTime（停机补跑基线）', () => {
    it('目录无快照：返回 null', () => {
      cleanPanelBackupDir();
      expect(getLatestSnapshotTime()).toBeNull();
    });

    it('取 mtime 最新的快照（与保留清理同口径，不解析文件名时间戳）', () => {
      const dir = getPanelBackupDir();
      const older = inDir(dir, fakeSnapshotName(isoDaysAgo(2)));
      const newer = inDir(dir, fakeSnapshotName(isoDaysAgo(1)));
      fs.writeFileSync(older, 'x');
      fs.writeFileSync(newer, 'x');
      expect(getLatestSnapshotTime()).toBe(fs.statSync(newer).mtimeMs);

      // mtime 反转（回拨较新文件的 mtime）：口径跟随 mtime 而非文件名
      const aged = new Date(Date.now() - 3 * 86_400_000);
      fs.utimesSync(newer, aged, aged);
      expect(getLatestSnapshotTime()).toBe(fs.statSync(older).mtimeMs);
    });
  });

  describe('runPanelBackupCycle', () => {
    beforeEach(() => {
      cleanPanelBackupDir();
    });

    it('一次周期 = 快照 + 清理，返回删除计数', async () => {
      const dir = getPanelBackupDir();
      // 预置 3 个旧快照（超过 maxBackups=3：新快照落盘后共 4 个 → 删 1 个最旧）
      const oldNames = [9, 8, 7].map((d) => fakeSnapshotName(isoDaysAgo(d)));
      for (const n of oldNames) fs.writeFileSync(path.join(dir, n), 'x');

      const result = await runPanelBackupCycle();

      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(result.deletedCount).toBe(1);
      const remaining = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('panel-') && f.endsWith('.db'));
      expect(remaining.length).toBe(3);
    });
  });
});
