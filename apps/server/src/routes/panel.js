/**
 * 面板自身的去留（认证域内）：清点数据、导出存档、停用。
 *
 * 「彻底删除」不在面板里做——删掉自己正在运行的程序没有安全的收尾点，
 * 且一旦删错无从回滚。面板只负责把用户送到终端那一条命令，并在之前
 * 把「会删什么」按真实内容列清楚。
 */
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { success, error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { logger } from '../utils/logger.js';
import { AdminAccountModel, AdminRecoveryCodeModel } from '../db/index.js';
import { verifyPassword } from '../utils/password.js';
import { verifyTotpCode, normalizeTotpCode } from '../utils/totp.js';
import config from '../config.js';

/** 两类失败都是安装侧缺件，用户改不了，只能告诉他该走哪条路 */
function removalTriggerMessage(raw) {
  if (/not found/i.test(raw)) {
    return '这台机器上没有删除执行单元，面板无法自删。请用部署脚本的 --uninstall 卸载，或重新安装一次以补齐删除单元。';
  }
  if (/password|sudo/i.test(raw)) {
    return '面板没有执行删除的权限（sudo 白名单缺失）。请用部署脚本的 --uninstall 卸载。';
  }
  return `无法启动删除流程：${raw || '未知原因'}`;
}

/** 第二因子校验：配了 2FA 就必须给动态口令或恢复码，没配则不要求 */
function verifySecondFactor(state, rawCode) {
  if (typeof rawCode !== 'string' || rawCode.trim() === '') return { ok: false };
  if (state.secret && normalizeTotpCode(rawCode) !== null) {
    const check = verifyTotpCode(state.secret, rawCode, state.lastStep);
    if (check.ok) {
      AdminAccountModel.setTotpLastStep(check.step);
      return { ok: true };
    }
  }
  if (AdminRecoveryCodeModel.verifyAndConsume(rawCode)) return { ok: true };
  return { ok: false };
}
import { surveyData, collectExportSources } from '../services/panel-lifecycle.js';

export function createPanelRoutes() {
  const router = Router();

  // GET /api/v1/panel/data - 面板当前存了多少东西（设置页「危险区」据此说真话）
  router.get(
    '/panel/data',
    asyncHandler(async (_req, res) => {
      res.json(success({ items: surveyData() }, 'OK'));
    }),
  );

  // GET /api/v1/panel/export - 下载实例与备份的单文件压缩包
  // 用户换机器时要的是一个文件，不是让他理解 var/servers 与 var/backups 的关系
  router.get(
    '/panel/export',
    asyncHandler(async (req, res) => {
      const sources = collectExportSources();
      if (sources.length === 0) {
        return res
          .status(404)
          .json(error(ErrorCodes.NOT_FOUND, '没有可导出的数据（实例目录与备份都是空的）'));
      }
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="mc-commander-backup-${stamp}.tar.gz"`,
      );
      // 直接流式打包：先落盘再发会让 2C 小盘机器在导出时多占一倍空间
      const args = ['-czf', '-', ...sources.flatMap((s) => ['-C', path.dirname(s.dir), s.name])];
      const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      tar.stdout.pipe(res);
      tar.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) logger.warn('panel export tar:', text.slice(0, 200));
      });
      tar.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json(error(ErrorCodes.SERVER_ERROR, '打包失败：系统缺少 tar 命令'));
        } else res.destroy();
      });
      req.on('close', () => tar.kill());
    }),
  );

  // POST /api/v1/panel/stop - 停用面板服务（保留全部数据，随时可重新启用）
  router.post(
    '/panel/stop',
    asyncHandler(async (req, res) => {
      recordAudit({
        action: AuditActions.PANEL_STOP,
        targetType: 'panel',
        targetId: 'panel',
      });
      res.json(success(null, '面板即将停止，数据全部保留'));
      // 响应发出后再停：先停会让用户拿不到这句确认，只看到连接中断
      setTimeout(() => {
        const child = spawn('systemctl', ['stop', 'mc-commander'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }, 800);
    }),
  );

  // GET /api/v1/panel/removal-preview - 彻底删除前要用户确认的全部事实
  // 用户要在这里看到「会删什么、留什么」，而不是删完才知道
  router.get(
    '/panel/removal-preview',
    asyncHandler(async (_req, res) => {
      const survey = surveyData();
      const account = AdminAccountModel.get();
      res.json(
        success({
          items: survey,
          totpEnabled: Boolean(account?.totp_enabled),
          installDir: config.rootDir ?? process.env.MC_COMMANDER_DIR ?? '/opt/mc-commander',
        }),
      );
    }),
  );

  // POST /api/v1/panel/removal - 面板内彻底删除
  //
  // 删除要越过「正在运行的这个进程」：直接在自己内部 rm -rf 会在删到一半时
  // 失去可执行文件与依赖树，留下半删状态且无法回报结果。故由 sudo 触发安装时
  // 预置的 root 一次性单元，由 systemd 在本进程之外执行清理脚本。
  router.post(
    '/panel/removal',
    asyncHandler(async (req, res) => {
      const account = AdminAccountModel.get();
      if (!account) {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, '管理员账号不存在'));
      }
      const { password, code, confirmText, keepData } = req.body || {};

      // 第一因子：登录密码。面板可能暴露在公网，一次误点就删光存档。
      if (!verifyPassword(String(password ?? ''), account.password_hash)) {
        return res.status(401).json(error(ErrorCodes.AUTH_INVALID_CREDENTIALS, '密码错误'));
      }
      // 第二因子：配了 2FA 就要动态口令（未配则跳过，不能强制用户先去开 2FA）
      const totpState = AdminAccountModel.getTotpState();
      if (totpState.enabled && !verifySecondFactor(totpState, code).ok) {
        return res.status(401).json(error(ErrorCodes.AUTH_TOTP_INVALID, '两步验证码错误'));
      }
      // 防手滑：必须逐字输入「彻底删除」
      if (String(confirmText ?? '').trim() !== '彻底删除') {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, '请输入「彻底删除」以确认'));
      }

      recordAudit({
        action: AuditActions.PANEL_STOP,
        targetType: 'panel',
        targetId: 'panel',
        detail: { action: 'removal', keepData: keepData === true },
      });

      // 触发结果必须同步拿到：没启动成功时页面只会静默等下去，用户没有任何其它途径知道。
      // 面板以低权限用户运行、删不掉自己，故触发安装时预置的 root 单元在面板进程外执行。
      const unit =
        keepData === true ? 'mc-commander-removal-keep.service' : 'mc-commander-removal.service';
      // --no-block：oneshot 单元默认要等脚本跑完才返回，而脚本第一步就停掉本进程
      // 用 /usr/bin/systemctl：sudoers 按解析后的真实路径匹配，写 /bin 会不匹配
      const trigger = spawnSync('sudo', ['-n', '/usr/bin/systemctl', 'start', '--no-block', unit], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (trigger.status !== 0) {
        const raw = (trigger.stderr || trigger.error?.message || '').trim().split('\n')[0];
        logger.error('panel removal trigger failed:', raw || `exit ${trigger.status}`);
        return res.status(500).json(error(ErrorCodes.SERVER_ERROR, removalTriggerMessage(raw)));
      }

      res.json(success(null, '已开始清理，完成后本页面会断开'));
    }),
  );

  return router;
}
