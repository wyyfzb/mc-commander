import { describe, it, expect } from 'vitest';
import {
  PANEL_PORT,
  GAME_PORT_START,
  GAME_PORT_COUNT,
  RCON_PORT_START,
  allocateGamePort,
  rconPortFor,
  isPortFreeInRange,
  probeBindable,
} from '../src/services/port-allocator.js';

describe('实例端口分配', () => {
  it('game 段不包含面板端口', () => {
    const end = GAME_PORT_START + GAME_PORT_COUNT - 1;
    expect(GAME_PORT_START).toBeGreaterThan(PANEL_PORT);
    expect(GAME_PORT_START > PANEL_PORT).toBe(true);
    expect(end >= PANEL_PORT).toBe(true);
    // 段本身必须整体在面板端口之上
    expect(GAME_PORT_START).toBe(25567);
    expect(end).toBe(25666);
  });

  it('rcon 段与 game 段不重叠', () => {
    const gameEnd = GAME_PORT_START + GAME_PORT_COUNT - 1;
    expect(RCON_PORT_START).toBeGreaterThan(gameEnd);
    expect(rconPortFor(GAME_PORT_START)).toBe(RCON_PORT_START);
    expect(rconPortFor(gameEnd)).toBe(RCON_PORT_START + GAME_PORT_COUNT - 1);
  });

  it('空列表分配第一个端口', () => {
    expect(allocateGamePort([], 'abc')).toBe(GAME_PORT_START);
  });

  it('跳过已被占用的端口，取最小空闲值', () => {
    const list = [
      { id: 'a', port: 25567 },
      { id: 'b', port: 25568 },
    ];
    expect(allocateGamePort(list, 'c')).toBe(25569);
  });

  it('空洞优先于尾部追加（删掉中间实例后新实例补位）', () => {
    const list = [
      { id: 'a', port: 25567 },
      { id: 'b', port: 25569 },
    ];
    expect(allocateGamePort(list, 'c')).toBe(25568);
  });

  it('已存在的实例沿用原端口（换端口等于换地址，玩家收藏会失效）', () => {
    const list = [
      { id: 'a', port: 25567 },
      { id: 'b', port: 25570 },
    ];
    expect(allocateGamePort(list, 'b')).toBe(25570);
  });

  it('段内端口用尽时返回 null，由调用方报错', () => {
    const list = Array.from({ length: GAME_PORT_COUNT }, (_, i) => ({
      id: `i${i}`,
      port: GAME_PORT_START + i,
    }));
    expect(allocateGamePort(list, 'new')).toBeNull();
  });

  it('历史实例的低位端口（旧版 25565 起）不参与占用判定', () => {
    // 旧版按 hash 派生 25565~25664，其中 25565/25566 落在面板段与段外
    const list = [
      { id: 'old1', port: 25565 },
      { id: 'old2', port: 25566 },
    ];
    expect(allocateGamePort(list, 'new')).toBe(GAME_PORT_START);
  });

  it('isPortFreeInRange 忽略自身', () => {
    const list = [
      { id: 'a', port: 25567 },
      { id: 'b', port: 25568 },
    ];
    expect(isPortFreeInRange(list, 25567, 'a')).toBe(true);
    expect(isPortFreeInRange(list, 25567, 'b')).toBe(false);
  });

  it('probeBindable 对已占用端口返回 false、空闲端口返回 true', async () => {
    const net = await import('node:net');
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
    const busyPort = blocker.address().port;
    expect(await probeBindable(busyPort)).toBe(false);
    await new Promise((r) => blocker.close(r));
    expect(await probeBindable(busyPort)).toBe(true);
  });
});
