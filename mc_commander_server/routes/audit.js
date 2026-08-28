import { Router } from 'express';
import { successPaginated } from '../utils/response.js';
import { AuditLogModel, CommandHistoryModel } from '../db/index.js';

export function createAuditRoutes() {
  const router = Router();

  // GET /api/v1/audit-logs
  router.get('/audit-logs', (req, res, next) => {
    try {
      let page = parseInt(req.query.page) || 1;
      let pageSize = parseInt(req.query.pageSize) || 20;
      page = Math.max(1, Math.min(page, 1000));
      pageSize = Math.max(1, Math.min(pageSize, 200));

      const result = AuditLogModel.findAll({
        instanceId: req.query.instanceId,
        action: req.query.action,
        targetType: req.query.targetType,
        startTime: req.query.startTime,
        endTime: req.query.endTime,
        source: req.query.source,
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
      let page = parseInt(req.query.page) || 1;
      let pageSize = parseInt(req.query.pageSize) || 20;
      page = Math.max(1, Math.min(page, 1000));
      pageSize = Math.max(1, Math.min(pageSize, 200));

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
