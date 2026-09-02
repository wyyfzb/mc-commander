/**
 * Webhook CRUD 路由
 * - 列表 / 详情 / 创建 / 更新 / 删除
 * - 事件类型白名单查询
 * - 测试投递
 * - 投递日志查询
 */
import { Router } from 'express';
import { WebhookModel } from '../db/index.js';
import { success, successPaginated, error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { WebhookService, WEBHOOK_EVENT_TYPES } from '../services/webhook.service.js';
import { checkPublicUrl } from '../utils/url-guard.js';
import { webhookCreatePayloadSchema, webhookSchema } from '@mc-commander/schemas';
import { validateBody, validatedSuccess, validatedSuccessPaginated } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createWebhookRoutes() {
  const router = Router();

  // GET /webhooks/event-types — 查询可用事件类型
  router.get('/webhooks/event-types', (req, res) => {
    res.json(success(WEBHOOK_EVENT_TYPES));
  });

  // GET /webhooks — 列表
  router.get('/webhooks', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const result = WebhookModel.findAll({ page, pageSize });
    res.json(validatedSuccessPaginated(webhookSchema, result.webhooks, result.total, result.page, result.pageSize));
  });

  // GET /webhooks/:id — 详情
  router.get('/webhooks/:id', (req, res) => {
    const webhook = WebhookModel.findById(parseInt(req.params.id, 10));
    if (!webhook) {
      return res.status(404).json(error(ErrorCodes.WEBHOOK_NOT_FOUND));
    }
    res.json(validatedSuccess(webhookSchema, webhook));
  });

  // POST /webhooks — 创建
  router.post('/webhooks', validateBody(webhookCreatePayloadSchema), asyncHandler(async (req, res) => {
    const { name, url, secret, events, instanceId, isEnabled } = req.body;

    if (!validateUrl(url)) {
      return res.status(400).json(error(ErrorCodes.WEBHOOK_INVALID_URL));
    }
    // SSRF 防护：拒绝指向私网/环回/保留地址的 URL（含 DNS 解析校验）
    const guard = await checkPublicUrl(url);
    if (!guard.ok) {
      return res.status(400).json(error(ErrorCodes.WEBHOOK_INVALID_URL, guard.reason));
    }
    if (events && Array.isArray(events)) {
      const invalid = events.filter(e => !WEBHOOK_EVENT_TYPES.includes(e));
      if (invalid.length > 0) {
        return res.status(400).json(error(ErrorCodes.WEBHOOK_INVALID_EVENTS,
          `无效事件类型: ${invalid.join(', ')}`));
      }
    }

    const webhook = WebhookModel.create({ name, url, secret: secret || null, events: events || [], instanceId: instanceId || null, isEnabled });
    recordAudit({ action: AuditActions.WEBHOOK_CREATE, targetType: 'webhook', targetId: String(webhook.id), detail: { name, url } });
    res.json(validatedSuccess(webhookSchema, webhook, 'Webhook 创建成功'));
  }));

  // PUT /webhooks/:id — 更新
  router.put('/webhooks/:id', asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = WebhookModel.findById(id);
    if (!existing) {
      return res.status(404).json(error(ErrorCodes.WEBHOOK_NOT_FOUND));
    }

    const { name, url, secret, events, instanceId, isEnabled } = req.body;
    if (url && !validateUrl(url)) {
      return res.status(400).json(error(ErrorCodes.WEBHOOK_INVALID_URL));
    }
    // SSRF 防护：拒绝指向私网/环回/保留地址的 URL（含 DNS 解析校验）
    if (url) {
      const guard = await checkPublicUrl(url);
      if (!guard.ok) {
        return res.status(400).json(error(ErrorCodes.WEBHOOK_INVALID_URL, guard.reason));
      }
    }
    if (events && Array.isArray(events)) {
      const invalid = events.filter(e => !WEBHOOK_EVENT_TYPES.includes(e));
      if (invalid.length > 0) {
        return res.status(400).json(error(ErrorCodes.WEBHOOK_INVALID_EVENTS,
          `无效事件类型: ${invalid.join(', ')}`));
      }
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (url !== undefined) data.url = url;
    if (secret !== undefined) data.secret = secret;
    if (events !== undefined) data.events = events;
    if (instanceId !== undefined) data.instanceId = instanceId;
    if (isEnabled !== undefined) data.isEnabled = isEnabled;

    const webhook = WebhookModel.update(id, data);
    recordAudit({ action: AuditActions.WEBHOOK_UPDATE, targetType: 'webhook', targetId: String(id), detail: { name: webhook.name } });
    res.json(success(webhook, 'Webhook 更新成功'));
  }));

  // DELETE /webhooks/:id — 删除
  router.delete('/webhooks/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = WebhookModel.findById(id);
    if (!existing) {
      return res.status(404).json(error(ErrorCodes.WEBHOOK_NOT_FOUND));
    }
    WebhookModel.delete(id);
    recordAudit({ action: AuditActions.WEBHOOK_DELETE, targetType: 'webhook', targetId: String(id), detail: { name: existing.name } });
    res.json(success(null, 'Webhook 已删除'));
  });

  // POST /webhooks/:id/test — 测试投递
  router.post('/webhooks/:id/test', asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = WebhookModel.findById(id);
    if (!existing) {
      return res.status(404).json(error(ErrorCodes.WEBHOOK_NOT_FOUND));
    }

    const result = await WebhookService.testDelivery(id);
    recordAudit({ action: AuditActions.WEBHOOK_TEST, targetType: 'webhook', targetId: String(id), detail: { success: result.success, statusCode: result.statusCode } });

    if (result.success) {
      res.json(success({ statusCode: result.statusCode, body: result.body }, '测试投递成功'));
    } else {
      res.status(500).json(error(ErrorCodes.WEBHOOK_TEST_FAILED, result.error || '测试投递失败'));
    }
  }));

  // GET /webhooks/:id/deliveries — 投递日志
  router.get('/webhooks/:id/deliveries', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = WebhookModel.findById(id);
    if (!existing) {
      return res.status(404).json(error(ErrorCodes.WEBHOOK_NOT_FOUND));
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const result = WebhookModel.findDeliveries({ webhookId: id, page, pageSize });
    res.json(successPaginated(result.deliveries, result.total, result.page, result.pageSize));
  });

  return router;
}