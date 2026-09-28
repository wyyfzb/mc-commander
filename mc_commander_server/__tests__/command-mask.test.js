import { describe, it, expect } from 'vitest';
import { maskSensitiveCommand } from '../utils/command-mask.js';

describe('maskSensitiveCommand（命令史敏感值遮蔽）', () => {
  it('运维命令不遮蔽：提权/封禁/踢人/给予的目标与理由是审计核心价值', () => {
    expect(maskSensitiveCommand('op Steve')).toBe('op Steve');
    expect(maskSensitiveCommand('deop Alex')).toBe('deop Alex');
    expect(maskSensitiveCommand('ban-ip 1.2.3.4 恶意破坏')).toBe('ban-ip 1.2.3.4 恶意破坏');
    expect(maskSensitiveCommand('kick Bob 挂机')).toBe('kick Bob 挂机');
    expect(maskSensitiveCommand('give Steve minecraft:diamond_sword 1')).toBe(
      'give Steve minecraft:diamond_sword 1',
    );
    expect(maskSensitiveCommand('whitelist add Steve')).toBe('whitelist add Steve');
    expect(maskSensitiveCommand('weather rain')).toBe('weather rain');
    expect(maskSensitiveCommand('time set night')).toBe('time set night');
  });

  it('key=value 形态遮蔽值保留键名', () => {
    expect(maskSensitiveCommand('login password=hunter2')).toBe('login password=***');
    expect(maskSensitiveCommand('set api_key:abcd1234')).toBe('set api_key:***');
    expect(maskSensitiveCommand('auth secret = topsecret')).toBe('auth secret = ***');
  });

  it('裸键名后跟值形态遮蔽（login <token>）', () => {
    expect(maskSensitiveCommand('login eyJhbGciOi.eyJzdWIi.signed')).toBe('login ***');
    expect(maskSensitiveCommand('register password hunter2')).toBe('register password ***');
  });

  it('命令中间出现敏感参数同样遮蔽', () => {
    expect(maskSensitiveCommand('say 注意 token=abc123 已更新')).toBe('say 注意 token=*** 已更新');
  });

  it('key 名不含敏感词的普通等值不遮蔽', () => {
    expect(maskSensitiveCommand('gamerule doDaylightCycle false')).toBe(
      'gamerule doDaylightCycle false',
    );
    expect(maskSensitiveCommand('effect give Steve minecraft:speed 60 1')).toBe(
      'effect give Steve minecraft:speed 60 1',
    );
  });

  it('空串与非字符串原样返回', () => {
    expect(maskSensitiveCommand('')).toBe('');
    expect(maskSensitiveCommand(null)).toBe(null);
    expect(maskSensitiveCommand(undefined)).toBe(undefined);
  });
});
