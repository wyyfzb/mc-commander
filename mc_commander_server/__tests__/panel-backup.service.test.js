import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
} from '../services/panel-backup.service.js';

function fakeSnapshotName(iso) {
  return `panel-${iso.replace(/[:.]/g, '-')}.db`;
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
        "INSERT INTO instances (id, name) VALUES ('panel-bu-test', '面板备份测试实例')"
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

      db.prepare(
        "INSERT INTO instances (id, name) VALUES ('panel-bu-test-2', '增量实例')"
      ).run();

      // 文件名时间戳为毫秒精度：等过 1ms 保证两次快照文件名不同
      // （生产触发源为每日 cron，无同毫秒并发场景）
      await new Promise((r) => setTimeout(r, 2));

      const second = await createPanelSnapshot();
      expect(second.filePath).not.toBe(first.filePath);

      const snap1 = new Database(first.filePath, { readonly: true });
      const snap2 = new Database(second.filePath, { readonly: true });
      expect(snap1.prepare("SELECT COUNT(*) AS c FROM instances WHERE id = 'panel-bu-test-2'").get().c).toBe(0);
      expect(snap2.prepare("SELECT COUNT(*) AS c FROM instances WHERE id = 'panel-bu-test-2'").get().c).toBe(1);
      snap1.close();
      snap2.close();
    });
  });

  describe('cleanupPanelSnapshots', () => {
    // 清理测试隔离：每用例前清空真快照（前面 describe 的产物会干扰数量断言）
    beforeEach(() => {
      const dir = getPanelBackupDir();
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('panel-') && f.endsWith('.db')) {
          fs.rmSync(path.join(dir, f), { force: true });
        }
      }
    });

    it('数量上限：超出部分最旧先删', () => {
      const dir = getPanelBackupDir();
      // 文件名内嵌毫秒时间戳：先固定再创建/断言共用，避免 isoDaysAgo 重复调用毫秒抖动
      const [name5, name4, name3, name2, name1] = [5, 4, 3, 2, 1].map((d) => fakeSnapshotName(isoDaysAgo(d)));
      for (const n of [name5, name4, name3, name2, name1]) fs.writeFileSync(path.join(dir, n), 'x');

      const deleted = cleanupPanelSnapshots({ maxBackups: 3, maxAgeDays: 365 });

      expect(deleted).toBe(2);
      const remaining = fs.readdirSync(dir).filter((f) => f.startsWith('panel-') && f.endsWith('.db'));
      expect(remaining.length).toBe(3);
      expect(remaining).toContain(name1);
      expect(remaining).not.toContain(name5);
      expect(remaining).not.toContain(name4);
    });

    it('天数上限：mtime 过期的快照删除（mtime 即创建时刻语义）', () => {
      const dir = getPanelBackupDir();
      const oldPath = path.join(dir, fakeSnapshotName(isoDaysAgo(40)));
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
  });

  describe('runPanelBackupCycle', () => {
    beforeEach(() => {
      const dir = getPanelBackupDir();
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('panel-') && f.endsWith('.db')) {
          fs.rmSync(path.join(dir, f), { force: true });
        }
      }
    });

    it('一次周期 = 快照 + 清理，返回删除计数', async () => {
      const dir = getPanelBackupDir();
      // 预置 3 个旧快照（超过 maxBackups=3：新快照落盘后共 4 个 → 删 1 个最旧）
      const oldNames = [9, 8, 7].map((d) => fakeSnapshotName(isoDaysAgo(d)));
      for (const n of oldNames) fs.writeFileSync(path.join(dir, n), 'x');

      const result = await runPanelBackupCycle();

      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(result.deletedCount).toBe(1);
      const remaining = fs.readdirSync(dir).filter((f) => f.startsWith('panel-') && f.endsWith('.db'));
      expect(remaining.length).toBe(3);
    });
  });
});
