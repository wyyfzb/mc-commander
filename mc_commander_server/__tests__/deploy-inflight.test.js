/**
 * 在途部署注册表读取判据测试（utils/deploy-inflight.js）：
 * 两个出口（WS 连接补发 / GET /instances/deploy/status）必须同口径——
 * 死快照一律不算在途，updatedAt 缺失同样按死快照处理（无法判龄即不可放行）
 * 数据一律虚构（paper-xxxx / 生存服）
 */
import { describe, it, expect } from 'vitest';
import {
  inFlightDeploys,
  isDeployInFlight,
  latestInFlightDeploy,
  MAX_INFLIGHT_DEPLOY_AGE_MS,
} from '../utils/deploy-inflight.js';

/** 在途条目（结构占位：与 trackDeployProgress 写入的字段一致） */
function entry(overrides = {}) {
  return {
    instanceId: 'paper-a1b2c3d4',
    instanceName: '生存服',
    type: 'paper',
    mcVersion: '1.21.4',
    stage: 'download',
    percent: 0.45,
    transferred: 52_428_800,
    total: 104_857_600,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function managerOf(entries = []) {
  return { activeDeploys: new Map(entries.map((e) => [e.instanceId, e])) };
}

describe('在途部署读取判据', () => {
  it('activeDeploys 缺失（旧 manager 形态）：按无在途处理，不抛错', () => {
    expect(inFlightDeploys({})).toEqual([]);
    expect(latestInFlightDeploy({})).toBeNull();
    expect(isDeployInFlight({})).toBe(false);
  });

  it('空注册表：无在途', () => {
    expect(isDeployInFlight(managerOf())).toBe(false);
  });

  it('时限内的条目算在途，超时限的死快照不算', () => {
    const stale = entry({ instanceId: 'paper-stale', updatedAt: Date.now() - MAX_INFLIGHT_DEPLOY_AGE_MS - 1 });
    expect(isDeployInFlight(managerOf([stale]))).toBe(false);

    const fresh = entry({ updatedAt: Date.now() - MAX_INFLIGHT_DEPLOY_AGE_MS + 60_000 });
    expect(isDeployInFlight(managerOf([fresh]))).toBe(true);
  });

  it('updatedAt 缺失按死快照处理（无法判龄则不放行兜底时限）', () => {
    const noTimestamp = entry({ instanceId: 'paper-legacy' });
    delete noTimestamp.updatedAt;

    expect(inFlightDeploys(managerOf([noTimestamp]))).toEqual([]);
  });

  it('latestInFlightDeploy 取 updatedAt 最新的一条（面板同一时刻只呈现一个进度视图）', () => {
    const older = entry({ instanceId: 'paper-older', updatedAt: Date.now() - 60_000 });
    const newer = entry({ instanceId: 'paper-newer', updatedAt: Date.now() });

    expect(inFlightDeploys(managerOf([older, newer]))).toHaveLength(2);
    expect(latestInFlightDeploy(managerOf([newer, older]))?.instanceId).toBe('paper-newer');
  });
});
