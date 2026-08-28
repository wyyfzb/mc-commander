import { Router } from 'express';
import { success, successPaginated, ErrorCodes, AppError } from '../utils/response.js';
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';
import { recordAudit, AuditActions } from '../utils/audit.js';

export function createTaskRoutes(serverManager, taskScheduler) {
  const router = Router({ mergeParams: true });
  
  // 获取实例的定时任务列表
  router.get('/instances/:instanceId/tasks', (req, res, next) => {
    try {
      const { instanceId } = req.params;
      let page = parseInt(req.query.page) || 1;
      let pageSize = parseInt(req.query.pageSize) || 20;
      page = Math.max(1, Math.min(page, 1000));
      pageSize = Math.max(1, Math.min(pageSize, 100));
      const type = req.query.type;
      const isEnabled = req.query.isEnabled !== undefined ? req.query.isEnabled === 'true' : undefined;
      
      const result = ScheduledTaskModel.findAll({
        instanceId,
        page,
        pageSize,
        type,
        isEnabled
      });
      
      res.json(successPaginated(result.tasks, result.total, page, pageSize));
    } catch (err) {
      next(err);
    }
  });
  
  // 获取所有定时任务
  router.get('/tasks', (req, res, next) => {
    try {
      let page = parseInt(req.query.page) || 1;
      let pageSize = parseInt(req.query.pageSize) || 20;
      page = Math.max(1, Math.min(page, 1000));
      pageSize = Math.max(1, Math.min(pageSize, 100));
      const type = req.query.type;
      const isEnabled = req.query.isEnabled !== undefined ? req.query.isEnabled === 'true' : undefined;
      
      const result = ScheduledTaskModel.findAll({
        page,
        pageSize,
        type,
        isEnabled
      });
      
      res.json(successPaginated(result.tasks, result.total, page, pageSize));
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
      
      res.json(success(task));
    } catch (err) {
      next(err);
    }
  });
  
  // 创建定时任务
  router.post('/instances/:instanceId/tasks', (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const { name, type, cronExpression, command, isEnabled } = req.body;
      
      // 验证必填字段
      if (!name || !type || !cronExpression) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Name, type and cronExpression are required');
      }
      
      // 验证任务类型
      const validTypes = ['restart', 'backup', 'command', 'stop', 'start'];
      if (!validTypes.includes(type)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid task type. Must be one of: ${validTypes.join(', ')}`);
      }
      
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
      res.status(201).json(success(task, 'Scheduled task created successfully'));
    } catch (err) {
      next(err);
    }
  });
  
  // 更新定时任务
  router.put('/tasks/:id', (req, res, next) => {
    try {
      const task = ScheduledTaskModel.findById(req.params.id);
      
      if (!task) {
        throw new AppError(ErrorCodes.TASK_NOT_FOUND);
      }
      
      const updatedTask = ScheduledTaskModel.update(req.params.id, req.body);
      recordAudit({ instanceId: task.instanceId, action: AuditActions.TASK_UPDATE, targetType: 'task', targetId: req.params.id });
      res.json(success(updatedTask, 'Scheduled task updated successfully'));
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
