import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import config from '../config.js';
import { error, ErrorCodes } from '../utils/response.js';
import { apiKeyRotateResponseSchema } from '@mc-commander/schemas';
import { validatedSuccess } from '../middleware/validate.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { hashToken } from '../utils/password.js';

/** 生成新 Key：前缀 + 3 组 8 位随机（服务端自托管格式，无第三方约定）。
 * 前缀区分凭据种类（mcck = 管理员，mcro = 只读），仅便于运维辨认，鉴权只看摘要 */
function generateApiKey(prefix = 'mcck-') {
  const rand = crypto.randomBytes(12).toString('hex').slice(0, 24);
  return prefix + rand.replace(/(.{8})(?=.)/g, '$1-');
}

/**
 * 写回 .env 哈希（保留其余键；dropPatterns 用于顺带清理明文行——明文 Key 不落盘，
 * 与 index.js 启动迁移同约束），原子写防半截文件，权限 0o600。
 * 路径取 config.envFilePath（dotenv 的同一加载源）——测试可指向临时目录，
 * 不必触碰真实 .env
 */
function persistEnvHash(envPath, envKey, hash, dropPatterns = []) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  for (const pattern of dropPatterns) content = content.replace(pattern, '');
  const newLine = `${envKey}=${hash}`;
  const linePattern = new RegExp(`^${envKey}=.*$`, 'm');
  if (linePattern.test(content)) {
    content = content.replace(linePattern, newLine);
  } else {
    content += (content === '' || content.endsWith('\n') ? '' : '\n') + newLine + '\n';
  }
  const tmp = envPath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 无权限位 */ }
  fs.renameSync(tmp, envPath);
}

function persistApiKeyHash(envPath, hash) {
  persistEnvHash(envPath, 'API_KEY_HASH', hash, [/^API_KEY=.*$/m]);
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
    const newKey = generateApiKey('mcro-');
    const newHash = hashToken(newKey);
    try {
      persistEnvHash(config.envFilePath, 'READONLY_API_KEY_HASH', newHash);
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
