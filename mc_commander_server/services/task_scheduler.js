import { Cron } from 'croner';
import path from 'path';
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';
import { BanModel } from '../db/ban.model.js';
import { BackupModel } from '../db/backup.model.js';
import { AuditLogModel, CommandHistoryModel } from '../db/audit.model.js';
import { WebhookModel } from '../db/webhook.model.js';
import { BackupService } from './backup.service.js';
import { runPanelBackupCycle } from './panel-backup.service.js';
import config from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * 定时任务调度器
 *
 * 使用 croner 库（零依赖、TypeScript 原生、DST 感知）替代手写 CronParser。
 * 保留每分钟轮询机制，确保 DB 中的任务变更（增删改）无需重启即可生效。
 */
export class TaskScheduler {
  constructor(serverManager) {
    this.serverManager = serverManager;
    this.backupService = new BackupService(serverManager);
    this.running = false;
    this.interval = null;
    this.lastCheckMinute = -1;
    this.panelBackupCron = null;
    this.retentionPruneCron = null;
  }

  start() {
    if (this.running) return;

    this.running = true;
    logger.info('Task scheduler started');

    this.interval = setInterval(() => {
      this.checkAndRunTasks();
    }, 60 * 1000);

    this.checkAndRunTasks();

    this.startPanelBackupCron();

    // 保留策略首执行（issue #472）：不等到首个 cron 触发点（默认次日凌晨），
    // 启动即收敛一次存量增长；失败仅记日志不阻塞调度器启动
    if (config.retentionPrune.enabled) {
      this.runRetentionPrune('startup');
    }

    this.startRetentionPruneCron();
  }

  stop() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.panelBackupCron) {
      this.panelBackupCron.stop();
      this.panelBackupCron = null;
    }
    if (this.retentionPruneCron) {
      this.retentionPruneCron.stop();
      this.retentionPruneCron = null;
    }
    logger.info('Task scheduler stopped');
  }

  // append-only 表保留清理（独立 croner 实例）：与面板快照同型——不进用户
  // 定时任务体系，DB/清理故障不影响用户任务调度主循环
  startRetentionPruneCron() {
    if (!config.retentionPrune.enabled) return;
    try {
      this.retentionPruneCron = new Cron(config.retentionPrune.cron, () => {
        this.runRetentionPrune('cron');
      });
    } catch (err) {
      logger.error('Retention prune cron register failed:', err.message);
    }
  }

  /**
   * 执行一轮保留清理：审计日志、webhook 投递记录与命令历史三张 append-only 表
   * 分别 try/catch——单表失败不拖累其余表，返回删除计数供日志与测试断言。
   * @param {'startup'|'cron'} trigger 触发来源（日志归因用）
   * @returns {{auditDeleted: number, webhookDeleted: number, commandHistoryDeleted: number, failed: string[]}}
   */
  runRetentionPrune(trigger = 'manual') {
    const result = { auditDeleted: 0, webhookDeleted: 0, commandHistoryDeleted: 0, failed: [] };
    try {
      result.auditDeleted = AuditLogModel.prune(config.retentionPrune.auditLogDays);
    } catch (err) {
      result.failed.push('audit');
      logger.error(`[RetentionPrune] audit_logs prune failed (${trigger}):`, err.message);
    }
    try {
      result.webhookDeleted = WebhookModel.pruneDeliveries(config.retentionPrune.webhookDeliveryDays);
    } catch (err) {
      result.failed.push('webhook');
      logger.error(`[RetentionPrune] webhook_deliveries prune failed (${trigger}):`, err.message);
    }
    try {
      result.commandHistoryDeleted = CommandHistoryModel.prune(config.retentionPrune.commandHistoryDays);
    } catch (err) {
      result.failed.push('command_history');
      logger.error(`[RetentionPrune] command_history prune failed (${trigger}):`, err.message);
    }
    if (result.failed.length === 0) {
      logger.info(
        `[RetentionPrune] ok (${trigger}): audit_logs -${result.auditDeleted}, webhook_deliveries -${result.webhookDeleted}, command_history -${result.commandHistoryDeleted}`
      );
    }
    return result;
  }

  // 面板库每日快照（独立 croner 实例）：不进用户定时任务体系——面板库
  // 故障时用户任务仍可正常增删执行，快照失败仅记日志不干扰调度主循环
  startPanelBackupCron() {
    if (!config.panelBackup.enabled) return;
    try {
      this.panelBackupCron = new Cron(config.panelBackup.cron, () => {
        this.runPanelBackup();
      });
    } catch (err) {
      logger.error('Panel backup cron register failed:', err.message);
    }
  }

  async runPanelBackup() {
    try {
      const result = await runPanelBackupCycle();
      logger.info(
        `[PanelBackup] snapshot ok: ${path.basename(result.filePath)} ` +
        `(${Math.max(1, Math.round(result.sizeBytes / 1024))} KB), cleaned ${result.deletedCount}`
      );
    } catch (err) {
      logger.error('[PanelBackup] snapshot failed:', err.message);
    }
  }

  checkAndRunTasks() {
    const now = new Date();
    const currentMinute = now.getMinutes();

    if (currentMinute === this.lastCheckMinute) return;
    this.lastCheckMinute = currentMinute;

    // croner 的 Cron#match 严格匹配到秒：只有当日期恰好落在调度触发时刻
    // （秒=0、毫秒=0）时才返回 true。setInterval 回调触发时 now 的秒数
    // 通常非零，会导致 match 误判为 false，定时任务永不触发。
    // 这里将秒与毫秒清零，对齐到当前分钟边界后再做模式匹配。
    const matchTime = new Date(now);
    matchTime.setSeconds(0, 0);

    // 临时封禁到期自动解封（服务端自实现 tempban）
    this.checkExpiredBans();

    try {
      const tasks = ScheduledTaskModel.getEnabledTasks();

      for (const task of tasks) {
        try {
          // croner 的 Cron 实例 match 方法判断当前时间是否匹配 cron 表达式
          // 使用 paused: true 避免实际调度（仅用于模式匹配）
          const cron = new Cron(task.cronExpression, { paused: true });
          if (cron.match(matchTime)) {
            this.executeTask(task);
          }
        } catch (err) {
          logger.error(`Error checking task ${task.id}:`, err);
        }
      }
    } catch (err) {
      logger.error('Error checking scheduled tasks:', err);
    }
  }

  /**
   * 临时封禁到期自动解封。
   * 扫描 temp_bans 中已到期且生效的记录，对运行中的实例执行原版 pardon/pardon-ip。
   * 实例未运行时跳过（记录保持生效，实例启动后的下一次轮询再处理），
   * 实例被删除时 DB 外键级联删除记录。
   */
  checkExpiredBans() {
    try {
      const expired = BanModel.findExpiredActive();
      for (const ban of expired) {
        const instance = ban.instanceId
          ? this.serverManager.getInstance(ban.instanceId)
          : null;
        if (!instance || !instance.isRunning) continue;

        const cmd = ban.targetType === 'ip'
          ? `pardon-ip ${ban.target}`
          : `pardon ${ban.target}`;
        instance.sendCommand(cmd)
          .then(() => {
            BanModel.deactivate(ban.id);
            logger.info(`Auto-pardoned ${ban.targetType} ${ban.target} (expired temp ban)`);
          })
          .catch((err) => {
            // 发送失败时保留记录，下次轮询重试
            logger.error(`Failed to auto-pardon ${ban.target} (${ban.targetType}):`, err.message);
          });
      }
    } catch (err) {
      logger.error('Error checking expired temp bans:', err);
    }
  }

  executeTask(task) {
    logger.info(`Executing scheduled task: ${task.name} (${task.type})`);
    // 执行起点：command/backup 的异步结果回写历史时换算 duration_ms
    const startTs = Date.now();

    // 触发任务执行事件
    if (this.serverManager) {
      this.serverManager.emit('instance:taskExecute', {
        instanceId: task.instanceId,
        taskId: task.id,
        taskName: task.name,
        taskType: task.type,
      });
    }

    // nextRunAt 触发时统一计算：失败/跳过同样消费本次触发并刷新下次计划
    const nextRun = getNextRun(task.cronExpression);
    const nextRunAt = nextRun?.toISOString();

    try {
      const instance = task.instanceId
        ? this.serverManager.getInstance(task.instanceId)
        : null;

      switch (task.type) {
        case 'start':
          if (instance && !instance.isRunning) {
            instance.start();
          }
          break;

        case 'stop':
          if (instance && instance.isRunning) {
            instance.stop();
          }
          break;

        case 'restart':
          if (instance) {
            instance.restart();
          }
          break;

        case 'command':
          if (instance && instance.isRunning && task.command) {
            // 触发先刷新时间戳，结果由异步回调回填 status
            ScheduledTaskModel.updateLastRun(task.id, nextRunAt);
            instance.sendCommand(task.command)
              .then(() => ScheduledTaskModel.updateLastRunStatus(task.id, 'success', null, Date.now() - startTs))
              .catch((err) => {
                const errMsg = err?.message ?? String(err);
                ScheduledTaskModel.updateLastRunStatus(task.id, 'failed', errMsg, Date.now() - startTs);
                this.emitTaskFailed(task, err);
              });
          } else {
            // 实例未运行/无命令未真正下发：本次触发按跳过计
            ScheduledTaskModel.updateLastRun(task.id, nextRunAt, 'skipped');
          }
          break;

        case 'backup':
          if (instance) {
            // 卡死恢复先行：进程崩溃残留的 creating/restoring 记录必须在此处
            // 重置（路由 hasInProgressBackup 与服务层 createBackup 已同步前置，
            // 调度器路径同样先 reset 再判断——否则崩溃后定时备份路径同样锁死）
            BackupModel.resetStaleInProgress({
              maxAgeMs: config.backupInProgressTimeoutMs,
              instanceId: task.instanceId,
            });
            // 互斥检查（restoring 状态机）：与手动备份入口（routes/backups.js）
            // 检查保持一致，实例已有进行中操作（creating=备份中 / restoring=
            // 恢复中）时跳过本次触发，避免定时备份与手动备份并发执行——
            // 两个备份的 save-off/save-all flush/save-on 序列交错，压缩期间
            // 世界文件被改写导致备份包损坏（Windows 下还因文件占用报错）。
            // 服务层 backup.service.js createBackup 内亦有同款兜底检查。
            const creatingCount = BackupModel.findAll({
              instanceId: task.instanceId,
              status: 'creating',
            }).total;
            const restoringCount = BackupModel.findAll({
              instanceId: task.instanceId,
              status: 'restoring',
            }).total;
            if (creatingCount + restoringCount > 0) {
              logger.warn(
                `Scheduled backup skipped for instance ${task.instanceId}: backup/restore already in progress`
              );
              // 跳过必须对用户可见：发送 backupSkipped 提示事件；结果状态
              // 一并落 skipped（skip 也消费本次触发，避免短周期 cron 每分钟
              // 重试刷屏——下个 cron 周期仍会再尝试，重试语义保留）
              if (this.serverManager) {
                this.serverManager.emit('instance:backupSkipped', {
                  instanceId: task.instanceId,
                  taskId: task.id,
                  taskName: task.name,
                  content: `定时备份已跳过：${task.name} 触发时上一备份/恢复仍在进行`,
                });
              }
              ScheduledTaskModel.updateLastRun(task.id, nextRunAt, 'skipped');
              break;
            }
            // 实际创建备份（异步执行），与手动备份走同一通道。
            // taskId 透传给 backup.service：真实成败（快照完成/失败）由
            // executeBackup 内部回写 lastRunStatus——createBackup 是
            // fire-and-forget（resolve 早于快照完成），不能在 .then 写 success
            ScheduledTaskModel.updateLastRun(task.id, nextRunAt);
            this.backupService.createBackup(task.instanceId, {
              name: task.name ? `${task.name} ${new Date().toISOString().replace(/[:.]/g, '-')}` : undefined,
              type: 'scheduled',
              createdBy: 'scheduler',
              taskId: task.id,
            }).catch(err => {
              // 仅 setup 阶段失败（世界缺失/磁盘不足/RCON 不可用等，executeBackup
              // 尚未启动）走这里；执行阶段失败由 executeBackup 内部回写。
              // 定时备份失败必须对用户可见：补发 backupFailed 事件（旧实现仅记日志）
              logger.error(`Scheduled backup failed for instance ${task.instanceId}:`, err);
              if (this.serverManager) {
                this.serverManager.emit('instance:backupFailed', {
                  instanceId: task.instanceId,
                  error: err.message,
                  phase: 'scheduled',
                  content: `备份失败: ${err.message}`,
                });
              }
              ScheduledTaskModel.updateLastRunStatus(task.id, 'failed', err.message, Date.now() - startTs);
            });
            logger.info(`Backup task triggered for instance ${task.instanceId}`);
          } else {
            // 实例缺失（instance_id 为空/实例未被加载）：与 command 分支一致记 skipped，
            // 避免备份分支零落库（不刷新 last_run_at 也不写状态）
            ScheduledTaskModel.updateLastRun(task.id, nextRunAt, 'skipped');
          }
          break;

        default:
          logger.warn(`Unknown task type: ${task.type}`);
          ScheduledTaskModel.updateLastRun(task.id, nextRunAt, 'failed', `未知任务类型: ${task.type}`, Date.now() - startTs);
          this.emitTaskFailed(task, new Error(`未知任务类型: ${task.type}`));
      }

      // start/stop/restart 记「触发结果」（trigger outcome）而非实例最终状态：
      // restart 是延迟 3s 启动（_scheduleRestartStart 内部吞错）、stop 的 RCON
      // 回执被实例内部吞掉，最终成败由实例状态/自动重启机制反映，不落任务状态。
      // command/backup 的 status 由异步回调回填，触发时时间戳已在分支内落库
      if (task.type === 'start' || task.type === 'stop' || task.type === 'restart') {
        ScheduledTaskModel.updateLastRun(task.id, nextRunAt, 'success');
      }

    } catch (err) {
      logger.error(`Task execution failed (${task.name}):`, err);
      // 同步 throw（如 start 的 EULA/路径校验）：失败同样落库记录 last_run_at
      ScheduledTaskModel.updateLastRun(task.id, nextRunAt, 'failed', err?.message ?? String(err), Date.now() - startTs);
      this.emitTaskFailed(task, err);
    }
  }

  /**
   * 任务失败通知：与定时备份失败（backupFailed）同链路——事件经 websocket
   * 落库并广播，前端通知中心 + Toast 提示；补齐“失败仅静默写库”的可见性缺口。
   */
  emitTaskFailed(task, err) {
    if (!this.serverManager) return;
    const message = err?.message ?? String(err);
    this.serverManager.emit('instance:taskFailed', {
      instanceId: task.instanceId,
      taskId: task.id,
      taskName: task.name,
      taskType: task.type,
      error: message,
      content: `定时任务「${task.name}」执行失败: ${message}`,
    });
  }

  runTask(taskId) {
    const task = ScheduledTaskModel.findById(taskId);
    if (!task) {
      throw new Error('Task not found');
    }

    this.executeTask(task);
    return true;
  }

  getNextRunTime(taskId) {
    const task = ScheduledTaskModel.findById(taskId);
    if (!task) {
      throw new Error('Task not found');
    }

    return getNextRun(task.cronExpression);
  }
}

/**
 * 获取 cron 表达式的下一次运行时间
 * @param {string} cronExpr - 标准 5 字段 cron 表达式
 * @returns {Date|null} 下次运行时间，无匹配则返回 null
 */
function getNextRun(cronExpr) {
  try {
    const cron = new Cron(cronExpr, { paused: true });
    return cron.nextRun();
  } catch (e) {
    logger.error(`Invalid cron expression: ${cronExpr}`, e);
    return null;
  }
}

export default TaskScheduler;
