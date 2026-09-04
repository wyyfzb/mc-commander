import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// InstanceModel 持久层语义补测（真实 SQLite，instance.model.js 语义锁定）。
// 覆盖：create 默认值链 / 行转换（布尔化 + jvm_args JSON 安全回退）/
// CRUD / 运行时长累加 / JSON 迁移去重。db 层用真实 SQLite 实例，仅替身
// database.js 的连接管理（getDb 指向本文件创建的临时库），SQL 语义真实。

const TEST_DIR = path.join(os.tmpdir(), `mcs-instance-model-${process.pid}-${Date.now()}`);

let db;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 与 database.js createTables 的 instances 表结构一致（全列，
  // rowToInstance 按 COLUMN_TO_FIELD 全列遍历，缺列会静默丢字段）
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'stopped',
      jar_file TEXT,
      java_path TEXT DEFAULT 'java',
      max_memory TEXT DEFAULT '2G',
      min_memory TEXT DEFAULT '1G',
      start_command TEXT,
      server_path TEXT,
      mc_version TEXT,
      mod_loader TEXT DEFAULT 'Vanilla',
      port INTEGER DEFAULT 25565,
      auto_start INTEGER DEFAULT 0,
      auto_restart INTEGER DEFAULT 1,
      total_uptime INTEGER DEFAULT 0,
      jvm_args TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// 替身 database.js 的连接管理，SUT 的 SQL 全部落在真实库上
vi.mock('../db/database.js', () => ({
  getDb: () => db,
}));

const { InstanceModel } = await import('../db/instance.model.js');

describe('InstanceModel.create 默认值链', () => {
  it('无 type → mod_loader 兜底 Vanilla，port 兜底 25565', () => {
    const id = InstanceModel.create({ id: 'inst-def', name: 'Default' });
    expect(id).toBe('inst-def');
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get('inst-def');
    expect(row.mod_loader).toBe('Vanilla');
    expect(row.port).toBe(25565);
  });

  it('type 小写 → capitalizeFirst（paper → Paper）', () => {
    InstanceModel.create({ id: 'inst-paper', name: 'P', type: 'paper' });
    const row = db.prepare('SELECT mod_loader FROM instances WHERE id = ?').get('inst-paper');
    expect(row.mod_loader).toBe('Paper');
  });

  it('可选字段缺省时写入安全默认（java/2G/1G，其余 null）', () => {
    InstanceModel.create({ id: 'inst-opt', name: 'Opt' });
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get('inst-opt');
    expect(row.java_path).toBe('java');
    expect(row.max_memory).toBe('2G');
    expect(row.min_memory).toBe('1G');
    expect(row.jar_file).toBeNull();
    expect(row.server_path).toBeNull();
    expect(row.mc_version).toBeNull();
  });

  it('显式传入全部字段时按传入值落库', () => {
    InstanceModel.create({
      id: 'inst-full',
      name: 'Full',
      type: 'fabric',
      port: 25570,
      jarFile: 'server.jar',
      javaPath: '/usr/bin/java',
      maxMemory: '4G',
      minMemory: '2G',
      serverPath: '/data/servers/full',
      mcVersion: '1.21.4',
    });
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get('inst-full');
    expect(row.mod_loader).toBe('Fabric');
    expect(row.port).toBe(25570);
    expect(row.jar_file).toBe('server.jar');
    expect(row.java_path).toBe('/usr/bin/java');
    expect(row.max_memory).toBe('4G');
    expect(row.min_memory).toBe('2G');
    expect(row.server_path).toBe('/data/servers/full');
    expect(row.mc_version).toBe('1.21.4');
  });
});

describe('InstanceModel 行转换（rowToInstance）', () => {
  it('getById 缺失实例返回 null', () => {
    expect(InstanceModel.getById('no-such')).toBeNull();
  });

  it('auto_start/auto_restart 整数布尔化（0/1 → false/true）', () => {
    db.prepare(`INSERT INTO instances (id, name, auto_start, auto_restart)
      VALUES ('inst-bool', 'Bool', 1, 0)`).run();
    const inst = InstanceModel.getById('inst-bool');
    expect(inst.autoStart).toBe(true);
    expect(inst.autoRestart).toBe(false);
  });

  it('auto_start 为 NULL 时保持 null（不布尔化）', () => {
    db.prepare(`INSERT INTO instances (id, name, auto_start, auto_restart)
      VALUES ('inst-null', 'Null', NULL, NULL)`).run();
    const inst = InstanceModel.getById('inst-null');
    expect(inst.autoStart).toBeNull();
    expect(inst.autoRestart).toBeNull();
  });

  it('jvm_args JSON 数组文本解析为数组', () => {
    db.prepare(`INSERT INTO instances (id, name, jvm_args)
      VALUES ('inst-jvm', 'JVM', ?)`).run(JSON.stringify(['-Xmx2G', '-XX:+UseG1GC']));
    const inst = InstanceModel.getById('inst-jvm');
    expect(inst.jvmArgs).toEqual(['-Xmx2G', '-XX:+UseG1GC']);
  });

  it('jvm_args 损坏 JSON 安全回退 null（不抛错）', () => {
    db.prepare(`INSERT INTO instances (id, name, jvm_args)
      VALUES ('inst-jvm-bad', 'Bad', '{broken')`).run();
    const inst = InstanceModel.getById('inst-jvm-bad');
    expect(inst.jvmArgs).toBeNull();
  });

  it('jvm_args 为 NULL 时保持 null', () => {
    const inst = InstanceModel.getById('inst-def');
    expect(inst.jvmArgs).toBeNull();
  });

  it('getAll 按 created_at DESC 返回 camelCase 行', () => {
    db.prepare(`INSERT INTO instances (id, name, created_at)
      VALUES ('inst-old', 'Old', '2020-01-01 00:00:00')`).run();
    db.prepare(`INSERT INTO instances (id, name, created_at)
      VALUES ('inst-new', 'New', '2030-01-01 00:00:00')`).run();
    const all = InstanceModel.getAll();
    const ids = all.map((i) => i.id);
    expect(ids.indexOf('inst-new')).toBeLessThan(ids.indexOf('inst-old'));
    const old = all.find((i) => i.id === 'inst-old');
    expect(old.name).toBe('Old');
    expect(typeof old.port).toBe('number');
  });
});

describe('InstanceModel.update 字段映射', () => {
  it('camelCase 字段全量映射到 snake_case 列', () => {
    InstanceModel.create({ id: 'inst-upd', name: 'Upd' });
    const updated = InstanceModel.update('inst-upd', {
      name: 'Renamed',
      status: 'running',
      description: 'desc',
      jarFile: 'new.jar',
      javaPath: '/usr/bin/java',
      maxMemory: '8G',
      minMemory: '4G',
      startCommand: 'java -jar new.jar',
      serverPath: '/data/servers/renamed',
      mcVersion: '1.21.4',
      modLoader: 'Forge',
      port: 25580,
      autoStart: true,
      autoRestart: false,
      jvmArgs: ['-Xmx8G'],
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.status).toBe('running');
    expect(updated.jarFile).toBe('new.jar');
    expect(updated.port).toBe(25580);
    expect(updated.autoStart).toBe(true);
    expect(updated.autoRestart).toBe(false);
    expect(updated.jvmArgs).toEqual(['-Xmx8G']);
  });

  it('autoStart/autoRestart 布尔落库为 0/1 整数', () => {
    const row = db.prepare('SELECT auto_start, auto_restart FROM instances WHERE id = ?').get('inst-upd');
    expect(row.auto_start).toBe(1);
    expect(row.auto_restart).toBe(0);
  });

  it('jvmArgs 显式 null 时写 NULL 而非 JSON 文本', () => {
    InstanceModel.update('inst-upd', { jvmArgs: null });
    const row = db.prepare('SELECT jvm_args FROM instances WHERE id = ?').get('inst-upd');
    expect(row.jvm_args).toBeNull();
  });

  it('空 fields 不执行 UPDATE，返回当前行', () => {
    const before = InstanceModel.getById('inst-upd');
    const after = InstanceModel.update('inst-upd', {});
    expect(after).toEqual(before);
  });

  it('未支持字段（id 等）被忽略不落库', () => {
    const updated = InstanceModel.update('inst-upd', { id: 'hacked', unknownField: 'x' });
    expect(updated.id).toBe('inst-upd');
  });

  it('更新不存在的实例返回 null', () => {
    expect(InstanceModel.update('no-such', { name: 'X' })).toBeNull();
  });
});

describe('InstanceModel.delete / 运行时长', () => {
  it('delete 存在返回 true，缺失返回 false', () => {
    InstanceModel.create({ id: 'inst-del', name: 'Del' });
    expect(InstanceModel.delete('inst-del')).toBe(true);
    expect(InstanceModel.delete('inst-del')).toBe(false);
  });

  it('addUptime 累加秒数并向下取整，返回最新行', () => {
    InstanceModel.create({ id: 'inst-up', name: 'Up' });
    InstanceModel.addUptime('inst-up', 10);
    const after = InstanceModel.addUptime('inst-up', 15.7);
    expect(after.totalUptime).toBe(25); // 10 + floor(15.7)
  });

  it('getTotalUptime 存在返回累计值，缺失返回 0', () => {
    expect(InstanceModel.getTotalUptime('inst-up')).toBe(25);
    expect(InstanceModel.getTotalUptime('no-such')).toBe(0);
  });
});

describe('InstanceModel.migrateFromJson（JSON 配置迁移）', () => {
  it('id 不存在时创建（serverPath 以参数覆盖）并返回 true', () => {
    const ok = InstanceModel.migrateFromJson(
      { id: 'legacy-1', name: 'Legacy', type: 'forge', port: 25575 },
      '/data/servers/legacy',
    );
    expect(ok).toBe(true);
    const inst = InstanceModel.getById('legacy-1');
    expect(inst.serverPath).toBe('/data/servers/legacy');
    expect(inst.modLoader).toBe('Forge');
  });

  it('id 已存在时返回 false 且不覆盖既有数据', () => {
    const ok = InstanceModel.migrateFromJson(
      { id: 'legacy-1', name: 'Legacy2' },
      '/data/servers/other',
    );
    expect(ok).toBe(false);
    const inst = InstanceModel.getById('legacy-1');
    expect(inst.name).toBe('Legacy');
    expect(inst.serverPath).toBe('/data/servers/legacy');
  });
});
