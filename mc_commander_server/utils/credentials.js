/**
 * 机器凭据的生成与 .env 写回（生成/播种/轮换的单一实现；SETUP_TOKEN 的一次性
 * 剥离仍由 utils/setup-token.js 负责，那里的语义是「用后即焚」而非「写回新值」）。
 *
 * 两个调用方：routes/keys.js 的轮换端点（`POST /rotate-key`、`POST /rotate-readonly-key`）
 * 与 index.js 的首次启动播种（`.env` 无 `API_KEY_HASH` 时由服务端签发）。两处各写一份
 * 生成/写盘逻辑必然分叉——本轮之前「部署方自行 `printf … | sha256sum`」正是弱 Key 的
 * 入口：人挑的明文无法约束，而服务端签发一律走 CSPRNG。
 *
 * 熵口径：32 字节（256 位）CSPRNG。这既是文档对「自填 Key」的最低要求，也是服务端自己
 * 签发时采用的强度——两条路径同一把尺子，避免出现「要求你 32 字节、自己发 12 字节」。
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import { atomicWriteFile } from './fs-utils.js';
import { hashToken } from './password.js';

/** 明文前缀用于区分凭据种类（mcck = 管理员，mcro = 只读），仅便于运维辨认，鉴权只看摘要 */
export const ADMIN_KEY_PREFIX = 'mcck-';
export const READONLY_KEY_PREFIX = 'mcro-';

/** 随机字节数：32 字节 = 64 位 hex，按 8 位分组加连字符便于人工核对 */
const KEY_RANDOM_BYTES = 32;

/** 生成新 Key：前缀 + 8 位一组的 hex 随机段（服务端自托管格式，无第三方约定） */
export function generateApiKey(prefix = ADMIN_KEY_PREFIX) {
  const hex = crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');
  return prefix + hex.replace(/(.{8})(?=.)/g, '$1-');
}

/**
 * 写回 .env 一行（保留其余键；dropPatterns 用于顺带清理不应留存的明文行），
 * 原子写防半截文件，权限 0o600。
 * 路径取 config.envFilePath（dotenv 的同一加载源）——测试可指向临时目录，
 * 不必触碰真实 .env。
 * 读取即判定：ENOENT ＝ 尚无 .env（从空串起写），不做 existsSync 预检——预检判定
 * 「不存在」而窗口内 .env 被创建时，会以空串为基线 rename 覆盖掉整份 .env。
 */
export function persistEnvLine(envPath, envKey, value, dropPatterns = []) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const pattern of dropPatterns) content = content.replace(pattern, '');
  const newLine = `${envKey}=${value}`;
  const linePattern = new RegExp(`^${envKey}=.*$`, 'm');
  if (linePattern.test(content)) {
    // 用函数形式替换：字符串形式会把值里的 `$&`/`$1` 当替换模式展开（通用导出，
    // 值不是只可能来自 sha256 hex）
    content = content.replace(linePattern, () => newLine);
  } else {
    content += (content === '' || content.endsWith('\n') ? '' : '\n') + newLine + '\n';
  }
  // 原子写（唯一临时名）：固定 `<env>.tmp` 名字会让并发轮换互相踩踏（一方 rename
  // 走了另一方的临时文件），且直接覆盖写崩溃时会把 .env 截断成半截
  atomicWriteFile(envPath, content, { mode: 0o600 });
}

/** 读回 .env 里某个键的值（不存在返回 null）：播种后的自校验用 */
function readEnvValue(envPath, envKey) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const match = content.match(new RegExp(`^${envKey}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

/**
 * 写回管理员 Key 摘要，并顺带清掉历史遗留的明文 `API_KEY=` 行（明文不落盘；
 * 模式连行尾换行一起删，避免在 .env 里留空行）
 */
export function persistApiKeyHash(envPath, hash) {
  persistEnvLine(envPath, 'API_KEY_HASH', hash, [/^API_KEY=.*\r?\n/m]);
}

/**
 * 首次启动播种：生成一把管理员 Key 并把摘要写回 .env，返回 `{ apiKey, hash }`
 * （明文只回给调用方做一次性展示，本函数不落明文）。
 *
 * 抽成独立函数（而不是留在 index.js 的启动流程里）是为了能被真实文件系统测试覆盖：
 * 这段逻辑的正确性由「写回失败必须抛出」承担——调用方据此拒绝启动，避免降级成
 * 「每次重启换一把」的临时凭据（已接入的脚本会在重启后收到无法解释的 401）。
 */
export function bootstrapApiKey(envPath) {
  const apiKey = generateApiKey();
  const hash = hashToken(apiKey);
  persistApiKeyHash(envPath, hash);
  // 写后回读自校验：两个实例同时对着同一个 .env 首次播种时，后写者的行会盖掉先写者，
  // 先写者的实例就持有「只在内存里、磁盘上没有」的 Key——它照常服务，但重启即失效，
  // 且横幅展示的明文与 .env 摘要不符。判据取「磁盘最终值」而非「调用成功」，不等即抛，
  // 让调用方拒绝启动（显式失败，而不是静默发一把留不住的凭据）
  if (readEnvValue(envPath, 'API_KEY_HASH') !== hash) {
    throw new Error('API_KEY_HASH 写回后被并发覆盖（疑似另一个实例同时在首次播种）');
  }
  return { apiKey, hash };
}

/**
 * 监听地址是否对外可达（非环回）。用于判断「公网部署」语境——首访设密的所有权证明
 * （SETUP_TOKEN）与「面板只应对可信网络开放」的建议都只在这一语境下成立。
 * 判定保守：无法解析时按「对外可达」处理（宁可多提示一次，也不静默漏提示）。
 */
export function isPublicBind(host) {
  const value = String(host ?? '')
    .trim()
    .toLowerCase();
  if (value === '') return false; // 未显式配置：config 默认已落到 127.0.0.1
  // 显式环回：IPv4 127.0.0.0/8、IPv6 ::1、localhost
  if (value === 'localhost' || value === '::1' || value === '[::1]') return false;
  // 只有 IPv4 字面量才按 127.0.0.0/8 判环回：主机名 `127.example.com` 不是环回，
  // 误判成环回会漏掉公网部署告警（漏提示比多提示危险）
  if (net.isIP(value) === 4 && /^127\./.test(value)) return false;
  // 其余（0.0.0.0、::、具体外网/内网 IP、主机名）一律按对外可达
  return true;
}
