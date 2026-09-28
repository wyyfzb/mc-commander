/**
 * latest.log 日志缓冲回填测试
 * - 面板（重）启动时从 vanilla 权威日志恢复当次运行日志（尾部至多 1000 行）
 * - start() 清空语义不受影响：新一次运行从空缓冲开始
 * 数据全部为虚构占位（Steve/TEST-NET 风格地址）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-log-restore-test-'));
  return {
    default: {
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'info',
      rateLimit: { windowMs: 60000, max: 100 },
      crashLoop: { windowMs: 300000, maxCrashes: 5 },
    },
  };
});

import { MCServerInstance } from '../services/mc_server.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-log-restore-fixture-'));

/** 固定于临时根目录下的夹具实例目录（边界校验防路径越出临时根） */
function makeInstance(name, latestLines) {
  const serverPath = path.resolve(tmpBase, name);
  if (!serverPath.startsWith(tmpBase + path.sep)) throw new Error('fixture path escape');
  fs.mkdirSync(path.join(serverPath, 'logs'), { recursive: true });
  if (latestLines) {
    fs.writeFileSync(path.join(serverPath, 'logs', 'latest.log'), latestLines.join('\n') + '\n');
  }
  return new MCServerInstance({
    id: name,
    name,
    javaPath: 'java',
    jarFile: 'server.jar',
    serverPath,
  });
}

beforeAll(() => {
  // 短路 constructor 的公网 IP 异步探测（避免测试触网）
  vi.stubEnv('PUBLIC_IP', '203.0.113.1');
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('latest.log 回填（面板启动恢复当次运行日志）', () => {
  it('latest.log 存在 → logBuffer 注入全部行（type stdout）', () => {
    const inst = makeInstance('restore-all', [
      '[19:35:19] [Server thread/INFO]: Starting minecraft server version 26.2',
      '[19:35:24] [Server thread/INFO]: Done (0.534s)! For help, type "help"',
      '[19:36:00] [Server thread/INFO]: Steve joined the game',
    ]);
    expect(inst.logBuffer).toHaveLength(3);
    expect(inst.logBuffer[0].text).toContain('Starting minecraft server version');
    expect(inst.logBuffer[2].text).toContain('Steve joined the game');
    expect(inst.logBuffer.every((e) => e.type === 'stdout')).toBe(true);
  });

  it('超过 1000 行 → 只保留尾部 1000 行（与 logBuffer 滚动上限一致）', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `[line-${i + 1}] filler`);
    const inst = makeInstance('restore-trim', lines);
    expect(inst.logBuffer).toHaveLength(1000);
    expect(inst.logBuffer[0].text).toBe('[line-201] filler');
    expect(inst.logBuffer[inst.logBuffer.length - 1].text).toBe('[line-1200] filler');
  });

  it('无 latest.log → 缓冲为空', () => {
    const inst = makeInstance('restore-none', null);
    expect(inst.logBuffer).toHaveLength(0);
  });

  it('噪音行（RCON 线程/监听器）回填时被过滤——与实时推送口径一致', () => {
    const inst = makeInstance('restore-noise', [
      '[19:35:19] [Server thread/INFO]: Done (0.534s)! For help, type "help"',
      '[19:35:20] [RCON Listener #1/INFO]: RCON running on 0.0.0.0:25575',
      '[19:35:21] [RCON Client /127.0.0.1 #2/INFO]: Thread RCON Client started',
      '[19:35:22] [Server thread/INFO]: Steve joined the game',
    ]);
    expect(inst.logBuffer).toHaveLength(2);
    expect(inst.logBuffer[0].text).toContain('Done (0.534s)');
    expect(inst.logBuffer[1].text).toContain('Steve joined the game');
  });
});
