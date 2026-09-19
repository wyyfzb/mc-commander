/**
 * instance-properties.service 行为级测试（issue 514 分层治理）
 *
 * 覆盖 service 层核心分支：单键值校验（布尔/数值/level-name 路径穿越/
 * 换行注入/运行期命令字符集/非标量拒绝）、敏感键掩码、PUT
 * 校验阶段（敏感键占位符短路/白名单拒绝/整体拒绝原子性）、写盘与重启
 * 联动编排（磁盘快照 diff 基线/restartRequired 判定/运行中命令逐条下发
 * 与单条失败降级）、GET 展示视图（运行状态覆盖/掩码/异常兜底）、缓存
 * 刷新边界。路由层端点行为由 status.test.js / status.endpoints.test.js /
 * status.input.contract.test.js 既有行为级测试守护（零改动通过）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../utils/logger.js';
import {
  RUNTIME_COMMAND_MAP,
  SENSITIVE_PROPERTIES,
  SENSITIVE_PLACEHOLDER,
  ALLOWED_PROPERTY_KEYS,
  validatePropertyValue,
  maskSensitiveProperties,
  reloadProperties,
  getPropertiesView,
  validatePropertySubmission,
  applyPropertyUpdates,
} from '../services/instance-properties.service.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 行为级 instance fixture：properties 读写与命令下发全部可观测 */
function makeInstance(overrides = {}) {
  return {
    id: 's1',
    properties: { difficulty: 'peaceful', 'view-distance': '10' },
    isRunning: false,
    _loadProperties: vi.fn(() => null),
    readDifficulty: vi.fn(async () => null),
    _readGameTypeFromLevelDat: vi.fn(() => null),
    saveProperties: vi.fn(),
    sendCommand: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  };
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

describe('instance-properties.service · 敏感键掩码 maskSensitiveProperties', () => {
  it('敏感键替换为占位符，非敏感键原样保留，不改写原对象（纯函数）', () => {
    const src = { 'rcon.password': 'secret', motd: 'hi', difficulty: 'hard' };
    const masked = maskSensitiveProperties(src);
    expect(masked['rcon.password']).toBe(SENSITIVE_PLACEHOLDER);
    expect(masked.motd).toBe('hi');
    expect(masked.difficulty).toBe('hard');
    expect(src['rcon.password']).toBe('secret');
  });

  it('敏感键集合覆盖 9 个网络/权限键（收口面不缩水）', () => {
    expect(SENSITIVE_PROPERTIES.size).toBe(9);
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
    ]) {
      expect(SENSITIVE_PROPERTIES.has(key)).toBe(true);
    }
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

  it('运行期命令键在白名单并集内（命令键不可绕过白名单）', () => {
    for (const key of Object.keys(RUNTIME_COMMAND_MAP)) {
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

  it('命令下发失败降级：单条抛错仅警告，保存与返回不受阻', async () => {
    const instance = makeInstance({
      isRunning: true,
      properties: { difficulty: 'peaceful' },
      sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
    });
    const r = await applyPropertyUpdates(instance, { difficulty: 'hard' });
    expect(r.applied).toBe(true);
    expect(r.restartRequired).toEqual([]);
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
