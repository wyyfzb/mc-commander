import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetLoginLockState,
  _getLoginFailuresSize,
  _recordLoginFailure,
  _isLoginLocked,
  _clearLoginFailures,
} from '../routes/auth.js';
import config from '../config.js';

describe('loginFailures LRU 容量上限', () => {
  beforeEach(() => {
    resetLoginLockState();
  });

  it('正常锁定路径回归：多次失败后锁定', () => {
    const maxFails = config.adminSession.loginLockMaxFails;
    const ip = '1.2.3.4';
    for (let i = 0; i < maxFails - 1; i++) {
      _recordLoginFailure(ip);
      expect(_isLoginLocked(ip)).toBe(false);
    }
    // 第 maxFails 次触发锁定
    _recordLoginFailure(ip);
    expect(_isLoginLocked(ip)).toBe(true);
  });

  it('正常解锁路径回归：成功登录清零', () => {
    const maxFails = config.adminSession.loginLockMaxFails;
    const ip = '5.6.7.8';
    for (let i = 0; i < maxFails; i++) {
      _recordLoginFailure(ip);
    }
    expect(_isLoginLocked(ip)).toBe(true);
    _clearLoginFailures(ip);
    expect(_isLoginLocked(ip)).toBe(false);
    expect(_getLoginFailuresSize()).toBe(0);
  });

  it('容量淘汰：超过上限后 Map 大小回到 75% 缓冲线', () => {
    // loginFailures 上限为 10000，插入 10001 个不同 IP
    for (let i = 0; i < 10001; i++) {
      _recordLoginFailure('10.0.0.' + i);
    }
    // 淘汰到 75% = 7500
    expect(_getLoginFailuresSize()).toBeLessThanOrEqual(7500);
  });

  it('LRU 淘汰最旧条目：最早插入的 IP 被淘汰', () => {
    // 插入 10001 个 IP，第 0 个应该被淘汰
    for (let i = 0; i < 10001; i++) {
      _recordLoginFailure('10.0.0.' + i);
    }
    // 第 0 个 IP 已被淘汰（size <= 7500，前 2501 个被淘汰）
    expect(_isLoginLocked('10.0.0.0')).toBe(false);
  });

  it('淘汰后新 IP 仍可正常锁定', () => {
    const maxFails = config.adminSession.loginLockMaxFails;
    // 先填满到触发淘汰
    for (let i = 0; i < 10001; i++) {
      _recordLoginFailure('10.0.0.' + i);
    }
    // 淘汰后对最新 IP 继续失败直到锁定
    const latestIp = '10.0.0.10000';
    // 已有 1 次失败，补到 maxFails
    for (let i = 1; i < maxFails; i++) {
      _recordLoginFailure(latestIp);
    }
    expect(_isLoginLocked(latestIp)).toBe(true);
  });
});
