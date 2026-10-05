/**
 * MSMP 客户端域测试。
 *
 * 对端用本仓既有的 `ws` 起一个**真实** WebSocket 服务端（不是 mock）：客户端要处理的
 * 恰恰是握手、401、错误响应、超时这些线上行为，把它们 mock 掉等于把被测对象一起换了。
 * 数据全部为虚构占位（Steve/Alex、TEST-NET 网段）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';

vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-msmp-test-'));
  return {
    default: {
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'error',
      rateLimit: { windowMs: 60000, max: 100 },
      autoStartDelayMs: 2000,
      crashLoop: { windowMs: 300000, maxCrashes: 5 },
    },
  };
});

import { MCServerInstance } from '../services/mc_server.js';
import { _msmpRequest } from '../services/mc-server/msmp-client.js';

const SECRET = 'A'.repeat(40);

/** 裸原型实例：验证 Object.assign 挂载后的 this 绑定，不经 constructor 副作用 */
function makeInstance(overrides = {}) {
  const inst = Object.create(MCServerInstance.prototype);
  inst.id = 'msmp-test';
  inst.isRunning = true;
  inst.logBuffer = [];
  inst.properties = {
    'management-server-enabled': 'true',
    'management-server-host': '127.0.0.1',
    'management-server-port': '0',
    'management-server-secret': SECRET,
    'management-server-tls-enabled': 'false',
    ...overrides,
  };
  return inst;
}

/** 起一个真实 MSMP 服务端桩；onMessage 自行决定如何回应 */
async function startStub(onMessage, { requireAuth = true } = {}) {
  const seen = { auth: null };
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info, cb) => {
      if (!requireAuth || info.req.headers.authorization === `Bearer ${SECRET}`) return cb(true);
      // 认证失败必须是 HTTP 401（协议如此），不是 WS close
      cb(false, 401, 'Unauthorized');
    },
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket, req) => {
    seen.auth = req.headers.authorization;
    socket.on('message', (data) => onMessage(JSON.parse(data.toString()), socket));
  });
  return {
    port: wss.address().port,
    seen,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

/** 把桩端口写进 properties，返回实例 */
function instFor(port) {
  return makeInstance({ 'management-server-port': String(port) });
}

describe('_msmpResolveEndpoint 端点解析', () => {
  it('未开启 MSMP → null（不产生任何网络开销）', () => {
    const inst = makeInstance({ 'management-server-enabled': 'false' });
    expect(inst._msmpResolveEndpoint()).toBeNull();
  });

  it('缺密钥 → null（无凭据连不上，早退省一次握手）', () => {
    expect(makeInstance({ 'management-server-secret': '' })._msmpResolveEndpoint()).toBeNull();
  });

  it('固定端口 → 直接给出端点', () => {
    const inst = makeInstance({ 'management-server-port': '25585' });
    expect(inst._msmpResolveEndpoint()).toMatchObject({ port: 25585, tls: false });
  });

  it('tls-enabled=true → 端点标 tls（决定 ws/wss）', () => {
    const inst = makeInstance({
      'management-server-port': '25585',
      'management-server-tls-enabled': 'true',
    });
    expect(inst._msmpResolveEndpoint()).toMatchObject({ tls: true });
  });

  it('port=0（默认随机）+ 日志里有播报行 → 取实际端口', () => {
    const inst = makeInstance();
    inst.logBuffer = [
      { text: '[01:12:41] [Server thread/INFO]: Starting json RPC server on localhost:25585' },
    ];
    expect(inst._msmpResolveEndpoint()).toMatchObject({ port: 25585 });
  });

  it('port=0 且日志里没有播报行 → null（随机端口无从预知）', () => {
    expect(makeInstance()._msmpResolveEndpoint()).toBeNull();
  });
});

describe('_msmpPortFromLog 端口播报行', () => {
  it('认两种播报行，且取最后一条（重启后端口可能变）', () => {
    const inst = makeInstance();
    inst.logBuffer = [
      { text: 'Starting json RPC server on localhost:11111' },
      { text: 'Json-RPC Management connection listening on localhost:22222' },
    ];
    expect(inst._msmpPortFromLog()).toBe(22222);
  });

  it('绑到 0.0.0.0 同样能取到端口', () => {
    const inst = makeInstance();
    inst.logBuffer = [{ text: 'Starting json RPC server on 0.0.0.0:8080' }];
    expect(inst._msmpPortFromLog()).toBe(8080);
  });

  it('无播报行 → null', () => {
    const inst = makeInstance();
    inst.logBuffer = [
      { text: '[01:00:00] [Server thread/INFO]: Done (10.3s)! For help, type "help"' },
    ];
    expect(inst._msmpPortFromLog()).toBeNull();
  });
});

describe('_msmpRequest JSON-RPC 往返', () => {
  let stub;
  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  it('请求带 Bearer 认证头，返回 result 的裸值', async () => {
    let seenBody = null;
    stub = await startStub((msg, socket) => {
      seenBody = msg;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'Steve' }] }));
    });
    const result = await instFor(stub.port)._msmpRequest('minecraft:players', []);
    expect(result).toEqual([{ name: 'Steve' }]);
    // 认证头是唯一可用的认证路径（subprotocol 路径受 origin 白名单门控，默认即关闭）
    expect(stub.seen.auth).toBe(`Bearer ${SECRET}`);
    expect(seenBody).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'minecraft:players',
      params: [],
    });
  });

  it('错误响应 → null（不把错误对象当数据）', async () => {
    stub = await startStub((msg, socket) => {
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        }),
      );
    });
    expect(await instFor(stub.port)._msmpRequest('minecraft:nope', [])).toBeNull();
  });

  it('认证失败（HTTP 401）→ null', async () => {
    stub = await startStub(() => {}, { requireAuth: true });
    const inst = makeInstance({
      'management-server-port': String(stub.port),
      'management-server-secret': 'WRONG'.repeat(8),
    });
    expect(await inst._msmpRequest('minecraft:players', [])).toBeNull();
  });

  it('服务端只发通知（无 id）→ 超时归 null，不误当响应', async () => {
    stub = await startStub((_msg, socket) => {
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'minecraft:notification/players/joined',
          params: [{ name: 'Alex' }],
        }),
      );
    });
    expect(await instFor(stub.port)._msmpRequest('minecraft:players', [], 300)).toBeNull();
  });

  it('服务端不回 → 超时归 null', async () => {
    stub = await startStub(() => {});
    expect(await instFor(stub.port)._msmpRequest('minecraft:players', [], 300)).toBeNull();
  });

  it('返回非法 JSON → null（不抛给调用方）', async () => {
    stub = await startStub((_msg, socket) => socket.send('{ not json'));
    expect(await instFor(stub.port)._msmpRequest('minecraft:players', [], 800)).toBeNull();
  });

  it('未开启 MSMP → 直接 null，不建连接', async () => {
    const inst = makeInstance({ 'management-server-enabled': 'false' });
    expect(await inst._msmpRequest('minecraft:players', [])).toBeNull();
  });

  it('未开启 MSMP 时即使端口可解析也不建连接（早退判据是开关，不是端口）', async () => {
    // 端口指向真实桩：若早退失效，这里会真的连上，seen.auth 即被赋值
    stub = await startStub(() => {});
    const inst = makeInstance({
      'management-server-enabled': 'false',
      'management-server-port': String(stub.port),
    });
    expect(await inst._msmpRequest('minecraft:players', [])).toBeNull();
    expect(stub.seen.auth).toBeNull();
  });
});

describe('_msmpFetchOnlinePlayers 名单解析', () => {
  let stub;
  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  const serve = (result) =>
    startStub((msg, socket) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });

  it('取 id+name，返回 {names}', async () => {
    stub = await serve([
      { id: '853c80ef-3c37-49fd-aa49-938b674adae6', name: 'Steve' },
      { id: '11111111-2222-3333-4444-555555555555', name: 'Alex' },
    ]);
    expect(await instFor(stub.port)._msmpFetchOnlinePlayers()).toEqual({
      names: ['Steve', 'Alex'],
    });
  });

  it('空名单 → {names: []}（是合法答案，不是「取不到」）', async () => {
    stub = await serve([]);
    expect(await instFor(stub.port)._msmpFetchOnlinePlayers()).toEqual({ names: [] });
  });

  it('返回值不是数组 → null（协议变了不能当成空名单，否则会清空界面名单）', async () => {
    stub = await serve({ players: ['Steve'] });
    expect(await instFor(stub.port)._msmpFetchOnlinePlayers()).toBeNull();
  });

  it('条目缺 name / name 为空 → 跳过该条，其余照常返回', async () => {
    stub = await serve([{ id: 'aaa' }, { name: '' }, null, { id: 'bbb', name: 'Alex' }]);
    expect(await instFor(stub.port)._msmpFetchOnlinePlayers()).toEqual({ names: ['Alex'] });
  });

  it('实例已停 → null，不建连接', async () => {
    const inst = makeInstance({ 'management-server-port': '1' });
    inst.isRunning = false;
    expect(await inst._msmpFetchOnlinePlayers()).toBeNull();
  });
});

describe('toStatus 的能力字段', () => {
  /** 全量构造（走 constructor 初始化，保证 _msmpAvailable 等状态真实存在） */
  const build = (over = {}) =>
    new MCServerInstance({
      id: 'msmp-cap',
      name: 'Test',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '1G',
      minMemory: '512M',
      serverPath: `/tmp/test-msmp-cap-${Date.now()}`,
      ...over,
    });

  it('capabilities 并列报两条通道，初值 msmp=false（尚未实测到）', () => {
    const status = build().toStatus();
    expect(status.capabilities).toEqual({ rcon: expect.any(Boolean), msmp: false });
  });

  it('实例已停 → msmp 报 false（上一次运行的残留实测值不得外泄为当前状态）', () => {
    const inst = build();
    inst.isRunning = false;
    inst._msmpAvailable = true; // 上一次运行实测到过
    expect(inst.toStatus().capabilities.msmp).toBe(false);
  });

  it('运行中且实测到 MSMP → msmp 报 true', () => {
    const inst = build();
    inst.isRunning = true;
    inst._msmpAvailable = true;
    expect(inst.toStatus().capabilities.msmp).toBe(true);
  });
});
