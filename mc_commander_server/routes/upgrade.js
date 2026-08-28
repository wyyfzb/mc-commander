import { Router } from 'express';
import { success, error, ErrorCodes } from '../utils/response.js';
import { recordAudit } from '../utils/audit.js';
import { AuditActions } from '../utils/audit.js';
import { UpgradeService, VALID_TYPES } from '../services/upgrade.service.js';

/**
 * 升级路由（P0-4）
 * POST /instances/:id/upgrade —— 202 异步，WS 推送进度
 * GET /instances/:id/upgrade/status —— 查询当前升级状态
 */
export function createUpgradeRoutes(serverManager) {
  const router = Router();
  const upgradeService = new UpgradeService(serverManager);

  // POST /api/v1/instances/:id/upgrade
  router.post('/instances/:id/upgrade', async (req, res, next) => {
    const { id } = req.params;
    const { mcVersion, type = 'vanilla' } = req.body || {};

    try {
      // 前置校验 1：mcVersion 必填
      if (!mcVersion || typeof mcVersion !== 'string') {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'mcVersion is required'));
      }

      // 前置校验 2：type 白名单
      if (!VALID_TYPES.has(type)) {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, `Invalid type: ${type}. Must be one of: ${[...VALID_TYPES].join(', ')}`));
      }

      // 前置校验 3：实例存在
      const instance = serverManager.getInstance(id);
      if (!instance) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance not found'));
      }

      // 前置校验 4：实例未运行
      if (instance.status === 'running') {
        return res.status(400).json(error(ErrorCodes.INSTANCE_RUNNING, 'Instance must be stopped before upgrade'));
      }

      // 前置校验 5：未升级中
      if (upgradeService.isUpgrading(id)) {
        return res.status(409).json(error(ErrorCodes.UPGRADE_IN_PROGRESS, 'An upgrade is already in progress for this instance'));
      }

      // 前置校验 6：版本不同
      if (instance.mcVersion === mcVersion) {
        return res.status(400).json(error(ErrorCodes.UPGRADE_VERSION_SAME, 'Target version is the same as current version'));
      }

      // 审计埋点
      recordAudit({
        instanceId: id,
        action: AuditActions.INSTANCE_UPGRADE,
        targetId: id,
        detail: JSON.stringify({ from: instance.mcVersion, to: mcVersion, type }),
      });

      // 异步启动升级（不 await）
      upgradeService.upgrade(id, mcVersion, type).catch((err) => {
        console.error(`[UpgradeRoute] Upgrade failed for ${id}:`, err.message);
      });

      return res.status(202).json(success({
        message: 'Upgrade started',
        instanceId: id,
        mcVersion,
        type,
      }));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/instances/:id/upgrade/status
  router.get('/instances/:id/upgrade/status', (req, res) => {
    const { id } = req.params;
    const progress = upgradeService.getUpgradeProgress(id);
    if (!progress) {
      return res.json(success({ upgrading: false }));
    }
    return res.json(success({ upgrading: true, ...progress }));
  });

  return router;
}
