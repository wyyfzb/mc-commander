import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { TextDecoder } from 'util';
import iconv from 'iconv-lite';
import multer from 'multer';
import { ErrorCodes, AppError } from '../utils/response.js';
import { atomicWriteFile, ensureDir, renameNoClobber, resolveSafePath, PathTraversalError } from '../utils/fs-utils.js';
import config from '../config.js';
import { BanModel } from '../db/index.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import {
  fileListRequestSchema,
  filePathRequestSchema,
  fileSaveRequestSchema,
  fileMkdirRequestSchema,
  fileRenameRequestSchema,
  fileUploadQuerySchema,
  fileListResponseSchema,
  fileInfoResponseSchema,
  fileContentResponseSchema,
  fileSaveResponseSchema,
  fileMkdirResponseSchema,
  fileRenameResponseSchema,
  fileUploadResponseSchema,
  nullDataSchema,
} from '@mc-commander/schemas';
import { validateBody, validateQuery, validatedSuccess } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';

// Content-Disposition filename 编码（RFC 5987）：ASCII 可直接用 filename，
// 非 ASCII（中文等）用 filename*=UTF-8''percent-encoded，双写兼容不支持 5987 的旧客户端
function contentDisposition(fileName) {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/(["\\])/g, '\\$1');
  const encoded = encodeURIComponent(fileName)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// 前 1024 字节含 NUL 字节 → 判定二进制（文本文件几乎不含 NUL）
function detectBinary(buffer) {
  return buffer.subarray(0, 1024).includes(0);
}

// UTF-8 BOM 标记（带 BOM 文件保存后需保留，避免 BOM 静默丢失）
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

// 解码文件内容：UTF-8 严格解码优先（带 BOM 先剥离并标记），失败回退 GBK；二进制返回 null
function decodeContent(buffer) {
  if (detectBinary(buffer)) return null;
  let hasBom = false;
  let body = buffer;
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    hasBom = true;
    body = buffer.subarray(3);
  }
  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(body),
      encoding: 'utf-8',
      hasBom
    };
  } catch {
    return { content: iconv.decode(buffer, 'gbk'), encoding: 'gbk', hasBom: false };
  }
}

// 读取文件头部（编码/二进制检测只需开头字节，避免 PUT 场景全量读入大文件）
function readFileHead(fullPath, size = 4096) {
  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// 按编码编码内容：utf-8 保留 BOM；gbk 往返校验，防不可表示字符被静默替换为 '?' 造成损坏
function encodeContent(content, encoding, hasBom) {
  let encoded = iconv.encode(content, encoding);
  if (encoding === 'gbk') {
    if (iconv.decode(encoded, 'gbk') !== content) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR,
        'Content contains characters not representable in GBK encoding');
    }
  } else if (hasBom) {
    encoded = Buffer.concat([UTF8_BOM, encoded]);
  }
  return encoded;
}

// ── 列表文件编辑同步 ──────────────────────────────────────────────
// 原版 MC 启动时把 banned-players.json / banned-ips.json / whitelist.json /
// ops.json 读入内存，运行中直接编辑文件不会生效（ban/op 无 reload 命令，
// 仅 whitelist 有 /whitelist reload，但逐个命令同步更精确且兼容旧版）。
// 用户通过文件管理编辑这些文件时，若只改文件，会与 MC 内存状态不一致
// （典型症状：文件删了封禁条目但玩家仍无法连接）。因此保存后对比新旧
// 内容差异：被移除的条目执行 pardon/pardon-ip/whitelist remove/deop，
// 被新增的条目执行 ban/ban-ip/whitelist add/op 让变更立即生效。
// 封禁文件另有 temp_bans 表需同步清理（自实现临时封禁记录）。
const LIST_FILE_SYNC = {
  'banned-players.json': {
    key: 'name',
    removeCmd: 'pardon',
    addCmd: 'ban',
    hasReason: true,
    cleanTempBan: (instanceId, target) => BanModel.deactivateByPlayer(instanceId, target),
  },
  'banned-ips.json': {
    key: 'ip',
    removeCmd: 'pardon-ip',
    addCmd: 'ban-ip',
    hasReason: true,
    cleanTempBan: (instanceId, target) => BanModel.deactivateByIp(instanceId, target),
  },
  'whitelist.json': {
    key: 'name',
    removeCmd: 'whitelist remove',
    addCmd: 'whitelist add',
    hasReason: false,
  },
  'ops.json': {
    key: 'name',
    removeCmd: 'deop',
    addCmd: 'op',
    hasReason: false,
    // 注意：ops.json 的 level 字段无法通过命令精确同步（原版 op 固定 level 4），
    // 修改 level 需重启服务器生效；增删条目同步无此限制。
  },
};

// 原子写统一走 utils/fs-utils.js 公共实现（写唯一 .tmp 再 rename，失败清残留）。
// 防止并发写入竞态——目标文件被直接 writeFileSync 覆盖时（先 truncate 后写），
// 同时刻的读取者会读到空/半截内容；且 server.properties 存在双写入点
// （本接口与 mc_server.js saveProperties），原子写消除"读-改-写不原子"的互相覆盖。

// 清理 reason 字符串，防止命令注入（与 players.js sanitizeReason 一致）
function sanitizeReason(reason) {
  if (!reason) return '';
  return String(reason).replace(/[\r\n;|&]/g, ' ').trim().substring(0, 200);
}

// 解析列表文件 JSON 数组，提取 { target, reason } 列表；非合法数组抛错
function parseListEntries(content, fileName) {
  const spec = LIST_FILE_SYNC[fileName];
  const arr = JSON.parse(content);
  if (!Array.isArray(arr)) {
    throw new Error(`${fileName} must be a JSON array`);
  }
  return arr
    .filter((entry) => entry && entry[spec.key])
    .map((entry) => ({
      target: String(entry[spec.key]),
      reason: spec.hasReason ? sanitizeReason(entry.reason) : '',
    }));
}

// 对比新旧条目差异并同步：
//  - 移除的目标 → 运行中实例执行 removeCmd（同步 MC 内存）
//  - 新增的目标 → 运行中实例执行 addCmd（变更立即生效）
// 封禁文件另清理被移除目标的 temp_bans 生效记录（文件是编辑后的最终状态，
// 记录跟随文件，避免封禁记录残留已失效的"生效中"条目）。
// 实例未运行时跳过命令（启动时自动加载文件），但 temp_bans 记录仍跟随文件清理。
function syncListFileChanges(instance, fileName, oldEntries, newEntries) {
  const spec = LIST_FILE_SYNC[fileName];
  const oldMap = new Map(oldEntries.map((e) => [e.target, e.reason]));
  const newMap = new Map(newEntries.map((e) => [e.target, e.reason]));
  const removed = oldEntries.map((e) => e.target).filter((t) => !newMap.has(t));
  const added = newEntries.filter((e) => !oldMap.has(e.target));
  if (removed.length === 0 && added.length === 0) return;

  if (spec.cleanTempBan) {
    for (const target of removed) spec.cleanTempBan(instance.id, target);
  }
  if (!instance.isRunning) return;

  // 命令串行执行（RCON 并行存在响应交叉问题），尽力而为，失败不阻断文件保存。
  // fire-and-forget 的 IIFE 必须带全局 catch：任何逃逸内部 try/catch 的异常
  // （如未来重构新增未包裹的 await）若变成 unhandled rejection，Node 默认
  // unhandledRejection=throw 会终止整个服务进程。
  (async () => {
    try {
      for (const target of removed) {
        try {
          await instance.sendCommand(`${spec.removeCmd} ${target}`);
        } catch (err) {
          logger.error(`[Files] Failed to ${spec.removeCmd} ${target} after ${fileName} edit:`, err.message);
        }
      }
      for (const entry of added) {
        try {
          await instance.sendCommand(
            `${spec.addCmd} ${entry.target}${entry.reason ? ` ${entry.reason}` : ''}`,
          );
        } catch (err) {
          logger.error(`[Files] Failed to ${spec.addCmd} ${entry.target} after ${fileName} edit:`, err.message);
        }
      }
    } catch (fatalErr) {
      logger.error('[Files] Unexpected error syncing list file commands:', fatalErr);
    }
  })();
}

// 统一实例内路径校验入口（共用）：resolveSafePath 抛出的
// PathTraversalError 映射为 PATH_TRAVERSAL_DETECTED（403）；其余错误原样上抛，
// 由各路由现有 catch 按 ENOENT→FILE_NOT_FOUND（404）的风格处理
function resolveInstancePath(basePath, userPath, options) {
  try {
    return resolveSafePath(basePath, userPath, options);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new AppError(ErrorCodes.PATH_TRAVERSAL_DETECTED);
    }
    throw err;
  }
}

export function createFileRoutes(serverManager) {
  const router = Router({ mergeParams: true });
  
  // 列出文件/目录（查询契约 issue 391：path 缺省归一 '/'，未知字段剥离）
  router.get('/instances/:instanceId/files', validateQuery(fileListRequestSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const dirPath = req.query.path;
      
      // 检查实例是否存在
      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);
      // 统一路径校验：resolveSafePath 四步防线——path.resolve 归一化、
      // 相等排除 + sep 边界、已存在组件逐段 realpath、最终目标 symlink 拒绝。
      // 列表根目录 '/' 是唯一合法的"归一化后等于实例根"场景，故传 allowRoot。
      const fullPath = resolveInstancePath(basePath, dirPath, { allowRoot: true });

      const stats = fs.statSync(fullPath);
      
      if (stats.isDirectory()) {
        const files = fs.readdirSync(fullPath).map(fileName => {
          const filePath = path.join(fullPath, fileName);
          const fileStats = fs.statSync(filePath);
          return {
            name: fileName,
            path: path.join(dirPath, fileName),
            type: fileStats.isDirectory() ? 'directory' : 'file',
            size: fileStats.size,
            modifiedAt: fileStats.mtime.toISOString(),
            isDirectory: fileStats.isDirectory()
          };
        });
        
        // 目录在前，文件在后，按名称排序
        files.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
        
        res.json(validatedSuccess(fileListResponseSchema, {
          path: dirPath,
          isDirectory: true,
          files
        }));
      } else {
        // 返回文件信息
        res.json(validatedSuccess(fileInfoResponseSchema, {
          name: path.basename(fullPath),
          path: dirPath,
          type: 'file',
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          isDirectory: false
        }));
      }
    } catch (err) {
      // 目标在 statSync/readdirSync/子项 statSync 执行期间被并发删除（另一管理
      // 请求、MC 重启清理、备份删除等）时抛裸 ENOENT：映射为 404 FILE_NOT_FOUND，
      // 否则 errorHandler 兜底返回 500。
      if (err.code === 'ENOENT') {
        next(new AppError(ErrorCodes.FILE_NOT_FOUND));
        return;
      }
      next(err);
    }
  });

  // 下载文件（GET /instances/:instanceId/files/download?path=）
  // 流式发送（createReadStream 不整读入内存，world/备份等大文件可下）；
  // 目录拒绝（目录下载应走备份打包流程，避免递归流拼接的边界问题）；
  // 审计 FILE_DOWNLOAD（与管理页其他文件操作对齐，下载敏感文件可追溯）
  router.get('/instances/:instanceId/files/download', validateQuery(filePathRequestSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const filePath = req.query.path;

      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);
      // 统一路径校验：实例内符号链接可越界读任意文件，
      // 与 GET /content 同级别的 realpath + symlink 拒绝防线
      const fullPath = resolveInstancePath(basePath, filePath);

      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Path is not a file (directory download not supported)');
      }

      const fileName = path.basename(fullPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', contentDisposition(fileName));

      recordAudit({
        instanceId,
        action: AuditActions.FILE_DOWNLOAD,
        targetType: 'file',
        targetId: filePath,
        detail: { name: fileName, sizeBytes: stats.size },
      });

      // 流错误在 headers 已发送后只能终止连接（无法改写状态码）——
      // 转发为 destroy 让 Node 记录连接错误，客户端表现为下载中断
      const stream = fs.createReadStream(fullPath);
      stream.on('error', (streamErr) => {
        logger.error('[Files] Download stream error:', streamErr.message);
        res.destroy(streamErr);
      });
      stream.pipe(res);
    } catch (err) {
      // statSync 阶段被并发删除 → 404（与 GET /content 同语义）
      if (err.code === 'ENOENT') {
        next(new AppError(ErrorCodes.FILE_NOT_FOUND));
        return;
      }
      next(err);
    }
  });

  // 读取文件内容
  router.get('/instances/:instanceId/files/content', validateQuery(filePathRequestSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const filePath = req.query.path;

      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);
      // 统一路径校验：实例目录内符号链接可越界读文件（root 运行时
      // 可读 /etc/shadow 等敏感文件），resolveSafePath 逐段 realpath + 最终目标
      // symlink 拒绝
      const fullPath = resolveInstancePath(basePath, filePath);

      // 不采用 existsSync 预检 + 后续 stat/read 的 check-then-act 模式：检查通过
      // 不保证读取时文件仍存在，并发删除会让 statSync/readFileSync 抛裸 ENOENT
      // 落入 500。直接 stat/read，文件不存在统一在 catch 映射为 404 FILE_NOT_FOUND。
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Path is not a file');
      }
      
      // 限制文件大小（10MB）
      if (stats.size > 10 * 1024 * 1024) {
        throw new AppError(ErrorCodes.FILE_TOO_LARGE, 'File too large to read content (max 10MB)');
      }
      
      const raw = fs.readFileSync(fullPath);
      const decoded = decodeContent(raw);
      if (!decoded) {
        throw new AppError(ErrorCodes.BINARY_FILE_NOT_SUPPORTED);
      }

      res.json(validatedSuccess(fileContentResponseSchema, {
        path: filePath,
        name: path.basename(fullPath),
        size: stats.size,
        content: decoded.content,
        encoding: decoded.encoding,
        modifiedAt: stats.mtime.toISOString()
      }));
    } catch (err) {
      // 文件在 statSync 与 readFileSync 之间被并发删除（另一管理请求、MC 重启
      // 重建文件、备份清理等）时抛裸 ENOENT：映射为 404 FILE_NOT_FOUND，
      // 否则 errorHandler 兜底返回 500 SERVER_ERROR。AppError.code 为数字错误码，
      // 与 fs 错误码字符串 'ENOENT' 互不冲突，不会误判。
      if (err.code === 'ENOENT') {
        next(new AppError(ErrorCodes.FILE_NOT_FOUND));
        return;
      }
      next(err);
    }
  });

  // 写入文件内容
  router.put('/instances/:instanceId/files/content', validateBody(fileSaveRequestSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const { path: filePath, content } = req.body;

      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);
      // 统一路径校验：符号链接越界写可覆盖实例外任意文件
      const fullPath = resolveInstancePath(basePath, filePath);

      // 确保目录存在（mkdir recursive 幂等，不做 existsSync 预检）
      ensureDir(path.dirname(fullPath));

      // 目标已存在且为二进制文件时拒绝覆盖（防二进制被 utf-8 解码乱码后保存损坏）
      // 已存在文件按原编码写回（utf-8 或 gbk，含 BOM 保留），新文件默认 utf-8
      // 读头部即判定：ENOENT ＝ 新建文件，不再用 existsSync 预检——预检与 openSync
      // 之间的窗口里文件被创建时，会把 GBK/二进制内容按「新文件」写成 UTF-8
      let encoding = 'utf-8';
      let hasBom = false;
      let targetExisted = true;
      let existingDecoded = null;
      try {
        existingDecoded = decodeContent(readFileHead(fullPath));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        targetExisted = false;
      }
      if (targetExisted) {
        if (!existingDecoded) {
          throw new AppError(ErrorCodes.BINARY_FILE_NOT_SUPPORTED);
        }
        encoding = existingDecoded.encoding;
        hasBom = existingDecoded.hasBom;
      }

      // 列表文件（banned-players/banned-ips/whitelist/ops.json）编辑后需同步 MC 内存：
      // 原版 MC 运行中不重读这些文件，直接改文件会导致内存/文件不一致（封禁文件另有
      // temp_bans 表）。保存前校验新内容为合法 JSON 数组（坏文件会让 MC 启动时加载
      // 失败），保存后对比新旧差异对运行中实例执行移除/新增命令并清理 temp_bans。
      // 大小写不敏感：BANNED-PLAYERS.JSON 等大写/混合大小写文件同样命中同步
      // （与前端 _languageForFile 的 toLowerCase 保持一致）
      const fileName = path.basename(fullPath).toLowerCase();
      const listSync = LIST_FILE_SYNC[fileName];
      if (listSync) {
        // 写入前读取旧条目（写完后旧内容已不存在，无法对比）；文件不存在或损坏
        // 一律视为空，仅同步新增——读操作本身容忍 ENOENT，故不做存在性预检
        let oldEntries = [];
        try {
          const oldDecoded = decodeContent(fs.readFileSync(fullPath));
          oldEntries = oldDecoded ? parseListEntries(oldDecoded.content, fileName) : [];
        } catch {
          oldEntries = []; // 旧文件不存在/损坏无法解析 → 视为空，仅同步新增
        }

        // 校验新内容必须为合法 JSON 数组，非法直接拒绝保存
        let newEntries;
        try {
          newEntries = parseListEntries(content, fileName);
        } catch {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, `${fileName} 必须是合法的 JSON 数组`);
        }

        atomicWriteFile(fullPath, encodeContent(content, encoding, hasBom));
        syncListFileChanges(instance, fileName, oldEntries, newEntries);
      } else {
        atomicWriteFile(fullPath, encodeContent(content, encoding, hasBom));
      }

      // 保存 server.properties 后刷新实例内存缓存：缓存仅在构造时加载一次，
      // 不刷新会导致 isRconConnected 判 RCON 关闭、saveProperties 以陈旧缓存
      // 为合并基址回滚文件编辑、状态页读到过期值（与 GET /properties 的重读行为对齐）
      if (fileName === 'server.properties' && typeof instance._loadProperties === 'function') {
        const fresh = instance._loadProperties();
        if (fresh && Object.keys(fresh).length > 0) {
          instance.properties = fresh;
        }
      }

      const stats = fs.statSync(fullPath);

      recordAudit({
        instanceId,
        action: AuditActions.FILE_SAVE,
        targetType: 'file',
        targetId: filePath,
        detail: { name: path.basename(fullPath), sizeBytes: stats.size, encoding },
      });

      res.json(validatedSuccess(fileSaveResponseSchema, {
        path: filePath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      }, 'File saved successfully'));
    } catch (err) {
      // 读取/写入期间文件被并发删除（另一管理请求、MC 重启清理、备份删除等）时
      // 抛裸 ENOENT：映射为 404 FILE_NOT_FOUND，否则 errorHandler 兜底返回 500。
      if (err.code === 'ENOENT') {
        next(new AppError(ErrorCodes.FILE_NOT_FOUND));
        return;
      }
      next(err);
    }
  });
  
  // 删除文件/目录
  router.delete('/instances/:instanceId/files', validateQuery(filePathRequestSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const filePath = req.query.path;

      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);
      // 统一路径校验：resolveSafePath 相等性排除兜住根目录删除，
      // sep 边界杜绝父子实例越界，删除前 lstat 确认目标非符号链接。
      const fullPath = resolveInstancePath(basePath, filePath);

      // 列表文件（banned-players/banned-ips/whitelist/ops.json）删除 = 清空全部条目：
      // 删除前读取旧条目，删除后同步 MC 内存（下发移除命令）+ 清理 temp_bans，
      // 否则 MC 运行中内存封禁仍生效、玩家无法进服（与 PUT 的 LIST_FILE_SYNC 行为对齐）
      // 存在性与类型只取一次 stat：预检 + statSync 两步之间的删除窗口会抛裸 ENOENT，
      // 而 rmSync 的 force 本就容忍 ENOENT，预检没有承担任何判定职责
      const delStat = fs.statSync(fullPath);
      const delFileName = path.basename(fullPath).toLowerCase();
      const delSpec = LIST_FILE_SYNC[delFileName];
      let delOldEntries = [];
      if (delSpec && delStat.isFile()) {
        try {
          const oldDecoded = decodeContent(fs.readFileSync(fullPath));
          delOldEntries = oldDecoded ? parseListEntries(oldDecoded.content, delFileName) : [];
        } catch {
          delOldEntries = []; // 旧文件不存在/损坏无法解析 → 视为空
        }
      }

      const delIsDirectory = delStat.isDirectory();

      // 递归删除
      fs.rmSync(fullPath, { recursive: true, force: true });

      // 文件已删除 → 新条目为空：全部旧条目视为移除
      if (delSpec && delOldEntries.length > 0) {
        syncListFileChanges(instance, delFileName, delOldEntries, []);
      }

      recordAudit({
        instanceId,
        action: AuditActions.FILE_DELETE,
        targetType: delIsDirectory ? 'directory' : 'file',
        targetId: filePath,
        detail: { name: path.basename(fullPath), isDirectory: delIsDirectory },
      });

      res.json(validatedSuccess(nullDataSchema, null, 'File/directory deleted successfully'));
    } catch (err) {
      // statSync/读取期间目标被并发删除（另一管理请求、MC 重启清理、备份删除等）
      // 时抛裸 ENOENT：映射为 404 FILE_NOT_FOUND，否则 errorHandler 兜底返回 500
      // SERVER_ERROR。AppError.code 为数字错误码，与 fs 错误码字符串 'ENOENT'
      // 互不冲突，不会误判。
      if (err.code === 'ENOENT') {
        next(new AppError(ErrorCodes.FILE_NOT_FOUND));
        return;
      }
      next(err);
    }
  });
  
  // 新建目录（POST /instances/:instanceId/files/mkdir）
  router.post('/instances/:instanceId/files/mkdir', validateBody(fileMkdirRequestSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const { path: dirPath } = req.body;

      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);
      const fullPath = resolveInstancePath(basePath, dirPath);

      // 非递归 mkdir 独占创建：EEXIST 即「已存在」的原子判定（recursive 会把已存在
      // 吞成成功，预检 + recursive 之间的窗口会返回 200 而非 409）。父目录缺失时
      // 先补齐父级再重试，保持「支持多级路径」的既有语义（前端新建目录走该能力）
      try {
        fs.mkdirSync(fullPath);
      } catch (err) {
        if (err.code === 'EEXIST') {
          throw new AppError(ErrorCodes.FILE_ALREADY_EXISTS, 'Directory already exists');
        }
        if (err.code !== 'ENOENT') throw err;
        ensureDir(path.dirname(fullPath));
        try {
          fs.mkdirSync(fullPath);
        } catch (retryErr) {
          if (retryErr.code === 'EEXIST') {
            throw new AppError(ErrorCodes.FILE_ALREADY_EXISTS, 'Directory already exists');
          }
          throw retryErr;
        }
      }

      recordAudit({
        instanceId,
        action: AuditActions.FILE_MKDIR,
        targetType: 'directory',
        targetId: dirPath,
        detail: { name: path.basename(fullPath) },
      });

      res.json(validatedSuccess(fileMkdirResponseSchema, {
        path: dirPath,
        name: path.basename(fullPath),
      }, 'Directory created successfully'));
    } catch (err) {
      next(err);
    }
  });

  // 重命名文件/目录（POST /instances/:instanceId/files/rename）
  router.post('/instances/:instanceId/files/rename', validateBody(fileRenameRequestSchema), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const { path: oldPath, newPath } = req.body;

      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);
      const fullOldPath = resolveInstancePath(basePath, oldPath);
      const fullNewPath = resolveInstancePath(basePath, newPath);

      // 无覆盖重命名：目标是否存在由 renameNoClobber 的独占声明判定。不用
      // 「existsSync 预检 + renameSync」——两步之间目标被并发创建时，rename 会
      // 静默覆盖（POSIX 与 Windows 实测皆覆盖），被覆盖方数据直接丢失
      try {
        renameNoClobber(fullOldPath, fullNewPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'Source file not found');
        }
        if (err.code === 'EEXIST') {
          throw new AppError(ErrorCodes.FILE_ALREADY_EXISTS, 'Target already exists');
        }
        throw err;
      }

      recordAudit({
        instanceId,
        action: AuditActions.FILE_RENAME,
        targetType: 'file',
        targetId: newPath,
        detail: { from: oldPath, to: newPath },
      });

      res.json(validatedSuccess(fileRenameResponseSchema, {
        oldPath,
        newPath,
        name: path.basename(fullNewPath),
      }, 'Renamed successfully'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        next(new AppError(ErrorCodes.FILE_NOT_FOUND));
        return;
      }
      next(err);
    }
  });

// ── 文件上传常量 ──────────────────────────────────────────────

/** 上传体积上限（字节），可通过环境变量覆盖 */
const FILE_UPLOAD_MAX_SIZE = parseInt(process.env.FILE_UPLOAD_MAX_SIZE || '') || 50 * 1024 * 1024;

/** 扩展名黑名单：可执行文件与 MC JAR（JAR 走部署流程不上传） */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.sh', '.bash', '.bat', '.cmd', '.ps1', '.vbs', '.wsf',
  '.dll', '.so', '.dylib', '.class', '.jar', '.msi', '.deb', '.rpm',
]);

/**
 * 清洗上传文件名：拒绝路径分隔符、控制字符、..、.、空名；
 * 保留 MC 配置文件 .properties 等以点开头的合法名称。
 */
function sanitizeFileName(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // 拒绝路径分隔符与控制字符
  if (/[\\/\x00-\x1f]/.test(raw)) return null; // eslint-disable-line no-control-regex
  // 拒绝 .. 和单独 .
  if (raw === '..' || raw === '.') return null;
  // 拒绝以 .. 开头或包含 /../ 的路径段
  if (raw.includes('..')) return null;
  return raw;
}

/** multer 磁盘缓冲配置（临时目录在系统 tmpdir 下，不污染实例目录） */
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(os.tmpdir(), 'mc-commander-uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, `.upload.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: FILE_UPLOAD_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    // 扩展名黑名单
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return cb(new AppError(ErrorCodes.FILE_TYPE_NOT_ALLOWED, `File type ${ext} is not allowed`), false);
    }
    // 文件名清洗（拒绝路径分隔符 / .. / 控制字符）
    const safeName = sanitizeFileName(file.originalname);
    if (!safeName) {
      return cb(new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid file name'), false);
    }
    cb(null, true);
  },
});


  // 上传文件（POST /instances/:instanceId/files/upload，multipart/form-data）
  // multer 错误标准化中间件：MulterError（file too large 等）→ AppError；
  // targetDir 查询契约（issue 391）：缺省归一 '/'、拒绝控制字符，由 schema 完成
  router.post('/instances/:instanceId/files/upload', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        // multer 自身错误（MulterError）统一映射为 400
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError(ErrorCodes.FILE_UPLOAD_TOO_LARGE,
            `File too large (max ${Math.round(FILE_UPLOAD_MAX_SIZE / 1024 / 1024)}MB)`));
        }
        // AppError（文件名清洗/扩展名黑名单）直接透传
        return next(err);
      }
      next();
    });
  }, validateQuery(fileUploadQuerySchema, {
    // multer diskStorage 已落盘（系统 tmpdir 缓冲）：schema 拒绝非法 targetDir
    // （空串/控制字符）时在 400 前清理临时文件，承接原 handler 内 unlinkSync
    // 清理语义，杜绝磁盘残留（#397 回归修复，issue 391 安全性只增不减）
    onError: (req) => {
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
    },
  }), (req, res, next) => {
    try {
      const { instanceId } = req.params;
      const uploadedFile = req.file;

      if (!uploadedFile) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'No file uploaded');
      }

      // 清洗原始文件名
      const safeName = sanitizeFileName(uploadedFile.originalname);
      if (!safeName) {
        // 清理 multer 临时文件
        try { fs.unlinkSync(uploadedFile.path); } catch {}
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid file name');
      }

      const instance = serverManager.getInstance(instanceId);
      if (!instance) {
        try { fs.unlinkSync(uploadedFile.path); } catch {}
        throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
      }

      const basePath = instance.serverPath || path.join(config.serversDir, instanceId);

      // 目标目录：可选 targetDir 查询参数（schema 已缺省归一 '/'、补全前导 /
      // 并拒绝控制字符，issue 391）
      const normalizedDir = req.query.targetDir;
      // 去掉前导 / 以便拼接（normalizedDir 为 '/' 时 relativeDir 为空）
      const relativeDir = normalizedDir === '/' ? '' : normalizedDir.slice(1);
      const relativePath = relativeDir ? `${relativeDir}/${safeName}` : safeName;

      // 路径校验（resolveInstancePath 兜住目录穿越）
      const targetDirFullPath = resolveInstancePath(basePath, normalizedDir, { allowRoot: true });
      // 目标目录必须存在（ENOENT → 400；非目录 → 400）
      let dirStats;
      try {
        dirStats = fs.statSync(targetDirFullPath);
      } catch {
        try { fs.unlinkSync(uploadedFile.path); } catch {}
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Target directory does not exist');
      }
      if (!dirStats.isDirectory()) {
        try { fs.unlinkSync(uploadedFile.path); } catch {}
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Target path is not a directory');
      }

      // 目标路径：文件名取自清洗后的原始名
      const targetPath = path.join(targetDirFullPath, safeName);
      // 二次路径校验（用完整路径兜住边缘情况）
      resolveInstancePath(basePath, `/${relativePath}`);

      // 同名覆盖（MC 用户常上传覆盖配置）；跨设备安全用 copyFileSync + unlink
      fs.copyFileSync(uploadedFile.path, targetPath);
      try { fs.unlinkSync(uploadedFile.path); } catch {}

      const stats = fs.statSync(targetPath);
      const resultPath = `/${relativePath}`;

      recordAudit({
        instanceId,
        action: AuditActions.FILE_UPLOAD,
        targetType: 'file',
        targetId: resultPath,
        detail: { name: safeName, sizeBytes: stats.size },
      });

      res.json(validatedSuccess(fileUploadResponseSchema, {
        path: resultPath,
        name: safeName,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        isDirectory: false,
      }, 'File uploaded successfully'));
    } catch (err) {
      // 清理 multer 临时文件（如果还存在）
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
      next(err);
    }
  });

  return router;
}

export default createFileRoutes;
