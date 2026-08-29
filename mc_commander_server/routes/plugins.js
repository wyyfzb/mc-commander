import { Router } from 'express';
import { success, error, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { listPlugins, setPluginEnabled, deletePlugin } from '../services/plugin.service.js';
import path from 'path';
import config from '../config.js';

/**
 * 插件管理路由（feat-8 P0-5 插件管理最小闭环）
 * GET    /api/v1/instances/:id/plugins                    —— 列表（含元数据与启停状态）
 * PUT    /api/v1/instances/:id/plugins/:file/enabled      —— 启用/禁用（body: {enabled}）
 * DELETE /api/v1/instances/:id/plugins/:file              —— 删除插件 jar
 *
 * 设计要点：
 * - :file 为白名单文件名（见 plugin.service PLUGIN_FILE_REGEX），非任意路径
 * - 启停 = jar ↔ jar.disabled 重命名（行业通用约定），重启实例后生效
 * - 服务器运行中允许启停/删除（Bukkit 仅在启动时加载插件），前端提示重启生效
 */
export function createPluginRoutes(serverManager) {
  const router = Router();

  /// 解析实例并返回其 serverPath（与 upgrade/files 路由同构）
  function requireInstance(id) {
    const instance = serverManager.getInstance(id);
    if (!instance) return null;
    return instance.serverPath || path.join(config.serversDir, id);
  }

  // GET /api/v1/instances/:id/plugins
  router.get('/instances/:id/plugins', (req, res, next) => {
    try {
      const serverPath = requireInstance(req.params.id);
      if (!serverPath) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance not found'));
      }
      res.json(success(listPlugins(serverPath)));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/instances/:id/plugins/:file/enabled  body: { enabled: boolean }
  router.put('/instances/:id/plugins/:file/enabled', (req, res, next) => {
    try {
      const { id, file } = req.params;
      const serverPath = requireInstance(id);
      if (!serverPath) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance not found'));
      }
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'enabled must be a boolean'));
      }
      const result = setPluginEnabled(serverPath, file, enabled);
      recordAudit({
        instanceId: id,
        action: enabled ? AuditActions.PLUGIN_ENABLE : AuditActions.PLUGIN_DISABLE,
        targetType: 'plugin',
        targetId: file,
        detail: { from: file, to: result.file },
      });
      res.json(success(result));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/instances/:id/plugins/:file
  router.delete('/instances/:id/plugins/:file', (req, res, next) => {
    try {
      const { id, file } = req.params;
      const serverPath = requireInstance(id);
      if (!serverPath) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance not found'));
      }
      const result = deletePlugin(serverPath, file);
      recordAudit({
        instanceId: id,
        action: AuditActions.PLUGIN_DELETE,
        targetType: 'plugin',
        targetId: file,
        detail: null,
      });
      res.json(success(result));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
