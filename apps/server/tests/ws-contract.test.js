import { describe, it, expect, vi, beforeEach } from 'vitest';
import { observeWsPayload } from '../src/utils/ws-contract.js';
import { resetContractAlarms } from '../src/utils/contract-alarm.js';
import { logger } from '../src/utils/logger.js';

/**
 * 服务端 WS 载荷的发送前观测。
 *
 * 判据是「有没有留下漂移告警」，不断言耗时——校验只负责让漂移可见，不做拦截。
 */
describe('WS 载荷契约观测', () => {
  let errorSpy;

  beforeEach(() => {
    resetContractAlarms();
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  it('合法载荷不产生告警', () => {
    observeWsPayload('statusSnapshot', {
      status: 'running',
      isRunning: true,
      players: [],
      tps: 20,
      msmpPush: false,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('缺字段的载荷留下漂移告警，且不抛出（发送照常进行）', () => {
    expect(() => observeWsPayload('statusSnapshot', { status: 'running' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0][0])).toContain('ws');
  });

  it('非事件类型直接放行（pong/auth 是客户端消息的应答，不在事件目录里）', () => {
    for (const type of ['pong', 'auth']) {
      observeWsPayload(type, { anything: true });
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('同一签名在窗口内只报一次（避免高频推送把日志刷成噪音）', () => {
    const bad = { status: 'running' };
    for (let i = 0; i < 20; i += 1) observeWsPayload('statusSnapshot', bad);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('不同签名分别记录：不能因为一条漂移掩盖另一条', () => {
    observeWsPayload('statusSnapshot', { status: 'running' });
    observeWsPayload('weatherUpdate', { weather: 'snow' });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('玩家事件按类型各自校验：缺该事件必填字段即告警', () => {
    // 形状相近不等于可以共用一份契约：chat 缺 message 必须报出来
    expect(() => observeWsPayload('playerChat', { name: 'Steve' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledOnce();

    resetContractAlarms();
    errorSpy.mockClear();
    observeWsPayload('playerSleep', { name: 'Steve', sleeping: true });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('death 的两种真实形态都通过：单条与 5s 窗口聚合的批量', () => {
    observeWsPayload('playerDeath', { name: 'Steve', cause: '被射杀' });
    observeWsPayload('playerDeath', {
      players: [{ name: 'Steve', cause: '被射杀' }],
      count: 1,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('备份生命周期要求 content：通知中心的文案由服务端给', () => {
    observeWsPayload('backupComplete', {
      instanceId: 's1',
      backupId: 1,
      name: 'b1',
      content: '备份完成: b1（12.3 MB）',
    });
    expect(errorSpy).not.toHaveBeenCalled();

    observeWsPayload('backupComplete', { instanceId: 's1', backupId: 1 });
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('备份失败带 phase 时按枚举校验', () => {
    observeWsPayload('backupFailed', {
      instanceId: 's1',
      error: '磁盘已满',
      phase: 'execution',
      content: '备份失败: 磁盘已满',
    });
    expect(errorSpy).not.toHaveBeenCalled();

    resetContractAlarms();
    errorSpy.mockClear();
    observeWsPayload('backupFailed', { error: 'x', phase: 'not-a-phase', content: 'y' });
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('部署进度复用契约包里的同一份形状', () => {
    observeWsPayload('deployProgress', {
      stage: 'download',
      percent: 0.5,
      transferred: 1024,
      total: 2048,
      instanceId: 's1',
      instanceName: 'Survival',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('升级终态要求 instanceName：通知文案要说实例名', () => {
    const base = {
      instanceId: 's1',
      stage: 'completed',
      percent: 100,
      detail: '升级完成',
      timestamp: 1,
    };
    observeWsPayload('upgradeComplete', { ...base, instanceName: 'Survival' });
    expect(errorSpy).not.toHaveBeenCalled();

    resetContractAlarms();
    errorSpy.mockClear();
    observeWsPayload('upgradeComplete', base);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('systemStatsUpdate 与 REST 同一份 schema', () => {
    observeWsPayload('systemStatsUpdate', {
      cpuUsage: 12.5,
      memoryUsage: 4.2,
      totalMemory: 16,
      memoryPercent: 26.3,
      cpuCores: 8,
      loadAvg: [0.5],
      uptime: 3600,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
