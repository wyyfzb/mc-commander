/**
 * 网络暴露收口测试
 * ① rcon.port 按实例配置派生（消除硬编码 25575）
 * ② HOST 环境变量可配（默认 127.0.0.1）
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── ① rcon.port 派生 ──

describe('rcon.port 与 server-port 的分配', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/server-jar.js'), 'utf-8');

  it('硬编码 rcon.port=25575 已消除', () => {
    expect(src).not.toMatch(/\brcon\.port=25575\b/);
  });

  it('两个端口都取自分配器，不再按 instanceId 哈希抽签', () => {
    // 哈希取模会撞车：100 个槽位里第 101 个实例必然与别人同端口
    expect(src).not.toMatch(/parseInt\(instanceId\.slice\(-4\), 16\)/);
    expect(src).toMatch(/server-port=\$\{gamePort\}/);
    expect(src).toMatch(/rcon\.port=\$\{rconPortFor\(gamePort\)\}/);
  });

  it('写入 properties 的端口与写入 DB 的端口同源', () => {
    // 两处各算一次会出现「实例跑在 A 端口、面板显示 B 端口」
    expect(src).toMatch(/generateServerProperties\(instanceId, mcVersion, gamePort\)/);
    expect(src).toMatch(/port: gamePort/);
  });
});

// ── ② HOST 可配 ──

describe('HOST 环境变量可配', () => {
  it('config.js 导出 host 字段', async () => {
    const config = (await import('../src/config.js')).default;
    expect(typeof config.host).toBe('string');
    expect(config.host.length).toBeGreaterThan(0);
  });

  it('.env.example 包含 HOST=127.0.0.1', () => {
    const envExample = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf-8');
    expect(envExample).toMatch(/HOST=127\.0\.0\.1/);
  });

  it('index.js 监听地址使用 config.host 而非硬编码', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf-8');
    expect(src).toMatch(/server\.listen\(config\.port,\s*config\.host/);
  });
});
