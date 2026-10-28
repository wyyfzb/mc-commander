/**
 * 面板自身的去留（认证域内）：清点数据、导出存档、停用。
 *
 * 「彻底删除」不在面板里做——删掉自己正在运行的程序没有安全的收尾点，
 * 且一旦删错无从回滚。面板只负责把用户送到终端那一条命令，并在之前
 * 把「会删什么」按真实内容列清楚。
 */
import fs from 'node:fs';
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
      // tar 的失败形态很隐蔽：某个成员 stat 不到时它只报 stderr 并以非 0 退出，
      // stdout 仍是一段**合法的空 gzip**。不查退出码，用户会下载到一个「能解开、
      // 里面什么都没有」的包，还看到「备份已下载」。
      tar.on('close', (code) => {
        if (code === 0) return;
        logger.error(`[Panel] 导出打包失败（tar 退出码 ${code}）`);
        if (res.headersSent) res.destroy();
        else res.status(500).json(error(ErrorCodes.SERVER_ERROR, `打包失败：tar 退出码 ${code}`));
      });
      req.on('close', () => tar.kill());
    }),
  );

  // POST /api/v1/panel/stop - 停用面板服务（保留全部数据，随时可重新启用）
  //
  // 三步：先用 `sudo -l` 只校验权限（不执行），权限不足就当场报错；
  // 再回话；最后 detached 执行真正的 stop。顺序不能换——
  // 直接执行会在回包前把进程自己 SIGTERM 掉，前端只看到连接中断、拿不到任何结论；
  // 而像以前那样先回 200 再 spawn、且不看退出码，权限不足时用户永远不知道面板没停
  // （面板以 mc-commander 身份运行，stop 默认要交互式认证，必然退出码 1）。
  router.post(
    '/panel/stop',
    asyncHandler(async (req, res) => {
      const args = ['-n', 'systemctl', 'stop', 'mc-commander.service'];
      // `sudo -l <命令> <参数…>` 里首个参数是可执行文件路径、其后是参数，不能再写一遍命令名
      const probe = spawnSync(
        'sudo',
        ['-n', '-l', '/usr/bin/systemctl', 'stop', 'mc-commander.service'],
        {
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      if (probe.status !== 0) {
        const raw = `${probe.stderr || probe.stdout || ''}`.trim() || `退出码 ${probe.status}`;
        logger.error(`[Panel] 无停止面板的权限：${raw}`);
        return res
          .status(500)
          .json(
            error(
              ErrorCodes.SERVER_ERROR,
              '面板没有停止自身的权限（sudo 白名单缺失）。请用部署脚本的 --uninstall 卸载，或重新安装一次以补齐权限。',
            ),
          );
      }
      recordAudit({
        action: AuditActions.PANEL_STOP,
        targetType: 'panel',
        targetId: 'panel',
      });
      res.json(success(null, '面板已停止，数据全部保留'));
      // 响应发出后再停：先停会让用户拿不到这句确认，只看到连接中断
      setTimeout(() => {
        const child = spawn('sudo', args, { detached: true, stdio: 'ignore' });
        child.unref();
      }, 800);
    }),
  );

  // POST /api/v1/panel/update - 面板内自更新
  //
  // 更新要把 node_modules 清空重建，而面板自己就是那个「依赖被抽走却还在服务」
  // 的进程；它一旦中途退出，就再没有东西能执行回滚。故由 sudo 触发安装时预置的
  // root 一次性单元，在面板进程之外完成「停 → 换代码 → 重装依赖 → 起 → 验版本」。
  //
  // 版本号只接受形如 v0.10.4 的 tag：它会被拼进下载 URL，
  // 放任任意字符串等于把 URL 拼接的入口交给请求方。
  router.post(
    '/panel/update',
    asyncHandler(async (req, res) => {
      const tag = String(req.body?.tag ?? '').trim();
      if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
        return res
          .status(400)
          .json(error(ErrorCodes.VALIDATION_ERROR, '版本号格式不正确（应形如 v0.10.4）'));
      }

      // 目标版本经请求文件传：单元名必须固定（sudoers 的 command 参数禁止通配符，
      // 按 tag 授权不同实例的做法整份文件会被拒载）
      const requestPath = path.join(config.rootDir, '.update-request');
      try {
        fs.writeFileSync(requestPath, `${tag}\n`, { mode: 0o600 });
      } catch (err) {
        logger.error('写入更新请求失败:', err.message);
        return res
          .status(500)
          .json(error(ErrorCodes.SERVER_ERROR, '无法写入更新请求，请检查安装目录权限'));
      }

      const unit = 'mc-commander-update.service';
      // `sudo -l <可执行文件> <参数…>`：首个参数是路径、其后是参数，不能再写一遍命令名
      const probe = spawnSync(
        'sudo',
        ['-n', '-l', '/usr/bin/systemctl', 'start', '--no-block', unit],
        { encoding: 'utf8', timeout: 10000 },
      );
      if (probe.status !== 0) {
        const raw = `${probe.stderr || probe.stdout || ''}`.trim() || `退出码 ${probe.status}`;
        logger.error(`[Panel] 无自更新权限：${raw}`);
        try {
          fs.unlinkSync(requestPath);
        } catch {
          /* 已不存在 */
        }
        return res
          .status(500)
          .json(
            error(
              ErrorCodes.SERVER_ERROR,
              '面板没有自更新的权限（sudo 白名单缺失）。请重新运行一次部署脚本以补齐权限。',
            ),
          );
      }

      recordAudit({
        action: AuditActions.PANEL_STOP,
        targetType: 'panel',
        targetId: 'panel',
        detail: { action: 'update', tag },
      });

      // --no-block：oneshot 默认要等脚本跑完才返回，而脚本第一步就是停掉本进程，
      // 不等它回话用户才能拿到「已开始更新」这个结论
      const trigger = spawnSync('sudo', ['-n', '/usr/bin/systemctl', 'start', '--no-block', unit], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (trigger.status !== 0) {
        const raw = (trigger.stderr || trigger.error?.message || '').trim().split('\n')[0];
        logger.error('panel update trigger failed:', raw || `exit ${trigger.status}`);
        return res
          .status(500)
          .json(error(ErrorCodes.SERVER_ERROR, `无法启动更新流程：${raw || '未知原因'}`));
      }

      res.json(success(null, '已开始更新，面板会短暂断开，完成后自动恢复'));
    }),
  );

  // POST /api/v1/panel/migrate - 数据目录迁移（换到更大的分区）
  //
  // 用户遇到这条的唯一场景是「系统盘满了、必须把数据挪到数据盘」。搬运必须停实例
  // （世界存档一边被写一边被复制会产出不可用的包），而停了实例面板也不该再服务，
  // 失败时还要把旧配置退回——这些动作都发生在面板不可用的时刻，故交给 root 单元。
  //
  // 参数经请求文件传递而非实参：实参要进 sudoers 白名单，而目标路径由用户输入。
  router.post(
    '/panel/migrate',
    asyncHandler(async (req, res) => {
      const key = String(req.body?.key ?? '').trim();
      const target = String(req.body?.target ?? '').trim();
      if (!['servers', 'data', 'backups'].includes(key)) {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, '未知的数据目录类别'));
      }
      // 只接受绝对路径：相对路径会按 root 的 cwd 解析，落到谁也找不到的位置
      if (!target.startsWith('/') || target.includes('\n') || target.length > 500) {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, '目标目录必须是绝对路径'));
      }
      if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
        return res
          .status(400)
          .json(error(ErrorCodes.VALIDATION_ERROR, `目标目录已存在且非空：${target}`));
      }
      const parent = path.dirname(target);
      if (!fs.existsSync(parent)) {
        return res
          .status(400)
          .json(
            error(
              ErrorCodes.VALIDATION_ERROR,
              `目标父目录不存在：${parent}。请先挂载数据盘，或换一个已存在的目录。`,
            ),
          );
      }

      const requestPath = path.join(config.rootDir, '.migrate-request');
      try {
        fs.writeFileSync(requestPath, `${key}\n${target}\n`, { mode: 0o600 });
      } catch (err) {
        logger.error('写入迁移请求失败:', err.message);
        return res
          .status(500)
          .json(error(ErrorCodes.SERVER_ERROR, '无法写入迁移请求，请检查安装目录权限'));
      }

      const unit = 'mc-commander-migrate.service';
      const probe = spawnSync(
        'sudo',
        ['-n', '-l', '/usr/bin/systemctl', 'start', '--no-block', unit],
        { encoding: 'utf8', timeout: 10000 },
      );
      if (probe.status !== 0) {
        const raw = `${probe.stderr || probe.stdout || ''}`.trim() || `退出码 ${probe.status}`;
        logger.error(`[Panel] 无迁移权限：${raw}`);
        // 清掉刚写的请求文件：留着会让下一次误触发的迁移用这份过期目标
        try {
          fs.unlinkSync(requestPath);
        } catch {
          /* 已不存在 */
        }
        return res
          .status(500)
          .json(
            error(
              ErrorCodes.SERVER_ERROR,
              '面板没有迁移数据目录的权限（sudo 白名单缺失）。请重新运行一次部署脚本以补齐权限。',
            ),
          );
      }

      recordAudit({
        action: AuditActions.PANEL_STOP,
        targetType: 'panel',
        targetId: 'panel',
        detail: { action: 'migrate', key, target },
      });

      const trigger = spawnSync('sudo', ['-n', '/usr/bin/systemctl', 'start', '--no-block', unit], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (trigger.status !== 0) {
        const raw = (trigger.stderr || trigger.error?.message || '').trim().split('\n')[0];
        logger.error('panel migrate trigger failed:', raw || `exit ${trigger.status}`);
        return res
          .status(500)
          .json(error(ErrorCodes.SERVER_ERROR, `无法启动迁移流程：${raw || '未知原因'}`));
      }

      res.json(success(null, '已开始迁移，面板会暂停；完成后数据在新目录，失败会自动退回原目录'));
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
