/**
 * 推送通道（MSMP）开关。
 *
 * 承重点：**三项必须一起写**。实测（MC 26.3）只写 `enabled=true` 而 TLS 保持默认 true
 * 会让服务器**再也起不来**（`TLS is enabled but keystore is not configured`），
 * secret 非 40 位字母数字同样直接崩。故这一层的价值不在"写对键名"，而在
 * **写出的组合是不是自洽的**——本文件的断言都围绕组合。
 *
 * 另一条承重：`host` / `allowed-origins` **不写**。前者是主要防护面（MC 默认 localhost
 * 即仅 loopback），后者实测不拦截任意 Origin，写了反而像有防护。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../services/instance-properties.service.js', async (orig) => {
  const actual = await orig();
  return { ...actual, reloadProperties: vi.fn() };
});

const { generateMsmpSecret, isValidMsmpSecret, readPushChannelState, setPushChannel } =
  await import('../services/msmp.service.js');

/** 最小实例替身：properties 是读写的唯一事实源，saveProperties 是唯一的落盘口 */
function makeInstance(props = {}, { isRunning = false } = {}) {
  const instance = {
    id: 'i1',
    serverPath: '/tmp/does-not-matter',
    isRunning,
    properties: { ...props },
    saveProperties: vi.fn(function (updates) {
      this.properties = { ...this.properties, ...updates };
    }),
  };
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateMsmpSecret', () => {
  it('恰好 40 位、纯字母数字，且通过 isValidMsmpSecret', () => {
    for (let i = 0; i < 50; i++) {
      const s = generateMsmpSecret();
      expect(s).toHaveLength(40);
      expect(s).toMatch(/^[A-Za-z0-9]{40}$/);
      expect(isValidMsmpSecret(s)).toBe(true);
    }
  });

  it('每次生成都不同（凭据不能重复）', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateMsmpSecret()));
    expect(set.size).toBe(200);
  });

  it('拒绝采样：≥248 的字节被跳过，不作为字符消费（确定性断言，不靠统计）', () => {
    // 先写过一版「统计首位字符分布」的断言，阈值放到 1.35 倍——**变异探针显示它不承重**：
    // 去掉拒绝采样后比率只到约 1.21，照样全绿。统计断言要能分辨就得放大样本量，
    // 那是把确定性性质交给概率来守。改为直接钉住「拒绝」这一行为本身。
    const rejected = 250; // 250 % 62 === 2（'C'）；若被消费，输出首位会是 'C'
    const valid = Array.from({ length: 40 }, (_, i) => i); // 0..39 → 全部 <248
    const spy = vi.spyOn(crypto, 'randomBytes').mockImplementation((n) => {
      const out = Buffer.alloc(n);
      // 第一次调用先给一个应被拒绝的字节，其余给合法字节
      const source = [rejected, ...valid, ...valid];
      for (let i = 0; i < n; i++) out[i] = source[i % source.length];
      return out;
    });
    try {
      const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const secret = generateMsmpSecret();
      // 期望值＝合法字节 0..39 直接映射（被拒的 250 不参与）
      const expected = valid.map((b) => CHARSET[b % CHARSET.length]).join('');
      expect(secret).toBe(expected);
      // 被消费时的样子：250 % 62 === 2 → 首位 'C' 且整体右移一位。钉住这个分叉
      expect(secret[0]).toBe('A');
      expect(secret[0]).not.toBe(CHARSET[250 % CHARSET.length]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isValidMsmpSecret', () => {
  it.each([
    ['39 位', 'a'.repeat(39)],
    ['41 位', 'a'.repeat(41)],
    ['含连字符', 'a'.repeat(39) + '-'],
    ['含下划线', 'a'.repeat(39) + '_'],
    ['空串', ''],
    ['非字符串', 12345],
    ['null', null],
  ])('拒绝：%s', (_label, v) => {
    expect(isValidMsmpSecret(v)).toBe(false);
  });

  it('接受：40 位字母数字', () => {
    expect(isValidMsmpSecret('aB3'.repeat(13) + 'x')).toBe(true);
  });
});

describe('readPushChannelState', () => {
  it('键缺失时按 MC 的默认读：未启用、TLS 视为 true、host=localhost、port=0', () => {
    const state = readPushChannelState(makeInstance({}));
    expect(state).toEqual({
      enabled: false,
      tlsEnabled: true,
      host: 'localhost',
      port: 0,
      secretConfigured: false,
    });
  });

  it('读磁盘现值（enabled/port/host/secret 合法性）', () => {
    const state = readPushChannelState(
      makeInstance({
        'management-server-enabled': 'true',
        'management-server-tls-enabled': 'false',
        'management-server-host': '0.0.0.0',
        'management-server-port': '25585',
        'management-server-secret': 'a'.repeat(40),
      }),
    );
    expect(state).toEqual({
      enabled: true,
      tlsEnabled: false,
      host: '0.0.0.0',
      port: 25585,
      secretConfigured: true,
    });
  });

  it('secret 形态不合法时 secretConfigured 为 false（否则开启后会带着坏 secret 崩）', () => {
    expect(
      readPushChannelState(makeInstance({ 'management-server-secret': 'a'.repeat(39) }))
        .secretConfigured,
    ).toBe(false);
  });

  it('port 非数字时不抛出，回落 0', () => {
    expect(readPushChannelState(makeInstance({ 'management-server-port': 'abc' })).port).toBe(0);
  });
});

describe('setPushChannel：开启', () => {
  it('无 secret 时一次写三项（enabled + tls=false + 新 secret）', () => {
    const inst = makeInstance({});
    const r = setPushChannel(inst, true);

    expect(inst.saveProperties).toHaveBeenCalledTimes(1);
    const written = inst.saveProperties.mock.calls[0][0];
    expect(Object.keys(written).sort()).toEqual([
      'management-server-enabled',
      'management-server-secret',
      'management-server-tls-enabled',
    ]);
    expect(written['management-server-enabled']).toBe('true');
    expect(written['management-server-tls-enabled']).toBe('false');
    expect(isValidMsmpSecret(written['management-server-secret'])).toBe(true);
    expect(r).toEqual({ enabled: true, restartRequired: false, secretGenerated: true });
  });

  it('已有合法 secret 时复用（不轮换——轮换会打断用户已有的 MSMP 客户端）', () => {
    const existing = 'b'.repeat(40);
    const inst = makeInstance({ 'management-server-secret': existing });
    const r = setPushChannel(inst, true);

    expect(inst.saveProperties.mock.calls[0][0]['management-server-secret']).toBeUndefined();
    expect(inst.properties['management-server-secret']).toBe(existing);
    expect(r.secretGenerated).toBe(false);
  });

  it('已有坏 secret（39 位）时替换为合法值', () => {
    const inst = makeInstance({ 'management-server-secret': 'c'.repeat(39) });
    const r = setPushChannel(inst, true);

    const written = inst.saveProperties.mock.calls[0][0];
    expect(isValidMsmpSecret(written['management-server-secret'])).toBe(true);
    expect(r.secretGenerated).toBe(true);
  });

  it('用户已配好 keystore 且显式开了 TLS 时，尊重其配置不动 TLS', () => {
    // 「TLS 开 + keystore 空」才是必崩组合；keystore 有值时用户是有意为之
    const inst = makeInstance({
      'management-server-tls-enabled': 'true',
      'management-server-tls-keystore': '/etc/keystore.p12',
    });
    setPushChannel(inst, true);

    expect(inst.saveProperties.mock.calls[0][0]['management-server-tls-enabled']).toBeUndefined();
    expect(inst.properties['management-server-tls-enabled']).toBe('true');
  });

  it('TLS 开着但 keystore 为空时，强制关 TLS（必崩组合）', () => {
    const inst = makeInstance({
      'management-server-tls-enabled': 'true',
      'management-server-tls-keystore': '',
    });
    setPushChannel(inst, true);
    expect(inst.saveProperties.mock.calls[0][0]['management-server-tls-enabled']).toBe('false');
  });

  it('绝不写 host / allowed-origins（前者是主要防护面，后者实测无效会误导）', () => {
    const inst = makeInstance({ 'management-server-host': '0.0.0.0' });
    setPushChannel(inst, true);

    const written = inst.saveProperties.mock.calls[0][0];
    expect(written).not.toHaveProperty('management-server-host');
    expect(written).not.toHaveProperty('management-server-allowed-origins');
    // 用户自己设的 0.0.0.0 保持不动（不在未授权时替用户改暴露面）
    expect(inst.properties['management-server-host']).toBe('0.0.0.0');
  });

  it('服务器运行中 ⇒ restartRequired=true（MSMP 只在启动时读）', () => {
    expect(setPushChannel(makeInstance({}, { isRunning: true }), true).restartRequired).toBe(true);
  });
});

describe('setPushChannel：关闭', () => {
  it('只写 enabled=false，保留 tls/secret（惰性，且能让用户日后手开也不踩 TLS 坑）', () => {
    const inst = makeInstance({
      'management-server-enabled': 'true',
      'management-server-tls-enabled': 'false',
      'management-server-secret': 'd'.repeat(40),
    });
    const r = setPushChannel(inst, false);

    expect(inst.saveProperties).toHaveBeenCalledTimes(1);
    expect(inst.saveProperties.mock.calls[0][0]).toEqual({
      'management-server-enabled': 'false',
    });
    expect(inst.properties['management-server-tls-enabled']).toBe('false');
    expect(inst.properties['management-server-secret']).toBe('d'.repeat(40));
    expect(r).toEqual({ enabled: false, restartRequired: false, secretGenerated: false });
  });

  it('关闭不会新生成 secret', () => {
    const inst = makeInstance({});
    setPushChannel(inst, false);
    expect(inst.saveProperties.mock.calls[0][0]).not.toHaveProperty('management-server-secret');
  });
});
