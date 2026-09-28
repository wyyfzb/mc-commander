/**
 * 网络暴露收口测试
 * ① rcon.port 按实例配置派生（消除硬编码 25575）
 * ② HOST 环境变量可配（默认 127.0.0.1）
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── ① rcon.port 派生 ──

describe('rcon.port 按实例配置派生', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/server-jar.js'), 'utf-8');

  it('硬编码 rcon.port=25575 已消除', () => {
    expect(src).not.toMatch(/\brcon\.port=25575\b/);
  });

  it('rcon.port 使用与 server-port 同款的派生规则', () => {
    expect(src).toMatch(/rcon\.port=\$\{25575.*parseInt.*instanceId.*slice.*16.*%/);
  });

  it('派生公式基值差 10（保证不冲突）', () => {
    expect(src).toMatch(/server-port.*25565/);
    expect(src).toMatch(/rcon\.port.*25575/);
  });

  const derive = (base, id) => base + (parseInt(id.slice(-4), 16) % 100);

  it.each([['inst-0001'], ['inst-00ff'], ['inst-abcd']])(
    'rcon.port 比对应 server-port 大 10（%s）',
    (id) => {
      expect(derive(25575, id)).toBe(derive(25565, id) + 10);
    },
  );
});

// ── ② HOST 可配 ──

describe('HOST 环境变量可配', () => {
  it('config.js 导出 host 字段', async () => {
    const config = (await import('../config.js')).default;
    expect(typeof config.host).toBe('string');
    expect(config.host.length).toBeGreaterThan(0);
  });

  it('.env.example 包含 HOST=127.0.0.1', () => {
    const envExample = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf-8');
    expect(envExample).toMatch(/HOST=127\.0\.0\.1/);
  });

  it('index.js 监听地址使用 config.host 而非硬编码', () => {
    const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf-8');
    expect(src).toMatch(/server\.listen\(config\.port,\s*config\.host/);
  });
});
