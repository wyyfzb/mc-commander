import { Router } from 'express';
import { systemMetricsSeriesSchema } from '@mc-commander/schemas';
import { MetricsModel } from '../db/metrics.model.js';
import { validatedSuccess } from '../middleware/validate.js';

export function createMetricsRoutes() {
  const router = Router();

  // GET /api/v1/metrics?hours=24 - 分钟级主机指标历史（管理员；未入只读白名单）。
  // 消费方：面板尚未上线，端点先行供 dashboard「昨日摘要」等能力取数。
  //
  // hours 上限 72 高于保留期 48h：上限是**参数笔误的容忍度**（写大了返回现有全部样本，
  // 而不是 400），不是「有 72h 数据」的承诺。
  // ⚠️ captured_at 由 SQLite 的 CURRENT_TIMESTAMP 写入，是 **UTC**；而「昨日」是调用方的
  // **本地日历日**。跨这两者换算必须显式处理时区，直接把 captured_at 当日历日切分会错位。
  router.get('/metrics', (req, res) => {
    const hours = Math.max(1, Math.min(parseInt(req.query.hours, 10) || 24, 72));
    res.json(validatedSuccess(systemMetricsSeriesSchema, MetricsModel.list(hours)));
  });

  return router;
}
