import { Router } from 'express';
import { error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { UpgradeService, MC_VERSION_REGEX } from '../services/upgrade.service.js';
import {
  upgradeRequestSchema,
  upgradeStartResponseSchema,
  upgradeCancelResponseSchema,
  upgradeStatusResponseSchema,
} from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { cancelTask, TASK_KINDS } from '../utils/cancellable-task.js';

/**
 * 升级路由
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
  router.post(
    '/instances/:id/upgrade',
    validateBody(upgradeRequestSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const { mcVersion, type } = req.body;

      // 白名单校验：仅允许点分数字版本形态，
      // 杜绝 '../../'、绝对路径、URL 特殊字符等 payload 进入文件名与上游 URL。
      // 正则从服务层导入，与服务层纵深防御同一口径。
      if (!MC_VERSION_REGEX.test(mcVersion)) {
        return res
          .status(400)
          .json(
            error(
              ErrorCodes.VALIDATION_ERROR,
              `Invalid mcVersion: ${mcVersion}. Expected dotted numeric version like 1.21.4`,
            ),
          );
      }

      // 前置校验：实例存在
      const instance = serverManager.getInstance(id);
      if (!instance) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance not found'));
      }

      // 前置校验：实例未运行（INSTANCE_RUNNING 语义 = 409 CONFLICT）。
      // 判据是实例自身的 isRunning——实例上没有 status 字段（那是状态 DTO 的字段），
      // 误读会让这道守卫恒假，运行中也能发起升级（替换正在被 MC 占用的文件）
      if (instance.isRunning) {
        return res
          .status(ErrorCodes.INSTANCE_RUNNING.status)
          .json(error(ErrorCodes.INSTANCE_RUNNING, 'Instance must be stopped before upgrade'));
      }

      // 前置校验：未升级中
      if (upgradeService.isUpgrading(id)) {
        return res
          .status(409)
          .json(
            error(
              ErrorCodes.UPGRADE_IN_PROGRESS,
              'An upgrade is already in progress for this instance',
            ),
          );
      }

      // 前置校验：版本不同
      if (instance.mcVersion === mcVersion) {
        return res
          .status(400)
          .json(
            error(ErrorCodes.UPGRADE_VERSION_SAME, 'Target version is the same as current version'),
          );
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

      return res.status(202).json(
        validatedSuccess(upgradeStartResponseSchema, {
          message: 'Upgrade started',
          instanceId: id,
          mcVersion,
          type,
        }),
      );
    }),
  );

  // GET /api/v1/instances/:id/upgrade/status
  router.get('/instances/:id/upgrade/status', (req, res) => {
    const { id } = req.params;
    const progress = upgradeService.getUpgradeProgress(id);
    if (!progress) {
      return res.json(validatedSuccess(upgradeStatusResponseSchema, { upgrading: false }));
    }
    return res.json(
      validatedSuccess(upgradeStatusResponseSchema, { upgrading: true, ...progress }),
    );
  });

  /**
   * 取消在途升级（用户中断）：中断备份等待 / 下载 / 首启校验。
   * 归属由路径参数给出（与升级本身同一把 id），服务端按 id 精确匹配注册表，
   * 不做「取消当前那个」的推断。
   * 响应只表示「已受理中断」：替换阶段之后的取消会在服务端回滚到旧版本，实际结果由
   * cancelled/rolled_back/failed 终态事件给出，客户端据终态事件判定。
   */
  router.post('/instances/:id/upgrade/cancel', (req, res) => {
    const { id } = req.params;
    if (!cancelTask(TASK_KINDS.UPGRADE, id)) {
      return res
        .status(ErrorCodes.UPGRADE_NOT_IN_PROGRESS.status)
        .json(
          error(ErrorCodes.UPGRADE_NOT_IN_PROGRESS, `No upgrade in progress for instance ${id}`),
        );
    }
    logger.info(`[UpgradeRoute] Upgrade cancellation requested for ${id}`);
    return res.json(
      validatedSuccess(upgradeCancelResponseSchema, { instanceId: id, cancelled: true }),
    );
  });

  return router;
}
