/**
 * 实例 id 形态与生成（utils/instance-id.js）：
 * 生成侧与备份快照清扫侧共用同一形态定义——两处各写一份时改生成方式会让清扫静默停止
 */
import { describe, it, expect } from 'vitest';
import {
  INSTANCE_ID_PATTERN,
  INSTANCE_ID_RANDOM_BYTES,
  generateInstanceId,
} from '../utils/instance-id.js';

describe('instance-id 形态单一事实源', () => {
  it('生成的 id 一律匹配形态（多种类型 × 多次抽样）', () => {
    for (const type of ['vanilla', 'paper', 'fabric', 'forge', 'purpur']) {
      for (let i = 0; i < 20; i++) {
        const id = generateInstanceId(type);
        expect(id.startsWith(`${type}-`)).toBe(true);
        expect(id).toMatch(INSTANCE_ID_PATTERN);
      }
    }
  });

  it('随机段长度由同一常量派生：改字节数则生成与形态同时变（不会只改一处）', () => {
    const id = generateInstanceId('paper');
    const hex = id.split('-').pop();
    expect(hex).toHaveLength(INSTANCE_ID_RANDOM_BYTES * 2);
  });

  it('形态白名单排除非本面板命名空间（panel/ 与人工放置目录不进入清扫射程）', () => {
    expect(INSTANCE_ID_PATTERN.test('panel')).toBe(false);
    expect(INSTANCE_ID_PATTERN.test('old-manual-backup')).toBe(false);
    expect(INSTANCE_ID_PATTERN.test('paper-XYZ12345')).toBe(false);
    // 正向样本按常量拼（不写死 8 位字面量）：常量变更时这条仍成立，红的是真正依赖长度的断言
    expect(INSTANCE_ID_PATTERN.test(`paper-${'a'.repeat(INSTANCE_ID_RANDOM_BYTES * 2)}`)).toBe(
      true,
    );
  });
});
