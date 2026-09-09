/**
 * 接管实例日志续读域测试（UXT-15 后续）
 * - 首次轮询只记文件末尾位置：构造期已回填当次运行日志，不重复摄取
 * - 追加内容逐轮摄取（行边界完整才推送）
 * - 文件重写/轮转（长度回退）→ 从头读
 * - 不完整行与多字节字符跨块：余段留待下轮拼接，不拆行、不产生乱码
 * - 接管结束/实例停止 → 自清理定时器
 * 数据全部为虚构占位。
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-logtail-test-'));
  return {
    default: {
      apiKey: '',
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'info',
      rateLimit: { windowMs: 60000, max: 100 },
      autoStartDelayMs: 2000,
      crashLoop: { windowMs: 300000, maxCrashes: 5 },
    },
  };
});

import { MCServerInstance } from '../services/mc_server.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-logtail-fixture-'));

function makeInstance(name) {
  const serverPath = path.join(tmpBase, name);
  fs.mkdirSync(path.join(serverPath, 'logs'), { recursive: true });
  // 裸原型实例（同 adopt.test 模式）：验证原型注入后的 this 绑定
  const inst = Object.create(MCServerInstance.prototype);
  inst.id = name;
  inst.serverPath = serverPath;
  inst.isRunning = true;
  inst.adopted = true;
  inst._logTailTimer = null;
  inst._logTailState = null;
  // 聚焦续读边界：摄取链路由 _ingestLogText 的既有行为覆盖
  inst._ingestLogText = vi.fn();
  return inst;
}

function logPath(inst) {
  return path.join(inst.serverPath, 'logs', 'latest.log');
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('接管实例日志续读', () => {
  it('首次轮询只记位置（不重复构造期回填），追加内容逐轮摄取', () => {
    const inst = makeInstance('tail-basic');
    fs.writeFileSync(logPath(inst), 'line-1\nline-2\n');
    inst._startAdoptedLogTail();

    inst._pollAdoptedLogTail(); // 首次：记录末尾位置
    expect(inst._ingestLogText).not.toHaveBeenCalled();

    fs.appendFileSync(logPath(inst), 'line-3\nline-4\n');
    inst._pollAdoptedLogTail();
    expect(inst._ingestLogText).toHaveBeenCalledTimes(1);
    expect(inst._ingestLogText).toHaveBeenCalledWith('line-3\nline-4\n', 'stdout');

    // 无新增：不重复摄取
    inst._pollAdoptedLogTail();
    expect(inst._ingestLogText).toHaveBeenCalledTimes(1);
    inst._stopAdoptedLogTail();
  });

  it('文件重写（长度回退）→ 从头读新内容', () => {
    const inst = makeInstance('tail-rewrite');
    fs.writeFileSync(logPath(inst), 'old-line-1\nold-line-2\n');
    inst._startAdoptedLogTail();
    inst._pollAdoptedLogTail();

    // vanilla 每次启动重写 latest.log：新内容更短 → 长度回退触发重置
    fs.writeFileSync(logPath(inst), 'new\n');
    inst._pollAdoptedLogTail();
    expect(inst._ingestLogText).toHaveBeenCalledWith('new\n', 'stdout');
    inst._stopAdoptedLogTail();
  });

  it('末尾不完整行留待下轮拼接（不拆行）', () => {
    const inst = makeInstance('tail-partial');
    fs.writeFileSync(logPath(inst), 'head\n');
    inst._startAdoptedLogTail();
    inst._pollAdoptedLogTail();

    fs.appendFileSync(logPath(inst), 'partial-line'); // 无换行结尾
    inst._pollAdoptedLogTail();
    expect(inst._ingestLogText).not.toHaveBeenCalled();

    fs.appendFileSync(logPath(inst), '-rest\n');
    inst._pollAdoptedLogTail();
    expect(inst._ingestLogText).toHaveBeenCalledTimes(1);
    expect(inst._ingestLogText).toHaveBeenCalledWith('partial-line-rest\n', 'stdout');
    inst._stopAdoptedLogTail();
  });

  it('多字节字符跨读取块不产生乱码（StringDecoder 保留半个字符）', () => {
    const inst = makeInstance('tail-multibyte');
    fs.writeFileSync(logPath(inst), 'head\n');
    inst._startAdoptedLogTail();
    inst._pollAdoptedLogTail();

    const zh = Buffer.from('中文行\n', 'utf8');
    // 写入「中」的前 2 字节：不构成完整字符
    fs.appendFileSync(logPath(inst), zh.subarray(0, 2));
    inst._pollAdoptedLogTail();
    expect(inst._ingestLogText).not.toHaveBeenCalled();

    fs.appendFileSync(logPath(inst), zh.subarray(2));
    inst._pollAdoptedLogTail();
    expect(inst._ingestLogText).toHaveBeenCalledTimes(1);
    expect(inst._ingestLogText).toHaveBeenCalledWith('中文行\n', 'stdout');
    inst._stopAdoptedLogTail();
  });

  it('接管结束/实例停止 → 自清理定时器', () => {
    const inst = makeInstance('tail-selfstop');
    fs.writeFileSync(logPath(inst), 'x\n');
    inst._startAdoptedLogTail();
    expect(inst._logTailTimer).not.toBeNull();

    inst.adopted = false;
    inst._pollAdoptedLogTail();
    expect(inst._logTailTimer).toBeNull();
    expect(inst._logTailState).toBeNull();
  });

  it('日志文件不存在时不抛（下轮再试）', () => {
    const inst = makeInstance('tail-missing');
    inst._startAdoptedLogTail();
    expect(() => inst._pollAdoptedLogTail()).not.toThrow();
    expect(inst._ingestLogText).not.toHaveBeenCalled();
    inst._stopAdoptedLogTail();
  });
});
