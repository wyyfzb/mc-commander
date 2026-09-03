import { Router } from 'express';
import { Cron } from 'croner';
import { success, ErrorCodes, AppError } from '../utils/response.js';
import { parsePagination } from '../utils/pagination.js';
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';
import { TaskRunHistoryModel } from '../db/task_run_history.model.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { taskCreatePayloadSchema, taskUpdatePayloadSchema, scheduledTaskSchema, taskRunHistorySchema } from '@mc-commander/schemas';
import { validateBody, validatedSuccess, validatedSuccessPaginated } from '../middleware/validate.js';

/**
 * cron 表达式合法性校验（与 task_scheduler 同用 croner 解析器，保证「存得进就能跑」）。
 * 不校验则非法表达式入库后任务静默永不触发（运行期仅 console.error）。
 */
function assertValidCron(cronExpression) {
  try {
    new Cron(cronExpression, { paused: true });
  } catch {
    throw new AppError(ErrorCodes.INVALID_CRON_EXPRESSION, `Invalid cron expression: ${cronExpression}`);
  }
}

export function createTaskRoutes(serverManager, taskScheduler) {
  const router = Router({ mergeParams: true });
  
  // 获取实例的定时任务列表
  router.get('/instances/:instanceId/tasks', (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const { page, pageSize } = parsePagination(req.query, { maxPageSize: 100 });
      const type = req.query.type;
      const isEnabled = req.query.isEnabled !== undefined ? req.query.isEnabled === 'true' : undefined;
      
      const result = ScheduledTaskModel.findAll({
        instanceId,
        page,
        pageSize,
        type,
        isEnabled
      });
      
      res.json(validatedSuccessPaginated(scheduledTaskSchema, result.tasks, result.total, page, pageSize));
    } catch (err) {
      next(err);
    }
  });
  
  // 获取所有定时任务
  router.get('/tasks', (req, res, next) => {
    try {
      const { page, pageSize } = parsePagination(req.query, { maxPageSize: 100 });
      const type = req.query.type;
      const isEnabled = req.query.isEnabled !== undefined ? req.query.isEnabled === 'true' : undefined;
      
      const result = ScheduledTaskModel.findAll({
        page,
        pageSize,
        type,
        isEnabled
      });
      
      res.json(validatedSuccessPaginated(scheduledTaskSchema, result.tasks, result.total, page, pageSize));
    } catch (err) {
      next(err);
    }
  });
  
  // 获取单个任务详情
  router.get('/tasks/:id', (req, res, next) => {
    try {
      const task = ScheduledTaskModel.findById(req.params.id);
      
      if (!task) {
        throw new AppError(ErrorCodes.TASK_NOT_FOUND);
      }
      
      res.json(validatedSuccess(scheduledTaskSchema, task));
    } catch (err) {
      next(err);
    }
  });

  // 任务执行历史（倒序，最新在前）：scheduled_tasks.last_run_* 是覆盖写
  // 单槽，排障需要完整时间线（失败次数/原因/耗时）时查此接口
  router.get('/tasks/:id/history', (req, res, next) => {
    try {
      const task = ScheduledTaskModel.findById(req.params.id);

      if (!task) {
        throw new AppError(ErrorCodes.TASK_NOT_FOUND);
      }

      let limit = parseInt(req.query.limit) || 20;
      limit = Math.max(1, Math.min(limit, 100));

      const runs = TaskRunHistoryModel.findByTask(task.id, limit);
      res.json(validatedSuccessPaginated(taskRunHistorySchema, runs, runs.length, 1, limit));
    } catch (err) {
      next(err);
    }
  });
  
  // 创建定时任务（请求体 schema parse 校验：必填/枚举由 taskCreatePayloadSchema 单源定义）
  router.post('/instances/:instanceId/tasks', validateBody(taskCreatePayloadSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const { name, type, cronExpression, command, isEnabled } = req.body;

      // 验证 cron 表达式（非法表达式拒绝入库，返回 40004）
      assertValidCron(cronExpression);

      // 检查实例是否存在
      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }
      
      const task = ScheduledTaskModel.create({
        instanceId,
        name,
        type,
        cronExpression,
        command,
        isEnabled: isEnabled !== false,
      });
      
      recordAudit({ instanceId, action: AuditActions.TASK_CREATE, targetType: 'task', targetId: String(task.id), detail: { name, type } });
      res.status(201).json(validatedSuccess(scheduledTaskSchema, task, 'Scheduled task created successfully'));
    } catch (err) {
      next(err);
    }
  });
  
  // 更新定时任务
  router.put('/tasks/:id', validateBody(taskUpdatePayloadSchema), (req, res, next) => {
    try {
      const task = ScheduledTaskModel.findById(req.params.id);
      
      if (!task) {
        throw new AppError(ErrorCodes.TASK_NOT_FOUND);
      }

      // 更新携带 cronExpression 时同样校验（非法表达式拒绝写入）
      if (req.body.cronExpression !== undefined) {
        assertValidCron(req.body.cronExpression);
      }

      const updatedTask = ScheduledTaskModel.update(req.params.id, req.body);
      recordAudit({ instanceId: task.instanceId, action: AuditActions.TASK_UPDATE, targetType: 'task', targetId: req.params.id });
      res.json(validatedSuccess(scheduledTaskSchema, updatedTask, 'Scheduled task updated successfully'));
    } catch (err) {
      next(err);
    }
  });
  
  // 删除定时任务
  router.delete('/tasks/:id', (req, res, next) => {
    try {
      const task = ScheduledTaskModel.findById(req.params.id);
      
      if (!task) {
        throw new AppError(ErrorCodes.TASK_NOT_FOUND);
      }
      
      ScheduledTaskModel.delete(req.params.id);
      recordAudit({ instanceId: task.instanceId, action: AuditActions.TASK_DELETE, targetType: 'task', targetId: req.params.id });
      res.json(success(null, 'Scheduled task deleted successfully'));
    } catch (err) {
      next(err);
    }
  });
  
  // 立即执行任务
  router.post('/tasks/:id/run', async (req, res, next) => {
    try {
      const task = ScheduledTaskModel.findById(req.params.id);
      
      if (!task) {
        throw new AppError(ErrorCodes.TASK_NOT_FOUND);
      }
      
      if (taskScheduler) {
        await taskScheduler.runTask(task.id);
      }
      recordAudit({ instanceId: task.instanceId, action: AuditActions.TASK_EXECUTE, targetType: 'task', targetId: req.params.id });
      res.json(success(null, 'Task execution triggered'));
    } catch (err) {
      next(err);
    }
  });
  
  return router;
}

export default createTaskRoutes;
