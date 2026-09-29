import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { load as yamlLoad, FAILSAFE_SCHEMA } from 'js-yaml';
import { AppError, ErrorCodes } from '../utils/response.js';
import {
  ensureDir,
  renameNoClobber,
  resolveSafePath,
  PathTraversalError,
} from '../utils/fs-utils.js';

/**
 * 插件/模组文件管理服务（同一套模型的两种装载目标）。
 *
 * 两种目标目录（`kind`）：
 * - `plugin`（默认）：Bukkit 系（Paper/Spigot/Purpur）`plugins/` 目录内的 jar。
 *   启停 = 行业通用约定：jar 重命名追加/移除 `.disabled` 后缀（Multicraft、GGServers、
 *   TogglePlugins 等均如此），不做依赖解析、不做运行期热卸载（Bukkit 插件仅在服务器
 *   启动时加载，启停后需重启实例生效，由前端明确提示）。
 * - `mod`：Fabric/Forge `mods/` 目录内的 jar。**只做列表 / 上传 / 删除**——启停
 *   **刻意不支持**：`.disabled` 是 Bukkit 系约定，Forge/Fabric 在文件层面**没有**通用
 *   等价物，照搬会让用户以为「已禁用」而实际仍被加载。要启停得走各自 loader 的配置，
 *   那是另一件事（见下方 MOD_ENABLE_UNSUPPORTED）。
 *
 * 目录名**由 kind 参数化**：此前写死 `plugins/`，本次抽成 LOAD_TARGETS 一处声明，
 * 新增目标不再散落到三个函数里各改一遍。
 */

/**
 * 装载目标表（目录名 + 是否支持文件级启停）——**唯一声明源**。
 * `supportsToggle=false` 的目标在启停入口即拒绝，而不是静默改名（静默改名会写出
 * loader 不认的文件名，表现为「mod 消失了」）。
 */
export const LOAD_TARGETS = Object.freeze({
  plugin: { dir: 'plugins', label: '插件', supportsToggle: true },
  mod: { dir: 'mods', label: '模组', supportsToggle: false },
});

/** 默认目标：既有调用方不传 kind 时行为逐字不变 */
export const DEFAULT_LOAD_TARGET = 'plugin';

/**
 * 解析装载目标：未知 kind 报错而不是回落到 plugins/——回落会把「拼错的 kind」
 * 变成「操作了错误的目录」（对 mods 的危险是双向的：既可能删错，也可能删不掉）。
 */
export function resolveLoadTarget(kind = DEFAULT_LOAD_TARGET) {
  const target = LOAD_TARGETS[kind];
  if (!target) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Unknown load target: ${kind}`);
  }
  return { kind, ...target };
}

/// 插件文件名白名单：字母数字开头，允许 . _ - ，以 .jar 或 .jar.disabled 结尾。
/// 拒绝路径分隔符/空白/控制字符/隐藏文件，路径逃逸由 resolveSafePath 兜底。
const PLUGIN_FILE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jar(\.disabled)?$/;

/// 上传文件名白名单：仅允许 .jar（不允许直接上传 .disabled 状态，启停走接口）
const PLUGIN_UPLOAD_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jar$/;

/// zip 容器魔数（jar 实为 zip）：PK\x03\x04。mod jar 同样是 zip，故同一校验复用
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/// 单实例条目数量上限：防止异常目录拖垮列表请求（正常服 < 100 个）
const MAX_PLUGINS = 200;

/**
 * 校验条目文件名：白名单 + resolveSafePath 双重防护。
 * 返回目标目录下该文件的绝对路径。
 */
function resolveTargetFile(serverPath, fileName, kind = DEFAULT_LOAD_TARGET) {
  const { dir, label } = resolveLoadTarget(kind);
  if (typeof fileName !== 'string' || !PLUGIN_FILE_REGEX.test(fileName)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid ${kind} file name: ${fileName}`);
  }
  const targetDir = path.join(serverPath, dir);
  try {
    // userPath 允许一层文件名；allowRoot 无关（文件名不可能解析为根）
    const full = resolveSafePath(targetDir, fileName, { allowRoot: false });
    // 再校验父目录必须是目标目录本身（防止实例根作为 base 时逃逸）
    if (path.dirname(full) !== path.resolve(targetDir)) {
      throw new PathTraversalError(`${label} file must reside directly in ${dir}/`);
    }
    return full;
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid ${kind} path: ${fileName}`);
    }
    throw err;
  }
}

/**
 * 从 jar 内读取插件元数据：优先 plugin.yml（Bukkit 系），退回 paper-plugin.yml。
 * jar 实为 zip：adm-zip 先读 central directory，再按需解压单个 entry，
 * 对 MB 级插件 jar 成本可控（不整包解压）。
 * 任一环节失败返回 null（显示层降级为"无元数据"，绝不因个别损坏 jar 拖垮列表）。
 */
export function readPluginMeta(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const entryNames = ['plugin.yml', 'paper-plugin.yml'];
    for (const name of entryNames) {
      const entry = zip.getEntry(name);
      if (!entry) continue;
      const text = entry.getData().toString('utf8');
      let doc;
      try {
        // FAILSAFE schema：所有标量按字符串读取（与 Bukkit PluginDescriptionFile 语义一致），
        // 避免 version: 2.0 / api-version: 1.20 被 YAML 解析为 float 后丢失尾零/类型不符
        doc = yamlLoad(text, { schema: FAILSAFE_SCHEMA });
      } catch {
        continue; // YAML 解析失败，尝试下一个 descriptor
      }
      if (!doc || typeof doc !== 'object') continue;
      // Bukkit plugin.yml：name/version/main/api-version/authors/description/depend
      // paper-plugin.yml：name/version/main/apiVersion/…（api-version 的连字符变体）
      const meta = {
        name: typeof doc.name === 'string' ? doc.name : null,
        version: typeof doc.version === 'string' ? doc.version : null,
        main: typeof doc.main === 'string' ? doc.main : null,
        apiVersion:
          typeof doc['api-version'] === 'string'
            ? doc['api-version']
            : typeof doc.apiVersion === 'string'
              ? doc.apiVersion
              : null,
        description: typeof doc.description === 'string' ? doc.description : null,
        authors: Array.isArray(doc.authors)
          ? doc.authors.filter((a) => typeof a === 'string').slice(0, 10)
          : typeof doc.author === 'string'
            ? [doc.author]
            : [],
        depend: Array.isArray(doc.depend)
          ? doc.depend.filter((d) => typeof d === 'string').slice(0, 20)
          : [],
        // 详情面板扩展字段：软依赖（缺失不影响加载）、官网、加载时机（STARTUP/POSTWORLD）
        softdepend: Array.isArray(doc.softdepend)
          ? doc.softdepend.filter((d) => typeof d === 'string').slice(0, 20)
          : [],
        website: typeof doc.website === 'string' ? doc.website : null,
        load: doc.load === 'STARTUP' || doc.load === 'POSTWORLD' ? doc.load : null,
      };
      // 至少有 name 或 main 才算有效元数据
      if (meta.name || meta.main) return meta;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 上传条目 jar（延伸）：multer 已将 multipart 落盘到临时文件。
 * - 文件名校验：PLUGIN_UPLOAD_NAME_REGEX（仅 .jar，拒绝路径分隔符/控制字符）
 * - zip 魔数校验：头部 4 字节必须为 PK\x03\x04（拒绝伪装成 jar 的任意文件）
 * - 目标目录不存在时自动创建（首次启动前装插件/模组是主流流程）
 * - 同名冲突：默认拒绝（40912）；overwrite=true 时替换旧文件（审计记录 overwritten）
 * - 移动：copyFileSync（跨设备安全，与 files 路由同模式；临时文件由路由层清理）
 * 返回 { file, sizeBytes, mtimeMs, meta, overwritten }。
 */
export function uploadPlugin(
  serverPath,
  tmpFilePath,
  originalName,
  { overwrite = false, kind = DEFAULT_LOAD_TARGET } = {},
) {
  const { dir } = resolveLoadTarget(kind);
  if (typeof originalName !== 'string' || !PLUGIN_UPLOAD_NAME_REGEX.test(originalName)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid ${kind} file name: ${originalName}`);
  }

  // zip 魔数校验（只读头部 4 字节，不整包扫描）
  let head;
  try {
    const fd = fs.openSync(tmpFilePath, 'r');
    try {
      head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to read uploaded file: ${err.message}`);
  }
  if (!head.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Uploaded file is not a valid jar (zip magic check failed)',
    );
  }

  const targetDir = path.join(serverPath, dir);
  try {
    ensureDir(targetDir);
  } catch (err) {
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to create ${dir} dir: ${err.message}`);
  }

  // 路径兜底：文件名不可能含分隔符（正则已挡），双保险校验解析结果仍在目标目录下
  const targetFull = path.join(targetDir, originalName);
  if (path.dirname(targetFull) !== path.resolve(targetDir)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid ${kind} path: ${originalName}`);
  }

  // 同名冲突判定由写入动作本身承担，不用「existsSync 预检 + unlink + copy」三步：
  // 预检与 unlink 之间被并发创建的同名插件会被静默删除，且 unlink 与 copy 之间
  // 崩溃会留下「插件已消失」的中间态。overwrite=false 走 COPYFILE_EXCL（存在即
  // EEXIST，独占创建语义）；overwrite=true 先写同目录临时文件再 rename 覆盖
  // （rename 是原子替换）。
  const existedBefore = fs.existsSync(targetFull); // 仅决定回执状态码 200/201，不承担并发闸门
  if (overwrite) {
    const staging = `${targetFull}.${crypto.randomUUID()}.tmp`;
    try {
      fs.copyFileSync(tmpFilePath, staging);
      fs.renameSync(staging, targetFull);
    } catch (err) {
      try {
        fs.unlinkSync(staging);
      } catch {
        /* 未创建或已被 rename 消费 */
      }
      throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to save plugin: ${err.message}`);
    }
  } else {
    try {
      fs.copyFileSync(tmpFilePath, targetFull, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new AppError(
          ErrorCodes.PLUGIN_FILE_EXISTS,
          `Plugin file already exists: ${originalName}`,
        );
      }
      throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to save plugin: ${err.message}`);
    }
  }
  const overwritten = overwrite && existedBefore;

  let stat;
  try {
    stat = fs.statSync(targetFull);
  } catch (err) {
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to stat plugin: ${err.message}`);
  }
  return {
    file: originalName,
    sizeBytes: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    meta: readPluginMeta(targetFull),
    overwritten,
  };
}

/**
 * 列出目标目录下所有条目（含启用与禁用）。
 * 返回 `{ plugins: [{ file, name, enabled, sizeBytes, mtimeMs, meta }] }`，
 * 按启用优先、文件名字典序排序。目录不存在视为空列表（首启前无该目录）。
 *
 * `plugins` 这个键名对 `mod` 目标同样沿用：它是既有前端契约的字段名，
 * 改键名会让旧前端取不到数据；语义上它就是「条目列表」。
 */
export function listPlugins(serverPath, { kind = DEFAULT_LOAD_TARGET } = {}) {
  const { dir, label } = resolveLoadTarget(kind);
  const targetDir = path.join(serverPath, dir);
  let entries;
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { plugins: [] };
    if (err.code === 'ENOTDIR') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `${dir} is not a directory`);
    }
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to list ${label}: ${err.message}`);
  }

  const plugins = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(/^(.+\.jar)(\.disabled)?$/i);
    if (!m) continue;
    if (!PLUGIN_FILE_REGEX.test(ent.name)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(targetDir, ent.name));
    } catch {
      continue; // 竞态：列表瞬间文件被移除，直接跳过
    }
    plugins.push({
      file: ent.name,
      name: m[1].replace(/\.jar$/i, ''),
      enabled: !m[2],
      sizeBytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      meta: readPluginMeta(path.join(targetDir, ent.name)),
    });
    if (plugins.length >= MAX_PLUGINS) break;
  }

  plugins.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.file.localeCompare(b.file);
  });
  return { plugins };
}

/**
 * 启用/禁用插件：jar ↔ jar.disabled 原子重命名。
 * - 文件必须存在且类型匹配目标状态（重复启停返回 409 语义冲突）
 * - 目标名已存在时拒绝（409），避免覆盖
 * - 服务器运行中允许操作（Bukkit 仅启动时加载），由前端提示重启生效
 *
 * **仅对支持文件级启停的目标有效**（`LOAD_TARGETS[kind].supportsToggle`）。
 * `mod` 目标在入口即拒绝：Forge/Fabric 没有 `.disabled` 通用约定，照搬会写出
 * loader 不认的文件名，表现为「mod 消失了」——比明确报错危险得多。
 */
export function setPluginEnabled(
  serverPath,
  fileName,
  enabled,
  { kind = DEFAULT_LOAD_TARGET } = {},
) {
  const { label, supportsToggle } = resolveLoadTarget(kind);
  if (!supportsToggle) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `${label}不支持按文件启停（该 loader 无文件层启停约定），请用其自身的配置启停`,
    );
  }
  if (typeof enabled !== 'boolean') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'enabled must be a boolean');
  }
  const full = resolveTargetFile(serverPath, fileName, kind);
  const isDisabled = fileName.toLowerCase().endsWith('.jar.disabled');
  if (enabled === !isDisabled) {
    throw new AppError(
      ErrorCodes.PLUGIN_STATE_CONFLICT,
      enabled ? 'Plugin is already enabled' : 'Plugin is already disabled',
    );
  }
  const baseName = isDisabled ? fileName.slice(0, -'.disabled'.length) : fileName;
  const targetName = enabled ? baseName : `${fileName}.disabled`;
  const targetFull = path.join(path.dirname(full), targetName);
  // 源不存在 / 目标被占用都由 renameNoClobber 的独占声明判定并抛原生错误码：
  // 「existsSync 预检 + renameSync」之间目标被并发创建时，rename 会静默覆盖
  try {
    renameNoClobber(full, targetFull);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new AppError(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin file not found: ${fileName}`);
    }
    if (err.code === 'EEXIST') {
      throw new AppError(
        ErrorCodes.PLUGIN_STATE_CONFLICT,
        `Target file already exists: ${targetName}`,
      );
    }
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to rename plugin: ${err.message}`);
  }
  return { file: targetName, enabled };
}

/**
 * 删除条目文件（启用/禁用状态均可删）。插件与模组共用，目录由 `kind` 决定。
 */
export function deletePlugin(serverPath, fileName, { kind = DEFAULT_LOAD_TARGET } = {}) {
  resolveLoadTarget(kind);
  const full = resolveTargetFile(serverPath, fileName, kind);
  // 不做存在性预检：unlink 的 ENOENT 即「不存在」，映射为 404 语义
  try {
    fs.unlinkSync(full);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new AppError(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin file not found: ${fileName}`);
    }
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to delete ${kind}: ${err.message}`);
  }
  return { deleted: fileName };
}
