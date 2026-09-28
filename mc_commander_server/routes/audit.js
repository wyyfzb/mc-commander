import { Router } from 'express';
import { parsePagination } from '../utils/pagination.js';
import {
  auditLogsQuerySchema,
  commandHistoryQuerySchema,
  auditLogItemSchema,
  commandHistoryItemSchema,
} from '@mc-commander/schemas';
import { validateQuery, validatedSuccessPaginated } from '../middleware/validate.js';
import { AuditLogModel, CommandHistoryModel } from '../db/index.js';

export function createAuditRoutes() {
  const router = Router();

  // GET /api/v1/audit-logs
  // 查询参数契约（issue 391）：筛选字段 + order（asc/desc，缺省/非法回落 desc，
  // issue 383 向后兼容语义由 schema catch 表达）；page/pageSize 透传给
  // parsePagination（issue 391 分页边界，#392 收敛的解析语义不变）
  router.get('/audit-logs', validateQuery(auditLogsQuerySchema), (req, res, next) => {
    try {
      const { page, pageSize } = parsePagination(req.query);

      const result = AuditLogModel.findAll({
        instanceId: req.query.instanceId,
        action: req.query.action,
        targetType: req.query.targetType,
        startTime: req.query.startTime,
        endTime: req.query.endTime,
        source: req.query.source,
        order: req.query.order,
        page,
        pageSize,
      });

      res.json(
        validatedSuccessPaginated(auditLogItemSchema, result.logs, result.total, page, pageSize),
      );
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/command-history
  router.get('/command-history', validateQuery(commandHistoryQuerySchema), (req, res, next) => {
    try {
      const { page, pageSize } = parsePagination(req.query);

      const result = CommandHistoryModel.findAll({
        instanceId: req.query.instanceId,
        startTime: req.query.startTime,
        endTime: req.query.endTime,
        source: req.query.source,
        page,
        pageSize,
      });

      res.json(
        validatedSuccessPaginated(
          commandHistoryItemSchema,
          result.commands,
          result.total,
          page,
          pageSize,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createAuditRoutes;
