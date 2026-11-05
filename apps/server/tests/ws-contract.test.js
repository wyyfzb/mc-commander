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

  it('未登记契约的事件直接放行', () => {
    // 40 个事件类型里只有 9 个有 payload schema，其余属「暂无契约」而非漏配
    for (const type of ['deployProgress', 'systemStatsUpdate', 'error', 'upgradeProgress']) {
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

  it('player 系列共用一份载荷契约', () => {
    for (const type of ['playerJoin', 'playerLeave', 'playerDeath', 'playerChat']) {
      observeWsPayload(type, { name: 'Steve' });
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('backup 系列共用一份载荷契约', () => {
    for (const type of ['backupStart', 'backupComplete', 'backupFailed', 'backupCancelled']) {
      observeWsPayload(type, { id: 1, name: 'b1' });
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
