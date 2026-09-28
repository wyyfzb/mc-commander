import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { writeUncompressed } from 'prismarine-nbt';

// ── Mock 隔离：子进程 / RCON / SQLite 模型 / 配置目录 ──
vi.mock('child_process', () => {
  const spawn = vi.fn();
  const spawnSync = vi.fn();
  const exec = vi.fn();
  return { spawn, spawnSync, exec, default: { spawn, spawnSync, exec } };
});

vi.mock('rcon-client', () => ({
  Rcon: { connect: vi.fn() },
}));

vi.mock('../db/index.js', () => ({
  InstanceModel: {
    getAll: vi.fn(() => []),
    getById: vi.fn(() => null),
    migrateFromJson: vi.fn(),
    addUptime: vi.fn(),
    getTotalUptime: vi.fn(() => 0),
  },
}));

// 将 serversDir 指向临时目录，避免 loadInstances/createInstance 读写真实 servers/ 目录
vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-manager-test-'));
  return {
    default: {
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'info',
      rateLimit: { windowMs: 60000, max: 100 },
    },
  };
});

import config from '../config.js';
import { MCServerManager } from '../services/mc_server.js';

// 构造 gzip 压缩的 NBT 存档文件
function writeNbtFile(filePath, nbtData) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, zlib.gzipSync(writeUncompressed(nbtData)));
}

/** 构造含 version.json 的最小 jar（vanilla/Paper 该文件均在包根，实测同构） */
function writeJarWithVersionJson(jarPath, versionJson) {
  fs.mkdirSync(path.dirname(jarPath), { recursive: true });
  const zip = new AdmZip();
  zip.addFile('version.json', Buffer.from(JSON.stringify(versionJson), 'utf8'));
  zip.writeZip(jarPath);
}

describe('MCServerManager', () => {
  let manager;

  beforeEach(() => {
    manager = new MCServerManager();
  });

  afterAll(() => {
    // 清理 mock 配置创建的临时目录
    fs.rmSync(path.dirname(config.serversDir), { recursive: true, force: true });
  });

  describe('createInstance', () => {
    it('should create a new instance', () => {
      const instance = manager.createInstance({
        id: 'test-server',
        name: 'Test Server',
        jarFile: 'server.jar',
      });

      expect(instance).toBeDefined();
      expect(instance.id).toBe('test-server');
      expect(instance.name).toBe('Test Server');
    });

    it('should store instances in the map', () => {
      // DB 与 serversDir 均已隔离为空，实例表初始必为空
      expect(manager.instances.size).toBe(0);
      manager.createInstance({
        id: 'server-1',
        name: 'Server 1',
        jarFile: 'server.jar',
      });

      expect(manager.instances.size).toBe(1);
      expect(manager.getInstance('server-1')).toBeDefined();
    });
  });

  describe('getInstance', () => {
    it('should return undefined for non-existent instance', () => {
      expect(manager.getInstance('nonexistent')).toBeUndefined();
    });

    it('should return the correct instance', () => {
      manager.createInstance({
        id: 'server-1',
        name: 'Server 1',
        jarFile: 'server.jar',
      });

      const instance = manager.getInstance('server-1');
      expect(instance.name).toBe('Server 1');
    });
  });

  describe('getAllInstances', () => {
    it('should return all loaded instances', () => {
      // DB 与 serversDir 均已隔离为空，实例列表初始必为空
      expect(manager.getAllInstances()).toHaveLength(0);
      manager.createInstance({ id: 's1', name: 'S1', jarFile: 's.jar' });
      manager.createInstance({ id: 's2', name: 'S2', jarFile: 's.jar' });

      const instances = manager.getAllInstances();
      expect(instances).toHaveLength(2);
      expect(instances[0]).toHaveProperty('id');
      expect(instances[0]).toHaveProperty('name');
    });
  });

  describe('MCServerInstance', () => {
    describe('mcVersion 传播', () => {
      it('JAR 内 version.json 优先于 DB 值（用户手动换 jar 后仍准确）', () => {
        const instance = manager.createInstance({
          id: 'ver-jar',
          name: 'Jar Version',
          jarFile: 'server.jar',
          mcVersion: '1.21.4',
        });
        // 真实 jar 内 version.json 的结构（vanilla 与 Paper 均同构）
        writeJarWithVersionJson(path.join(instance.serverPath, 'server.jar'), {
          id: '26.3',
          java_version: 25,
          protocol_version: 777,
        });
        const status = instance.toStatus();
        expect(status.mcVersion).toBe('26.3');
      });

      it('JAR 不可读（不存在/非 zip）时回退 DB 值', () => {
        const instance = manager.createInstance({
          id: 'ver-db',
          name: 'DB Version',
          jarFile: 'server.jar',
          mcVersion: '1.21.4',
        });
        const status = instance.toStatus();
        expect(status.mcVersion).toBe('1.21.4');
      });

      it('非 zip 的 jar（如 Fabric 启动器写坏/占位文件）不抛错，回退 DB 值', () => {
        const instance = manager.createInstance({
          id: 'ver-badzip',
          name: 'Bad Zip',
          jarFile: 'server.jar',
          mcVersion: '1.20.4',
        });
        fs.writeFileSync(path.join(instance.serverPath, 'server.jar'), 'not a zip');
        const status = instance.toStatus();
        expect(status.mcVersion).toBe('1.20.4');
      });

      it('version.json 缺 id 字段时视为无效，回退 DB 值', () => {
        const instance = manager.createInstance({
          id: 'ver-noid',
          name: 'No Id',
          jarFile: 'server.jar',
          mcVersion: '1.21.4',
        });
        writeJarWithVersionJson(path.join(instance.serverPath, 'server.jar'), {
          java_version: 21,
        });
        const status = instance.toStatus();
        expect(status.mcVersion).toBe('1.21.4');
      });

      it('DB 无版本且无 JAR 时返回 unknown', () => {
        const instance = manager.createInstance({
          id: 'ver-none',
          name: 'No Version',
          jarFile: 'server.jar',
        });
        const status = instance.toStatus();
        expect(status.mcVersion).toBe('unknown');
      });

      it('已不再回退 versions/ 目录探测（该目录是运行期产物，不是权威版本源）', () => {
        const instance = manager.createInstance({
          id: 'ver-fs',
          name: 'FS Version',
          jarFile: 'server.jar',
        });
        const versionsDir = path.join(instance.serverPath, 'versions');
        fs.mkdirSync(versionsDir, { recursive: true });
        fs.writeFileSync(path.join(versionsDir, '1.20.4'), '');
        expect(instance.toStatus().mcVersion).toBe('unknown');
      });

      it('jar 被替换后版本随之更新（stat 键失效缓存）', () => {
        const instance = manager.createInstance({
          id: 'ver-refresh',
          name: 'Refresh',
          jarFile: 'server.jar',
          mcVersion: '1.20.4',
        });
        const jarPath = path.join(instance.serverPath, 'server.jar');
        writeJarWithVersionJson(jarPath, { id: '1.21.4', java_version: 21 });
        expect(instance.toStatus().mcVersion).toBe('1.21.4');
        // 外部替换为另一版本：mtime/size 变化 → 缓存失效重读
        writeJarWithVersionJson(jarPath, { id: '26.1', java_version: 25, pad: 'x'.repeat(64) });
        expect(instance.toStatus().mcVersion).toBe('26.1');
      });
    });

    it('should have correct initial status', () => {
      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'server.jar',
      });

      const status = instance.toStatus();
      expect(status.isRunning).toBe(false);
      expect(status.players).toEqual([]);
      expect(status.playerCount).toBe(0);
    });

    it('should throw when starting without jar file', () => {
      // start() 先检查 EULA 再检查 jar，需先准备已同意的 eula.txt
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');

      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'nonexistent.jar',
        serverPath: tmpDir,
      });

      expect(() => instance.start()).toThrow('Jar file not found');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should throw EULA_NOT_ACCEPTED when eula.txt is missing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));

      const instance = manager.createInstance({
        id: 'test-eula',
        name: 'Test EULA',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });

      expect(() => instance.start()).toThrow('EULA_NOT_ACCEPTED');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('events', () => {
    it('should detect player join from logs', () => {
      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'server.jar',
      });

      return new Promise((resolve) => {
        instance.on('playerJoin', (player) => {
          expect(player.name).toBe('Steve');
          resolve();
        });

        instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      });
    });

    it('should detect player leave from logs', () => {
      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'server.jar',
      });

      return new Promise((resolve) => {
        instance.on('playerLeave', (player) => {
          expect(player.name).toBe('Steve');
          resolve();
        });

        // 玩家先加入服务器才可能离开（真实场景）
        instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
        instance._parseOutput('[12:01:00] [Server thread/INFO]: Steve left the game');
      });
    });

    it('should track player in players map', () => {
      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'server.jar',
      });

      instance._parseOutput('[12:00:00] [Server thread/INFO]: Alice joined the game');
      expect(instance.players.has('Alice')).toBe(true);

      instance._parseOutput('[12:01:00] [Server thread/INFO]: Alice left the game');
      expect(instance.players.has('Alice')).toBe(false);
    });

    it('should record leave event for passive leave (lost connection: kicked/banned)', () => {
      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'server.jar',
      });

      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      instance._parseOutput(
        '[12:05:00] [Server thread/INFO]: Steve lost connection: Kicked by admin: reason',
      );

      const events = instance.playerEvents.get('Steve') || [];
      expect(events.some((e) => e.type === 'leave' && e.message === '离开服务器')).toBe(true);
      expect(instance.players.has('Steve')).toBe(false);
    });

    it('should record leave event for passive leave (was kicked)', () => {
      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'server.jar',
      });

      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      instance._parseOutput('[12:05:00] [Server thread/INFO]: Steve was kicked by admin: reason');

      const events = instance.playerEvents.get('Steve') || [];
      expect(events.some((e) => e.type === 'leave' && e.message === '离开服务器')).toBe(true);
      expect(instance.players.has('Steve')).toBe(false);
    });

    it('should not duplicate leave event when left the game follows lost connection', () => {
      const instance = manager.createInstance({
        id: 'test',
        name: 'Test',
        jarFile: 'server.jar',
      });

      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      instance._parseOutput('[12:05:00] [Server thread/INFO]: Steve lost connection: Disconnected');
      instance._parseOutput('[12:05:01] [Server thread/INFO]: Steve left the game');

      const events = instance.playerEvents.get('Steve') || [];
      expect(events.filter((e) => e.type === 'leave').length).toBe(1);
    });
  });

  describe('MCServerInstance - 世界种子读取', () => {
    it('从旧版 level.dat 的 Data.WorldGenSettings.seed 读取种子（1.16+）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seed-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              WorldGenSettings: {
                type: 'compound',
                value: {
                  seed: { type: 'long', value: 12345n },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'seed-old',
        name: 'Seed Old',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readSeedFromLevelDat()).toBe('12345');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从旧版 level.dat 的 Data.RandomSeed 读取种子（1.16 之前）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seed-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              RandomSeed: { type: 'long', value: 77777n },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'seed-rs',
        name: 'Seed RS',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readSeedFromLevelDat()).toBe('77777');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从 MC 26.x 的 data/minecraft/world_gen_settings.dat 读取种子（WorldGenSettings 已拆分）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seed-'));
      // 26.x：seed 在 <world>/data/minecraft/world_gen_settings.dat 的 data 子节点，
      // level.dat 不再包含 WorldGenSettings.seed
      writeNbtFile(path.join(tmpDir, 'world', 'data', 'minecraft', 'world_gen_settings.dat'), {
        type: 'compound',
        name: '',
        value: {
          data: {
            type: 'compound',
            value: {
              seed: { type: 'long', value: 67890n },
              bonus_chest: { type: 'byte', value: 0 },
              generate_structures: { type: 'byte', value: 1 },
              dimensions: { type: 'compound', value: {} },
            },
          },
          DataVersion: { type: 'int', value: 4903 },
        },
      });
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              difficulty_settings: { type: 'compound', value: {} },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'seed-26',
        name: 'Seed 26',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readSeedFromLevelDat()).toBe('67890');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('兼容 world_gen_settings.dat 位于世界根目录的兜底路径', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seed-'));
      writeNbtFile(path.join(tmpDir, 'world', 'world_gen_settings.dat'), {
        type: 'compound',
        name: '',
        value: {
          seed: { type: 'long', value: 55555n },
          dimensions: { type: 'compound', value: {} },
        },
      });
      const instance = manager.createInstance({
        id: 'seed-26-root',
        name: 'Seed 26 Root',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readSeedFromLevelDat()).toBe('55555');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('恢复备份（世界文件被替换、种子变化）后应读取到新种子而不是永久缓存旧值', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seed-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              WorldGenSettings: {
                type: 'compound',
                value: {
                  seed: { type: 'long', value: 12345n },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'seed-restore',
        name: 'Seed Restore',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      // 首次读取 → 缓存 12345
      expect(instance._readSeedFromLevelDat()).toBe('12345');
      expect(instance.toStatus().seed).toBe('12345');

      // 模拟恢复备份：世界目录被整体替换，新世界种子为 99999
      fs.rmSync(path.join(tmpDir, 'world'), { recursive: true, force: true });
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              WorldGenSettings: {
                type: 'compound',
                value: {
                  seed: { type: 'long', value: 99999n },
                },
              },
            },
          },
        },
      });

      // 应读取新备份的种子（缓存按源文件 mtime/size 自动失效重读）
      expect(instance._readSeedFromLevelDat()).toBe('99999');
      expect(instance.toStatus().seed).toBe('99999');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('世界尚未生成（无存档文件）时返回 null 且不缓存，世界生成后能读到种子', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seed-'));
      const instance = manager.createInstance({
        id: 'seed-nocache',
        name: 'Seed NoCache',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      // 首次：无存档 → null（不应永久缓存）
      expect(instance._readSeedFromLevelDat()).toBeNull();
      // 之后世界生成，出现 level.dat → 应能读到（证明失败未被缓存）
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              WorldGenSettings: {
                type: 'compound',
                value: {
                  seed: { type: 'long', value: 424242n },
                },
              },
            },
          },
        },
      });
      expect(instance._readSeedFromLevelDat()).toBe('424242');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('MCServerInstance - 难度与默认游戏模式读取（level.dat）', () => {
    it('从 MC 26.x level.dat 的 difficulty_settings.difficulty 字符串读取难度', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-diff-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              difficulty_settings: {
                type: 'compound',
                value: {
                  difficulty: { type: 'string', value: 'easy' },
                  hardcore: { type: 'byte', value: 0 },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'diff-26',
        name: 'Diff 26',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readDifficultyFromLevelDat()).toBe('easy');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从旧版 level.dat 的 Data.Difficulty 字节读取难度（0=peaceful..3=hard）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-diff-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              Difficulty: { type: 'byte', value: 3 },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'diff-old',
        name: 'Diff Old',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readDifficultyFromLevelDat()).toBe('hard');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从 level.dat 的 Data.GameType 读取默认游戏模式（0=survival..3=spectator）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gm-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              GameType: { type: 'int', value: 2 },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'gm',
        name: 'GM',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readGameTypeFromLevelDat()).toBe('adventure');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('readDifficulty 在 RCON 不可用时回退到 level.dat', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-diff-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              difficulty_settings: {
                type: 'compound',
                value: {
                  difficulty: { type: 'string', value: 'easy' },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'diff-rcon-off',
        name: 'Diff Rcon Off',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      // 未运行/RCON 未开 → 跳过 RCON 查询 → 读 level.dat
      expect(await instance.readDifficulty()).toBe('easy');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('无 level.dat 时难度与默认模式读取返回 null', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-diff-'));
      const instance = manager.createInstance({
        id: 'diff-none',
        name: 'Diff None',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readDifficultyFromLevelDat()).toBeNull();
      expect(instance._readGameTypeFromLevelDat()).toBeNull();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('MCServerInstance - 世界出生点读取', () => {
    it('从旧版 level.dat 的 Data.SpawnX/SpawnY/SpawnZ 读取出生点', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-spawn-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              SpawnX: { type: 'int', value: 10 },
              SpawnY: { type: 'int', value: 64 },
              SpawnZ: { type: 'int', value: -20 },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'spawn-old',
        name: 'Spawn Old',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      instance._readWorldSpawnFromLevelDat();
      expect(instance._worldSpawn).toEqual({ x: 10, y: 64, z: -20 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从 MC 1.21+/26.x 的 Data.spawn compound（pos intArray）读取出生点', () => {
      // 实测 26.x level.dat：spawn.pos 是 intArray（value 直接为数组），非 list
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-spawn-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              spawn: {
                type: 'compound',
                value: {
                  pos: { type: 'intArray', value: [208, 63, 128] },
                  dimension: { type: 'string', value: 'minecraft:overworld' },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'spawn-pos',
        name: 'Spawn Pos',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      instance._readWorldSpawnFromLevelDat();
      expect(instance._worldSpawn).toEqual({ x: 208, y: 63, z: 128 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从 MC 1.21+/26.x 的 Data.spawn compound（pos list）读取出生点（兼容 list）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-spawn-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              spawn: {
                type: 'compound',
                value: {
                  pos: { type: 'list', value: { type: 'int', value: [5, 70, 30] } },
                  dimension: { type: 'string', value: 'minecraft:overworld' },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'spawn-pos-list',
        name: 'Spawn Pos List',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      instance._readWorldSpawnFromLevelDat();
      expect(instance._worldSpawn).toEqual({ x: 5, y: 70, z: 30 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从 MC 1.21+/26.x 的 Data.spawn compound（SpawnX/Y/Z 字段）读取出生点', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-spawn-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              spawn: {
                type: 'compound',
                value: {
                  SpawnX: { type: 'int', value: -100 },
                  SpawnY: { type: 'int', value: 80 },
                  SpawnZ: { type: 'int', value: 200 },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'spawn-fields',
        name: 'Spawn Fields',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      instance._readWorldSpawnFromLevelDat();
      expect(instance._worldSpawn).toEqual({ x: -100, y: 80, z: 200 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('运行中 /setworldspawn 修改旧版 level.dat 后，_worldSpawn 与玩家 spawnPoint 应同步为新坐标（回归）', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-spawn-live-'));
      // 初始出生点 (10, 64, -20)
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              SpawnX: { type: 'int', value: 10 },
              SpawnY: { type: 'int', value: 64 },
              SpawnZ: { type: 'int', value: -20 },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'spawn-live-old',
        name: 'Spawn Live Old',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      // 构造/start 时读取一次
      expect(instance._worldSpawn).toEqual({ x: 10, y: 64, z: -20 });

      // 模拟运行中 /setworldspawn 300 65 -500：MC 服务器将新出生点写回 level.dat
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              SpawnX: { type: 'int', value: 300 },
              SpawnY: { type: 'int', value: 65 },
              SpawnZ: { type: 'int', value: -500 },
            },
          },
        },
      });

      // 运行中 /setworldspawn 写回 level.dat 后，_worldSpawn getter 通过原始字节对比检测变更并重读
      expect(instance._worldSpawn).toEqual({ x: 300, y: 65, z: -500 });
      const details = await instance.getPlayerDetails('Steve');
      expect(details.spawnPoint).toEqual({ x: 300, y: 65, z: -500 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('运行中 /setworldspawn 修改 26.x 新版 level.dat（spawn compound）后，_worldSpawn 应同步为新坐标（回归）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-spawn-live-'));
      // 初始出生点 (208, 63, 128)
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              spawn: {
                type: 'compound',
                value: {
                  pos: { type: 'intArray', value: [208, 63, 128] },
                  dimension: { type: 'string', value: 'minecraft:overworld' },
                },
              },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'spawn-live-new',
        name: 'Spawn Live New',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._worldSpawn).toEqual({ x: 208, y: 63, z: 128 });

      // 模拟运行中 /setworldspawn 1000 64 -1000：写入新 spawn compound
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              spawn: {
                type: 'compound',
                value: {
                  pos: { type: 'intArray', value: [1000, 64, -1000] },
                  dimension: { type: 'string', value: 'minecraft:overworld' },
                },
              },
            },
          },
        },
      });

      expect(instance._worldSpawn).toEqual({ x: 1000, y: 64, z: -1000 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('MCServerInstance - 天气状态读取', () => {
    it('从真实字段 raining/thundering 读取下雨状态', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-weather-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              raining: { type: 'byte', value: 1 },
              thundering: { type: 'byte', value: 0 },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'weather-rain',
        name: 'Weather Rain',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readWeatherFromLevelDat()).toBe('rain');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从真实字段 raining/thundering 读取雷暴状态', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-weather-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              raining: { type: 'byte', value: 1 },
              thundering: { type: 'byte', value: 1 },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'weather-thunder',
        name: 'Weather Thunder',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readWeatherFromLevelDat()).toBe('thunder');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('从 MC 26.x 的 data/minecraft/weather.dat 读取天气（26.x 天气已从 level.dat 移出）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-weather-'));
      writeNbtFile(path.join(tmpDir, 'world', 'data', 'minecraft', 'weather.dat'), {
        type: 'compound',
        name: '',
        value: {
          data: {
            type: 'compound',
            value: {
              raining: { type: 'byte', value: 1 },
              thundering: { type: 'byte', value: 0 },
              rain_time: { type: 'int', value: 0 },
              thunder_time: { type: 'int', value: 0 },
              clear_weather_time: { type: 'int', value: 0 },
            },
          },
          DataVersion: { type: 'int', value: 4903 },
        },
      });
      // 26.x 的 level.dat 不再包含天气字段
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              difficulty_settings: { type: 'compound', value: {} },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'weather-26',
        name: 'Weather 26',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readWeatherFromLevelDat()).toBe('rain');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('无天气字段时返回 clear', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-weather-'));
      writeNbtFile(path.join(tmpDir, 'world', 'level.dat'), {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              Time: { type: 'long', value: 6000n },
            },
          },
        },
      });
      const instance = manager.createInstance({
        id: 'weather-clear',
        name: 'Weather Clear',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'level-name': 'world' };
      expect(instance._readWeatherFromLevelDat()).toBe('clear');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('MCServerInstance - 世界时间查询', () => {
    it('MC 26.2 格式：通过 time query minecraft:day 获取时间（反映 time set），天数用 gametime/24000', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-time-'));
      const instance = manager.createInstance({
        id: 'time-26',
        name: 'Time 26',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      const rconMock = vi
        .spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Timeline minecraft:day is at 13000 tick(s)')
        .mockResolvedValueOnce('The game time is 360000 tick(s)'); // gametime → day = 15

      const result = await instance._queryWorldTime();
      expect(result).toEqual({ time: 13000, day: 15 });
      expect(rconMock).toHaveBeenNthCalledWith(1, 'time query minecraft:day');
      expect(rconMock).toHaveBeenNthCalledWith(2, 'time query gametime');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('旧版格式：通过 time query daytime 获取时间，天数用 gametime/24000', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-time-'));
      const instance = manager.createInstance({
        id: 'time-old',
        name: 'Time Old',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      const rconMock = vi
        .spyOn(instance, '_rconSend')
        // minecraft:day 在旧版不存在，返回错误文本（不匹配 timeline 格式）
        .mockResolvedValueOnce("Can't find element 'minecraft:day' of type 'minecraft:timeline'")
        .mockResolvedValueOnce('The time is 5000')
        .mockResolvedValueOnce('The time is 60000');

      const result = await instance._queryWorldTime();
      expect(result).toEqual({ time: 5000, day: 2 });
      expect(rconMock).toHaveBeenNthCalledWith(2, 'time query daytime');
      expect(rconMock).toHaveBeenNthCalledWith(3, 'time query gametime');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('兜底：minecraft:day 与 daytime 均不可用时用 gametime % 24000', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-time-'));
      const instance = manager.createInstance({
        id: 'time-fallback',
        name: 'Time Fallback',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce("Can't find element 'minecraft:day' of type 'minecraft:timeline'")
        .mockResolvedValueOnce(
          "Can't find element 'minecraft:daytime' of type 'minecraft:timeline'",
        )
        .mockResolvedValueOnce('The game time is 50000 tick(s)');

      const result = await instance._queryWorldTime();
      // 50000 % 24000 = 2000，50000 / 24000 = 2
      expect(result).toEqual({ time: 2000, day: 2 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('RCON 全部失败时返回 null', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-time-'));
      const instance = manager.createInstance({
        id: 'time-fail',
        name: 'Time Fail',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      vi.spyOn(instance, '_rconSend').mockRejectedValue(new Error('RCON disconnected'));

      const result = await instance._queryWorldTime();
      expect(result).toBeNull();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('MCServerInstance - 命令失败响应解析', () => {
    function buildRunningInstance(tmpDir, id) {
      const instance = manager.createInstance({
        id,
        name: 'Cmd',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      instance.properties = { 'enable-rcon': 'true', 'rcon.password': 'x' };
      instance.isRunning = true;
      instance.process = {};
      return instance;
    }

    it('RCON 返回"离线玩家"失败文本时，sendCommand 抛错而非静默成功', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cmd-'));
      const instance = buildRunningInstance(tmpDir, 'cmd-offline');
      vi.spyOn(instance, '_rconSend').mockResolvedValue('No player was found');

      await expect(instance.sendCommand('give OfflineX minecraft:stone 1')).rejects.toThrow(
        '命令执行失败: No player was found',
      );
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('未知物品失败文本也抛错', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cmd-'));
      const instance = buildRunningInstance(tmpDir, 'cmd-item');
      vi.spyOn(instance, '_rconSend').mockResolvedValue("Unknown item 'minecraft:not_real_item'");

      await expect(
        instance.sendCommand('give TestPlayer minecraft:not_real_item 1'),
      ).rejects.toThrow('命令执行失败: Unknown item');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('RCON 返回成功输出（difficulty）时，sendCommand 正常返回响应', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cmd-'));
      const instance = buildRunningInstance(tmpDir, 'cmd-ok');
      vi.spyOn(instance, '_rconSend').mockResolvedValue('The difficulty is Easy');

      const resp = await instance.sendCommand('difficulty');
      expect(resp).toBe('The difficulty is Easy');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('MCServerInstance - 意外停止自动重启', () => {
    it('autoRestart 默认开启（未传参时）', () => {
      const instance = manager.createInstance({
        id: 'ar-default',
        name: 'AR Default',
        jarFile: 'server.jar',
      });
      expect(instance.autoRestart).toBe(true);
    });

    it('可显式关闭 autoRestart', () => {
      const instance = manager.createInstance({
        id: 'ar-off',
        name: 'AR Off',
        jarFile: 'server.jar',
        autoRestart: false,
      });
      expect(instance.autoRestart).toBe(false);
    });

    it('start() 应重置 _manualStop 为 false（自动重启/崩溃恢复可用）', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ar-'));
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
      fs.writeFileSync(path.join(tmpDir, 'server.jar'), 'dummy');
      const instance = manager.createInstance({
        id: 'ar-start',
        name: 'AR Start',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      // 先模拟手动停止标记，start() 应重置
      instance._manualStop = true;
      // 直接调用内部流程会走 spawn，这里仅验证标记重置逻辑需 start 成功
      // 用 spy 拦截 spawn 的副作用验证 _manualStop 在 spawn 前被重置
      const { spawn } = await import('child_process');
      spawn.mockReturnValue({
        on: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { write: vi.fn() },
        kill: vi.fn(),
      });
      instance.start();
      expect(instance._manualStop).toBe(false);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stop() 应标记 _manualStop = true（避免误判为崩溃）', () => {
      const instance = manager.createInstance({
        id: 'ar-stop',
        name: 'AR Stop',
        jarFile: 'server.jar',
      });
      instance.isRunning = true;
      instance.process = {};
      vi.spyOn(instance, 'sendCommand').mockResolvedValue(null);
      instance.stop();
      expect(instance._manualStop).toBe(true);
    });

    it('restart() 应标记 _manualStop = true（避免 stop 阶段触发自动重启）', () => {
      const instance = manager.createInstance({
        id: 'ar-restart',
        name: 'AR Restart',
        jarFile: 'server.jar',
      });
      instance.isRunning = true;
      instance.process = {};
      vi.spyOn(instance, 'sendCommand').mockResolvedValue(null);
      // 仅验证标记设置，不实际执行 3 秒后的 start()
      vi.spyOn(globalThis, 'setTimeout').mockReturnValue(0);
      instance.restart();
      expect(instance._manualStop).toBe(true);
      vi.restoreAllMocks();
    });

    it('kill() 应标记 _manualStop = true（避免误判为崩溃）', () => {
      const instance = manager.createInstance({
        id: 'ar-kill',
        name: 'AR Kill',
        jarFile: 'server.jar',
      });
      instance.process = { kill: vi.fn() };
      instance._rconCleanup = vi.fn();
      instance.kill();
      expect(instance._manualStop).toBe(true);
    });
  });

  describe('MCServerInstance - 会话历史与日志统计', () => {
    it('玩家加入时创建会话（进行中）', () => {
      const instance = manager.createInstance({
        id: 'sess-join',
        name: 'Sess Join',
        jarFile: 'server.jar',
      });
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      const p = instance.players.get('Steve');
      expect(p).toBeDefined();
      expect(p.sessions).toHaveLength(1);
      expect(p.sessions[0].end).toBeNull(); // 进行中
      expect(p.sessions[0].start).toBeGreaterThan(0);
    });

    it('玩家离开时关闭会话（记录结束时间与时长）', () => {
      const instance = manager.createInstance({
        id: 'sess-leave',
        name: 'Sess Leave',
        jarFile: 'server.jar',
      });
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      const p = instance.players.get('Steve');
      // 模拟加入 10 秒后离开
      p.joinTime = Date.now() - 10000;
      instance._parseOutput('[12:00:10] [Server thread/INFO]: Steve left the game');
      // leave 会删除 players 中的玩家，但从 playerdata 读取验证
      const saved = instance._loadPlayerData('Steve');
      expect(saved).not.toBeNull();
      expect(saved.sessions).toHaveLength(1);
      expect(saved.sessions[0].end).not.toBeNull();
      expect(saved.sessions[0].duration).toBeGreaterThanOrEqual(10);
    });

    it('60 秒自动保存在线玩家时不覆盖「最后离线时间」lastSeen', () => {
      const instance = manager.createInstance({
        id: 'sess-lastseen',
        name: 'Sess LastSeen',
        jarFile: 'server.jar',
      });
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      const p = instance.players.get('Steve');
      p.joinTime = Date.now() - 10000;
      instance._parseOutput('[12:00:10] [Server thread/INFO]: Steve left the game');
      const leaveTime = instance._loadPlayerData('Steve').lastSeen;
      expect(leaveTime).not.toBeNull();

      // 玩家重新上线，模拟 60 秒定时自动保存：不应把 lastSeen 刷成当前在线时间
      instance._parseOutput('[12:05:00] [Server thread/INFO]: Steve joined the game');
      const p2 = instance.players.get('Steve');
      instance._savePlayerData('Steve', p2);
      expect(instance._loadPlayerData('Steve').lastSeen).toBe(leaveTime);
    });

    it('服务端重启后从 playerdata 恢复会话（持久化不丢失）', () => {
      const instance = manager.createInstance({
        id: 'sess-restore',
        name: 'Sess Restore',
        jarFile: 'server.jar',
      });
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      const p = instance.players.get('Steve');
      p.joinTime = Date.now() - 5000;
      instance._parseOutput('[12:00:05] [Server thread/INFO]: Steve left the game');

      // 新实例（模拟重启）从同一 serverPath 加载
      const instance2 = manager.createInstance({
        id: 'sess-restore',
        name: 'Sess Restore',
        jarFile: 'server.jar',
      });
      const saved = instance2._loadPlayerData('Steve');
      expect(saved.sessions).toHaveLength(1);
      expect(saved.sessions[0].end).not.toBeNull();
    });

    it('_savePlayerData 持久化成就事件，新实例从 playerdata 恢复', () => {
      const instance = manager.createInstance({
        id: 'sess-events',
        name: 'Sess Events',
        jarFile: 'server.jar',
      });
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      // 模拟在线获得成就（stdout 日志解析）：join + achievement 共 2 个事件
      instance._parseOutput(
        '[12:01:00] [Server thread/INFO]: Steve has made the advancement [Stone Age]',
      );
      expect(instance.playerEvents.get('Steve')).toHaveLength(2);

      // 60 秒定时自动保存（在线玩家）：events 应写入 playerdata
      instance._savePlayerData('Steve', instance.players.get('Steve'));
      const saved = instance._loadPlayerData('Steve');
      expect(Array.isArray(saved.events)).toBe(true);
      expect(saved.events).toHaveLength(2);
      expect(saved.events.some((e) => e.message.includes('Stone Age'))).toBe(true);

      // 新实例（模拟服务端重启）从同一 serverPath 恢复成就事件
      const instance2 = manager.createInstance({
        id: 'sess-events',
        name: 'Sess Events',
        jarFile: 'server.jar',
      });
      const restored = instance2._loadPlayerData('Steve');
      expect(Array.isArray(restored.events)).toBe(true);
      expect(restored.events).toHaveLength(2);
      expect(restored.events.some((e) => e.message.includes('Stone Age'))).toBe(true);
    });

    it('_savePlayerData 持久化时合并内存与既有事件并去重', () => {
      const instance = manager.createInstance({
        id: 'sess-events-merge',
        name: 'Sess Events Merge',
        jarFile: 'server.jar',
      });
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      // 第一次保存：获得成就 1（join + achievement 共 2 事件）
      instance._parseOutput(
        '[12:01:00] [Server thread/INFO]: Steve has made the advancement [Stone Age]',
      );
      instance._savePlayerData('Steve', instance.players.get('Steve'));

      // 继续在线获得成就 2，再次保存：事件应合并（不丢成就 1，共 3 事件）
      instance._parseOutput(
        '[12:02:00] [Server thread/INFO]: Steve has made the advancement [Getting an Upgrade]',
      );
      instance._savePlayerData('Steve', instance.players.get('Steve'));
      const saved = instance._loadPlayerData('Steve');
      expect(saved.events).toHaveLength(3);
      const msgs = saved.events.map((e) => e.message).join('|');
      expect(msgs).toContain('Stone Age');
      expect(msgs).toContain('Getting an Upgrade');
    });

    it('_savePlayerData 写盘失败时记录错误日志（不静默吞掉）', () => {
      const instance = manager.createInstance({
        id: 'sess-save-fail',
        name: 'Sess Save Fail',
        jarFile: 'server.jar',
      });
      // 制造写盘失败：playerdata 路径被同名文件占用 → mkdirSync 抛错
      const tmpDir = instance.serverPath;
      fs.writeFileSync(path.join(tmpDir, 'playerdata'), 'not a dir');

      const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.error 走 stderr
      try {
        instance._savePlayerData('Steve', { name: 'Steve' });
        // 修复前：空 catch 静默吞掉，写盘失败无任何日志可排查
        expect(errorSpy).toHaveBeenCalled();
        expect(errorSpy.mock.calls[0][0]).toContain('Steve');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('玩家离开时 leave 事件应随 _savePlayerData 立即落盘（进程退出后不丢失）', () => {
      const instance = manager.createInstance({
        id: 'sess-leave-event',
        name: 'Sess Leave Event',
        jarFile: 'server.jar',
      });
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      // 离开：_handlePlayerLeave 内部 _savePlayerData + _addPlayerEvent('leave')
      instance._parseOutput('[12:00:10] [Server thread/INFO]: Steve left the game');
      // 此时玩家已不在在线表（60s 定时保存不会再覆盖该玩家），
      // 磁盘上必须已含 leave 事件，否则进程退出后 leave 事件永久丢失
      const saved = instance._loadPlayerData('Steve');
      expect(Array.isArray(saved.events)).toBe(true);
      expect(saved.events.some((e) => e.type === 'leave' && e.message === '离开服务器')).toBe(true);

      // 模拟进程退出后重启：新实例从 playerdata 恢复，leave 事件不能丢
      const instance2 = manager.createInstance({
        id: 'sess-leave-event',
        name: 'Sess Leave Event',
        jarFile: 'server.jar',
      });
      const restored = instance2._loadPlayerData('Steve');
      expect(Array.isArray(restored.events)).toBe(true);
      expect(restored.events.some((e) => e.type === 'leave' && e.message === '离开服务器')).toBe(
        true,
      );
    });

    it('_mergePlayerEvents 去重合并并按时间倒序', () => {
      const instance = manager.createInstance({
        id: 'sess-merge',
        name: 'Sess Merge',
        jarFile: 'server.jar',
      });
      const savedEvents = [
        { type: 'join', message: '进入服务器', timestamp: 1000 },
        { type: 'death', message: '被骷髅射杀', timestamp: 2000 },
      ];
      const memEvents = [
        { type: 'death', message: '被骷髅射杀', timestamp: 2000 }, // 重复
        { type: 'leave', message: '离开服务器', timestamp: 3000 },
      ];
      const merged = instance._mergePlayerEvents(savedEvents, memEvents);
      expect(merged).toHaveLength(3); // 去重后 3 个
      expect(merged[0].timestamp).toBe(3000); // 最新在前
      expect(merged[1].timestamp).toBe(2000);
      expect(merged[2].timestamp).toBe(1000);
    });

    it('_computePlayerStats 计算总在线/登录/离线/死亡/进度/入睡统计', () => {
      const instance = manager.createInstance({
        id: 'sess-stats',
        name: 'Sess Stats',
        jarFile: 'server.jar',
      });
      const now = Date.now();
      const sessions = [
        { start: now - 200000, end: now - 100000, duration: 100 }, // 历史会话
        { start: now - 50000, end: null, duration: 0 }, // 进行中
      ];
      const events = [
        { type: 'join', timestamp: now - 200000 },
        { type: 'death', timestamp: now - 180000 },
        { type: 'achievement', timestamp: now - 170000 },
        { type: 'achievement', timestamp: now - 160000 },
        { type: 'sleep', timestamp: now - 150000 },
        { type: 'wake', timestamp: now - 140000 },
        { type: 'leave', timestamp: now - 100000 },
      ];
      // 在线玩家：进行中会话按 now 计算，offlineSince=0
      const stats = instance._computePlayerStats(sessions, events, {});
      expect(stats.totalOnline).toBe(100 + 50); // 100 + (now - (now-50000))/1000
      expect(stats.loginCount).toBe(2);
      expect(stats.offlineSince).toBe(0); // 在线
      expect(stats.deathCount).toBe(1);
      expect(stats.achievementCount).toBe(2);
      expect(stats.sleepCount).toBe(1);
    });

    it('_computePlayerStats 优先读取 MC 官方真实统计（players/stats）', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-realstats-'));
      const instance = manager.createInstance({
        id: 'realstats',
        name: 'RealStats',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      // 构造 MC 26.1+ 的 world/players/stats/<uuid>.json
      const statsDir = path.join(tmpDir, 'world', 'players', 'stats');
      fs.mkdirSync(statsDir, { recursive: true });
      fs.writeFileSync(
        path.join(statsDir, 'test-uuid.json'),
        JSON.stringify({
          stats: {
            'minecraft:custom': {
              'minecraft:deaths': 24,
              'minecraft:sleep_in_bed': 45,
              'minecraft:play_time': 550019,
              'minecraft:leave_game': 42,
            },
          },
        }),
      );
      vi.spyOn(instance, '_getPlayerUuid').mockReturnValue('test-uuid');

      const stats = instance._computePlayerStats([], [], null, 'Steve');
      expect(stats.deathCount).toBe(24);
      expect(stats.sleepCount).toBe(45);
      expect(stats.loginCount).toBe(42);
      expect(stats.totalOnline).toBe(Math.floor(550019 / 20));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('_computePlayerStats stats 文件缺失时回退自建统计', () => {
      const instance = manager.createInstance({
        id: 'realstats-fb',
        name: 'FB',
        jarFile: 'server.jar',
      });
      const now = Date.now();
      const sessions = [{ start: now - 100000, end: now - 50000, duration: 50 }];
      const events = [{ type: 'death', timestamp: now - 80000 }];
      const stats = instance._computePlayerStats(sessions, events, null, 'Steve');
      expect(stats.deathCount).toBe(1);
      expect(stats.totalOnline).toBe(50);
      expect(stats.loginCount).toBe(1);
    });
  });

  describe('MCServerInstance - getAllKnownPlayers 从 usercache.json 读取 lastSeen', () => {
    it('usercache.json 使用真实字段名 expiresOn（字符串时间戳）时，lastSeen 应取到该值而非 null', () => {
      const id = `known-players-${Date.now()}`;
      const instance = manager.createInstance({
        id,
        name: 'Known Players',
        jarFile: 'server.jar',
      });
      // MC 真实 usercache.json 格式：{name, uuid, expiresOn: "yyyy-MM-dd HH:mm:ss Z"}
      fs.writeFileSync(
        path.join(config.serversDir, id, 'usercache.json'),
        JSON.stringify([
          {
            name: 'Steve',
            uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
            expiresOn: '2026-08-10 10:00:00 +0000',
          },
          {
            name: 'Alex',
            uuid: '853c80ef-3c37-49fd-aa49-938b674adae6',
            expiresOn: '2026-08-09 08:30:00 +0800',
          },
        ]),
      );

      const known = instance.getAllKnownPlayers();
      expect(known.get('Steve').lastSeen).toBe('2026-08-10 10:00:00 +0000');
      expect(known.get('Alex').lastSeen).toBe('2026-08-09 08:30:00 +0800');
      expect(known.get('Steve').uuid).toBe('069a79f4-44e9-4726-a5be-fca90e38aaf5');
    });
  });

  describe('MCServerInstance - 个人复活点读取（respawn 兼容）', () => {
    // 构造 RCON 就绪的实例并 mock getPlayerDetails 的依赖
    function setupRconInstance(id, rconHandler) {
      const instance = manager.createInstance({
        id,
        name: 'Respawn Test',
        jarFile: 'server.jar',
      });
      instance.isRunning = true;
      // isRconConnected 是 getter（isRunning && enable-rcon && rcon.password），通过属性间接满足
      instance.properties = { 'enable-rcon': 'true', 'rcon.password': 'test' };
      instance._worldSpawn = null;
      instance.players.set('Steve', {
        name: 'Steve',
        joinTime: Date.now(),
        sessions: [],
        totalPlayTime: 0,
      });
      instance.playerEvents.set('Steve', []);
      vi.spyOn(instance, '_loadPlayerData').mockReturnValue({});
      vi.spyOn(instance, '_getPlayerUuid').mockReturnValue('test-uuid');
      // tmp 实例目录无 stats 文件，getTotalPlayTime 自然返回 0，无需 mock
      vi.spyOn(instance, '_loadInventoryFromDat').mockReturnValue(null);
      vi.spyOn(instance, '_loadInventoryFromRcon').mockReturnValue(null);
      vi.spyOn(instance, '_queryAttribute').mockResolvedValue(20);
      vi.spyOn(instance, 'sendCommandWithResponse').mockImplementation(rconHandler);
      return instance;
    }

    // 非复活点命令的基础 RCON 响应
    const baseHandler = async (cmd) => {
      if (cmd.includes('respawn.pos')) return 'Found no elements matching respawn.pos';
      if (cmd.includes('SpawnX')) return 'Steve has the following entity data: 100';
      if (cmd.includes('SpawnY')) return 'Steve has the following entity data: 70';
      if (cmd.includes('SpawnZ')) return 'Steve has the following entity data: -50';
      if (cmd.includes('Pos')) return 'Steve has the following entity data: [1.0d, 64.0d, 2.0d]';
      if (cmd.includes('Health')) return 'Steve has the following entity data: 20.0f';
      if (cmd.includes('foodLevel')) return 'Steve has the following entity data: 20';
      if (cmd.includes('XpLevel')) return 'Steve has the following entity data: 5';
      if (cmd.includes('playerGameType')) return 'Steve has the following entity data: 0';
      if (cmd.includes('Dimension'))
        return 'Steve has the following entity data: "minecraft:overworld"';
      return 'Found no elements';
    };

    it('MC 26.x：从 respawn compound 的 Int Array pos 读取个人复活点', async () => {
      const instance = setupRconInstance('rp-26x', async (cmd) => {
        if (cmd.includes('respawn.pos'))
          return 'Steve has the following entity data: [I; 100, 70, -50]';
        return baseHandler(cmd);
      });
      const details = await instance.getPlayerDetails('Steve');
      expect(details.respawnPoint).toEqual({ x: 100, y: 70, z: -50 });
      // 新版走 respawn.pos 查询，不回退到 SpawnX
      const calls = instance.sendCommandWithResponse.mock.calls.map((c) => c[0]);
      expect(calls.some((c) => c.includes('respawn.pos'))).toBe(true);
      expect(calls.some((c) => c.includes('SpawnX'))).toBe(false);
    });

    it('旧版（<1.21.2）：respawn.pos 不存在时回退到顶层 SpawnX/SpawnY/SpawnZ', async () => {
      const instance = setupRconInstance('rp-legacy', async (cmd) => baseHandler(cmd));
      const details = await instance.getPlayerDetails('Steve');
      expect(details.respawnPoint).toEqual({ x: 100, y: 70, z: -50 });
    });

    it('无复活点时 respawnPoint 为 null', async () => {
      const instance = setupRconInstance('rp-none', async (cmd) => {
        if (cmd.includes('respawn.pos')) return 'Found no elements matching respawn.pos';
        if (cmd.includes('SpawnX')) return 'Found no elements matching SpawnX';
        return baseHandler(cmd);
      });
      const details = await instance.getPlayerDetails('Steve');
      expect(details.respawnPoint).toBeNull();
    });

    it('RCON 连接失败（错误消息含端口 25575）时，respawnPoint/health 等字段保持 null 而非垃圾值', async () => {
      // 回归测试：修复前连接错误消息 "connect ECONNREFUSED 127.0.0.1:25575"
      // 会被兜底正则 /:\s*(-?[\d.]+)/ 误解析，导致 respawnPoint = {25575, 25575, 25575}
      const instance = setupRconInstance('rp-conn-error', async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:25575');
      });
      const details = await instance.getPlayerDetails('Steve');
      expect(details.respawnPoint).toBeNull();
      expect(details.position).toBeNull();
      expect(details.health).toBeNull();
      expect(details.hunger).toBeNull();
      expect(details.xpLevel).toBeNull();
      expect(details.gameMode).toBeNull();
      expect(details.dimension).toBeNull();
    });
  });
});

describe('MCServerInstance - 死亡事件聚合（通知风暴防护）', () => {
  let manager;

  beforeEach(() => {
    manager = new MCServerManager();
  });

  it('团灭批量死亡事件在 5s 窗口内聚合为单条 players 事件', () => {
    vi.useFakeTimers();
    try {
      const instance = manager.createInstance({
        id: 'death-agg',
        name: 'Death Agg',
        jarFile: 'server.jar',
      });
      const deaths = [];
      instance.on('playerDeath', (d) => deaths.push(d));

      instance._parseOutput('[12:00:00] [Server thread/INFO]: Alice was slain by Zombie');
      instance._parseOutput('[12:00:01] [Server thread/INFO]: Bob was slain by Zombie');
      // 5s 聚合窗口内不立即发射
      expect(deaths.length).toBe(0);

      vi.advanceTimersByTime(5100);
      expect(deaths.length).toBe(1);
      expect(deaths[0].players).toHaveLength(2);
      expect(deaths[0].count).toBe(2);
      expect(deaths[0].players[0].name).toBe('Alice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('单条死亡事件 5s 窗口后保持原格式广播', () => {
    vi.useFakeTimers();
    try {
      const instance = manager.createInstance({
        id: 'death-single',
        name: 'Death Single',
        jarFile: 'server.jar',
      });
      const deaths = [];
      instance.on('playerDeath', (d) => deaths.push(d));

      instance._parseOutput('[12:00:00] [Server thread/INFO]: Alice was slain by Zombie');
      expect(deaths.length).toBe(0);

      vi.advanceTimersByTime(5100);
      expect(deaths.length).toBe(1);
      expect(deaths[0].name).toBe('Alice');
      expect(deaths[0].players).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('窗口内单条死亡不延迟（窗口结束即发射）', () => {
    vi.useFakeTimers();
    try {
      const instance = manager.createInstance({
        id: 'death-single-delay',
        name: 'Death Single Delay',
        jarFile: 'server.jar',
      });
      const deaths = [];
      instance.on('playerDeath', (d) => deaths.push(d));

      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve was slain by Zombie');
      vi.advanceTimersByTime(3000);
      // 窗口未结束仍缓冲
      expect(deaths.length).toBe(0);
      vi.advanceTimersByTime(2500);
      expect(deaths.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
