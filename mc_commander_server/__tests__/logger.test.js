import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import config from '../config.js';
import {
  logger,
  readErrorLog,
  __configureLogger,
  __resetLogger,
  __loggerState,
} from '../utils/logger.js';

// logger 单元测试（issue #325）：四级过滤 / error 分流 / 轮转 / banner 白名单
// 输出捕获：替换 process.stdout/stderr.write（logger 唯一输出口）
describe('logger 轻量结构化日志', () => {
  let tmpDir;
  let stdoutWrites;
  let stderrWrites;
  let origStdoutWrite;
  let origStderrWrite;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-logger-'));
    stdoutWrites = [];
    stderrWrites = [];
    origStdoutWrite = process.stdout.write.bind(process.stdout);
    origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    };
    __configureLogger({ dir: tmpDir });
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    vi.restoreAllMocks();
    __resetLogger();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('LOG_LEVEL 级别过滤：level=warn 时 debug/info 不输出，warn/error 输出', () => {
    __configureLogger({ dir: tmpDir, level: 'warn' });
    logger.debug('debug-msg');
    logger.info('info-msg');
    logger.warn('warn-msg');
    logger.error('error-msg');

    const stdout = stdoutWrites.join('');
    const stderr = stderrWrites.join('');
    expect(stdout).not.toContain('debug-msg');
    expect(stdout).not.toContain('info-msg');
    expect(stderr).toContain('warn-msg');
    expect(stderr).toContain('error-msg');
    // 级别标签与 ISO 时间戳格式
    expect(stderr).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[WARN\] warn-msg/);
    expect(stderr).toMatch(/\[ERROR\] error-msg/);
  });

  it('level=debug 时四级全输出，debug 走 stdout', () => {
    __configureLogger({ dir: tmpDir, level: 'debug' });
    logger.debug('dbg');
    logger.info('ifo');
    logger.warn('wrn');
    logger.error('err');

    const stdout = stdoutWrites.join('');
    const stderr = stderrWrites.join('');
    expect(stdout).toContain('dbg');
    expect(stdout).toMatch(/\[DEBUG\] dbg/);
    expect(stdout).toMatch(/\[INFO\] ifo/);
    expect(stderr).toMatch(/\[WARN\] wrn/);
    expect(stderr).toMatch(/\[ERROR\] err/);
  });

  it('非法 level 字符串回退 info（debug 不输出、info 输出）', () => {
    __configureLogger({ dir: tmpDir, level: 'verbose-not-a-level' });
    expect(__loggerState().level).toBe('info');
    logger.debug('hidden');
    logger.info('visible');
    expect(stdoutWrites.join('')).not.toContain('hidden');
    expect(stdoutWrites.join('')).toContain('visible');
  });

  it('config.logLevel 被消费：logger 默认级别来自 config（不再是死配置）', () => {
    // DEFAULTS.level 取自 config.logLevel（← LOG_LEVEL 环境变量，config.js 唯一来源）
    expect(__loggerState().defaultsLevel).toBe(config.logLevel);
    // 未注入覆盖时当前级别与默认一致
    __resetLogger();
    expect(__loggerState().level).toBe(config.logLevel);
  });

  it('error 分流独立文件：error 落盘 error.log，info 不落盘', () => {
    __configureLogger({ dir: tmpDir, level: 'debug' });
    logger.error('boom-detail', { code: 42 });
    logger.info('not-on-disk');
    logger.warn('warn-not-on-disk');

    const errorLog = path.join(tmpDir, 'error.log');
    expect(fs.existsSync(errorLog)).toBe(true);
    const content = fs.readFileSync(errorLog, 'utf-8');
    expect(content).toContain('boom-detail');
    expect(content).toMatch(/\[ERROR\] boom-detail/);
    // util.format 多参数行为保留（对象被 inspect）
    expect(content).toContain('{ code: 42 }');
    expect(content).not.toContain('not-on-disk');
    expect(content).not.toContain('warn-not-on-disk');
  });

  it('轮转触发：超过 maxSizeBytes 后移 .1~.3，最旧删除，error.log 为最新', () => {
    __configureLogger({ dir: tmpDir, maxSizeBytes: 200, maxFiles: 3 });
    // 每条 ~121 字节，rotate 在 append 前检查：每写 2 条触发一次轮转。
    // 8 条 → 3 次轮转（写3/写5/写7 前）→ error.log + .1~.3 齐全
    for (let i = 1; i <= 8; i++) {
      logger.error(`rotation-message-round-${i}-${'x'.repeat(60)}`);
    }
    const files = fs.readdirSync(tmpDir).sort();
    // maxFiles=3：仅保留 error.log + error.log.1~3
    expect(files).toContain('error.log');
    expect(files).toContain('error.log.1');
    expect(files).toContain('error.log.2');
    expect(files).toContain('error.log.3');
    expect(files).not.toContain('error.log.4');
    // error.log 为最新内容（round-8；round-7 同批未触发轮转），round-1 已移至 .3
    const newest = fs.readFileSync(path.join(tmpDir, 'error.log'), 'utf-8');
    expect(newest).toContain('rotation-message-round-8');
    expect(newest).not.toContain('rotation-message-round-1');
    const oldest = fs.readFileSync(path.join(tmpDir, 'error.log.3'), 'utf-8');
    expect(oldest).toContain('rotation-message-round-1');
    expect(oldest).not.toContain('rotation-message-round-8');
  });

  it('banner 白名单：level=error 时 banner 仍输出 stderr 且不落盘', () => {
    __configureLogger({ dir: tmpDir, level: 'error' });
    logger.banner('  MC_Commander Server v9.9.9');
    logger.info('filtered-info');

    const stderr = stderrWrites.join('');
    expect(stderr).toContain('MC_Commander Server v9.9.9');
    expect(stderr).not.toContain('filtered-info');
    // banner 不写文件
    expect(fs.existsSync(path.join(tmpDir, 'error.log'))).toBe(false);
  });

  it('文件系统故障降级：目录不可写时 error 不抛异常、仅 stderr 告警一次', () => {
    // 以「文件」冒充日志目录制造写入失败（mkdir recursive 对已存在文件抛 ENOTDIR）
    const blocked = path.join(tmpDir, 'blocked');
    fs.writeFileSync(blocked, 'not-a-dir');
    __configureLogger({ dir: blocked });

    expect(() => logger.error('should-not-throw-1')).not.toThrow();
    expect(() => logger.error('should-not-throw-2')).not.toThrow();
    // 主日志仍走 stderr（降级不丢流）
    const stderr = stderrWrites.join('');
    expect(stderr).toContain('should-not-throw-1');
    expect(stderr).toContain('should-not-throw-2');
    // 降级告警仅一次
    expect(stderr.split('[logger] error 日志文件写入失败').length - 1).toBe(1);
  });
});

// 读取侧（面板自身错误面）：与写入侧同一模块，故用真实写入路径产样本再真实读取——
// 两侧对格式的耦合由此被锁住，任一侧改格式都会转红
describe('readErrorLog 面板自身错误读取', () => {
  let dir;
  let origStdout;
  let origStderr;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-errlog-'));
    __configureLogger({ dir });
    // 写侧仍走真实路径，但把输出口接住：超长样本不该泄进测试输出
    origStdout = process.stdout.write;
    origStderr = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
  });
  afterEach(() => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    __resetLogger();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('日志文件不存在：readState=no-file（首次启动的常态，不是读取失败）', () => {
    const result = readErrorLog();
    expect(result.readState).toBe('no-file');
    expect(result.available).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.logFile).toBe(path.join(dir, 'error.log'));
  });

  it('文件存在但读不到（EACCES）：readState=unreadable —— 与「本来没有」分开', () => {
    // 权限位在 root 下不生效（CAP_DAC_OVERRIDE），故用一个真实存在的**目录**占住文件名：
    // 读它会得到 EISDIR（非 ENOENT），正是这条要区分的形态
    fs.mkdirSync(path.join(dir, 'error.log'));
    const result = readErrorLog();
    expect(result.readState).toBe('unreadable');
    expect(result.entries).toEqual([]);
  });

  it('读到任意一档即 ok（更旧的轮转档可读时，不因最新一档读不到而报读不到）', () => {
    fs.mkdirSync(path.join(dir, 'error.log'));
    fs.writeFileSync(
      path.join(dir, 'error.log.1'),
      '[2026-01-01T00:00:00.000Z] [ERROR] older-rotated\n',
      'utf-8',
    );
    const result = readErrorLog();
    expect(result.readState).toBe('ok');
    expect(result.entries.map((e) => e.message)).toEqual(['older-rotated']);
  });

  it('文件在、里面没条目：readState=ok 且 entries 为空（与 no-file / unreadable 都不同形）', () => {
    fs.writeFileSync(path.join(dir, 'error.log'), '', 'utf-8');
    const result = readErrorLog();
    expect(result.readState).toBe('ok');
    expect(result.available).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('读回真实写入的错误：最新在前，时间/级别/消息齐', () => {
    logger.error('first-failure');
    logger.error('second-failure');

    const { available, entries, readState } = readErrorLog();
    expect(readState).toBe('ok');
    expect(available).toBe(true);
    expect(entries.map((e) => e.message)).toEqual(['second-failure', 'first-failure']);
    expect(entries[0].level).toBe('ERROR');
    expect(entries[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('多行消息（堆栈）算一条：续行归上一条，不拆成多条错误', () => {
    logger.error('boom\n  at a.b.C(D.java:1)\n  at d.e.F(G.java:2)');

    const { entries } = readErrorLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('boom\n  at a.b.C(D.java:1)\n  at d.e.F(G.java:2)');
  });

  it('info/warn 不入档：读取面只反映 error 分流的那一份', () => {
    logger.warn('warn-not-persisted');
    logger.info('info-not-persisted');
    expect(readErrorLog().entries).toEqual([]);
  });

  it('轮转档按新→旧接续：error.log 的条目排在 error.log.1 之前', () => {
    fs.writeFileSync(
      path.join(dir, 'error.log.1'),
      '[2026-01-01T00:00:00.000Z] [ERROR] older-rotated\n',
      'utf-8',
    );
    logger.error('newest');

    const { entries, hasMore } = readErrorLog();
    expect(entries.map((e) => e.message)).toEqual(['newest', 'older-rotated']);
    expect(hasMore).toBe(false);
  });

  it('limit 生效且 hasMore=true（还有更早的没返回）', () => {
    logger.error('one');
    logger.error('two');
    logger.error('three');

    const { entries, hasMore } = readErrorLog({ limit: 2 });
    expect(entries.map((e) => e.message)).toEqual(['three', 'two']);
    expect(hasMore).toBe(true);
  });

  it('尾部截断读取：丢掉半截首行，不产生残缺条目', () => {
    // 单档读取上限 256KB：先写一条超长条目把窗口顶满，再写一条正常条目
    logger.error('x'.repeat(300 * 1024));
    logger.error('after-big');

    const { entries, hasMore, available } = readErrorLog();
    expect(available).toBe(true);
    expect(hasMore).toBe(true); // 本档更早的内容没进来
    expect(entries[0].message).toBe('after-big');
    // 被截断的超长条目只剩尾巴，且其行首时间戳已丢 ⇒ 不应被当成独立条目
    for (const e of entries) expect(e.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('尾部窗口恰好落在行首：首个完整条目不能被丢（丢了就是静默少一条错误）', () => {
    const tailBytes = 256 * 1024;
    const marker = '[2026-01-03T00:00:00.000Z] [ERROR] boundary-entry\n';
    const padPrefix = '[2026-01-02T00:00:00.000Z] [ERROR] ';
    const padLen = tailBytes - marker.length - padPrefix.length - 1;
    const rest = `${padPrefix}${'f'.repeat(padLen)}\n${marker}`;
    // 自证：尾部那段的字节数正好等于读取上限 ⇒ 窗口起点恰好落在 pad 那一行的行首
    expect(rest.length).toBe(tailBytes);
    fs.writeFileSync(
      path.join(dir, 'error.log'),
      `[2026-01-01T00:00:00.000Z] [ERROR] outside-window\n${rest}`,
      'utf-8',
    );

    const { entries, hasMore } = readErrorLog({ limit: 5 });

    expect(hasMore).toBe(true);
    // 窗口首行是完整条目 ⇒ 两条都要在（若被当成残块丢掉，就只剩 boundary-entry）
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('boundary-entry');
    expect(entries[1].message.startsWith('f'.repeat(10))).toBe(true);
  });

  it('超长单条按上限截断并标记（不静默丢内容）', () => {
    logger.error('y'.repeat(5000));

    const { entries } = readErrorLog();
    expect(entries[0].message.endsWith('…[已截断]')).toBe(true);
    expect(entries[0].message.length).toBe(4096 + '…[已截断]'.length);
  });

  it('日志目录不可读时不抛错（读取面不能把面板拖下去）', () => {
    const blocked = path.join(dir, 'blocked-read');
    fs.writeFileSync(blocked, 'not-a-dir');
    __configureLogger({ dir: blocked });

    let result;
    expect(() => {
      result = readErrorLog();
    }).not.toThrow();
    expect(result.available).toBe(false);
  });
});
