import { Router } from 'express';
import config from '../config.js';
import { error, ErrorCodes } from '../utils/response.js';
import {
  authStatusResponseSchema,
  authSetupResponseSchema,
  authSessionResponseSchema,
  authPasswordChangeResponseSchema,
  authLogoutResponseSchema,
  authSessionsResponseSchema,
  authSessionKickResponseSchema,
  authSetupRequestBodySchema,
  authLoginRequestBodySchema,
  authPasswordChangeRequestBodySchema,
} from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { AdminAccountModel, AdminSessionModel } from '../db/index.js';
import { needsRehash, hashPassword, verifyPassword, hashToken, generateSessionToken } from '../utils/password.js';
import { slidingExpiry } from '../middleware/auth.js';
import { isSetupTokenRequired, verifySetupToken, consumeSetupToken } from '../utils/setup-token.js';
import { toIsoUtc } from '../utils/db-time.js';
import { logger } from '../utils/logger.js';

/**
 * 管理员认证路由（安全主线：单管理员密码登录）
 *
 * - GET    /auth/status      公开  探测是否已设密（登录页首屏）
 * - POST   /auth/setup       公开  首访设密（仅未设密时可用；成功即自动登录）
 *                                  所有权证明约定（#309）：.env 配置了 SETUP_TOKEN 时（公网
 *                                  部署，部署脚本首次部署自动生成），请求必须携带
 *                                  `Authorization: SetupToken <token>`（本文件与
 *                                  utils/setup-token.js 约定的唯一通道；与 Bearer 会话头互不
 *                                  干扰——setup 为公开端点，authMiddleware 直接放行）；校验
 *                                  通过立即作废（内存 + .env，重启后同样失效）；未配置 token
 *                                  时不校验，保持本机首发行为
 * - POST   /auth/login       公开  密码换会话令牌（失败锁定挂靠点）
 * - PUT    /auth/password    认证  改密（验旧密；改后踢掉其余会话）
 * - POST   /auth/logout      认证  登出（删除当前会话；仅会话认证可用）
 * - GET    /auth/sessions    认证  活跃会话列表（踢单设备 UI 数据源）
 * - DELETE /auth/sessions/:id 认证 踢出指定会话
 *
 * 会话令牌：随机 32B → base64url 明文交客户端；服务端仅存 SHA-256 摘要；
 * 滑动续期由认证中间件完成；API Key 通道保留为自动化 / API 调用通道。
 */

/// 密码策略：8–128 位（自托管单管理员场景，长度优先于复杂度规则）
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/// 登录失败锁定：实现在 utils/credential-lockout.js（HTTP 登录与 WS 握手共享
/// 同一份封禁状态——攻击者把失败流量分流到不受限通道无法绕开锁定）
import {
  isLocked as isLoginLocked,
  recordFailure as recordLoginFailure,
  clearFailures as clearLoginFailures,
  resetForTests as resetLoginLockState,
  sizeForTests as _getLoginFailuresSize,
  recordFailureForTests as _recordLoginFailure,
  isLockedForTests as _isLoginLocked,
  clearFailuresForTests as _clearLoginFailures,
} from '../utils/credential-lockout.js';

function clientIp(req) {
  // 登录锁定键始终取直连 IP（socket.remoteAddress），不信任 X-Forwarded-For
  // 代理头可被客户端伪造；req.ip 仍可用于会话记录等非安全场景
  return req.socket?.remoteAddress || null;
}

function validatePasswordStrength(password) {
  return (
    typeof password === 'string' &&
    password.length >= PASSWORD_MIN &&
    password.length <= PASSWORD_MAX
  );
}

/**
 * 解析 `Authorization: SetupToken <token>` 头（setup 所有权证明通道）。
 * scheme 按 RFC 7235 不区分大小写，token 值本身区分大小写；
 * 格式不符/缺失返回 null。
 */
function parseSetupTokenHeader(header) {
  if (typeof header !== 'string') return null;
  const m = /^SetupToken\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

function createSession(req) {
  const token = generateSessionToken();
  // 初始有效期与滑动续期共用同一 cap 语义（P2-11）：ttlMs 配置大于绝对
  // 存活期时初始值不越过绝对重登边界（created_at 取 now，见 slidingExpiry）
  const expiresAt = slidingExpiry({ created_at: new Date().toISOString() });
  const session = AdminSessionModel.create({
    tokenHash: hashToken(token),
    userAgent: req.headers['user-agent']?.slice(0, 200) || null,
    ip: clientIp(req),
    expiresAt,
  });
  // 会话并发上限（P2-11）：新登录挤掉最旧会话（内部先惰性清理过期行）
  AdminSessionModel.enforceLimit(config.adminSession.maxSessions);
  return { token, sessionId: session.id, expiresAt };
}

export function createAuthRoutes() {
  const router = Router();

  // GET /api/v1/auth/status —— 公开：登录页首屏探测
  router.get('/auth/status', (req, res) => {
    res.json(validatedSuccess(authStatusResponseSchema, { hasPassword: AdminAccountModel.isConfigured() }));
  });

  // POST /api/v1/auth/setup —— 公开：首访设密（幂等防护：已设密 409；所有权证明：SETUP_TOKEN）
  // schema 只锁形状（#428）：SetupToken 403 校验在 handler 内先于密码强度 400，
  // 未证明所有权不泄露后续校验语义
  router.post('/auth/setup', validateBody(authSetupRequestBodySchema), (req, res, next) => {
    try {
      if (AdminAccountModel.isConfigured()) {
        return res.status(409).json(error(ErrorCodes.AUTH_ALREADY_CONFIGURED, '管理员密码已设置，请直接登录'));
      }
      // 所有权证明（audit S-P0-1 / #309）：公网部署时「部署完成 → 管理员设密」窗口内
      // 任何发现端口者可抢先设密永久接管面板；配置了 SETUP_TOKEN 则强制校验。
      // token 校验置于密码强度校验之前——未证明所有权不泄露后续校验语义
      const tokenRequired = isSetupTokenRequired();
      if (tokenRequired) {
        const provided = parseSetupTokenHeader(req.headers['authorization']);
        if (!provided || !verifySetupToken(provided)) {
          return res.status(403).json(error(ErrorCodes.AUTH_SETUP_TOKEN_INVALID));
        }
      }
      const { password } = req.body || {};
      if (!validatePasswordStrength(password)) {
        return res.status(400).json(error(
          ErrorCodes.VALIDATION_ERROR,
          `密码长度需在 ${PASSWORD_MIN}-${PASSWORD_MAX} 位之间`,
        ));
      }
      // TOCTOU 说明：better-sqlite3 为同步 API——上方 isConfigured() 检查与此处
      // setPassword() 写入之间无 await，事件循环内原子，无并发竞态窗口；
      // 该保障依赖同步语义（若换异步驱动需改为事务或条件更新）
      AdminAccountModel.setPassword(hashPassword(password));
      // 一次性：设密成功即作废（内存清空 + .env 移除，重启后同样失效）
      if (tokenRequired) {
        const { envRemoved } = consumeSetupToken();
        if (!envRemoved) {
          // best-effort 失败仅告警：内存已作废，本进程内已不可再用
          logger.warn('[auth] SETUP_TOKEN 已作废，但 .env 移除失败（重启前请手动移除 SETUP_TOKEN 行）');
        }
      }
      // 设密即登录：首访向导完成直达面板
      const session = createSession(req);
      recordAudit({ action: AuditActions.AUTH_SETUP, targetType: 'admin', targetId: '1', detail: null });
      res.json(validatedSuccess(authSetupResponseSchema, { hasPassword: true, ...session }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/login —— 公开：密码换会话令牌
  // schema 只锁形状（#428）：弱密码属凭据错误（401 + 失败锁定计数），不升为 400
  router.post('/auth/login', validateBody(authLoginRequestBodySchema), (req, res, next) => {
    try {
      const ip = clientIp(req);
      if (isLoginLocked(ip)) {
        return res.status(429).json(error(ErrorCodes.AUTH_LOGIN_LOCKED, '登录失败次数过多，请稍后再试'));
      }
      if (!AdminAccountModel.isConfigured()) {
        return res.status(400).json(error(ErrorCodes.AUTH_NOT_CONFIGURED, '管理员密码尚未设置，请先完成初始化'));
      }
      const { password } = req.body || {};
      const account = AdminAccountModel.get();
      if (!validatePasswordStrength(password) || !verifyPassword(String(password ?? ''), account.password_hash)) {
        recordLoginFailure(ip);
        return res.status(401).json(error(ErrorCodes.AUTH_INVALID_CREDENTIALS, '密码错误'));
      }
      clearLoginFailures(ip);
      // scrypt 参数透明升级（P2-5）：旧参数（如 2^14）哈希验证成功后立即按
      // 当前参数重哈希，逐步收敛到 OWASP 推荐成本，无需用户改密
      let rehashed = false;
      if (needsRehash(account.password_hash)) {
        AdminAccountModel.setPassword(hashPassword(String(password)));
        rehashed = true;
      }
      const session = createSession(req);
      recordAudit({
        action: AuditActions.AUTH_LOGIN,
        targetType: 'admin',
        targetId: '1',
        detail: { ip: clientIp(req), userAgent: req.headers['user-agent']?.slice(0, 100) || null, rehashed },
      });
      res.json(validatedSuccess(authSessionResponseSchema, session));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/auth/password —— 认证：改密（验旧密；改后踢单设备保留当前）
  // schema 只锁形状（#428）：旧密 401 校验先于新密强度 400，错误呈现顺序保持
  router.put('/auth/password', validateBody(authPasswordChangeRequestBodySchema), (req, res, next) => {
    try {
      const { oldPassword, newPassword } = req.body || {};
      const account = AdminAccountModel.get();
      if (!account) {
        return res.status(400).json(error(ErrorCodes.AUTH_NOT_CONFIGURED, '管理员密码尚未设置'));
      }
      if (!verifyPassword(String(oldPassword ?? ''), account.password_hash)) {
        return res.status(401).json(error(ErrorCodes.AUTH_INVALID_CREDENTIALS, '原密码错误'));
      }
      if (!validatePasswordStrength(newPassword)) {
        return res.status(400).json(error(
          ErrorCodes.VALIDATION_ERROR,
          `新密码长度需在 ${PASSWORD_MIN}-${PASSWORD_MAX} 位之间`,
        ));
      }
      AdminAccountModel.setPassword(hashPassword(newPassword));
      // 改密后踢掉其余会话（当前会话保留，避免把自己登出）
      if (req.auth?.source === 'session') {
        const kicked = AdminSessionModel.deleteAllExcept(req.auth.sessionId);
        recordAudit({
          action: AuditActions.AUTH_PASSWORD_CHANGE,
          targetType: 'admin',
          targetId: '1',
          detail: { kickedSessions: kicked },
        });
        res.json(validatedSuccess(authPasswordChangeResponseSchema, { ok: true, kickedSessions: kicked }));
      } else {
        // API Key 通道改密：无当前会话可保留，全部会话失效
        const kicked = AdminSessionModel.deleteAllExcept('__none__');
        recordAudit({
          action: AuditActions.AUTH_PASSWORD_CHANGE,
          targetType: 'admin',
          targetId: '1',
          detail: { kickedSessions: kicked, via: 'apiKey' },
        });
        res.json(validatedSuccess(authPasswordChangeResponseSchema, { ok: true, kickedSessions: kicked }));
      }
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/logout —— 认证：登出（删除当前会话）
  router.post('/auth/logout', (req, res, next) => {
    try {
      if (req.auth?.source !== 'session') {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, '当前为 API Key 认证，无会话可登出'));
      }
      AdminSessionModel.deleteById(req.auth.sessionId);
      recordAudit({ action: AuditActions.AUTH_LOGOUT, targetType: 'admin', targetId: '1', detail: null });
      res.json(validatedSuccess(authLogoutResponseSchema, { ok: true }));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/auth/sessions —— 认证：活跃会话列表（含 current 标记）
  router.get('/auth/sessions', (req, res, next) => {
    try {
      const sessions = AdminSessionModel.listActive().map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        // created_at/last_seen_at 是 CURRENT_TIMESTAMP 的无时区 UTC 串，
        // 下发前归一化（expires_at 由应用写 ISO，原样通过）
        createdAt: toIsoUtc(s.created_at),
        lastSeenAt: toIsoUtc(s.last_seen_at),
        expiresAt: s.expires_at,
        current: req.auth?.source === 'session' && req.auth.sessionId === s.id,
      }));
      res.json(validatedSuccess(authSessionsResponseSchema, { sessions }));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/auth/sessions/:id —— 认证：踢单设备
  router.delete('/auth/sessions/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      const deleted = AdminSessionModel.deleteById(id);
      if (!deleted) {
        return res.status(404).json(error(ErrorCodes.NOT_FOUND, '会话不存在或已过期'));
      }
      recordAudit({
        action: AuditActions.AUTH_SESSION_KICK,
        targetType: 'admin_session',
        targetId: id,
        detail: { current: req.auth?.sessionId === id },
      });
      res.json(validatedSuccess(authSessionKickResponseSchema, { ok: true, current: req.auth?.sessionId === id }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// 测试钩子（历史消费者从本模块导入）：以具名导入同名再导出，实现已收敛至
// utils/credential-lockout.js
export {
  resetLoginLockState,
  _getLoginFailuresSize,
  _recordLoginFailure,
  _isLoginLocked,
  _clearLoginFailures,
};
