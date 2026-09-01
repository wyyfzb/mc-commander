import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// mock BanModel
vi.mock('../db/ban.model.js', () => ({
  BanModel: {
    findActiveByInstance: vi.fn(() => []),
    findExpiredActive: vi.fn(() => []),
    create: vi.fn(() => ({ id: 99 })),
    deactivate: vi.fn(),
  },
}));

// mock atomicWriteFile
vi.mock('../utils/fs-utils.js', () => ({
  atomicWriteFile: vi.fn((p, data) => fs.writeFileSync(p, data)),
}));

import { reconcileTempBans } from '../utils/ban-reconcile.js';
import { BanModel } from '../db/ban.model.js';
import { atomicWriteFile } from '../utils/fs-utils.js';

describe('reconcileTempBans', () => {
  let tmpDir;
  let bannedPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
    bannedPath = path.join(tmpDir, 'banned-players.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('banned-players.json 不存在时不做任何事', () => {
    reconcileTempBans('inst-1', tmpDir);
    expect(BanModel.findActiveByInstance).not.toHaveBeenCalled();
  });

  it('文件损坏（非法 JSON）时不抛错', () => {
    fs.writeFileSync(bannedPath, 'NOT JSON{{{');
    expect(() => reconcileTempBans('inst-1', tmpDir)).not.toThrow();
  });

  it('文件内容非数组时不抛错', () => {
    fs.writeFileSync(bannedPath, JSON.stringify({ name: 'Steve' }));
    expect(() => reconcileTempBans('inst-1', tmpDir)).not.toThrow();
  });

  describe('方向 1：文件有但 DB 无 → 补入 DB', () => {
    it('文件中新增的封禁补入 DB（永久，expiresAt=MAX_SAFE_INTEGER）', () => {
      fs.writeFileSync(bannedPath, JSON.stringify([
        { name: 'Alex', uuid: 'u2', reason: 'Griefing', created: '2026-01-01' },
        { name: 'Steve', uuid: 'u1', reason: 'Cheating', created: '2026-01-01' },
      ]));
      // DB 中仅 Steve 有活跃记录
      BanModel.findActiveByInstance.mockReturnValue([
        { id: 1, targetType: 'player', target: 'Steve', expiresAt: Date.now() + 999999 },
      ]);
      BanModel.findExpiredActive.mockReturnValue([]);

      reconcileTempBans('inst-1', tmpDir);

      // Alex 应被补入 DB
      expect(BanModel.create).toHaveBeenCalledTimes(1);
      const call = BanModel.create.mock.calls[0][0];
      expect(call.instanceId).toBe('inst-1');
      expect(call.targetType).toBe('player');
      expect(call.target).toBe('Alex');
      expect(call.reason).toBe('Griefing');
      expect(call.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('文件中所有封禁 DB 都有 → 不补入', () => {
      fs.writeFileSync(bannedPath, JSON.stringify([
        { name: 'Steve', uuid: 'u1' },
      ]));
      BanModel.findActiveByInstance.mockReturnValue([
        { id: 1, targetType: 'player', target: 'Steve', expiresAt: Date.now() + 999999 },
      ]);
      BanModel.findExpiredActive.mockReturnValue([]);

      reconcileTempBans('inst-1', tmpDir);

      expect(BanModel.create).not.toHaveBeenCalled();
    });

    it('文件中条目无 name 字段 → 跳过', () => {
      fs.writeFileSync(bannedPath, JSON.stringify([
        { uuid: 'u1', reason: 'No name' },
      ]));
      BanModel.findActiveByInstance.mockReturnValue([]);
      BanModel.findExpiredActive.mockReturnValue([]);

      reconcileTempBans('inst-1', tmpDir);

      expect(BanModel.create).not.toHaveBeenCalled();
    });
  });

  describe('方向 2：DB 已过期但文件仍存在 → 清理文件 + 停用记录', () => {
    it('过期封禁从文件中删除且 DB 记录停用', () => {
      fs.writeFileSync(bannedPath, JSON.stringify([
        { name: 'Alex', uuid: 'u2', reason: 'Griefing' },
        { name: 'Steve', uuid: 'u1', reason: 'Cheating' },
      ]));
      const now = Date.now();
      BanModel.findActiveByInstance.mockReturnValue([
        { id: 1, targetType: 'player', target: 'Alex', expiresAt: now - 1000 },
        { id: 2, targetType: 'player', target: 'Steve', expiresAt: now + 999999 },
      ]);
      // Alex 已过期
      BanModel.findExpiredActive.mockReturnValue([
        { id: 1, instanceId: 'inst-1', targetType: 'player', target: 'Alex', expiresAt: now - 1000 },
      ]);

      reconcileTempBans('inst-1', tmpDir);

      // Alex 应被停用
      expect(BanModel.deactivate).toHaveBeenCalledWith(1);
      // 文件应被写回（仅剩 Steve）
      expect(atomicWriteFile).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(atomicWriteFile.mock.calls[0][1]);
      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].name).toBe('Steve');
    });

    it('过期封禁不在文件中 → 不修改文件', () => {
      fs.writeFileSync(bannedPath, JSON.stringify([
        { name: 'Steve', uuid: 'u1' },
      ]));
      BanModel.findActiveByInstance.mockReturnValue([
        { id: 1, targetType: 'player', target: 'Steve', expiresAt: Date.now() + 999999 },
      ]);
      // 过期的是另一个实例的记录
      BanModel.findExpiredActive.mockReturnValue([
        { id: 2, instanceId: 'other-inst', targetType: 'player', target: 'Ghost', expiresAt: Date.now() - 1000 },
      ]);

      reconcileTempBans('inst-1', tmpDir);

      expect(atomicWriteFile).not.toHaveBeenCalled();
    });
  });

  it('两个方向同时存在时正确处理', () => {
    fs.writeFileSync(bannedPath, JSON.stringify([
      { name: 'Alex', uuid: 'u2', reason: 'Griefing' },    // 过期→从文件删
      { name: 'Bob', uuid: 'u3', reason: 'Hacking' },      // 新增→补 DB
      { name: 'Steve', uuid: 'u1', reason: 'Cheating' },   // 已有→不变
    ]));
    const now = Date.now();
    BanModel.findActiveByInstance.mockReturnValue([
      { id: 1, targetType: 'player', target: 'Alex', expiresAt: now - 1000 },
      { id: 2, targetType: 'player', target: 'Steve', expiresAt: now + 999999 },
    ]);
    BanModel.findExpiredActive.mockReturnValue([
      { id: 1, instanceId: 'inst-1', targetType: 'player', target: 'Alex', expiresAt: now - 1000 },
    ]);

    reconcileTempBans('inst-1', tmpDir);

    // Alex 停用
    expect(BanModel.deactivate).toHaveBeenCalledWith(1);
    // Bob 补入
    expect(BanModel.create).toHaveBeenCalledTimes(1);
    expect(BanModel.create.mock.calls[0][0].target).toBe('Bob');
    // 文件写回：Alex 被删，Bob 和 Steve 保留
    const writtenData = JSON.parse(atomicWriteFile.mock.calls[0][1]);
    expect(writtenData).toHaveLength(2);
    expect(writtenData.map(e => e.name)).toEqual(['Bob', 'Steve']);
  });
});
