/**
 * 实例版本读取域：从服务端 JAR 内 `version.json` 取权威 MC 版本与所需 Java 版本。
 *
 * 为什么需要它：`mcVersion` 原先只来自 DB 字段（部署/升级时写入），用户绕过面板
 * 手动换 jar（或外部升级）后该值不会更新，而它被两处功能性消费——gamerule 版本
 * 选集（1.21.11 前后规则名不同）与推荐 JDK。取错版本会选错规则表、推荐错 Java。
 *
 * `version.json` 由服务端自身携带，vanilla 与 Paper 均在 JAR 根部提供同一份结构
 * （实测 1.21.4：vanilla 184 条目 / Paper 612 条目，两者该文件均含 id /
 * java_version / protocol_version）。故按「DB 的 jarFile → 常见 jar 名」定位，
 * 不依赖具体服务端类型。Fabric/Forge 的启动 jar 由安装器生成、不含该文件，
 * 读取失败即回退，不影响既有行为。
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { isPathContained } from '../../utils/fs-utils.js';
import { logger } from '../../utils/logger.js';

/** 候选 jar 名（按命中概率排序）：部署产物 jarFile 之外的常见形态 */
const CANDIDATE_JAR_NAMES = ['server.jar', 'paper.jar', 'purpur.jar', 'fabric-server-launch.jar'];

/**
 * 读取实例 JAR 内的 version.json。
 * 返回值全部可空：文件不存在/不是 zip/缺字段/越界 一律回退 null，由调用方决定降级。
 * @returns {{ id: string, javaVersion: number|null, protocolVersion: number|null } | null}
 */
/**
 * 读单个 jar 内的 version.json。**接绝对路径**，供升级路径读「刚下载、尚未替换」的新 jar。
 * 返回值全部可空：不存在/不是 zip/缺字段 一律 null，由调用方决定降级。
 * @param {string} jarPath
 * @returns {{ id: string, javaVersion: number|null, protocolVersion: number|null } | null}
 */
export function readJarVersionInfo(jarPath) {
  let zip;
  try {
    if (!fs.statSync(jarPath).isFile()) return null;
    zip = new AdmZip(jarPath);
  } catch {
    return null; // 不存在/打不开（非 zip、正在被写）
  }
  try {
    const entry = zip.getEntry('version.json');
    if (!entry) return null;
    const info = JSON.parse(zip.readAsText(entry));
    const id = typeof info?.id === 'string' && info.id.trim() ? info.id.trim() : null;
    if (!id) return null;
    return {
      id,
      javaVersion: Number.isInteger(info.java_version) ? info.java_version : null,
      protocolVersion: Number.isInteger(info.protocol_version) ? info.protocol_version : null,
    };
  } catch (e) {
    logger.warn(`读取 ${path.basename(jarPath)} 内 version.json 失败:`, e.message);
    return null;
  }
}

export function _readJarVersionInfo() {
  const candidates = [];
  // DB 的 jarFile 优先（Forge 实例是 forge-*-universal.jar，且部署已把它落到实例根）
  if (this.jarFile) candidates.push(this.jarFile);
  for (const name of CANDIDATE_JAR_NAMES) {
    if (!candidates.includes(name)) candidates.push(name);
  }

  for (const name of candidates) {
    const jarPath = path.join(this.serverPath, name);
    // 与 players/stats 读取同口径：resolve 后必须落在实例目录内，越界即丢弃
    if (!isPathContained(this.serverPath, jarPath)) continue;
    const info = readJarVersionInfo(jarPath);
    if (info) return info;
  }
  return null;
}

/**
 * 带 stat 键缓存的版本读取：jar 每次被替换（升级/手动换）mtime+size 必变，
 * 命中即返回，避免每轮状态轮询都解压 jar。
 */
export function _getJarVersionInfo() {
  const jarName = this.jarFile || 'server.jar';
  const jarPath = path.join(this.serverPath, jarName);
  let statKey = null;
  try {
    const st = fs.statSync(jarPath);
    statKey = `${st.mtimeMs}:${st.size}`;
  } catch {
    /* 取不到 stat：不缓存，直接尝试读取（可能命中其它候选名） */
  }

  const cache = this._jarVersionCache;
  if (cache && statKey && cache.statKey === statKey) return cache.value;

  const value = this._readJarVersionInfo();
  if (statKey) this._jarVersionCache = { statKey, value };
  return value;
}
