import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MetricsModel } from '../db/metrics.model.js';
import { initDatabase, getDb } from '../db/index.js';

// 分钟级指标历史：模型 CRUD + 保留期清理（真实临时库，契约经 schema 验证）

const TEST_TMP_ROOT = path.join(os.tmpdir(), `mcs-metrics-test-${process.pid}`);

describe('MetricsModel（分钟级主机指标历史）', () => {
  beforeEach(() => {
    process.env.DATA_DIR = path.join(TEST_TMP_ROOT, 'data');
    fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
    initDatabase();
    // initDatabase 是模块级单例（每文件只真正建一次库）：清表保证用例独立
    getDb().prepare('DELETE FROM metrics_history').run();
  });

  it('record → list 按时间升序返回并携带全部字段', () => {
    MetricsModel.record({
      cpuUsage: 12.5,
      memoryUsedGb: 3.2,
      memoryTotalGb: 16,
      memoryPercent: 20,
      playersOnline: 2,
    });
    MetricsModel.record({
      cpuUsage: 45.5,
      memoryUsedGb: 7.9,
      memoryTotalGb: 16,
      memoryPercent: 49.4,
      playersOnline: 5,
    });

    const rows = MetricsModel.list(24);
    expect(rows).toHaveLength(2);
    expect(rows[0].playersOnline).toBe(2);
    expect(rows[1].cpuUsage).toBe(45.5);
    expect(rows[1].capturedAt).toBeTruthy();
  });

  it('list 的 hours 参数夹紧到 [1, 72] 且按时间过滤', () => {
    MetricsModel.record({
      cpuUsage: 1,
      memoryUsedGb: 1,
      memoryTotalGb: 16,
      memoryPercent: 6.3,
      playersOnline: 0,
    });
    // 0 小时会被夹紧到 1 小时 → 样本仍在窗口内
    expect(MetricsModel.list(0)).toHaveLength(1);
    expect(MetricsModel.list(500)).toHaveLength(1);
  });

  it('deleteOlderThan 删除保留期外样本（插入旧时间戳行验证）', () => {
    MetricsModel.record({
      cpuUsage: 1,
      memoryUsedGb: 1,
      memoryTotalGb: 16,
      memoryPercent: 6.3,
      playersOnline: 0,
    });
    // 手工植入一条保留期外的旧行
    getDb()
      .prepare(
        `INSERT INTO metrics_history (captured_at, cpu_usage, players_online) VALUES (datetime('now', '-3 days'), 0, 0)`,
      )
      .run();

    const removed = MetricsModel.deleteOlderThan(24);
    expect(removed).toBe(1);
    expect(MetricsModel.list(72)).toHaveLength(1);
  });

  // 保留期默认值决定「不传参」那条路径的行为。48h 是**口径**而非随手取的值：
  // 清理每日一次 ⇒ 窗口在 [保留期, 保留期+24h) 之间摆动；取 24h 会让「昨日」这个完整
  // 本地日历日在清理后只剩 1387/1440 分钟。此断言防它被改回 24。
  it('deleteOlderThan 默认保留期为 48h（24h 会让「昨日」算不全）', () => {
    const insert = (offset) =>
      getDb()
        .prepare(
          `INSERT INTO metrics_history (captured_at, cpu_usage, players_online) VALUES (datetime('now', ?), 0, 0)`,
        )
        .run(offset);
    insert('-40 hours');
    insert('-60 hours');

    // 40h 前的样本落在 48h 保留期内 ⇒ 保留；60h 前的样本超期 ⇒ 删除
    const removed = MetricsModel.deleteOlderThan();
    expect(removed).toBe(1);
    expect(MetricsModel.list(72)).toHaveLength(1);
  });
});
