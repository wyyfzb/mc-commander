import { Router } from 'express';
import { systemMetricsSeriesSchema } from '@mc-commander/schemas';
import { MetricsModel } from '../db/metrics.model.js';
import { validatedSuccess } from '../middleware/validate.js';

export function createMetricsRoutes() {
  const router = Router();

  // GET /api/v1/metrics?hours=24 - 分钟级主机指标历史（管理员；未入只读白名单）。
  // 消费方：面板尚未上线，端点先行供 dashboard「昨日摘要」等能力取数。
  // hours 上限 72：保留期 24h，放宽上限只为容忍查询参数笔误不报错。
  router.get('/metrics', (req, res) => {
    const hours = Math.max(1, Math.min(parseInt(req.query.hours, 10) || 24, 72));
    res.json(validatedSuccess(systemMetricsSeriesSchema, MetricsModel.list(hours)));
  });

  return router;
}
