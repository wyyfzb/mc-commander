import { Router } from 'express';
import { successPaginated } from '../utils/response.js';
import { parsePagination } from '../utils/pagination.js';
import { AuditLogModel, CommandHistoryModel } from '../db/index.js';

export function createAuditRoutes() {
  const router = Router();

  // GET /api/v1/audit-logs
  router.get('/audit-logs', (req, res, next) => {
    try {
      const { page, pageSize } = parsePagination(req.query);

      // 排序参数白名单（issue 383）：仅接受 asc/desc，缺省/非法回落 desc（向后兼容）
      const order = req.query.order === 'asc' ? 'asc' : 'desc';

      const result = AuditLogModel.findAll({
        instanceId: req.query.instanceId,
        action: req.query.action,
        targetType: req.query.targetType,
        startTime: req.query.startTime,
        endTime: req.query.endTime,
        source: req.query.source,
        order,
        page,
        pageSize,
      });

      res.json(successPaginated(result.logs, result.total, page, pageSize));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/command-history
  router.get('/command-history', (req, res, next) => {
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

      res.json(successPaginated(result.commands, result.total, page, pageSize));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createAuditRoutes;
