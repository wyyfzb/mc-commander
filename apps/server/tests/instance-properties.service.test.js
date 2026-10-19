/**
 * instance-properties.service 行为级测试（分层治理）
 *
 * 覆盖 service 层核心分支：单键值校验（布尔/数值/level-name 路径穿越/
 * 换行注入/运行期命令字符集/非标量拒绝）、敏感键掩码、PUT
 * 校验阶段（敏感键占位符短路/白名单拒绝/整体拒绝原子性）、写盘与重启
 * 联动编排（磁盘快照 diff 基线/restartRequired 判定/运行中命令逐条下发
 * 与单条失败降级）、GET 展示视图（运行状态覆盖/掩码/异常兜底）、缓存
 * 刷新边界。路由层端点行为由 status.test.js / status.endpoints.test.js /
 * status.input.contract.test.js 行为级测试守护。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../src/utils/logger.js';
import { asInstance } from './helpers/msmp-instance.js';
import {
  SERVER_SETTING_KEYS,
  SERVER_SETTING_METHODS,
} from '../src/services/mc-server/msmp-methods.js';
// 跨包只读：面板属性表（零 import 的纯数据模块，可直接并入 node 测试环境）。
// 这条 import 就是「两个源」的另一侧——面板侧从它取，服务端侧从下方 service 常量取。
import { SERVER_PROPERTY_DEFS } from '../../web/src/lib/mc-properties';
import {
  SENSITIVE_PROPERTIES,
  SENSITIVE_PLACEHOLDER,
  ALLOWED_PROPERTY_KEYS,
  NUMERIC_PROPERTIES,
  NUMERIC_PROPERTY_RANGES,
  validatePropertyValue,
  maskSensitiveProperties,
  reloadProperties,
  getPropertiesView,
  validatePropertySubmission,
  applyPropertyUpdates,
} from '../src/services/instance-properties.service.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 行为级 instance fixture：properties 读写与命令下发全部可观测 */
function makeInstance(overrides = {}) {
  return asInstance({
    id: 's1',
    properties: { difficulty: 'peaceful', 'view-distance': '10' },
    isRunning: false,
    _loadProperties: vi.fn(() => null),
    readDifficulty: vi.fn(async () => null),
    _readGameTypeFromLevelDat: vi.fn(() => null),
    saveProperties: vi.fn(),
    sendCommand: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  });
}

describe('instance-properties.service · 单键值校验 validatePropertyValue', () => {
  it('布尔属性接受 true/false（大小写不敏感），其余值拒绝', () => {
    expect(validatePropertyValue('pvp', 'true')).toEqual({ ok: true, value: 'true' });
    expect(validatePropertyValue('pvp', 'FALSE')).toEqual({ ok: true, value: 'FALSE' });
    expect(validatePropertyValue('pvp', 'yes')).toEqual({
      ok: false,
      reason: '布尔属性仅接受 true/false',
    });
  });

  it('数值属性接受整数（含 -1 禁用语义），小数与非数字拒绝', () => {
    expect(validatePropertyValue('max-players', '20')).toEqual({ ok: true, value: '20' });
    expect(validatePropertyValue('max-tick-time', '-1')).toEqual({ ok: true, value: '-1' });
    expect(validatePropertyValue('view-distance', '12.5')).toEqual({
      ok: false,
      reason: '数值属性仅接受整数',
    });
    expect(validatePropertyValue('view-distance', 'abc')).toEqual({
      ok: false,
      reason: '数值属性仅接受整数',
    });
  });

  it('level-name 路径穿越根治：仅接受字母数字、下划线与连字符', () => {
    expect(validatePropertyValue('level-name', 'My_World-1')).toEqual({
      ok: true,
      value: 'My_World-1',
    });
    expect(validatePropertyValue('level-name', '../../etc')).toEqual({
      ok: false,
      reason: 'level-name 仅接受字母数字、下划线与连字符',
    });
  });

  it('字符串属性拒绝真实换行（防行注入）；motd 字面转义序列不受影响', () => {
    expect(validatePropertyValue('motd', 'line1\nline2')).toEqual({
      ok: false,
      reason: '字符串属性不允许包含换行符',
    });
    expect(validatePropertyValue('motd', 'a\rb').ok).toBe(false);
    expect(validatePropertyValue('motd', 'hello\\nworld').ok).toBe(true);
  });

  it('运行期命令键值字符集限制（difficulty/gamemode 拼入控制台命令，防注入）', () => {
    expect(validatePropertyValue('difficulty', 'hard')).toEqual({ ok: true, value: 'hard' });
    expect(validatePropertyValue('gamemode', 'creative; shutdown')).toEqual({
      ok: false,
      reason: '值包含非法字符',
    });
  });

  it('非标量值拒绝（null/undefined/对象）', () => {
    expect(validatePropertyValue('motd', null)).toEqual({ ok: false, reason: '值必须是标量' });
    expect(validatePropertyValue('motd', undefined)).toEqual({ ok: false, reason: '值必须是标量' });
    expect(validatePropertyValue('motd', { a: 1 })).toEqual({ ok: false, reason: '值必须是标量' });
  });
});

// 越界值在服务端不会报错，只会被钳制或让整项能力失效（query.port 越界即关闭查询、
// max-players 负数即永远满员）⇒ 保存前必须拦下。区间表只收有服务端依据的键，
// 未收录者一律放行——宁可让越界值写进去由服务端钳制，也不猜一个边界把合法值挡在门外。
describe('instance-properties.service · 数值属性区间校验', () => {
  const RANGE_KEYS = Object.entries(NUMERIC_PROPERTY_RANGES);

  it('区间表只收录数值属性（表里混进字符串键会让校验恒不触发）', () => {
    const stray = RANGE_KEYS.map(([key]) => key).filter((key) => !NUMERIC_PROPERTIES.has(key));
    expect(stray).toEqual([]);
    expect(RANGE_KEYS.length).toBeGreaterThan(0);
  });

  it.each(RANGE_KEYS)('%s 接受上下边界、拒绝越界一格', (key, range) => {
    expect(validatePropertyValue(key, String(range.min)).ok).toBe(true);
    expect(validatePropertyValue(key, String(range.max)).ok).toBe(true);
    expect(validatePropertyValue(key, String(range.min - 1)).ok).toBe(false);
    expect(validatePropertyValue(key, String(range.max + 1)).ok).toBe(false);
  });

  it('越界理由带上区间（用户要知道能填多少，而不是只听到「非法」）', () => {
    expect(validatePropertyValue('view-distance', '100')).toEqual({
      ok: false,
      reason: 'view-distance 仅接受 2~32 之间的整数',
    });
    expect(validatePropertyValue('query.port', '65536')).toEqual({
      ok: false,
      reason: 'query.port 仅接受 0~65535 之间的整数',
    });
    expect(validatePropertyValue('text-filtering-version', '7')).toEqual({
      ok: false,
      reason: 'text-filtering-version 仅接受 0~1 之间的整数',
    });
  });

  it('按数值比大小（退化成字符串比会拿字典序把 9 判成越界）', () => {
    // '9' > '2147483647' 在字典序下成立，数值比较下 9 远在区间内
    expect(validatePropertyValue('max-players', '9').ok).toBe(true);
    expect(validatePropertyValue('query.port', '9').ok).toBe(true);
  });

  it('未收录的数值键不猜边界：越界值照旧放行（交给服务端钳制）', () => {
    // 这三键在 26.3 上未找到任何钳制，写 100 会原样保留
    expect(validatePropertyValue('simulation-distance', '100').ok).toBe(true);
    expect(validatePropertyValue('spawn-protection', '-1').ok).toBe(true);
    expect(validatePropertyValue('network-compression-threshold', '-1').ok).toBe(true);
  });

  it('player-idle-timeout 仍走专用文案（不进区间表，负数另有语义说明）', () => {
    expect(validatePropertyValue('player-idle-timeout', '-5')).toEqual({
      ok: false,
      reason: '挂机超时仅接受非负整数（分钟，0=禁用）',
    });
  });

  it('区间校验接在写盘路径上：越界提交整批拒绝、不落盘', () => {
    const r = validatePropertySubmission({ motd: 'Aether', 'view-distance': '64' });
    expect(r.rejectedKeys).toEqual(['view-distance']);
    expect(r.validated).toEqual({ motd: 'Aether' });
  });
});

describe('instance-properties.service · 敏感键掩码 maskSensitiveProperties', () => {
  it('敏感键替换为占位符，非敏感键原样保留，不改写原对象（纯函数）', () => {
    const src = { 'rcon.password': 'secret', motd: 'hi', difficulty: 'hard' };
    const masked = maskSensitiveProperties(src);
    expect(masked['rcon.password']).toBe(SENSITIVE_PLACEHOLDER);
    expect(masked.motd).toBe('hi');
    expect(masked.difficulty).toBe('hard');
    expect(src['rcon.password']).toBe('secret');
  });

  it('敏感键集合覆盖 11 个网络/权限/凭据键（收口面不缩水）', () => {
    expect(SENSITIVE_PROPERTIES.size).toBe(11);
    for (const key of [
      'enable-rcon',
      'rcon.password',
      'rcon.port',
      'enable-query',
      'enable-status',
      'enable-command-block',
      'online-mode',
      'server-port',
      'server-ip',
      // MSMP 凭据：实测 26.3 要求 40 位字母数字，留空会让服务端崩在启动期（不是「自动生成」）
      'management-server-secret',
      'management-server-tls-keystore-password',
    ]) {
      expect(SENSITIVE_PROPERTIES.has(key)).toBe(true);
    }
  });

  it('MSMP 凭据键在 GET 视图中被掩码（不得明文回显）', async () => {
    const SECRET = 'S3CR3T-40-CHAR-abcdefghijklmnopqrstuvwxyz01';
    const instance = {
      properties: {
        'management-server-enabled': 'true',
        'management-server-secret': SECRET,
        'management-server-tls-keystore-password': 'KEYSTORE_PW',
        'rcon.password': 'RCON_PW',
      },
      _loadProperties: () => instance.properties,
      readDifficulty: async () => null,
      _readGameTypeFromLevelDat: () => null,
    };
    const view = await getPropertiesView(instance);
    expect(view['management-server-secret']).toBe(SENSITIVE_PLACEHOLDER);
    expect(view['management-server-tls-keystore-password']).toBe(SENSITIVE_PLACEHOLDER);
    // 对照组：既有凭据口径不变
    expect(view['rcon.password']).toBe(SENSITIVE_PLACEHOLDER);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});

describe('instance-properties.service · PUT 校验阶段 validatePropertySubmission', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('敏感键提交占位符 → 短路（不进 validated 也不进 rejected）；提交真实值 → 拒绝', () => {
    const r1 = validatePropertySubmission({ 'rcon.password': SENSITIVE_PLACEHOLDER, motd: 'x' });
    expect(r1.rejectedKeys).toEqual([]);
    expect(r1.validated).toEqual({ motd: 'x' });
    const r2 = validatePropertySubmission({ 'rcon.password': 'hacked' });
    expect(r2.rejectedKeys).toEqual(['rcon.password']);
    expect(r2.validated).toEqual({});
  });

  it('白名单外键与白名单内非法值均拒绝且不落 validated（原子性输入）', () => {
    const r = validatePropertySubmission({ 'evil-key': 'x', 'view-distance': 'abc' });
    expect(r.rejectedKeys).toEqual(['evil-key', 'view-distance']);
    expect(r.validated).toEqual({});
  });

  it('正常混合提交逐键收集（布尔/数值/字符串，数值经 String 归一）', () => {
    const r = validatePropertySubmission({ pvp: 'true', 'max-players': 30, motd: 'Aether' });
    expect(r.rejectedKeys).toEqual([]);
    expect(r.validated).toEqual({ pvp: 'true', 'max-players': '30', motd: 'Aether' });
  });

  it('player-idle-timeout 映射到官方 /setidletimeout（分钟）', () => {
    // 官方运行期直达路径：不加这条，改这项只能写文件 + 重启
    expect(SERVER_SETTING_METHODS['player-idle-timeout'].fallbackCommand('30')).toBe(
      'setidletimeout 30',
    );
    expect(SERVER_SETTING_METHODS['player-idle-timeout'].fallbackCommand('0')).toBe(
      'setidletimeout 0',
    );
  });

  it.each([
    ['0（禁用）', '0', true],
    ['正数分钟', '30', true],
    ['负数（语义无意义，会让命令被服务端拒绝）', '-5', false],
    ['小数', '1.5', false],
    ['非数字', 'abc', false],
  ])('player-idle-timeout 值校验：%s', (_label, value, ok) => {
    const r = validatePropertyValue('player-idle-timeout', value);
    expect(r.ok).toBe(ok);
    if (!ok) expect(r.reason).toBeTruthy();
  });

  it('运行期命令键在白名单并集内（命令键不可绕过白名单）', () => {
    for (const key of SERVER_SETTING_KEYS) {
      expect(ALLOWED_PROPERTY_KEYS.has(key)).toBe(true);
    }
  });
});

describe('instance-properties.service · 写盘与重启联动编排 applyPropertyUpdates', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  it('存在非法键 → ok:false 整体拒绝，不触发写盘（原子性）', async () => {
    const instance = makeInstance();
    const r = await applyPropertyUpdates(instance, { 'evil-key': 'x' });
    expect(r).toEqual({ ok: false, rejectedKeys: ['evil-key'] });
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });

  it('全部占位符/空提交 → applied:false，不触发写盘', async () => {
    const instance = makeInstance();
    const r = await applyPropertyUpdates(instance, { 'rcon.password': SENSITIVE_PLACEHOLDER });
    expect(r).toEqual({ ok: true, restartRequired: [], applied: false });
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });

  it('重读磁盘并入 diff 基线：_loadProperties 最新值刷新缓存后再判定变更', async () => {
    const instance = makeInstance({
      properties: { motd: 'stale' },
      _loadProperties: vi.fn(() => ({ motd: 'fresh' })),
    });
    const r = await applyPropertyUpdates(instance, { motd: 'fresh' });
    expect(instance._loadProperties).toHaveBeenCalled();
    expect(instance.properties).toEqual({ motd: 'fresh' });
    expect(r).toEqual({ ok: true, restartRequired: [], applied: true });
    expect(instance.saveProperties).toHaveBeenCalledWith({ motd: 'fresh' });
  });

  it('未运行：非 runtime 键变更不提示重启（下次启动自然生效），仍保存', async () => {
    const instance = makeInstance({ properties: { pvp: 'true' } });
    const r = await applyPropertyUpdates(instance, { pvp: 'false' });
    expect(r.applied).toBe(true);
    expect(r.restartRequired).toEqual([]);
    expect(instance.saveProperties).toHaveBeenCalledWith({ pvp: 'false' });
    expect(instance.sendCommand).not.toHaveBeenCalled();
  });

  it('运行中：非 runtime 键变更 → restartRequired 列出；runtime 键变更 → 下发命令', async () => {
    const instance = makeInstance({
      isRunning: true,
      properties: { pvp: 'true', difficulty: 'peaceful' },
    });
    const r = await applyPropertyUpdates(instance, { pvp: 'false', difficulty: 'hard' });
    expect(r.restartRequired).toEqual(['pvp']);
    expect(instance.sendCommand).toHaveBeenCalledTimes(1);
    expect(instance.sendCommand).toHaveBeenCalledWith('difficulty hard');
  });

  it('运行中命令构造：white-list 布尔分支与 gamemode 命令映射', async () => {
    const instance = makeInstance({
      isRunning: true,
      properties: { 'white-list': 'false', gamemode: 'survival' },
    });
    await applyPropertyUpdates(instance, { 'white-list': 'true', gamemode: 'creative' });
    expect(instance.sendCommand).toHaveBeenNthCalledWith(1, 'whitelist on');
    expect(instance.sendCommand).toHaveBeenNthCalledWith(2, 'defaultgamemode creative');
  });

  it('运行期应用失败：仅警告，保存与返回不受阻，且如实把该键列入「需重启」', async () => {
    const instance = makeInstance({
      isRunning: true,
      properties: { difficulty: 'peaceful' },
      sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
    });
    const r = await applyPropertyUpdates(instance, { difficulty: 'hard' });
    expect(r.applied).toBe(true);
    // 没生效就说没生效：只看「表里有没有这个键」，命令失败也会报「无需重启」
    expect(r.restartRequired).toEqual(['difficulty']);
    expect(instance.saveProperties).toHaveBeenCalled();
  });
});

describe('instance-properties.service · GET 展示视图 getPropertiesView', () => {
  it('重读文件并入 + difficulty 运行中真实值覆盖 + gamemode 读 level.dat + 敏感键掩码', async () => {
    const diskProps = { motd: 'file-motd', 'rcon.password': 'secret', difficulty: 'peaceful' };
    const instance = makeInstance({
      properties: diskProps,
      _loadProperties: vi.fn(() => diskProps),
      readDifficulty: vi.fn(async () => 'hard'),
      _readGameTypeFromLevelDat: vi.fn(() => 'creative'),
    });
    const view = await getPropertiesView(instance);
    expect(view).toEqual({
      motd: 'file-motd',
      'rcon.password': SENSITIVE_PLACEHOLDER,
      difficulty: 'hard',
      gamemode: 'creative',
    });
  });

  it('_loadProperties 抛错 → 沿用内存缓存；readDifficulty 抛错 → 不影响主体响应', async () => {
    const instance = makeInstance({
      properties: { motd: 'cached' },
      _loadProperties: vi.fn(() => {
        throw new Error('disk gone');
      }),
      readDifficulty: vi.fn(async () => {
        throw new Error('rcon gone');
      }),
    });
    const view = await getPropertiesView(instance);
    expect(view).toEqual({ motd: 'cached' });
  });
});

describe('instance-properties.service · 缓存刷新边界 reloadProperties', () => {
  it('fresh 为 null/空对象/undefined/抛错 → 均不覆盖内存缓存', () => {
    for (const ret of [null, {}, undefined]) {
      const instance = makeInstance({
        properties: { motd: 'keep' },
        _loadProperties: vi.fn(() => ret),
      });
      reloadProperties(instance);
      expect(instance.properties).toEqual({ motd: 'keep' });
    }
    const throwing = makeInstance({
      properties: { motd: 'keep' },
      _loadProperties: vi.fn(() => {
        throw new Error('io');
      }),
    });
    reloadProperties(throwing);
    expect(throwing.properties).toEqual({ motd: 'keep' });
  });
});

// 面板属性表标为可写的键，必须能被服务端接受：前端只回传用户真正改过的键，
// 故「面板标可写」就是「用户可提交」的全集，漏一个用户点保存就撞整批 400。
// 两侧刻意取自两个不同的源（面板表 vs 本包 service 常量），改成同一处推导会让断言恒真。
// 26.3 键与实例模板键已入白名单：面板模板（server-jar.js）会写 texture-pack/query.port/
// max-chained-neighbor-updates，引擎首启又会补齐 26.3 全套键；这些键若被拒，任何按整份文件
// 回传的调用方都会整批 400。
describe('instance-properties.service · 26.3 键与模板键白名单对齐', () => {
  const KEYS_WITH_SAMPLE = [
    ['white-list', 'true'],
    ['enforce-whitelist', 'false'],
    ['query.port', '25565'],
    ['texture-pack', ''],
    ['pause-when-empty-seconds', '60'],
    ['max-chained-neighbor-updates', '1000000'],
    ['resource-pack-id', ''],
    ['text-filtering-version', '0'],
    ['chat-spam-threshold-seconds', '10'],
    ['command-spam-threshold-seconds', '10'],
    ['status-heartbeat-interval', '0'],
  ];
  // 上表中走整数校验分支的键（其余为布尔/字符串）
  const NUMERIC_KEYS = [
    'query.port',
    'pause-when-empty-seconds',
    'max-chained-neighbor-updates',
    'text-filtering-version',
    'chat-spam-threshold-seconds',
    'command-spam-threshold-seconds',
    'status-heartbeat-interval',
  ];

  it('逐个提交都被接受（值采样自官方默认值/合法值）', () => {
    const rejected = [];
    for (const [key, sample] of KEYS_WITH_SAMPLE) {
      const { rejectedKeys } = validatePropertySubmission({ [key]: sample });
      if (rejectedKeys.length > 0) rejected.push(key);
    }
    expect(rejected).toEqual([]);
  });

  it('整数项同时落在数值校验集合里（否则非法值会被原样写进文件）', () => {
    const missing = NUMERIC_KEYS.filter((key) => !NUMERIC_PROPERTIES.has(key));
    expect(missing).toEqual([]);
    // 抽一条反向证据：整数项拒非整数
    expect(validatePropertyValue('chat-spam-threshold-seconds', 'abc').ok).toBe(false);
    expect(validatePropertyValue('max-chained-neighbor-updates', '-1').ok).toBe(true);
  });
});

// 面板属性表标为可写的键，必须能被服务端接受：前端只回传用户真正改过的键，
// 故「面板标可写」就是「用户可提交」的全集，漏一个用户点保存就撞整批 400。
// 两侧刻意取自两个不同的源（面板表 vs 本包 service 常量），改成同一处推导会让断言恒真。
// 采样值优先取面板表里的官方默认值（它必然是该键的合法值），默认值为空的（level-name、
// level-seed 这类）退回 '1'：若一律用 '1'，有区间的键（view-distance 下界 2、
// entity-broadcast-range-percentage 下界 10）会被区间校验挡下，守卫变成在验「1 合不合法」。
function sampleValue(def) {
  if (def.type === 'checkbox') return 'true';
  if (def.options) return def.options[0];
  return def.defaultValue === '' ? '1' : def.defaultValue;
}

describe('instance-properties.service · 面板可写键 ⊆ 服务端白名单（跨包守卫）', () => {
  const panelWritableDefs = SERVER_PROPERTY_DEFS.filter((def) => def.isWritable);

  it('面板可写键集合 ⊆ ALLOWED_PROPERTY_KEYS', () => {
    expect(panelWritableDefs.length).toBeGreaterThan(0);
    const missing = panelWritableDefs
      .map((def) => def.name)
      .filter((key) => !ALLOWED_PROPERTY_KEYS.has(key));
    expect(missing).toEqual([]);
  });

  it('面板可写键逐个提交都过校验（行为面，不只看集合成员）', () => {
    const rejected = [];
    for (const def of panelWritableDefs) {
      const { rejectedKeys } = validatePropertySubmission({ [def.name]: sampleValue(def) });
      if (rejectedKeys.length > 0) rejected.push(def.name);
    }
    expect(rejected).toEqual([]);
  });

  it('面板可写键一次性全量提交也过校验（用户批量改多项的形态）', () => {
    const payload = {};
    for (const def of panelWritableDefs) {
      payload[def.name] = sampleValue(def);
    }
    expect(validatePropertySubmission(payload).rejectedKeys).toEqual([]);
  });

  it('敏感键不得出现在面板可写集合里', () => {
    const leaked = panelWritableDefs
      .map((def) => def.name)
      .filter((key) => SENSITIVE_PROPERTIES.has(key));
    expect(leaked).toEqual([]);
  });
});
