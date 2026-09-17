import { Router } from 'express';
import config from '../config.js';
import { error, ErrorCodes } from '../utils/response.js';
import { apiKeyRotateResponseSchema } from '@mc-commander/schemas';
import { validatedSuccess } from '../middleware/validate.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { hashToken } from '../utils/password.js';
import {
  generateApiKey,
  persistApiKeyHash,
  persistEnvLine,
  READONLY_KEY_PREFIX,
} from '../utils/credentials.js';

export function createKeyRoutes() {
  const router = Router();

  // POST /api/rotate-key - API Key 轮换（需当前 Key 鉴权；旧 Key 立即失效）
  router.post('/rotate-key', (req, res) => {
    // 通道关闭时必须在**任何写文件动作之前**拒绝：否则会话通道仍可轮换，产出
    // 一把立刻不可用的 Key，同时把 .env 里的 API_KEY_HASH 覆写掉——「暂时关闭
    // 通道」会变成「永久作废旧凭据」，与 config.js/README 承诺的「哈希保留、
    // 重开即恢复」直接矛盾。错误码与鉴权处的关闭提示同源
    if (!config.apiKeyEnabled) {
      return res.status(403).json(error(
        ErrorCodes.API_KEY_DISABLED,
        'API Key 通道已关闭，无法轮换；如需自动化凭据请先启用该通道',
      ));
    }
    const newKey = generateApiKey();
    const newHash = hashToken(newKey);
    try {
      persistApiKeyHash(config.envFilePath, newHash);
    } catch {
      return res.status(500).json(error(
        ErrorCodes.SERVER_ERROR,
        'API Key 已生成但 .env 写入失败，请检查服务端目录写权限后重试',
      ));
    }
    config.apiKeyHash = newHash;
    recordAudit({ action: AuditActions.KEY_ROTATE, targetType: 'api_key', detail: { prefix: newKey.substring(0, 8) + '...' } });
    res.json(validatedSuccess(apiKeyRotateResponseSchema, { apiKey: newKey }, 'API Key 已轮换：旧 Key 立即失效，请立即保存新 Key'));
  });

  // POST /api/rotate-readonly-key - 只读 Key 轮换（仅管理员可达：该端点不在只读
  // 白名单内，角色门对只读凭据一律 403，故只读凭据无法自我提权或替换同类凭据）
  router.post('/rotate-readonly-key', (req, res) => {
    // 与 rotate-key 同款：通道关闭时必须在**任何写文件动作之前**拒绝，否则产出
    // 一把立刻不可用的 Key，还把 .env 里的 READONLY_API_KEY_HASH 覆写成「关闭态下
    // 无人能用」的新值——「暂时关闭」会变成「永久作废旧凭据」
    if (!config.readonlyApiKeyEnabled) {
      return res.status(403).json(error(
        ErrorCodes.READONLY_API_KEY_DISABLED,
        '只读 API Key 通道已关闭，无法轮换；如需只读凭据请先启用该通道',
      ));
    }
    const newKey = generateApiKey(READONLY_KEY_PREFIX);
    const newHash = hashToken(newKey);
    try {
      persistEnvLine(config.envFilePath, 'READONLY_API_KEY_HASH', newHash);
    } catch {
      return res.status(500).json(error(
        ErrorCodes.SERVER_ERROR,
        '只读 API Key 已生成但 .env 写入失败，请检查服务端目录写权限后重试',
      ));
    }
    config.readonlyApiKeyHash = newHash;
    recordAudit({ action: AuditActions.KEY_ROTATE, targetType: 'readonly_api_key', detail: { prefix: newKey.substring(0, 8) + '...' } });
    res.json(validatedSuccess(apiKeyRotateResponseSchema, { apiKey: newKey }, '只读 API Key 已轮换：旧只读 Key 立即失效，请立即保存新 Key'));
  });

  return router;
}
