import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import config from '../config.js';
import { logger, __configureLogger, __resetLogger, __loggerState } from '../utils/logger.js';

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
