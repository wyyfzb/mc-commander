import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { load as yamlLoad } from 'js-yaml';
import { AppError, ErrorCodes } from '../utils/response.js';
import { resolveSafePath, PathTraversalError } from '../utils/fs-utils.js';

/**
 * 插件管理服务（feat-8 P0-5 插件管理最小闭环）。
 *
 * 范围：Bukkit 系（Paper/Spigot/Purpur）`plugins/` 目录内 jar 插件的
 * 列表 / 启停 / 删除。启停 = 行业通用约定：jar 重命名追加/移除
 * `.disabled` 后缀（Multicraft、GGServers、TogglePlugins 等均如此），
 * 不做依赖解析、不做运行期热卸载（Bukkit 插件仅在服务器启动时加载，
 * 启停后需重启实例生效，由前端明确提示）。
 *
 * 远景（roadmap P2）：数据包与 mod 管理（mods/ 目录复用同一套模型）。
 */

/// 插件文件名白名单：字母数字开头，允许 . _ - ，以 .jar 或 .jar.disabled 结尾。
/// 拒绝路径分隔符/空白/控制字符/隐藏文件，路径逃逸由 resolveSafePath 兜底。
const PLUGIN_FILE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jar(\.disabled)?$/;

/// 单实例插件数量上限：防止异常目录拖垮列表请求（正常服 < 100 个插件）
const MAX_PLUGINS = 200;

/**
 * 校验插件文件名：白名单 + resolveSafePath 双重防护。
 * 返回 plugins 目录下该文件的绝对路径。
 */
function resolvePluginFile(serverPath, fileName) {
  if (typeof fileName !== 'string' || !PLUGIN_FILE_REGEX.test(fileName)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid plugin file name: ${fileName}`);
  }
  const pluginsDir = path.join(serverPath, 'plugins');
  try {
    // userPath 允许一层文件名；allowRoot 无关（文件名不可能解析为根）
    const full = resolveSafePath(pluginsDir, fileName, { allowRoot: false });
    // 再校验父目录必须是 plugins 目录本身（防止实例根作为 base 时逃逸）
    if (path.dirname(full) !== path.resolve(pluginsDir)) {
      throw new PathTraversalError('Plugin file must reside directly in plugins/');
    }
    return full;
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid plugin path: ${fileName}`);
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
        doc = yamlLoad(text);
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
        apiVersion: typeof doc['api-version'] === 'string'
          ? doc['api-version']
          : (typeof doc.apiVersion === 'string' ? doc.apiVersion : null),
        description: typeof doc.description === 'string' ? doc.description : null,
        authors: Array.isArray(doc.authors)
          ? doc.authors.filter((a) => typeof a === 'string').slice(0, 10)
          : (typeof doc.author === 'string' ? [doc.author] : []),
        depend: Array.isArray(doc.depend)
          ? doc.depend.filter((d) => typeof d === 'string').slice(0, 20)
          : [],
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
 * 列出实例 plugins/ 目录下所有插件（含启用与禁用）。
 * 返回 { plugins: [{ file, name, enabled, sizeBytes, mtimeMs, meta }] }，
 * 按启用优先、文件名字典序排序。plugins/ 目录不存在视为空列表（首启前无该目录）。
 */
export function listPlugins(serverPath) {
  const pluginsDir = path.join(serverPath, 'plugins');
  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { plugins: [] };
    if (err.code === 'ENOTDIR') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'plugins is not a directory');
    }
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to list plugins: ${err.message}`);
  }

  const plugins = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(/^(.+\.jar)(\.disabled)?$/i);
    if (!m) continue;
    if (!PLUGIN_FILE_REGEX.test(ent.name)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(pluginsDir, ent.name));
    } catch {
      continue; // 竞态：列表瞬间文件被移除，直接跳过
    }
    plugins.push({
      file: ent.name,
      name: m[1].replace(/\.jar$/i, ''),
      enabled: !m[2],
      sizeBytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      meta: readPluginMeta(path.join(pluginsDir, ent.name)),
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
 */
export function setPluginEnabled(serverPath, fileName, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'enabled must be a boolean');
  }
  const full = resolvePluginFile(serverPath, fileName);
  const isDisabled = fileName.toLowerCase().endsWith('.jar.disabled');
  if (enabled === !isDisabled) {
    throw new AppError(ErrorCodes.PLUGIN_STATE_CONFLICT,
      enabled ? 'Plugin is already enabled' : 'Plugin is already disabled');
  }
  if (!fs.existsSync(full)) {
    throw new AppError(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin file not found: ${fileName}`);
  }
  const baseName = isDisabled ? fileName.slice(0, -'.disabled'.length) : fileName;
  const targetName = enabled ? baseName : `${fileName}.disabled`;
  const targetFull = path.join(path.dirname(full), targetName);
  if (fs.existsSync(targetFull)) {
    throw new AppError(ErrorCodes.PLUGIN_STATE_CONFLICT, `Target file already exists: ${targetName}`);
  }
  try {
    fs.renameSync(full, targetFull);
  } catch (err) {
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to rename plugin: ${err.message}`);
  }
  return { file: targetName, enabled };
}

/**
 * 删除插件文件（启用/禁用状态均可删）。
 */
export function deletePlugin(serverPath, fileName) {
  const full = resolvePluginFile(serverPath, fileName);
  if (!fs.existsSync(full)) {
    throw new AppError(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin file not found: ${fileName}`);
  }
  try {
    fs.unlinkSync(full);
  } catch (err) {
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to delete plugin: ${err.message}`);
  }
  return { deleted: fileName };
}
