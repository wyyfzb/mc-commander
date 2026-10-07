/**
 * MSMP 方法面：通道择优与生效判据。
 *
 * 承重点两条：① **结构化通道给了答复就以它为准**——目标没进返回值时报错，不再退回命令
 * （kick/ban 非幂等，重复执行是实打实的副作用）；② 只有通道**没做成**（null）才回退命令，
 * 且回退后的命令与原实现逐字一致（行为等价）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  _writeViaPreferredChannel,
  whitelistAdd,
  whitelistRemove,
  opPlayer,
  deopPlayer,
  kickPlayer,
  banPlayer,
  banIp,
  pardonPlayer,
  pardonIp,
} from '../services/mc-server/msmp-methods.js';

/** 最小实例桩：只带方法面依赖的两个成员 */
function makeInstance(msmpResult) {
  return {
    id: 'inst-1',
    isRunning: true,
    _msmpAvailable: false,
    _msmpRequest: vi.fn(async () => msmpResult),
    sendCommand: vi.fn(async () => 'ok'),
  };
}

/** 把方法面的方法挂到桩上（与生产一致：方法在实例原型上） */
function withMethods(msmpResult) {
  const inst = makeInstance(msmpResult);
  for (const [name, fn] of Object.entries({
    _writeViaPreferredChannel,
    whitelistAdd,
    whitelistRemove,
    opPlayer,
    deopPlayer,
    kickPlayer,
    banPlayer,
    banIp,
    pardonPlayer,
    pardonIp,
  })) {
    inst[name] = fn.bind(inst);
  }
  return inst;
}

describe('结构化通道生效：不再发命令', () => {
  it('加白名单：返回值里带上该玩家 ⇒ 走 msmp，命令通道零调用', async () => {
    const inst = withMethods([{ id: '00000000-0000-4000-8000-000000000002', name: 'Steve' }]);

    await expect(inst.whitelistAdd('Steve')).resolves.toBe('msmp');
    expect(inst._msmpRequest).toHaveBeenCalledWith(
      'minecraft:allowlist/add',
      [[{ name: 'Steve' }]],
      expect.any(Number),
    );
    expect(inst.sendCommand).not.toHaveBeenCalled();
    // 正向证据才更新能力位（写失败可能是参数问题，不足以判定通道不可用）
    expect(inst._msmpAvailable).toBe(true);
  });

  it('封禁：bans/add 回的对象把玩家包在 player 里，也能判成生效', async () => {
    const inst = withMethods([{ player: { name: 'Steve' }, reason: '作弊', source: 'Server' }]);

    await expect(inst.banPlayer('Steve', '作弊')).resolves.toBe('msmp');
    expect(inst._msmpRequest).toHaveBeenCalledWith(
      'minecraft:bans/add',
      [[{ player: { name: 'Steve' }, reason: '作弊', source: 'Server' }]],
      expect.any(Number),
    );
    expect(inst.sendCommand).not.toHaveBeenCalled();
  });

  it('封禁 IP：ip_bans/add 回平铺的 ip 对象', async () => {
    const inst = withMethods([{ ip: '1.2.3.4', reason: '作弊', source: 'Server' }]);

    await expect(inst.banIp('1.2.3.4', '作弊')).resolves.toBe('msmp');
    expect(inst._msmpRequest).toHaveBeenCalledWith(
      'minecraft:ip_bans/add',
      [[{ ip: '1.2.3.4', reason: '作弊', source: 'Server' }]],
      expect.any(Number),
    );
  });
});

describe('结构化通道没做成：退回等价命令（逐字一致）', () => {
  it.each([
    ['whitelistAdd', ['Steve'], 'whitelist add Steve'],
    ['whitelistRemove', ['Steve'], 'whitelist remove Steve'],
    ['opPlayer', ['Steve'], 'op Steve'],
    ['deopPlayer', ['Steve'], 'deop Steve'],
    ['kickPlayer', ['Steve', '别刷屏'], 'kick Steve 别刷屏'],
    ['banPlayer', ['Steve', '作弊'], 'ban Steve 作弊'],
    ['banIp', ['1.2.3.4', '作弊'], 'ban-ip 1.2.3.4 作弊'],
    ['pardonPlayer', ['Steve'], 'pardon Steve'],
    ['pardonIp', ['1.2.3.4'], 'pardon-ip 1.2.3.4'],
  ])('%s：MSMP 返回 null ⇒ 走命令 %s', async (method, args, command) => {
    const inst = withMethods(null);

    await expect(inst[method](...args)).resolves.toBe('command');
    expect(inst.sendCommand).toHaveBeenCalledWith(command);
    // 通道不可用不是「能力位为真」的证据
    expect(inst._msmpAvailable).toBe(false);
  });

  it('理由缺省时命令不带尾部空格（与既有实现逐字一致）', async () => {
    const inst = withMethods(null);

    await inst.banPlayer('Steve');
    await inst.kickPlayer('Steve', '');

    expect(inst.sendCommand).toHaveBeenCalledWith('ban Steve');
    expect(inst.sendCommand).toHaveBeenCalledWith('kick Steve');
  });
});

describe('结构化通道有答复但未生效：报错，绝不退回命令', () => {
  it('加白名单：返回值空数组 ⇒ 报错且不发命令', async () => {
    const inst = withMethods([]);

    await expect(inst.whitelistAdd('Steve')).rejects.toThrow(/查不到该玩家的档案/);
    expect(inst.sendCommand).not.toHaveBeenCalled();
  });

  it('踢人：返回值空数组 ⇒ 报「不在线」，不发命令（否则会重复踢）', async () => {
    const inst = withMethods([]);

    await expect(inst.kickPlayer('Steve', '理由')).rejects.toThrow(/不在线，踢出未生效/);
    expect(inst.sendCommand).not.toHaveBeenCalled();
  });

  it('封禁 IP：返回值里是另一个 IP ⇒ 没封成，报错且不发命令', async () => {
    const inst = withMethods([{ ip: '5.6.7.8' }]);

    await expect(inst.banIp('1.2.3.4', '作弊')).rejects.toThrow(/无法封禁 IP 1\.2\.3\.4/);
    expect(inst.sendCommand).not.toHaveBeenCalled();
  });

  it('踢人：返回值里是别人 ⇒ 同样算没踢成（不能拿「有人被踢」当自己成功）', async () => {
    const inst = withMethods([{ name: 'Alex' }]);

    await expect(inst.kickPlayer('Steve')).rejects.toThrow(/不在线/);
    expect(inst.sendCommand).not.toHaveBeenCalled();
  });
});

describe('移除类：返回值分辨不出「移除了」与「本来就不在」，与命令通道一致按成功', () => {
  it.each([
    ['whitelistRemove', ['Steve']],
    ['deopPlayer', ['Steve']],
    ['pardonPlayer', ['Steve']],
    ['pardonIp', ['1.2.3.4']],
  ])('%s：空数组也算完成，不回退命令', async (method, args) => {
    const inst = withMethods([]);

    await expect(inst[method](...args)).resolves.toBe('msmp');
    expect(inst.sendCommand).not.toHaveBeenCalled();
  });
});

describe('_writeViaPreferredChannel 的边界', () => {
  let inst;

  beforeEach(() => {
    inst = withMethods(null);
  });

  it('结构化方法返回 undefined 与 null 同等看待（都算通道没做成）', async () => {
    inst._msmpRequest.mockResolvedValue(undefined);

    await expect(
      inst._writeViaPreferredChannel({ method: 'x', params: [] }, async () => 'cmd'),
    ).resolves.toBe('command');
  });

  it('没有结构化等价物时直接走命令', async () => {
    const runCommand = vi.fn(async () => 'ok');

    await expect(inst._writeViaPreferredChannel(null, runCommand)).resolves.toBe('command');
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(inst._msmpRequest).not.toHaveBeenCalled();
  });

  it('无 verify 的结构化方法：只要有答复就算完成', async () => {
    const answered = withMethods([]);
    const runCommand = vi.fn(async () => 'ok');

    await expect(
      answered._writeViaPreferredChannel(
        { method: 'minecraft:allowlist/remove', params: [[]] },
        runCommand,
      ),
    ).resolves.toBe('msmp');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
