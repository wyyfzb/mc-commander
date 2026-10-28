import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

/**
 * 面板收到 SIGTERM 后必须自己退干净。
 *
 * wss.close() 要等全部客户端断开才回调，而浏览器那一页正在等面板退出：
 * 两边互等就是永久挂起——实测面板停在 SIGTERM 之后 85 秒才退出，直到标签页被关掉。
 * 这里起真进程 + 真 WS 连接复现，断言「有客户端连着时也能按时退出」。
 */
const SERVER = path.resolve(import.meta.dirname, '../src/index.js');

let child;

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = undefined;
});

/** 起一个真面板进程：端口与数据目录都指向临时位置，不碰本机那份 */
function startPanel(dir, port) {
  child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: path.join(dir, 'data'),
      API_KEY_HASH: 'a'.repeat(64),
      MC_COMMANDER_DIR: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

/** 等端口可连：日志里出现监听行不代表 socket 已可 accept */
async function waitListening(port, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

describe('停机退出', () => {
  it('有 WS 客户端连着时，SIGTERM 后仍能在 5 秒内退出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-shutdown-'));
    const port = 25900 + Math.floor(Math.random() * 80);
    try {
      const proc = startPanel(dir, port);
      const listening = await waitListening(port);
      expect(listening, '面板没起来，本用例无法验证停机行为').toBe(true);

      // 保持一条连接不断开：这正是「用户开着标签页」的形态
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
      const sentAt = Date.now();
      proc.kill('SIGTERM');
      const code = await Promise.race([
        exited,
        new Promise((r) => setTimeout(() => r('TIMEOUT'), 5000)),
      ]);
      expect(code, '面板在客户端仍连着时没有退出，停机卡在 wss.close 上').not.toBe('TIMEOUT');
      expect(Date.now() - sentAt).toBeLessThan(5000);
      ws.terminate();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

/* 备份中途退出会把世界留在危险状态：save-off 已发、save-on 还没发，服务端从此
   不再自动保存，而面板已经没了。停机必须等这一种收尾，其余不等但要如实告知。 */
describe('停机时对在途备份的有界等待', () => {
  it('inFlightBackupOps 导出且无操作时返回空表', async () => {
    const { inFlightBackupOps } = await import('../src/services/backup.service.js');
    expect(typeof inFlightBackupOps).toBe('function');
    expect(inFlightBackupOps()).toEqual([]);
  });

  it('停机逻辑先查在途备份，再关调度器', () => {
    // 顺序承重：调度器一停，正在跑的备份不会被再排期，但已经跑着的仍要等。
    // 先停调度器再查在途会让「刚被取消的备份」漏出等待窗口。
    const src = fs.readFileSync(SERVER, 'utf8');
    const shutdownAt = src.indexOf('async function shutdown(signal)');
    const body = src.slice(shutdownAt, src.indexOf('wss.close(', shutdownAt));
    // 判据必须落在「决定要不要等」的那一处：等待循环的条件里真的调用它。
    // 只锁 `const pending = ...` 不够——后面还有两处调用，改成 [] 后仍会匹配到别处
    expect(body).toMatch(/while\s*\(\s*inFlightBackupOps\(\)\.length\s*>\s*0/);
    expect(body).toMatch(/const\s+\w+\s*=\s*inFlightBackupOps\(\)/);
    // 位置必须都在 shutdown 函数体内比：indexOf 从 shutdownAt 起找，
    // 但 import 那行在函数之前，若写成全局 indexOf 会拿 import 的位置冒充调用点
    const checkAt = body.indexOf('inFlightBackupOps()');
    const stopAt = body.indexOf('taskScheduler.stop()');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(stopAt);
  });

  it('等待有上限（不超过 30 秒），且超时后如实说明后果', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    const shutdownAt = src.indexOf('async function shutdown(signal)');
    const body = src.slice(shutdownAt, src.indexOf('wss.close(', shutdownAt));
    // 无界等待会让崩溃后的自动重启被无限拖住
    expect(body).toMatch(/30_000/);
    // 超时也要留证据：用户下次发现「服务器不自动保存」时得有据可查
    expect(body).toContain('save-off');
    expect(body).toContain('重启服务器即可恢复');
  });
});
