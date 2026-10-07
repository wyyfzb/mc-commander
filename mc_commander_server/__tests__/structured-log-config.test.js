/**
 * 结构化日志通道：覆盖配置的渲染契约、log4j 版本门槛、注入位置与回落行为。
 *
 * 断言分三层：渲染契约（面板既有消费方与 Mojang 格式的契约）、版本门槛与回落
 * （老版本/非标准布局必须退回今天的行为）、注入（真参数构建路径上「插在最前」且不抢用户配置）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock 隔离：子进程 / RCON / SQLite 模型 / 配置目录（避免在仓库根落 servers、data）──
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

vi.mock('../config.js', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const tmpRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mc-structured-log-test-'));
  return {
    default: {
      port: 0,
      serversDir: pathMod.join(tmpRoot, 'servers'),
      dataDir: pathMod.join(tmpRoot, 'data'),
      backupsDir: pathMod.join(tmpRoot, 'backups'),
      logLevel: 'info',
      rateLimit: { windowMs: 60000, max: 100 },
    },
  };
});

// 包一层以便计数：内容一致时不应重写（避免每次启动都 churn mtime）
vi.mock('../utils/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, atomicWriteFile: vi.fn(actual.atomicWriteFile) };
});

import { atomicWriteFile } from '../utils/fs-utils.js';
import { MCServerInstance } from '../services/mc_server.js';
import {
  STRUCTURED_LOG_CONFIG_FILE,
  STRUCTURED_LOG_JSONL,
  STRUCTURED_LOG_PROPERTY,
  _ensureStructuredLogConfig,
  _withStructuredLogArg,
  isLog4jVersionSupported,
  readLog4jCoreVersion,
  renderStructuredLogConfig,
} from '../services/mc-server/structured-log-config.js';

/** 面板既有解析与 latest.log 消费方依赖的纯文本格式（与 Mojang 随包配置逐字符一致） */
const MOJANG_PLAIN_PATTERN = '[%d{HH:mm:ss}] [%t/%level]: %msg{nolookups}%n';

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-slc-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造一个带标准 libraries 布局的实例目录；version 为 null 时不造 log4j-core */
function makeServerDir(version = '2.26.0') {
  const serverPath = fs.mkdtempSync(path.join(tmpRoot, 'srv-'));
  if (version) {
    const dir = path.join(
      serverPath,
      'libraries',
      'org',
      'apache',
      'logging',
      'log4j',
      'log4j-core',
      version,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `log4j-core-${version}.jar`), '');
  }
  return serverPath;
}

function createInstance(serverPath) {
  return new MCServerInstance({
    id: 's1',
    name: 'probe',
    javaPath: 'java',
    jarFile: 'server.jar',
    maxMemory: '2G',
    minMemory: '1G',
    serverPath,
    jvmArgs: null,
    startCommand: null,
    autoRestart: false,
    autoStart: false,
    mcVersion: '26.3',
  });
}

describe('覆盖配置的渲染契约', () => {
  it('纯文本通道与 Mojang 一致：latest.log + 逐字符 pattern + 网络包过滤 + 三个 appender 都挂上', () => {
    const xml = renderStructuredLogConfig();
    // 三个 appender 齐备：控制台（面板实时摄取）、纯文本文件（接管续读/重启回填）、JSONL（结构化）
    expect(xml).toContain('<Console name="SysOut"');
    expect(xml).toContain('<RollingRandomAccessFile name="File"');
    expect(xml).toContain('<RollingRandomAccessFile name="Jsonl"');
    for (const ref of ['SysOut', 'File', 'Jsonl']) {
      expect(xml).toContain(`<AppenderRef ref="${ref}"/>`);
    }
    // latest.log 的文件名与格式是既有消费方的契约，改成别的路径/格式等于同时改三处消费侧
    expect(xml).toContain('fileName="logs/latest.log"');
    expect(xml).toContain(MOJANG_PLAIN_PATTERN);
    // NETWORK_PACKETS 标记必须继续被拒，否则网络包日志会灌满面板的日志视图
    expect(xml).toContain(
      '<MarkerFilter marker="NETWORK_PACKETS" onMatch="DENY" onMismatch="NEUTRAL"/>',
    );
  });

  it('JSONL 通道：独立文件、字段齐、msg 走 json 转义且 %n 在 encode 之外', () => {
    const xml = renderStructuredLogConfig();
    expect(xml).toContain(`fileName="${STRUCTURED_LOG_JSONL}"`);
    for (const field of [
      '"ts":"%d{yyyy-MM-dd HH:mm:ss}"',
      '"lvl":"%level"',
      '"thr":"%t"',
      '"logger":"%logger"',
    ]) {
      expect(xml).toContain(field);
    }
    expect(xml).toContain('"msg":"%encode{%msg}{json}"');
    // 实测坑：%n 落在 encode 之内会把换行转义成字面 \n，整份日志就只剩一行
    expect(xml).toMatch(/"msg":"%encode\{%msg\}\{json\}"\}%n/);
    expect(xml).not.toMatch(/%encode\{%msg\}\{json\}%n/);
  });

  it('不依赖 Mojang 自有 appender 插件（跨版本自洽，避免配置初始化失败连带丢日志）', () => {
    const xml = renderStructuredLogConfig();
    expect(xml).not.toContain('<Queue ');
    expect(xml).not.toContain('<Listener ');
  });
});

describe('log4j 版本门槛', () => {
  it('按 libraries 标准布局读出 log4j-core 版本', () => {
    expect(readLog4jCoreVersion(makeServerDir('2.24.1'))).toBe('2.24.1');
  });

  it('无 libraries 目录 / 目录内无版本名 → null（调用方据此回落）', () => {
    expect(readLog4jCoreVersion(makeServerDir(null))).toBeNull();
    const serverPath = fs.mkdtempSync(path.join(tmpRoot, 'srv-'));
    const dir = path.join(
      serverPath,
      'libraries',
      'org',
      'apache',
      'logging',
      'log4j',
      'log4j-core',
    );
    fs.mkdirSync(path.join(dir, 'not-a-version'), { recursive: true });
    expect(readLog4jCoreVersion(serverPath)).toBeNull();
  });

  it('门槛＝已验证下限 2.24.1：低于它不启用，高于/等于启用', () => {
    for (const version of ['2.24.1', '2.25.2', '2.26.0', '3.0.0']) {
      expect(isLog4jVersionSupported(version)).toBe(true);
    }
    for (const version of ['2.24.0', '2.20.0', '1.9.9', null, '', 'unknown']) {
      expect(isLog4jVersionSupported(version)).toBe(false);
    }
  });
});

describe('启动前置：写配置与回落', () => {
  it('版本达门槛：写入实例目录并把绝对路径记到实例上', () => {
    const serverPath = makeServerDir('2.26.0');
    const instance = createInstance(serverPath);

    const configPath = instance._ensureStructuredLogConfig();

    expect(configPath).toBe(path.join(serverPath, STRUCTURED_LOG_CONFIG_FILE));
    expect(instance._structuredLogConfigPath).toBe(configPath);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(renderStructuredLogConfig());
  });

  it('幂等：内容一致时不重写', () => {
    const instance = createInstance(makeServerDir('2.26.0'));

    instance._ensureStructuredLogConfig();
    instance._ensureStructuredLogConfig();

    expect(atomicWriteFile).toHaveBeenCalledTimes(1);
  });

  it('内容被改动过则重写回面板版本（用户手改不能长期生效，否则与解析口径脱钩）', () => {
    const serverPath = makeServerDir('2.26.0');
    const instance = createInstance(serverPath);
    const configPath = path.join(serverPath, STRUCTURED_LOG_CONFIG_FILE);
    fs.writeFileSync(configPath, '<Configuration/>');

    instance._ensureStructuredLogConfig();

    expect(fs.readFileSync(configPath, 'utf-8')).toBe(renderStructuredLogConfig());
  });

  it('版本低于门槛：不写文件、路径为 null（回落即今天的行为，实例可用性不受影响）', () => {
    const serverPath = makeServerDir('2.20.0');
    const instance = createInstance(serverPath);

    expect(instance._ensureStructuredLogConfig()).toBeNull();
    expect(instance._structuredLogConfigPath).toBeNull();
    expect(fs.existsSync(path.join(serverPath, STRUCTURED_LOG_CONFIG_FILE))).toBe(false);
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });

  it('读取布局就抛错时不向外抛（任何异常都不能挡住实例启动）', () => {
    const serverPath = makeServerDir(null);
    // 把 log4j-core 造成「文件」：existsSync 为真、readdirSync 抛 ENOTDIR
    const dir = path.join(serverPath, 'libraries', 'org', 'apache', 'logging', 'log4j');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'log4j-core'), '');

    const instance = createInstance(serverPath);
    expect(() => instance._ensureStructuredLogConfig()).not.toThrow();
    expect(instance._structuredLogConfigPath).toBeNull();
  });
});

describe('启动参数注入', () => {
  it('未启用（路径为 null）：参数原样返回', () => {
    const args = ['-Xmx1G', '-jar', '/srv/server.jar', 'nogui'];
    expect(_withStructuredLogArg.call({ _structuredLogConfigPath: null }, args)).toEqual(args);
  });

  it('启用：插在参数最前（JVM 选项必须在主类之前，argfile 启动形态下附末尾会被当成应用程序参数）', () => {
    const result = _withStructuredLogArg.call(
      { _structuredLogConfigPath: '/srv/log4j2-mc-commander.xml' },
      ['-Xmx1G', '-jar', '/srv/server.jar', 'nogui'],
    );
    expect(result).toEqual([
      `-D${STRUCTURED_LOG_PROPERTY}=/srv/log4j2-mc-commander.xml`,
      '-Xmx1G',
      '-jar',
      '/srv/server.jar',
      'nogui',
    ]);
  });

  it.each([STRUCTURED_LOG_PROPERTY, 'log4j2.configurationFile'])(
    '用户已指定 -D%s：不覆盖',
    (property) => {
      const args = [`-D${property}=/custom.xml`, '-Xmx1G', '-jar', '/srv/server.jar', 'nogui'];
      expect(_withStructuredLogArg.call({ _structuredLogConfigPath: '/srv/ours.xml' }, args)).toBe(
        args,
      );
    },
  );
});

describe('与真实参数构建的集成锁', () => {
  it('默认分支（无 jvmArgs/startCommand）：达门槛时启动参数带上注入项且保留 jar 与 nogui', () => {
    const serverPath = makeServerDir('2.26.0');
    fs.writeFileSync(path.join(serverPath, 'server.jar'), '');
    const instance = createInstance(serverPath);
    instance._ensureStructuredLogConfig();

    const { command, args } = instance._resolveStartCommand(null);

    expect(command).toBe('java');
    expect(args[0]).toBe(
      `-D${STRUCTURED_LOG_PROPERTY}=${path.join(serverPath, STRUCTURED_LOG_CONFIG_FILE)}`,
    );
    expect(args).toContain('-jar');
    expect(args).toContain(path.join(serverPath, 'server.jar'));
    expect(args).toContain('nogui');
  });

  it('结构化 jvmArgs 分支：注入项在最前，用户参数顺序不变', () => {
    const serverPath = makeServerDir('2.26.0');
    fs.writeFileSync(path.join(serverPath, 'server.jar'), '');
    const instance = createInstance(serverPath);
    instance.jvmArgs = ['-Xmx4G', '-XX:+UseG1GC'];
    instance._ensureStructuredLogConfig();

    const { args } = instance._resolveStartCommand(null);

    // -Xms 由 _buildFullJvmArgs 补在用户参数之前（内存档由字段管理，已显式给的 -Xmx 不重复补）
    expect(args).toEqual([
      `-D${STRUCTURED_LOG_PROPERTY}=${path.join(serverPath, STRUCTURED_LOG_CONFIG_FILE)}`,
      '-Xms1G',
      '-Xmx4G',
      '-XX:+UseG1GC',
      '-jar',
      path.join(serverPath, 'server.jar'),
      'nogui',
    ]);
  });

  it('未达门槛（非标准布局）：启动参数不含注入项', () => {
    const serverPath = makeServerDir(null);
    fs.writeFileSync(path.join(serverPath, 'server.jar'), '');
    const instance = createInstance(serverPath);
    instance._ensureStructuredLogConfig();

    const { args } = instance._resolveStartCommand(null);

    expect(args.some((a) => String(a).startsWith(`-D${STRUCTURED_LOG_PROPERTY}=`))).toBe(false);
    expect(args).toContain('nogui');
  });
});
