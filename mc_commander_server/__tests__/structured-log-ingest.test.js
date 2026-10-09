/**
 * 结构化日志的摄取侧：双格式兼容（JSON 行 + 非 JSON 行）、展示层还原、流式按行组装，
 * 以及「同一行日志无论走纯文本还是走结构化，面板看到的结果一致」这条等价性。
 *
 * 等价性是本改造不回归的依据：stdout 换成 JSON 后，噪音过滤、事件正则、msmp 端口解析、
 * 日志查看四条下游都不能有感知差异，故逐条锁住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
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
  const tmpRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mc-structured-ingest-test-'));
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

import { MCServerInstance } from '../services/mc_server.js';
import {
  normalizeLogText,
  parseStructuredLogLine,
  renderStructuredLogLine,
} from '../services/mc-server/output-parser.js';

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ingest-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createInstance() {
  return new MCServerInstance({
    id: 's1',
    name: 'probe',
    javaPath: 'java',
    jarFile: 'server.jar',
    maxMemory: '1G',
    minMemory: '512M',
    serverPath: tmpRoot,
    jvmArgs: null,
    startCommand: null,
    autoRestart: false,
    autoStart: false,
    mcVersion: '26.3',
  });
}

/** 把纯文本形态的一行日志包成结构化行（字段与面板自带配置产出的完全一致） */
function jsonLine(ts, lvl, thr, logger, msg) {
  return JSON.stringify({ ts, lvl, thr, logger, msg });
}

const PLAIN_JOIN = '[04:50:51] [Server thread/INFO]: Steve joined the game';
const JSON_JOIN = jsonLine(
  '2026-10-08 04:50:51',
  'INFO',
  'Server thread',
  'net.minecraft.server.players.PlayerList',
  'Steve joined the game',
);

describe('结构化行解析与还原', () => {
  it('合法结构化行取出字段；多余字段忽略', () => {
    expect(parseStructuredLogLine(JSON_JOIN)).toEqual({
      ts: '2026-10-08 04:50:51',
      lvl: 'INFO',
      thr: 'Server thread',
      logger: 'net.minecraft.server.players.PlayerList',
      msg: 'Steve joined the game',
    });
    expect(parseStructuredLogLine(`${JSON_JOIN} `)).not.toBeNull();
  });

  it('不是我们的日志行一律返回 null（纯文本行、坏 JSON、缺 msg/lvl 的 JSON）', () => {
    expect(parseStructuredLogLine(PLAIN_JOIN)).toBeNull();
    expect(parseStructuredLogLine('{"ts":"2026-10-08 04:50:51","msg":"half')).toBeNull();
    expect(parseStructuredLogLine('{"ts":"x","lvl":"INFO"}')).toBeNull();
    expect(parseStructuredLogLine('{"ts":"x","msg":"no level"}')).toBeNull();
    expect(parseStructuredLogLine('Starting minecraft server version 26.3')).toBeNull();
    // 半截 JSON（chunk 从中间切开）也必须落到「非结构化」而不是抛错
    expect(
      parseStructuredLogLine('{"ts":"2026-10-08 04:50:51","lvl":"INFO","msg":"Star'),
    ).toBeNull();
  });

  it('还原成面板既有形态：时间取 ts 的时分秒，线程与级别进方括号', () => {
    expect(renderStructuredLogLine(parseStructuredLogLine(JSON_JOIN))).toBe(PLAIN_JOIN);
  });

  it('缺 ts 时用当前时刻补，不产生 [] 这种破形态', () => {
    const rendered = renderStructuredLogLine({ ts: '', lvl: 'WARN', thr: 'main', msg: 'hi' });
    expect(rendered).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[main\/WARN\]: hi$/);
  });

  it('消息里的引号/反斜杠/换行原样还原（换行仍铺成多行，与纯文本通道一致）', () => {
    const entry = parseStructuredLogLine(
      jsonLine('2026-10-08 04:50:51', 'ERROR', 'main', 'x.Y', 'a"b\\c\nd'),
    );
    expect(renderStructuredLogLine(entry)).toBe('[04:50:51] [main/ERROR]: a"b\\c\nd');
  });
});

describe('格式无关等价性', () => {
  it.each([
    [PLAIN_JOIN, JSON_JOIN],
    [
      '[04:50:51] [Server thread/INFO]: Done (0.322s)! For help, type "help"',
      jsonLine(
        '2026-10-08 04:50:51',
        'INFO',
        'Server thread',
        'net.minecraft.server.dedicated.DedicatedServer',
        'Done (0.322s)! For help, type "help"',
      ),
    ],
    [
      '[04:50:51] [main/ERROR]: boom\nstack line',
      jsonLine('2026-10-08 04:50:51', 'ERROR', 'main', 'x.Y', 'boom\nstack line'),
    ],
    [
      '[04:50:51] [Server thread/INFO]: <Steve> 你好 [RCON] 不是噪音',
      jsonLine(
        '2026-10-08 04:50:51',
        'INFO',
        'Server thread',
        'net.minecraft.server.network.ServerGamePacketListenerImpl',
        '<Steve> 你好 [RCON] 不是噪音',
      ),
    ],
  ])('规范结果与纯文本形态逐字符一致：%s', (plain, json) => {
    expect(normalizeLogText(json)).toBe(plain);
    expect(normalizeLogText(plain)).toBe(plain);
  });

  it('多行混合输入逐行规范：结构化行还原、JVM/bundler 原始行原样且顺序与行数不变', () => {
    const raw = [
      'WARNING: A restricted method in java.lang.System has been called',
      JSON_JOIN,
      'Starting net.minecraft.server.Main via BundlerClassPathCapture',
    ].join('\n');
    expect(normalizeLogText(raw).split('\n')).toEqual([
      'WARNING: A restricted method in java.lang.System has been called',
      PLAIN_JOIN,
      'Starting net.minecraft.server.Main via BundlerClassPathCapture',
    ]);
  });
});

describe('摄取路径：规范化后下游四路行为不变', () => {
  it('结构化行与纯文本行的 logBuffer / 事件完全一致', () => {
    const events = ['playerChat', 'status', 'playerJoin'];
    // playerJoin 载荷带 Date.now()，跨实例比较时只取稳定投影（名字）
    const project = { playerJoin: (p) => ({ name: p.name }) };

    const collect = (line) => {
      const instance = createInstance();
      const spies = Object.fromEntries(events.map((e) => [e, vi.fn()]));
      for (const [e, spy] of Object.entries(spies)) instance.on(e, spy);
      instance._ingestLogText(line, 'stdout');
      return {
        logBuffer: instance.logBuffer.map((l) => l.text),
        events: Object.fromEntries(
          Object.entries(spies).map(([e, s]) => [
            e,
            s.mock.calls.map((c) => (project[e] ? project[e](c[0]) : c[0])),
          ]),
        ),
      };
    };

    const plain = collect(`${PLAIN_JOIN}\n[04:50:52] [Server thread/INFO]: <Steve> 大家好`);
    const json = collect(
      `${JSON_JOIN}\n${jsonLine('2026-10-08 04:50:52', 'INFO', 'Server thread', 'net.minecraft.server.network.ServerGamePacketListenerImpl', '<Steve> 大家好')}`,
    );

    expect(json).toEqual(plain);
    expect(plain.events.playerJoin).toEqual([{ name: 'Steve' }]);
    expect(plain.events.playerChat).toEqual([{ name: 'Steve', message: '大家好' }]);
  });

  it('噪音过滤照样生效（判据是还原后的文本，不是 JSON 外壳）', () => {
    const instance = createInstance();
    // 行首分支：判据 `startsWith('[RCON')` 只有在还原成纯文本形态后才成立
    instance._ingestLogText(
      jsonLine(
        '2026-10-08 04:50:51',
        'INFO',
        'Server thread',
        'net.minecraft.server.rcon.RconConsoleSource',
        '[RCON Listener #1/INFO]: Thread RCON Client started',
      ),
      'stdout',
    );
    instance._ingestLogText(
      jsonLine(
        '2026-10-08 04:50:52',
        'INFO',
        'RCON Listener #1',
        'net.minecraft.server.rcon.RconConsoleSource',
        'Thread RCON Client shutting down',
      ),
      'stdout',
    );
    expect(instance.logBuffer).toEqual([]);
  });

  it('msmp 端口解析照样生效（面板从日志里读真实端口）', () => {
    const instance = createInstance();
    instance._ingestLogText(
      jsonLine(
        '2026-10-08 04:50:51',
        'INFO',
        'main',
        'net.minecraft.server.dedicated.DedicatedServer',
        'Starting json RPC server on localhost:0',
      ),
      'stdout',
    );
    instance._ingestLogText(
      jsonLine(
        '2026-10-08 04:50:52',
        'INFO',
        'main',
        'net.minecraft.server.dedicated.DedicatedServer',
        'Json-RPC Management connection listening on localhost:43055',
      ),
      'stdout',
    );
    expect(instance._msmpPortFromLog()).toBe(43055);
  });

  it('stderr 不做噪音过滤但同样规范化（与纯文本通道规则一致）', () => {
    const instance = createInstance();
    instance._ingestLogText(
      jsonLine('2026-10-08 04:50:51', 'WARN', 'main', 'x.Y', 'Thread RCON Client noise'),
      'stderr',
    );
    expect(instance.logBuffer.map((l) => l.text)).toEqual([
      '[04:50:51] [main/WARN]: Thread RCON Client noise',
    ]);
  });
});

describe('流式按行组装', () => {
  it('chunk 从中间切开结构化行：拼回一行，不把半截 JSON 露给用户', () => {
    const instance = createInstance();
    const half = Math.floor(JSON_JOIN.length / 2);

    instance._ingestStreamChunk(JSON_JOIN.slice(0, half), 'stdout');
    expect(instance.logBuffer).toEqual([]); // 未见到换行前不吐出

    instance._ingestStreamChunk(`${JSON_JOIN.slice(half)}\n`, 'stdout');
    expect(instance.logBuffer.map((l) => l.text)).toEqual([PLAIN_JOIN]);
  });

  it('一次 chunk 含多行：逐行摄取，残留留给下一次', () => {
    const instance = createInstance();
    instance._ingestStreamChunk(`${PLAIN_JOIN}\ntail-without`, 'stdout');
    expect(instance.logBuffer.map((l) => l.text)).toEqual([PLAIN_JOIN]);

    instance._ingestStreamChunk('-newline\n', 'stdout');
    expect(instance.logBuffer.map((l) => l.text)).toEqual([PLAIN_JOIN, 'tail-without-newline']);
  });

  it('无换行的超长输出按上限强制吐出，remainder 不会无限增长', () => {
    const instance = createInstance();
    instance._ingestStreamChunk('x'.repeat(64 * 1024 + 10), 'stdout');
    expect(instance._stdoutRemainder).toBe('');
    expect(instance.logBuffer).toHaveLength(1);
  });

  it('退出时补吐残留尾巴：末行没有换行也不会丢', () => {
    const instance = createInstance();
    instance._ingestStreamChunk('SERVER STOPPED', 'stdout');
    instance._ingestStreamChunk('err tail', 'stderr');

    instance._flushStreamRemainders();

    expect(instance.logBuffer.map((l) => l.text)).toEqual(['SERVER STOPPED', 'err tail']);
    expect(instance._stdoutRemainder).toBe('');
    expect(instance._stderrRemainder).toBe('');
  });

  it('stdout 与 stderr 各留各的残留，互不串行', () => {
    const instance = createInstance();
    instance._ingestStreamChunk('out-no-newline', 'stdout');
    instance._ingestStreamChunk('err-no-newline', 'stderr');

    instance._ingestStreamChunk('out-rest\n', 'stdout');

    expect(instance.logBuffer.map((l) => l.text)).toEqual(['out-no-newlineout-rest']);
    expect(instance._stderrRemainder).toBe('err-no-newline');
  });

  it('退出监听器会补吐残留（末行无换行也不丢）', () => {
    const instance = createInstance();
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn() };
    proc.pid = 4242;
    instance.process = proc;
    instance._attachOutputStreamListeners();
    instance._attachExitListener();

    proc.stdout.emit('data', Buffer.from(PLAIN_JOIN));
    expect(instance.logBuffer).toEqual([]);
    expect(() => proc.emit('exit', 0)).not.toThrow();

    expect(instance.logBuffer.map((l) => l.text)).toEqual([PLAIN_JOIN]);
  });
});
