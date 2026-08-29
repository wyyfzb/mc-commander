import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { success, error, AppError, ErrorCodes } from '../utils/response.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { listPlugins, setPluginEnabled, deletePlugin, uploadPlugin } from '../services/plugin.service.js';
import config from '../config.js';

/**
 * 插件管理路由（feat-8 P0-5 最小闭环 + 上传延伸）
 * GET    /api/v1/instances/:id/plugins                    —— 列表（含元数据与启停状态）
 * POST   /api/v1/instances/:id/plugins/upload             —— 上传插件 jar（multipart 字段 file；?overwrite=true 显式覆盖）
 * PUT    /api/v1/instances/:id/plugins/:file/enabled      —— 启用/禁用（body: {enabled}）
 * DELETE /api/v1/instances/:id/plugins/:file              —— 删除插件 jar
 *
 * 设计要点：
 * - :file 为白名单文件名（见 plugin.service PLUGIN_FILE_REGEX），非任意路径
 * - 启停 = jar ↔ jar.disabled 重命名（行业通用约定），重启实例后生效
 * - 上传：multer 磁盘缓冲（系统 tmpdir）+ zip 魔数校验；同名默认 40912 拒绝，
 *   显式 overwrite=true 才替换（插件升级/降级是高影响操作，必须用户显式确认，
 *   与文件页「同名静默覆盖」策略刻意不同）
 * - 服务器运行中允许启停/删除（Bukkit 仅在启动时加载插件），前端提示重启生效
 */

/// 单插件上传体积上限：主流插件 jar < 30MB，放宽至 100MB 兼容大型整合包插件
const PLUGIN_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;

/// multer 磁盘缓冲（与 files 路由同模式：tmpdir 下独立子目录，随机临时名）
const pluginUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(os.tmpdir(), 'mc-commander-uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, `.plugin-upload.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  },
});

const pluginUpload = multer({
  storage: pluginUploadStorage,
  limits: { fileSize: PLUGIN_UPLOAD_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    // 扩展名预检（严格校验在 service 层：白名单正则 + zip 魔数）
    if (!file.originalname.toLowerCase().endsWith('.jar')) {
      return cb(new AppError(ErrorCodes.VALIDATION_ERROR, 'Only .jar files can be uploaded as plugins'), false);
    }
    cb(null, true);
  },
});

/// multer 错误 → AppError 映射（与 files 路由同模式）
function handleMulterError(err, next) {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return next(new AppError(ErrorCodes.FILE_UPLOAD_TOO_LARGE,
      `Plugin too large (max ${Math.round(PLUGIN_UPLOAD_MAX_SIZE / 1024 / 1024)}MB)`));
  }
  next(err);
}

/// 临时文件清理（路由各失败路径统一兜底）
function cleanupTmp(file) {
  if (file?.path) {
    try { fs.unlinkSync(file.path); } catch { /* 已清理或不存在 */ }
  }
}

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

  // POST /api/v1/instances/:id/plugins/upload  multipart 字段 file；?overwrite=true 显式覆盖
  router.post('/instances/:id/plugins/upload', (req, res, next) => {
    pluginUpload.single('file')(req, res, (err) => handleMulterError(err, next));
  }, (req, res, next) => {
    const uploaded = req.file;
    try {
      const { id } = req.params;
      if (!uploaded) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'No file uploaded');
      }
      const serverPath = requireInstance(id);
      if (!serverPath) {
        return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND, 'Instance not found'));
      }
      const overwrite = req.query.overwrite === 'true';
      const result = uploadPlugin(serverPath, uploaded.path, uploaded.originalname, { overwrite });
      recordAudit({
        instanceId: id,
        action: AuditActions.PLUGIN_UPLOAD,
        targetType: 'plugin',
        targetId: result.file,
        detail: { sizeBytes: result.sizeBytes, overwritten: result.overwritten },
      });
      res.status(result.overwritten ? 200 : 201).json(success(result));
    } catch (err) {
      next(err);
    } finally {
      cleanupTmp(uploaded);
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
