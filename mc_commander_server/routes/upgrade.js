import { Router } from 'express';
import { error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { UpgradeService, MC_VERSION_REGEX } from '../services/upgrade.service.js';
import { upgradeRequestSchema, upgradeStartResponseSchema, upgradeStatusResponseSchema } from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';

/**
 * 升级路由（P0-4）
 * POST /instances/:id/upgrade —— 202 异步，WS 推送进度
 * GET /instances/:id/upgrade/status —— 查询当前升级状态
 *
 * 请求体契约（issue 391）：mcVersion 必填 + type 枚举（vanilla/paper/purpur，
 * 缺省归一 vanilla）由 upgradeRequestSchema 统一校验（非法 400 VALIDATION_ERROR
 * + 结构化 details）；点分版本白名单属服务层纵深防御口径，保留在路由内。
 */
export function createUpgradeRoutes(serverManager) {
  const router = Router();
  const upgradeService = new UpgradeService(serverManager);

  // POST /api/v1/instances/:id/upgrade
  router.post('/instances/:id/upgrade', validateBody(upgradeRequestSchema), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { mcVersion, type } = req.body;

    // 白名单校验（S-P0-2）：仅允许点分数字版本形态，
    // 杜绝 '../../'、绝对路径、URL 特殊字符等 payload 进入文件名与上游 URL。
    // 正则从服务层导入，与服务层纵深防御同一口径。
    if (!MC_VERSION_REGEX.test(mcVersion)) {
      return res.status(400).json(
        error(ErrorCodes.VALIDATION_ERROR, `Invalid mcVersion: ${mcVersion}. Expected dotted numeric version like 1.21.4`)
      );
    }

    // 前置校验：实例存在
    const instance = serverManager.getInstance(id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance not found'));
    }

    // 前置校验：实例未运行（INSTANCE_RUNNING 语义 = 409 CONFLICT）
    if (instance.status === 'running') {
      return res.status(ErrorCodes.INSTANCE_RUNNING.status).json(error(ErrorCodes.INSTANCE_RUNNING, 'Instance must be stopped before upgrade'));
    }

    // 前置校验：未升级中
    if (upgradeService.isUpgrading(id)) {
      return res.status(409).json(error(ErrorCodes.UPGRADE_IN_PROGRESS, 'An upgrade is already in progress for this instance'));
    }

    // 前置校验：版本不同
    if (instance.mcVersion === mcVersion) {
      return res.status(400).json(error(ErrorCodes.UPGRADE_VERSION_SAME, 'Target version is the same as current version'));
    }

    // 审计埋点（AuditLogModel.create 内部统一 stringify，这里传原始对象）
    recordAudit({
      instanceId: id,
      action: AuditActions.INSTANCE_UPGRADE,
      targetId: id,
      detail: { from: instance.mcVersion, to: mcVersion, type },
    });

    // 异步启动升级（不 await）
    upgradeService.upgrade(id, mcVersion, type).catch((err) => {
      logger.error(`[UpgradeRoute] Upgrade failed for ${id}:`, err.message);
    });

    return res.status(202).json(validatedSuccess(upgradeStartResponseSchema, {
      message: 'Upgrade started',
      instanceId: id,
      mcVersion,
      type,
    }));
  }));

  // GET /api/v1/instances/:id/upgrade/status
  router.get('/instances/:id/upgrade/status', (req, res) => {
    const { id } = req.params;
    const progress = upgradeService.getUpgradeProgress(id);
    if (!progress) {
      return res.json(validatedSuccess(upgradeStatusResponseSchema, { upgrading: false }));
    }
    return res.json(validatedSuccess(upgradeStatusResponseSchema, { upgrading: true, ...progress }));
  });

  return router;
}
