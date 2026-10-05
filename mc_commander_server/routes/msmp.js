import { Router } from 'express';
import { error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import {
  pushChannelRequestBodySchema,
  pushChannelStateSchema,
  pushChannelToggleResponseSchema,
} from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { readPushChannelState, setPushChannel } from '../services/msmp.service.js';

/**
 * 推送通道（MSMP）路由。
 *
 * 专用端点而非把 `management-server-*` 加进 properties 白名单：那三项必须**一起写**
 * （只写 enabled 会让服务器起不来），而通用 PUT 是逐键语义，表达不了这个原子约束。
 * 详见 services/msmp.service.js 文件头。
 *
 * GET  /instances/:id/push-channel —— 读当前状态（供界面显示，含绑定主机以提示暴露面）
 * POST /instances/:id/push-channel —— 开/关（原子写；运行中则需重启生效）
 */
export function createMsmpRoutes(serverManager) {
  const router = Router();

  router.get(
    '/instances/:id/push-channel',
    asyncHandler(async (req, res) => {
      const instance = serverManager.getInstance(req.params.id);
      if (!instance) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
      }
      res.json(validatedSuccess(pushChannelStateSchema, readPushChannelState(instance)));
    }),
  );

  router.post(
    '/instances/:id/push-channel',
    validateBody(pushChannelRequestBodySchema),
    asyncHandler(async (req, res) => {
      const instance = serverManager.getInstance(req.params.id);
      if (!instance) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
      }

      const { enabled } = req.body;
      const result = setPushChannel(instance, enabled);

      // 配置写入落审计：这是「新增一个网络监听面」这类动作，事后要能回答是谁开的
      recordAudit({
        instanceId: instance.id,
        action: enabled ? AuditActions.PUSH_CHANNEL_ENABLE : AuditActions.PUSH_CHANNEL_DISABLE,
        targetId: instance.id,
        detail: { enabled, secretGenerated: result.secretGenerated },
      });

      res.json(
        validatedSuccess(
          pushChannelToggleResponseSchema,
          result,
          enabled ? 'Push channel enabled' : 'Push channel disabled',
        ),
      );
    }),
  );

  return router;
}
