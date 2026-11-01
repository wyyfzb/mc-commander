import { Router } from 'express';
import { perfSnapshotRequestSchema, perfSnapshotResponseSchema } from '@mc-commander/schemas';
import { error, ErrorCodes } from '../utils/response.js';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { collectSnapshot, PerfCaptureError } from '../services/mc-server/perf-collect.js';

/**
 * 性能诊断路由。
 *
 * POST /instances/:id/perf/snapshot —— 取一次快照（同步等到产物落地才返回）。
 *
 * 为什么是 POST 而不是 GET：它会在服务器上**触发一次采集**（`/perf start` 会写盘、
 * `/jfr start` 会开一段 JVM 录制），不是幂等的读取。GET 会被浏览器预取、被重试中间件
 * 重放，一次「看性能」变成连开两段录制。
 *
 * 为什么同步等：整个窗口固定（perf 10 秒 / jfr 15 秒），同步返回能让「点一下 → 出结论」
 * 是一条直线，不需要前端轮询 + 服务端存中间态。代价是单次请求可能占十几秒，
 * 前端那条请求的超时必须相应放大。
 */
export function createPerfRoutes(serverManager) {
  const router = Router();

  router.post(
    '/instances/:id/perf/snapshot',
    validateBody(perfSnapshotRequestSchema),
    asyncHandler(async (req, res) => {
      const instance = serverManager.getInstance(req.params.id);
      if (!instance) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
      }

      let snapshot;
      try {
        snapshot = await collectSnapshot(instance, { kind: req.body.kind });
      } catch (err) {
        if (!(err instanceof PerfCaptureError)) throw err;
        // 三类失败各有各的下一步动作，故按类别映射错误码而不是一律 500：
        // 「没开 RCON」要用户去设置里开，「版本不支持」只能升级，「超时」可以重试
        if (err.kind === 'not-running') {
          return res.status(400).json(error(ErrorCodes.INSTANCE_NOT_RUNNING));
        }
        if (err.kind === 'no-rcon') {
          return res.status(503).json(error(ErrorCodes.RCON_UNAVAILABLE));
        }
        if (err.kind === 'unsupported') {
          // 独立码而非 VALIDATION_ERROR：前端要据此**隐藏重试入口**（重试同一条不存在的
          // 命令不会成功），而通用入参错误该保留重试。判据必须落在码上——前端展示层
          // 会按码覆盖 message，语义放在文案里会被吞掉
          return res.status(400).json(error(ErrorCodes.PERF_UNSUPPORTED, err.message));
        }
        logger.warn(`[${instance.id}] 性能快照采集失败:`, err.message);
        return res.status(500).json(error(ErrorCodes.SERVER_ERROR, err.message));
      }

      // 不落审计：这是只读诊断（产物是 debug/ 下的一次性取样文件，不改变实例配置与存档），
      // 与崩溃产物读取同口径。命令史里留有 `perf start` / `jfr start` 两条，已可追溯来源。
      res.json(validatedSuccess(perfSnapshotResponseSchema, snapshot));
    }),
  );

  return router;
}
