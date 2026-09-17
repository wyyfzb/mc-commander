import { Router } from 'express';
import QRCode from 'qrcode';
import config from '../config.js';
import { error, ErrorCodes } from '../utils/response.js';
import {
  authStatusResponseSchema,
  authCapabilitiesResponseSchema,
  authSetupResponseSchema,
  authSessionResponseSchema,
  authPasswordChangeResponseSchema,
  authLogoutResponseSchema,
  authSessionsResponseSchema,
  authSessionKickResponseSchema,
  authSetupRequestBodySchema,
  authLoginRequestBodySchema,
  authPasswordChangeRequestBodySchema,
  authTotpStatusResponseSchema,
  authTotpEnrollResponseSchema,
  authTotpConfirmRequestBodySchema,
  authTotpConfirmResponseSchema,
  authTotpDisableRequestBodySchema,
  authTotpDisableResponseSchema,
} from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { AdminAccountModel, AdminRecoveryCodeModel, AdminSessionModel } from '../db/index.js';
import { hashPassword, verifyPassword, hashToken, generateSessionToken } from '../utils/password.js';
import { slidingExpiry } from '../middleware/auth.js';
import { isSetupTokenRequired, verifySetupToken, consumeSetupToken } from '../utils/setup-token.js';
import { toIsoUtc } from '../utils/db-time.js';
import { logger } from '../utils/logger.js';
import {
  generateTotpSecret,
  normalizeTotpCode,
  verifyTotpCode,
  buildOtpauthUrl,
} from '../utils/totp.js';
import { generateRecoveryCodes, hashRecoveryCode } from '../utils/recovery-codes.js';

/**
 * 管理员认证路由（安全主线：单管理员密码登录）
 *
 * - GET    /auth/status      公开  探测是否已设密（登录页首屏）
 * - GET    /auth/capabilities 认证 部署能力探测（当前仅 apiKeyEnabled；据此隐藏
 *                                  API Key 轮换入口——该开关是部署配置，公开的 status
 *                                  刻意不回传配置面）
 * - POST   /auth/setup       公开  首访设密（仅未设密时可用；成功即自动登录）
 *                                  所有权证明约定（#309）：.env 配置了 SETUP_TOKEN 时（公网
 *                                  部署，部署脚本首次部署自动生成），请求必须携带
 *                                  `Authorization: SetupToken <token>`（本文件与
 *                                  utils/setup-token.js 约定的唯一通道；与 Bearer 会话头互不
 *                                  干扰——setup 为公开端点，authMiddleware 直接放行）；校验
 *                                  通过立即作废（内存 + .env，重启后同样失效）；未配置 token
 *                                  时不校验，保持本机首发行为
 * - POST   /auth/login       公开  密码换会话令牌（失败锁定挂靠点）；两步验证已挂靠时
 *                                  必须同时提交第二因子（动态口令或恢复码）
 * - PUT    /auth/password    认证  改密（验旧密；改后踢掉其余会话）
 * - POST   /auth/logout      认证  登出（删除当前会话；仅会话认证可用）
 * - GET    /auth/sessions    认证  活跃会话列表（踢单设备 UI 数据源）
 * - DELETE /auth/sessions/:id 认证 踢出指定会话
 * - GET    /auth/totp/status  认证 两步验证状态（不含 secret / 恢复码）
 * - POST   /auth/totp/enroll  认证 生成候选 secret + 二维码（未生效，须 confirm）
 * - POST   /auth/totp/confirm 认证 用动态口令确认挂靠，返回一次性恢复码
 * - POST   /auth/totp/disable 认证 密码 + 第二因子双重确认后关闭
 *
 * 会话令牌：随机 32B → base64url 明文交客户端；服务端仅存 SHA-256 摘要；
 * 滑动续期由认证中间件完成；API Key 通道保留为自动化 / API 调用通道
 * （可用 API_KEY_ENABLED=false 整体关闭）。
 *
 * 两步验证 secret 的静态存储取舍：totp_secret 以**明文**存 SQLite（同库已有
 * 密码哈希）。这是有意的：本面板是自托管单管理员形态，「能读到库文件」的
 * 攻击者已经能改管理员密码哈希/直接调 RCON，加密 secret 只会把防线挪到
 * 「同一台机器上的第二把密钥」（需要新的 env 与轮换设计），并不提升实际
 * 安全水位——本仓因此不自行发明密钥管理机制。可读库文件 = 可生成任意动态
 * 口令，这一点在 README 的信任模型里与「库泄露」同级看待。
 */

/// 密码策略：8–128 位（自托管单管理员场景，长度优先于复杂度规则）
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/// 认证器 App 里的发行方名（otpauth URI 的 issuer 与账户名前缀）
const TOTP_ISSUER = 'MC Commander';
/// 单管理员形态下账户名固定为 admin（仅用于 App 内显示）
const TOTP_ACCOUNT = 'admin';

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

/**
 * 安全档位变更后的会话吊销（与改密同款「保留当前会话」语义）。
 *
 * 为什么两步验证的启用/关闭必须吊销其它会话：2FA 只拦「新的登录」。变更之前
 * 创建的会话（可能已被窃取）若继续有效，就会绕过刚启用的第二因子，一直用到
 * 绝对过期（默认 30 天）——而启用 2FA 的动机通常正是「怀疑密码可能泄露」，
 * 不吊销恰好让新因子在最需要它的时刻完全不起作用（虚假安全感）。
 *
 * 会话通道保留当前会话（避免把正在操作的管理员自己登出）；API Key 通道没有
 * 当前会话可留 ⇒ 全部失效（与改密 API Key 分支同款）。
 * @returns {number} 被吊销的会话数
 */
function revokeOtherSessions(req) {
  const keepId = req.auth?.source === 'session' ? req.auth.sessionId : '__none__';
  return AdminSessionModel.deleteAllExcept(keepId);
}

/**
 * 第二因子校验（login / confirm / disable 共用同一实现，避免三处口径漂移）。
 *
 * 形态分流：6 位数字走动态口令（漂移窗 + 重放防护，命中即写回最后接受步长）；
 * 其余形状走一次性恢复码。两者都失败才算失败。
 *
 * secret 缺失（库被手工改坏）时动态口令不可判，但恢复码仍可用——这保证
 * 「secret 丢失」不会变成无法关闭两步验证的死锁。
 *
 * @param {{secret: string|null, lastStep: number|null}} state
 * @param {string} rawCode
 * @returns {{ ok: boolean, via: 'totp'|'recovery'|null }}
 */
function verifySecondFactor(state, rawCode) {
  if (typeof rawCode !== 'string' || rawCode.trim() === '') return { ok: false, via: null };
  if (state.secret && normalizeTotpCode(rawCode) !== null) {
    const check = verifyTotpCode(state.secret, rawCode, state.lastStep);
    if (check.ok) {
      AdminAccountModel.setTotpLastStep(check.step);
      return { ok: true, via: 'totp' };
    }
  }
  if (AdminRecoveryCodeModel.verifyAndConsume(rawCode)) return { ok: true, via: 'recovery' };
  return { ok: false, via: null };
}

export function createAuthRoutes() {
  const router = Router();

  // GET /api/v1/auth/status —— 公开：登录页首屏探测
  router.get('/auth/status', (req, res) => {
    res.json(validatedSuccess(authStatusResponseSchema, { hasPassword: AdminAccountModel.isConfigured() }));
  });

  // GET /api/v1/auth/capabilities —— 认证：部署能力探测
  //
  // 为什么单开一个受保护端点、而不是往公开的 /auth/status 加字段：那是未认证可达的
  // 信息面，部署配置不该出现在那里（status 只答「是否已设密」）。本端点落在
  // authMiddleware 的公开白名单之外，未认证一律 401。
  //
  // 只暴露「通道开关 + 凭据是否已配置」：客户端据此决定「API Key 轮换」与
  // 「只读凭据生成/轮换」入口的可见性与文案（未配置 = 首次生成，已配置 = 轮换）。
  // 部署配置的其余部分（路径、端口、后端开关等）不属本契约，勿顺手加入。
  router.get('/auth/capabilities', (req, res) => {
    res.json(validatedSuccess(authCapabilitiesResponseSchema, {
      apiKeyEnabled: config.apiKeyEnabled,
      readonlyApiKeyEnabled: config.readonlyApiKeyEnabled,
      // 只答「有没有配置」这一事实，不返回摘要本身（哈希也不外泄）
      readonlyApiKeyConfigured: Boolean(config.readonlyApiKeyHash),
    }));
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

      // 第二因子（RFC 6238 动态口令 / 一次性恢复码）。顺序刻意在密码校验之后：
      // 未通过密码者拿不到「该账号是否启用两步验证」这一信息面。
      const totpState = AdminAccountModel.getTotpState();
      let secondFactorVia = null;
      if (totpState.enabled) {
        const rawCode = req.body?.totpCode;
        if (typeof rawCode !== 'string' || rawCode.trim() === '') {
          // 密码正确但未带第二因子：可区分的「需要验证码」响应，不签发会话、
          // 不计失败（用户只是还没输入，不是一次错误尝试），也不清失败计数
          // （清计数只在完整认证成功后发生）
          return res.status(401).json(error(
            ErrorCodes.AUTH_TOTP_REQUIRED,
            '请输入两步验证码或恢复码',
          ));
        }
        const verified = verifySecondFactor(totpState, rawCode);
        if (!verified.ok) {
          // 第二因子失败与密码失败共用同一封禁计数（口径：6 位码错误同样计入）
          recordLoginFailure(ip);
          return res.status(401).json(error(
            ErrorCodes.AUTH_TOTP_INVALID,
            '两步验证码或恢复码错误',
          ));
        }
        secondFactorVia = verified.via;
      }

      clearLoginFailures(ip);
      const session = createSession(req);
      recordAudit({
        action: AuditActions.AUTH_LOGIN,
        targetType: 'admin',
        targetId: '1',
        detail: {
          ip: clientIp(req),
          userAgent: req.headers['user-agent']?.slice(0, 100) || null,
          // 走恢复码登录的事实必须留痕：一枚恢复码被消耗是不可逆的资源变化
          secondFactor: secondFactorVia,
        },
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

  // ── TOTP 两步验证（RFC 6238）。此组端点全部落在鉴权域内：authMiddleware 的
  // 公开白名单只有 status/setup/login，其余一律要求会话或 API Key ──

  // GET /api/v1/auth/totp/status —— 认证：状态（永不返回 secret 与恢复码明文）
  router.get('/auth/totp/status', (req, res, next) => {
    try {
      const state = AdminAccountModel.getTotpState();
      res.json(validatedSuccess(authTotpStatusResponseSchema, {
        enabled: state.enabled,
        // 库里是 CURRENT_TIMESTAMP 的无时区 UTC 串，下发前补时区标记
        confirmedAt: toIsoUtc(state.confirmedAt),
        recoveryCodesRemaining: AdminRecoveryCodeModel.countRemaining(),
      }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/totp/enroll —— 认证：生成候选 secret + otpauth URI + 二维码
  // 只写候选 secret，启用位保持 0：扫码/抄写正确性必须靠 confirm 的一次动态口令
  // 自证，否则一个抄错的 secret 会把管理员永久挡在门外
  router.post('/auth/totp/enroll', asyncHandler(async (req, res) => {
    // 未设密时 admin_account 无行：beginTotpEnrollment 会更新 0 行，若不拦截就会
    // 返回一个从未落库的 secret（随后 confirm 必然 400），故先按未初始化处理
    if (!AdminAccountModel.isConfigured()) {
      return res.status(400).json(error(ErrorCodes.AUTH_NOT_CONFIGURED, '管理员密码尚未设置，请先完成初始化'));
    }
    const state = AdminAccountModel.getTotpState();
    if (state.enabled) {
      // 已启用时拒绝重新挂靠：静默替换 secret 会让正在使用的认证器失效，
      // 而管理员可能并未意识到自己被降级/锁死。关闭要走 disable
      return res.status(409).json(error(ErrorCodes.AUTH_TOTP_ALREADY_ENABLED));
    }
    const secret = generateTotpSecret();
    AdminAccountModel.beginTotpEnrollment(secret);
    const otpauthUrl = buildOtpauthUrl({ secret, issuer: TOTP_ISSUER, account: TOTP_ACCOUNT });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      // 纠错档 M（~15%）：手机拍屏场景的常见选择，再高一档会显著增密影响小尺寸识别
      errorCorrectionLevel: 'M',
      // 留白 1 模块：认证器对极窄静默区的识别率不稳定，1 是经验下限
      margin: 1,
      width: 240,
    });
    recordAudit({
      action: AuditActions.AUTH_TOTP_ENROLL,
      targetType: 'admin',
      targetId: '1',
      detail: { ip: clientIp(req) },
    });
    // secret 明文仅在本次响应出现（审计日志不含 secret）
    res.json(validatedSuccess(authTotpEnrollResponseSchema, { secret, otpauthUrl, qrDataUrl }));
  }));

  // POST /api/v1/auth/totp/confirm —— 认证：动态口令确认挂靠；恢复码明文的唯一出口
  router.post('/auth/totp/confirm', validateBody(authTotpConfirmRequestBodySchema), (req, res, next) => {
    try {
      const ip = clientIp(req);
      if (isLoginLocked(ip)) {
        return res.status(429).json(error(ErrorCodes.AUTH_LOGIN_LOCKED, '登录失败次数过多，请稍后再试'));
      }
      const state = AdminAccountModel.getTotpState();
      if (state.enabled) {
        return res.status(409).json(error(ErrorCodes.AUTH_TOTP_ALREADY_ENABLED));
      }
      if (!state.secret) {
        return res.status(400).json(error(ErrorCodes.AUTH_TOTP_NOT_ENROLLED));
      }
      const { code } = req.body || {};
      const check = verifyTotpCode(state.secret, code, state.lastStep);
      if (!check.ok) {
        // 挂靠确认处的错误码尝试与登录处同源：错误尝试同样计入封禁计数
        recordLoginFailure(ip);
        return res.status(401).json(error(ErrorCodes.AUTH_TOTP_INVALID, '两步验证码错误'));
      }
      AdminAccountModel.setTotpLastStep(check.step);
      AdminAccountModel.confirmTotp();
      const recoveryCodes = generateRecoveryCodes();
      AdminRecoveryCodeModel.replaceAll(recoveryCodes.map((c) => hashRecoveryCode(c)));
      // 启用新因子后吊销其它会话：否则变更前创建的（可能已被窃取的）会话绕过 2FA
      const kicked = revokeOtherSessions(req);
      clearLoginFailures(ip);
      recordAudit({
        action: AuditActions.AUTH_TOTP_CONFIRM,
        targetType: 'admin',
        targetId: '1',
        detail: { ip, recoveryCodesIssued: recoveryCodes.length, kickedSessions: kicked },
      });
      const confirmed = AdminAccountModel.getTotpState().confirmedAt;
      res.json(validatedSuccess(authTotpConfirmResponseSchema, {
        enabled: true,
        confirmedAt: toIsoUtc(confirmed),
        recoveryCodes,
      }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/totp/disable —— 认证：关闭两步验证（降级安全档，必须双证）
  //
  // 为什么密码与第二因子都要：这是**唯一**能在没有第二因子的情况下把账号
  // 降回单因素的入口，只验密码等于「一个被偷的密码就能拆掉第二因子」；
  // 只验码则等于把关闭权交给一个可能被临时拿到手机的人。
  //
  // 第二因子接受「当前动态口令 或 一枚未用恢复码」：否则丢了手机的用户即使
  // 靠恢复码登录成功，也永远无法关闭/重挂两步验证（enroll 在启用态被拒），
  // 形成死锁。恢复码被用于关闭时同样置 used_at（一次性语义不变）。
  router.post('/auth/totp/disable', validateBody(authTotpDisableRequestBodySchema), (req, res, next) => {
    try {
      const ip = clientIp(req);
      if (isLoginLocked(ip)) {
        return res.status(429).json(error(ErrorCodes.AUTH_LOGIN_LOCKED, '登录失败次数过多，请稍后再试'));
      }
      const account = AdminAccountModel.get();
      if (!account) {
        return res.status(400).json(error(ErrorCodes.AUTH_NOT_CONFIGURED, '管理员密码尚未设置'));
      }
      const state = AdminAccountModel.getTotpState();
      if (!state.enabled) {
        return res.status(400).json(error(ErrorCodes.AUTH_TOTP_NOT_ENROLLED));
      }
      const { password, code } = req.body || {};
      if (!verifyPassword(String(password ?? ''), account.password_hash)) {
        recordLoginFailure(ip);
        return res.status(401).json(error(ErrorCodes.AUTH_INVALID_CREDENTIALS, '密码错误'));
      }
      const verified = verifySecondFactor(state, code);
      if (!verified.ok) {
        recordLoginFailure(ip);
        return res.status(401).json(error(ErrorCodes.AUTH_TOTP_INVALID, '两步验证码或恢复码错误'));
      }
      AdminAccountModel.disableTotp();
      // 恢复码随挂靠一并作废：留在库里等于给「已关闭两步验证」的账号留一批
      // 仍可通过 login 第二因子分支的凭据
      const revoked = AdminRecoveryCodeModel.deleteAll();
      // 关闭同样是安全档位变更：吊销其它会话，避免降级期间遗留的高权限会话
      const kicked = revokeOtherSessions(req);
      clearLoginFailures(ip);
      recordAudit({
        action: AuditActions.AUTH_TOTP_DISABLE,
        targetType: 'admin',
        targetId: '1',
        detail: { ip, via: verified.via, recoveryCodesRevoked: revoked, kickedSessions: kicked },
      });
      res.json(validatedSuccess(authTotpDisableResponseSchema, { ok: true }));
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
