/**
 * JAR 下载落地校验工具（issue 316）
 *
 * 防线一：体积上限——流式字节数断言（默认 512MB），恶意/损坏上游推超大
 * 文件时立刻断流，防磁盘耗尽。与插件市场 100MB 截断先例（market.service
 * PassThrough 计数中间层）同一思路，此处由调用方在 httpStream 的
 * downloadProgress 回调逐次传入累计 transferred（客户端已做流式统计，语义等价）。
 *
 * 防线二：落地完整性——下载完成后对落盘文件流式计算摘要，与上游 manifest
 * 提供的期望值比对（vanilla Piston 提供 sha1、Paper v3 提供 sha256、purpur 提供
 * md5）；上游无摘要字段时跳过（fabric 等），有则强制 fail-closed：
 * 不匹配即抛错，由调用方清理已下载残留。
 */
import crypto from 'crypto';
import fs from 'fs';
import { AppError, ErrorCodes } from './response.js';

/**
 * 各服务端类型允许的下载域（API 域与文件域都列，调用方按类型取子集）。
 *
 * 存在的理由：下载 URL **来自上游响应**（vanilla 的 `downloads.server.url`、paper v3 的
 * `downloadInfo.url`、Piston 详情的 `downloads.server.url`），
 * 上游被污染即可让面板去任意主机取一个 jar 并落进实例目录。故实际发起请求前断言域。
 *
 * **按类型取子集而不是共用一个大集合**：升级只支持 vanilla/paper/purpur，若给它并集，
 * 一个被污染的 Piston 响应就能指向 forge 的文件域而被放行——那是白名单被悄悄放宽。
 *
 * 域来源为静态核对（本仓常量 + 各上游的 URL 模板 + 实测响应），
 * 少一个域会让该加载器**部署直接失败**，故每个域都附了来处。
 */
export const DOWNLOAD_HOSTS_BY_TYPE = {
  vanilla: [
    'piston-meta.mojang.com', // 版本清单与详情
    'piston-data.mojang.com', // 服务端 jar 实际文件域（详情响应给出）
  ],
  paper: [
    'fill.papermc.io', // v3 API
    'fill-data.papermc.io', // v3 下载 URL 的实际域（实测响应）
  ],
  purpur: ['api.purpurmc.org'], // API 与文件同一域
  fabric: ['meta.fabricmc.net'], // API 与 server jar 同一域
  forge: [
    'files.minecraftforge.net', // promotions API
    'maven.minecraftforge.net', // 安装器文件域
  ],
};

/**
 * 取若干类型允许的域并集。
 * @param {string[]} types
 * @returns {Set<string>}
 */
export function allowedDownloadHosts(types) {
  const allowed = new Set();
  for (const type of types) {
    for (const host of DOWNLOAD_HOSTS_BY_TYPE[type] || []) allowed.add(host);
  }
  return allowed;
}

/**
 * 断言下载 URL 的 host 在给定白名单内。畸形 URL 与非白名单域一律 VALIDATION_ERROR。
 * @param {string} rawUrl
 * @param {Set<string>} allowedHosts
 */
export function assertAllowedDownloadHost(rawUrl, allowedHosts) {
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid download URL: ${rawUrl}`);
  }
  if (!allowedHosts.has(host)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Download host not allowed: ${host}`);
  }
}

/// JAR 下载体积上限（字节）：主流服务端 jar 均在 50MB 内，放宽至 512MB
/// 兼容大型核心包；超过即视为恶意/损坏上游。
export const JAR_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;

/**
 * 认可的摘要算法白名单（白名单外一律视为「无摘要」跳过：拿未知摘要当 sha256
 * 比对会把正常下载误判成损坏）。md5 在列是因为 purpur 上游只提供 md5，而 md5 档
 * 的威胁模型是传输损坏而非定向伪造——能改上游文件的人同样能改它给的摘要，
 * 故「用 md5 校验」严格强于「不校验」。
 */
export const JAR_HASH_ALGORITHMS = new Set(['sha256', 'sha1', 'md5']);

/**
 * 流式计算文件摘要（大文件不整读内存）。
 * @param {string} filePath
 * @param {'sha256'|'sha1'|'md5'} algorithm
 * @returns {Promise<string>} 十六进制摘要
 */
export function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 落地完整性校验：expectedHash 缺失（上游无 sha 字段）时跳过；
 * 摘要不匹配抛 SERVER_ERROR（消息含期望/实际摘要，fail-closed）。
 * @param {string} filePath
 * @param {{ algorithm: string, digest: string } | null} expectedHash
 */
export async function assertDownloadIntegrity(filePath, expectedHash) {
  if (!expectedHash?.algorithm || !expectedHash?.digest) return;
  const actual = await hashFile(filePath, expectedHash.algorithm);
  if (actual.toLowerCase() !== String(expectedHash.digest).toLowerCase()) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Download integrity check failed: expected ${expectedHash.algorithm}=${expectedHash.digest}, got ${actual} (upstream file corrupted or tampered)`,
    );
  }
}

/**
 * 体积超限断言：超限抛 SERVER_ERROR（消息含实际字节数与上限）。
 * @param {number} transferred - 累计已接收字节数
 * @param {number} [maxBytes]
 */
export function assertSizeWithinLimit(transferred, maxBytes = JAR_DOWNLOAD_MAX_BYTES) {
  if (transferred > maxBytes) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `JAR download aborted: ${transferred} bytes received, exceeds size limit of ${maxBytes} bytes`,
    );
  }
}
