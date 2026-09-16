import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import config from '../config.js';
import { error, ErrorCodes } from '../utils/response.js';
import { apiKeyRotateResponseSchema } from '@mc-commander/schemas';
import { validatedSuccess } from '../middleware/validate.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { hashToken } from '../utils/password.js';

/** 生成新 Key：mcck- 前缀 + 3 组 8 位随机（服务端自托管格式，无第三方约定） */
function generateApiKey() {
  const rand = crypto.randomBytes(12).toString('hex').slice(0, 24);
  return 'mcck-' + rand.replace(/(.{8})(?=.)/g, '$1-');
}

/**
 * 写回 .env 哈希（保留其余键；明文 API_KEY 行不落盘，与 index.js 启动迁移同约束），
 * 原子写防半截文件，权限 0o600。
 * 路径取 config.envFilePath（dotenv 的同一加载源）——测试可指向临时目录，
 * 不必触碰真实 .env
 */
function persistApiKeyHash(envPath, hash) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  content = content.replace(/^API_KEY=.*$/m, '');
  const newLine = `API_KEY_HASH=${hash}`;
  if (/^API_KEY_HASH=.*$/m.test(content)) {
    content = content.replace(/^API_KEY_HASH=.*$/m, newLine);
  } else {
    content += (content === '' || content.endsWith('\n') ? '' : '\n') + newLine + '\n';
  }
  const tmp = envPath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 无权限位 */ }
  fs.renameSync(tmp, envPath);
}

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

  return router;
}
