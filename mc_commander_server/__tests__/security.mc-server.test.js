import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { offlineUuid, getTotalPlayTime } from '../utils/player-utils.js';

// ── Mock 隔离：子进程 / RCON / SQLite 模型 / 配置目录 ──
vi.mock('child_process', () => {
  const spawn = vi.fn();
  const spawnSync = vi.fn();
  const exec = vi.fn();
  return { spawn, spawnSync, exec, default: { spawn, spawnSync, exec } };
});

vi.mock('rcon-client', () => {
  const Rcon = vi.fn();
  Rcon.connect = vi.fn();
  return { Rcon };
});

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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-test-'));
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

import { spawn } from 'child_process';
import { MCServerInstance } from '../services/mc_server.js';

// 构造一个模拟的 java 子进程（stdout/stderr/stdin/exit 均可控）
function makeFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn() };
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
}

describe('安全修复：start 结构化改造', () => {
  let tmpDir;
  let lastProc;

  function createInstance(overrides = {}) {
    return new MCServerInstance({
      id: 'sec-002',
      name: 'Sec 002',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '2G',
      minMemory: '1G',
      serverPath: tmpDir,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-002-'));
    fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
    vi.spyOn(MCServerInstance.prototype, '_detectPublicIp').mockResolvedValue(undefined);
    lastProc = null;
    spawn.mockReset();
    spawn.mockImplementation(() => {
      lastProc = makeFakeProcess();
      return lastProc;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('拒绝非 java 可执行作为 startCommand（bash 自由字符串不再可执行）', () => {
    const instance = createInstance();
    expect(() => instance.start('bash -c "rm -rf /"')).toThrow(/仅允许 java 可执行文件/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('拒绝 startCommand 字段配置为 bash（旧字段兼容读取 + 白名单校验）', () => {
    const instance = createInstance({ startCommand: 'sh -c "touch /tmp/pwned"' });
    expect(() => instance.start()).toThrow(/仅允许 java 可执行文件/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('拒绝非法 javaPath（纯命令名 python）', () => {
    const instance = createInstance({ javaPath: 'python' });
    expect(() => instance.start()).toThrow(/仅允许 java 可执行文件/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('拒绝不存在的绝对路径 javaPath', () => {
    const instance = createInstance({ javaPath: path.join(tmpDir, 'not-exist', 'bin', 'java') });
    expect(() => instance.start()).toThrow(/仅允许 java 可执行文件/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('接受绝对路径 javaPath（文件名 java 特征，existsSync 通过）', () => {
    const javaBin = path.join(tmpDir, 'jdk', 'bin', 'java.exe');
    fs.mkdirSync(path.dirname(javaBin), { recursive: true });
    fs.writeFileSync(javaBin, '');
    const instance = createInstance({ javaPath: javaBin });
    instance.start();
    expect(spawn).toHaveBeenCalledWith(
      javaBin,
      ['-Xmx2G', '-Xms1G', '-jar', path.join(tmpDir, 'server.jar'), 'nogui'],
      expect.objectContaining({ cwd: tmpDir }),
    );
  });

  it('拒绝 -jar 路径越出实例目录（../ 路径穿越）', () => {
    const instance = createInstance();
    expect(() => instance.start('java -Xmx4G -jar ../evil.jar nogui')).toThrow(/越出实例目录/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('拒绝 -jar 缺少路径参数', () => {
    const instance = createInstance();
    expect(() => instance.start('java -jar')).toThrow(/缺少 jar 文件路径/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('拒绝非 -X/-D/-jar/nogui 白名单参数', () => {
    const instance = createInstance();
    expect(() => instance.start('java -Xmx4G -jar server.jar nogui --exec evil.sh')).toThrow(
      /不支持的启动参数: --exec/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('结构化 jvmArgs 参数数组正常启动（-X/-D 与 -jar 白名单）', () => {
    const instance = createInstance();
    instance.start({ jvmArgs: ['-Xmx4G', '-Xms2G', '-jar', 'server.jar', 'nogui'] });
    expect(spawn).toHaveBeenCalledWith(
      'java',
      ['-Xmx4G', '-Xms2G', '-jar', 'server.jar', 'nogui'],
      expect.objectContaining({ cwd: tmpDir }),
    );
  });

  it('结构化 jvmArgs 拒绝越界 -jar 路径', () => {
    const instance = createInstance();
    expect(() => instance.start({ jvmArgs: ['-jar', '../evil.jar'] })).toThrow(/越出实例目录/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('结构化 jvmArgs 拒绝非白名单参数', () => {
    const instance = createInstance();
    expect(() => instance.start({ jvmArgs: ['-Xmx4G', '/bin/rm'] })).toThrow(/不支持的启动参数/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('旧 startCommand 字段兼容读取：合法 java 命令正常启动（不静默执行不合法值）', () => {
    const instance = createInstance({
      startCommand: 'java -Xmx3G -XX:+UseG1GC -jar server.jar nogui',
    });
    instance.start();
    expect(spawn).toHaveBeenCalledWith(
      'java',
      ['-Xmx3G', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui'],
      expect.objectContaining({ cwd: tmpDir }),
    );
  });

  it('旧 startCommand 字段含危险参数时拒绝启动', () => {
    const instance = createInstance({
      startCommand: 'java -jar server.jar nogui && touch /tmp/pwned',
    });
    expect(() => instance.start()).toThrow(/不支持的启动参数/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('实例配置 jvmArgs（DB 持久化）无传参启动时生效（优先级高于遗留 startCommand）', () => {
    const instance = createInstance({
      jvmArgs: ['-Xmx4G', '-Xms2G', '-jar', 'server.jar', 'nogui'],
      startCommand: 'java -Xmx1G -jar server.jar nogui', // 遗留旧命令应被 jvmArgs 覆盖
    });
    instance.start();
    expect(spawn).toHaveBeenCalledWith(
      'java',
      expect.arrayContaining([
        '-Xmx4G',
        '-Xms2G',
        '-jar',
        expect.stringContaining('server.jar'),
        'nogui',
      ]),
      expect.anything(),
    );
    // 旧 startCommand 的参数未被执行
    expect(JSON.stringify(spawn.mock.calls[0][1])).not.toContain('-Xmx1G');
  });

  it('实例配置 jvmArgs 含越界 -jar 时拒绝启动（DB 损坏/绕过路由校验兜底）', () => {
    const instance = createInstance({ jvmArgs: ['-jar', '../evil.jar', 'nogui'] });
    expect(() => instance.start()).toThrow(/越界|serverPath|实例目录/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('实例配置 jvmArgs 为空数组时回退默认启动参数', () => {
    const instance = createInstance({ jvmArgs: [] });
    instance.start();
    expect(spawn).toHaveBeenCalledWith(
      'java',
      expect.arrayContaining([
        '-Xmx2G',
        '-Xms1G',
        '-jar',
        expect.stringContaining('server.jar'),
        'nogui',
      ]),
      expect.anything(),
    );
  });

  it('实例配置 jvmArgs 仅含附加 flags（客户端真实数据形态）时补全 -Xmx/-Xms/-jar/nogui 启动', () => {
    // 回归：客户端保存 jvmArgs 只存 -jar 之前的附加 flags（Aikar 优化参数），
    // -Xmx/-Xms 走 maxMemory/minMemory、-jar/nogui 走 jarFile；
    // 未补全时生成 "java <flags>" 无主类命令 → java 报 Usage 退出码 1 → 无限自动重启循环
    const instance = createInstance({
      jvmArgs: ['-XX:+UseG1GC', '-Daikars.new.flags=true'],
    });
    instance.start();
    expect(spawn).toHaveBeenCalledWith(
      'java',
      [
        '-Xmx2G',
        '-Xms1G',
        '-XX:+UseG1GC',
        '-Daikars.new.flags=true',
        '-jar',
        path.join(tmpDir, 'server.jar'),
        'nogui',
      ],
      expect.objectContaining({ cwd: tmpDir }),
    );
  });

  it('实例配置 jvmArgs 已含 -Xmx/-jar 时不重复补全（显式值尊重）', () => {
    const instance = createInstance({ jvmArgs: ['-Xmx4G', '-jar', 'server.jar'] });
    instance.start();
    const args = spawn.mock.calls[0][1];
    expect(args.filter((a) => a.startsWith('-Xmx'))).toEqual(['-Xmx4G']);
    expect(args.filter((a) => a === '-jar')).toHaveLength(1);
    // -Xms 缺失仍补全
    expect(args).toContain('-Xms1G');
  });
});

describe('安全修复：saveProperties 换行转义', () => {
  let tmpDir;

  function createInstance() {
    return new MCServerInstance({
      id: 'sec-018',
      name: 'Sec 018',
      javaPath: 'java',
      jarFile: 'server.jar',
      serverPath: tmpDir,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-018-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('值内真实换行被转义为字面 \\n（防单属性走私多键注入）', () => {
    const instance = createInstance();
    fs.writeFileSync(path.join(tmpDir, 'server.properties'), 'max-players=20\n');
    instance.saveProperties({ 'max-players': '10\nmotd=hacked' });
    const content = fs.readFileSync(path.join(tmpDir, 'server.properties'), 'utf-8');
    // 写入的是字面 \\n（两字符），不存在独立走私键行
    expect(content).toContain('max-players=10\\nmotd=hacked');
    expect(content.split('\n').filter((l) => l.trim())).not.toContain('motd=hacked');
  });

  it('值内 \\r 同样被转义', () => {
    const instance = createInstance();
    fs.writeFileSync(path.join(tmpDir, 'server.properties'), '');
    instance.saveProperties({ motd: 'a\rb' });
    const content = fs.readFileSync(path.join(tmpDir, 'server.properties'), 'utf-8');
    expect(content).toContain('motd=a\\rb');
  });

  it('保留注释行与磁盘旧键（未知键自动追加合并行为不破坏）', () => {
    const instance = createInstance();
    fs.writeFileSync(path.join(tmpDir, 'server.properties'), '# comment line\nmax-players=20\n');
    instance.saveProperties({ 'new-key': 'v' });
    const content = fs.readFileSync(path.join(tmpDir, 'server.properties'), 'utf-8');
    expect(content).toContain('# comment line');
    expect(content).toContain('max-players=20');
    expect(content).toContain('new-key=v');
  });

  it('_saveProperties 内部方法同样转义', () => {
    const instance = createInstance();
    instance._saveProperties({ motd: 'x\ny' });
    const content = fs.readFileSync(path.join(tmpDir, 'server.properties'), 'utf-8');
    expect(content).toContain('motd=x\\ny');
  });
});

describe('安全修复：level-name 服务层兜底校验', () => {
  let tmpDir;

  function createInstance() {
    return new MCServerInstance({
      id: 'sec-extra1',
      name: 'Sec Extra1',
      javaPath: 'java',
      jarFile: 'server.jar',
      serverPath: tmpDir,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-extra1-'));
    fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
    vi.spyOn(MCServerInstance.prototype, '_detectPublicIp').mockResolvedValue(undefined);
    spawn.mockReset();
    spawn.mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn() };
      proc.pid = 12345;
      proc.kill = vi.fn();
      return proc;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('非法 level-name（../../）回退 world，_getWorldSize 不越界统计', () => {
    const instance = createInstance();
    // world 目录不存在 → 回退后统计结果为 0；未修复时 resolve 到 tmpDir 上级（存在）会统计其大小
    instance.properties = { 'level-name': '..' };
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn/error 均走 stderr
    expect(instance._getWorldSize()).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('合法 level-name 正常统计（校验不误伤自定义世界目录）', () => {
    const instance = createInstance();
    fs.mkdirSync(path.join(tmpDir, 'my_world-1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'my_world-1', 'data.bin'), '12345678');
    instance.properties = { 'level-name': 'my_world-1' };
    // 8 字节 → 0GB（四舍五入），仅验证不告警、不抛错
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn/error 均走 stderr
    expect(instance._getWorldSize()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('start() 的 session.lock 清理：非法 level-name 回退 world，不越界 unlink', () => {
    const instance = createInstance();
    instance.properties = { 'level-name': '..' };
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn/error 均走 stderr
    // 未修复时 lockPath = tmpDir/../session.lock（越界 unlink）；修复后回退 tmpDir/world/session.lock
    expect(() => instance.start()).not.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('_readSeedFromLevelDat / _readWeatherFromLevelDat 非法 level-name 回退 world 不越界', () => {
    const instance = createInstance();
    instance.properties = { 'level-name': '../evil' };
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn/error 均走 stderr
    expect(instance._readSeedFromLevelDat()).toBeNull();
    expect(instance._readWeatherFromLevelDat()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('安全修复：读侧路径校验', () => {
  let tmpDir;

  function createInstance() {
    return new MCServerInstance({
      id: 'sec-008',
      name: 'Sec 008',
      javaPath: 'java',
      jarFile: 'server.jar',
      serverPath: tmpDir,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-008-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getTotalPlayTime：非法 level-name 回退 world 路径读取统计文件', () => {
    const instance = createInstance();
    const statsDir = path.join(tmpDir, 'world', 'players', 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(
      path.join(statsDir, 'u1.json'),
      JSON.stringify({
        stats: { 'minecraft:custom': { 'minecraft:play_time': 400 } },
      }),
    );
    instance.properties = { 'level-name': '../../evil' };
    // 详情页等价调用（实例方法内部走共享函数 getTotalPlayTime）：
    // 非法 level-name 在共享函数内回退 world 后读到 400 tick
    expect(
      getTotalPlayTime({
        serverPath: tmpDir,
        uuid: 'u1',
        playerName: 'Steve',
        levelName: instance.properties?.['level-name'],
      }),
    ).toBe(20); // 400 tick / 20 = 20 秒
  });

  it('getTotalPlayTime：候选路径 resolve 越界时被丢弃（不读越界文件）', () => {
    // level-name 非法（含 ..）时回退 world；无文件 → 0（越界候选被过滤，不读外部文件）
    expect(
      getTotalPlayTime({
        serverPath: tmpDir,
        uuid: 'u1',
        playerName: 'Steve',
        levelName: '../../evil',
      }),
    ).toBe(0);
  });

  it('_loadInventoryFromDat：非法 level-name 回退 world 路径读取 dat 快照', () => {
    const instance = createInstance();
    const dataDir = path.join(tmpDir, 'world', 'players', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // gzip 压缩的空 NBT compound（无 Inventory 字段 → 快照为空但结构有效）
    fs.writeFileSync(path.join(dataDir, 'u1.dat'), zlib.gzipSync(Buffer.from([10, 0, 0])));
    instance.properties = { 'level-name': '../../evil' };
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn/error 均走 stderr
    const inv = instance._loadInventoryFromDat('u1', 'Steve');
    expect(inv).not.toBeNull();
    expect(inv.source).toBe('snapshot');
    warnSpy.mockRestore();
  });

  it('_loadPlayerRealStats：非法 level-name 回退 world 路径读取真实统计', () => {
    const instance = createInstance();
    const statsDir = path.join(tmpDir, 'world', 'players', 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(
      path.join(statsDir, 'u1.json'),
      JSON.stringify({
        stats: { 'minecraft:custom': { 'minecraft:deaths': 7 } },
      }),
    );
    vi.spyOn(instance, '_getPlayerUuid').mockReturnValue('u1');
    instance.properties = { 'level-name': '../evil' };
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn/error 均走 stderr
    const real = instance._loadPlayerRealStats('Steve');
    expect(real).not.toBeNull();
    expect(real.deaths).toBe(7);
    warnSpy.mockRestore();
  });

  it('_loadInventoryFromDat：uuid 空串走 offline uuid 兜底（无 usercache 玩家快照）', () => {
    const instance = createInstance();
    const offline = offlineUuid('Steve');
    const dataDir = path.join(tmpDir, 'world', 'players', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // gzip 压缩的空 NBT compound（无 Inventory 字段 → 快照为空但结构有效）
    fs.writeFileSync(path.join(dataDir, `${offline}.dat`), zlib.gzipSync(Buffer.from([10, 0, 0])));
    const inv = instance._loadInventoryFromDat('', 'Steve');
    expect(inv).not.toBeNull();
    expect(inv.source).toBe('snapshot');
  });

  it('_loadPlayerRealStats：无 usercache（uuid null）时 offline uuid 候选读取真实统计', () => {
    const instance = createInstance();
    const offline = offlineUuid('Steve');
    const statsDir = path.join(tmpDir, 'world', 'players', 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(
      path.join(statsDir, `${offline}.json`),
      JSON.stringify({
        stats: { 'minecraft:custom': { 'minecraft:deaths': 7 } },
      }),
    );
    vi.spyOn(instance, '_getPlayerUuid').mockReturnValue(null);
    const real = instance._loadPlayerRealStats('Steve');
    expect(real).not.toBeNull();
    expect(real.deaths).toBe(7);
  });
});

describe('安全修复：日志单行截断', () => {
  let tmpDir;
  let lastProc;

  function createInstance() {
    return new MCServerInstance({
      id: 'sec-023',
      name: 'Sec 023',
      javaPath: 'java',
      jarFile: 'server.jar',
      serverPath: tmpDir,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-023-'));
    fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
    vi.spyOn(MCServerInstance.prototype, '_detectPublicIp').mockResolvedValue(undefined);
    lastProc = null;
    spawn.mockReset();
    spawn.mockImplementation(() => {
      lastProc = makeFakeProcess();
      return lastProc;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stdout 超长单行截断 4096 并加 …[truncated] 标记', () => {
    const instance = createInstance();
    instance.start();
    const longLine = 'x'.repeat(5000);
    lastProc.stdout.emit('data', Buffer.from(longLine + '\n'));
    expect(instance.logBuffer.length).toBe(1);
    expect(instance.logBuffer[0].text).toBe('x'.repeat(4096) + '…[truncated]');
    expect(instance.logBuffer[0].text.length).toBeLessThan(5000);
  });

  it('stdout 多行中仅超长行被截断，短行保持原样', () => {
    const instance = createInstance();
    instance.start();
    const longLine = 'y'.repeat(4500);
    lastProc.stdout.emit('data', Buffer.from(`normal line\n${longLine}\n`));
    expect(instance.logBuffer.length).toBe(1);
    const lines = instance.logBuffer[0].text.split('\n');
    expect(lines[0]).toBe('normal line');
    expect(lines[1]).toBe('y'.repeat(4096) + '…[truncated]');
  });

  it('stderr 超长单行同样截断', () => {
    const instance = createInstance();
    instance.start();
    const longLine = 'z'.repeat(5000);
    lastProc.stderr.emit('data', Buffer.from(longLine + '\n'));
    expect(instance.logBuffer.length).toBe(1);
    // stderr 保留原始行结构（含尾随换行），仅超长行被截断加标记
    expect(instance.logBuffer[0].text).toBe('z'.repeat(4096) + '…[truncated]' + '\n');
    expect(instance.logBuffer[0].type).toBe('stderr');
  });

  it('正常长度日志不受截断影响', () => {
    const instance = createInstance();
    instance.start();
    lastProc.stdout.emit(
      'data',
      Buffer.from('[12:00:00] [Server thread/INFO]: Steve joined the game\n'),
    );
    expect(instance.logBuffer[0].text).toContain('Steve joined the game');
    expect(instance.players.has('Steve')).toBe(true);
  });
});
