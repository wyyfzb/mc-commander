import { Router } from 'express';
import config from '../config.js';
import { success, error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { AdminAccountModel, AdminSessionModel } from '../db/index.js';
import { hashPassword, verifyPassword, hashToken, generateSessionToken } from '../utils/password.js';

/**
 * 管理员认证路由（安全主线：单管理员密码登录）
 *
 * - GET    /auth/status      公开  探测是否已设密（登录页首屏）
 * - POST   /auth/setup       公开  首访设密（仅未设密时可用；成功即自动登录）
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

/// 登录失败锁定（内存级，进程重启即清零；配合全局速率限流双层防护）
const loginFailures = new Map(); // key: ip → { count, lockedUntil }

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function isLoginLocked(ip) {
  const f = loginFailures.get(ip);
  return Boolean(f?.lockedUntil && f.lockedUntil > Date.now());
}

function recordLoginFailure(ip) {
  const f = loginFailures.get(ip) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= config.adminSession.loginLockMaxFails) {
    f.lockedUntil = Date.now() + config.adminSession.loginLockMs;
  }
  loginFailures.set(ip, f);
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function validatePasswordStrength(password) {
  return (
    typeof password === 'string' &&
    password.length >= PASSWORD_MIN &&
    password.length <= PASSWORD_MAX
  );
}

function createSession(req) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.adminSession.ttlMs).toISOString();
  const session = AdminSessionModel.create({
    tokenHash: hashToken(token),
    userAgent: req.headers['user-agent']?.slice(0, 200) || null,
    ip: clientIp(req),
    expiresAt,
  });
  return { token, sessionId: session.id, expiresAt };
}

export function createAuthRoutes() {
  const router = Router();

  // GET /api/v1/auth/status —— 公开：登录页首屏探测
  router.get('/auth/status', (req, res) => {
    res.json(success({ hasPassword: AdminAccountModel.isConfigured() }));
  });

  // POST /api/v1/auth/setup —— 公开：首访设密（幂等防护：已设密 409）
  router.post('/auth/setup', (req, res, next) => {
    try {
      if (AdminAccountModel.isConfigured()) {
        return res.status(409).json(error(ErrorCodes.AUTH_ALREADY_CONFIGURED, '管理员密码已设置，请直接登录'));
      }
      const { password } = req.body || {};
      if (!validatePasswordStrength(password)) {
        return res.status(400).json(error(
          ErrorCodes.VALIDATION_ERROR,
          `密码长度需在 ${PASSWORD_MIN}-${PASSWORD_MAX} 位之间`,
        ));
      }
      AdminAccountModel.setPassword(hashPassword(password));
      // 设密即登录：首访向导完成直达面板
      const session = createSession(req);
      recordAudit({ action: AuditActions.AUTH_SETUP, targetType: 'admin', targetId: '1', detail: null });
      res.json(success({ hasPassword: true, ...session }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/login —— 公开：密码换会话令牌
  router.post('/auth/login', (req, res, next) => {
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
      const session = createSession(req);
      recordAudit({
        action: AuditActions.AUTH_LOGIN,
        targetType: 'admin',
        targetId: '1',
        detail: { ip: clientIp(req), userAgent: req.headers['user-agent']?.slice(0, 100) || null },
      });
      res.json(success(session));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/auth/password —— 认证：改密（验旧密；改后踢单设备保留当前）
  router.put('/auth/password', (req, res, next) => {
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
        res.json(success({ ok: true, kickedSessions: kicked }));
      } else {
        // API Key 通道改密：无当前会话可保留，全部会话失效
        const kicked = AdminSessionModel.deleteAllExcept('__none__');
        recordAudit({
          action: AuditActions.AUTH_PASSWORD_CHANGE,
          targetType: 'admin',
          targetId: '1',
          detail: { kickedSessions: kicked, via: 'apiKey' },
        });
        res.json(success({ ok: true, kickedSessions: kicked }));
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
      res.json(success({ ok: true }));
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
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        current: req.auth?.source === 'session' && req.auth.sessionId === s.id,
      }));
      res.json(success({ sessions }));
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
      res.json(success({ ok: true, current: req.auth?.sessionId === id }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** 测试钩子：清空登录失败锁定状态（生产代码不调用；进程重启同样等效清零） */
export function resetLoginLockState() {
  loginFailures.clear();
}
