import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import {
  checkInstanceReachability,
  isListeningLocally,
  BLOCKED,
  NOT_LISTENING,
  NO_PUBLIC_ADDRESS,
} from '../src/services/port-reachability.js';

const servers = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => (s.listening ? s.close(r) : r()))),
  );
});

/** 起一个只绑 127.0.0.1 的监听：模拟「本机在听、但外部不可达」 */
async function listenLocal() {
  const srv = net.createServer();
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}

describe('实例端口可达性', () => {
  it('没有公网地址时不说「已可达」（面板自己都不知道对外入口）', async () => {
    const r = await checkInstanceReachability({ port: 25567, publicHost: null });
    expect(r.state).toBe(NO_PUBLIC_ADDRESS);
  });

  it('内网地址同样归为「没有公网地址」', async () => {
    for (const host of ['192.168.1.10', '10.0.0.5', '172.16.0.5', 'localhost', '127.0.0.1']) {
      const r = await checkInstanceReachability({ port: 25567, publicHost: host });
      expect(r.state).toBe(NO_PUBLIC_ADDRESS);
    }
  });

  it('本地没监听时报「未运行」，不误报成端口没放行', async () => {
    // 关掉监听后探一个没人用的高位端口
    const r = await checkInstanceReachability({ port: 25999, publicHost: '1.2.3.4' });
    expect(r.state).toBe(NOT_LISTENING);
  });

  it('本地在听但公网连不上时报「被拦」（这才是安全组）', async () => {
    const port = await listenLocal();
    // 1.2.3.4 是文档示例地址，必然连不上；本地该端口在听
    const r = await checkInstanceReachability({ port, publicHost: '1.2.3.4' });
    expect(r.state).toBe(BLOCKED);
    expect(r.detail).toContain('本地已在监听');
  });

  it('监听 0.0.0.0 的端口能被本机探到在听', async () => {
    const srv = net.createServer();
    servers.push(srv);
    await new Promise((r) => srv.listen(0, '0.0.0.0', r));
    const p = srv.address().port;
    expect(await isListeningLocally(p)).toBe(true);
  });

  it('端口号非法时不抛异常', async () => {
    for (const port of [0, -1, null, undefined, 'abc']) {
      const r = await checkInstanceReachability({ port, publicHost: '1.2.3.4' });
      expect(r.state).toBe(NOT_LISTENING);
    }
  });

  it('探测失败不抛异常（不能因一个端口探测拖垮请求）', async () => {
    await expect(
      checkInstanceReachability({ port: 25998, publicHost: '203.0.113.99' }),
    ).resolves.toBeTruthy();
  });
});
