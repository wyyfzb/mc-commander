import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { success, error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 生成新 Key：mcck- 前缀 + 3 组 8 位随机（服务端自托管格式，无第三方约定） */
function generateApiKey() {
  const rand = crypto.randomBytes(12).toString('hex').slice(0, 24);
  return 'mcck-' + rand.replace(/(.{8})(?=.)/g, '$1-');
}

/** 写回 .env（保留其余键；API_KEY 行不存在则追加），原子写防半截文件 */
function persistApiKey(envPath, newKey) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const newLine = `API_KEY=${newKey}`;
  if (/^API_KEY=.*$/m.test(content)) {
    content = content.replace(/^API_KEY=.*$/m, newLine);
  } else {
    content += (content === '' || content.endsWith('\n') ? '' : '\n') + newLine + '\n';
  }
  const tmp = envPath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, envPath);
}

export function createKeyRoutes() {
  const router = Router();

  // POST /api/rotate-key - API Key 轮换（需当前 Key 鉴权；旧 Key 立即失效）
  router.post('/rotate-key', (req, res) => {
    const newKey = generateApiKey();
    const envPath = path.join(__dirname, '..', '.env');
    try {
      persistApiKey(envPath, newKey);
    } catch (e) {
      return res.status(500).json(error(
        ErrorCodes.SERVER_ERROR,
        'API Key 已生成但 .env 写入失败，请检查服务端目录写权限：' + e.message,
      ));
    }
    config.apiKey = newKey; // 内存即时生效（WS 与 HTTP 共用）
    recordAudit({ action: AuditActions.KEY_ROTATE, targetType: 'api_key', detail: { prefix: newKey.substring(0, 8) + '...' } });
    res.json(success({ apiKey: newKey }, 'API Key 已轮换：旧 Key 立即失效，请立即保存新 Key'));
  });

  return router;
}
