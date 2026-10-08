/**
 * 推送通道（MSMP）开关。
 *
 * 面板的「开启推送」只需用户点一下，**不能让他去手改 server.properties**——那正是本功能
 * 存在的理由：`management-server-*` 不在属性表单里（不在 `WRITABLE_PROPERTIES`），
 * 用户按直觉只改 `enabled=true` 会让服务器**再也起不来**。实测（MC 26.3，逐字复现）：
 *
 * | 配置 | 结果 |
 * | --- | --- |
 * | 只写 `enabled=true`（TLS 默认 true、keystore 默认空） | 启动崩：`IllegalStateException: Failed to configure TLS for the server management protocol` / `IllegalArgumentException: TLS is enabled but keystore is not configured` |
 * | secret 非 40 位字母数字 | 启动崩：`IllegalStateException: Invalid management server secret, must be 40 alphanumeric characters` |
 *
 * ⇒ 开启时必须**一次性**把三项写成自洽组合（`saveProperties` 内部是 atomicWriteFile，
 * 故一次调用即原子落盘）。
 *
 * 监听面口径（同样来自实测）：
 * - `host` **不写**：MC 默认 `localhost` ⇒ 仅 loopback 监听（`ss` 实测 `[::ffff:127.0.0.1]:port`）。
 *   这是主要防护面，**绝不能**替用户改成 `0.0.0.0`。
 * - `allowed-origins` **不写**：实测它**不拦截**带任意 `Origin` 的 WS 握手
 *   （设成具体值后，`Origin: http://evil.example` 照常成功）⇒ 写它反而像有防护，属误导。
 *   真实防护＝loopback + 服务端随机端口 + 面板生成的 40 位 secret。
 */
import crypto from 'crypto';
import { reloadProperties } from './instance-properties.service.js';
import { MSMP_MIN_MC_VERSION } from '@mc-commander/schemas';
import { logger } from '../utils/logger.js';

/** MC 对 `management-server-secret` 的硬要求（实测：非此形态直接崩在启动期） */
const SECRET_LENGTH = 40;
const SECRET_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/**
 * 拒绝采样上界：248 = 62 × 4。直接用 `byte % 62` 会让前 8 个字符概率偏高，
 * 而这是一个**凭据**——偏置会实打实降低熵。
 */
const SECRET_REJECT_ABOVE = 248;
/** MC 对 `management-server-host` 的默认值（未写该键时） */
const DEFAULT_MSMP_HOST = 'localhost';

/** 生成 40 位字母数字 secret（拒绝采样，无取模偏置） */
export function generateMsmpSecret(length = SECRET_LENGTH) {
  const out = [];
  while (out.length < length) {
    for (const byte of crypto.randomBytes((length - out.length) * 2)) {
      if (byte >= SECRET_REJECT_ABOVE) continue;
      out.push(SECRET_CHARSET[byte % SECRET_CHARSET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** secret 是否满足 MC 的要求：恰好 40 位、纯字母数字 */
export function isValidMsmpSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{40}$/.test(value);
}

/** 读磁盘真实状态（不读内存缓存：文件可能被游戏内命令或 files 路由改过） */
export function readPushChannelState(instance) {
  reloadProperties(instance);
  const props = instance.properties ?? {};
  return {
    // MC 读布尔走 Boolean.valueOf（大小写不敏感，javap 实证）：写 TRUE/True 时 MC 是开着的，
    // 严格比较会让面板长期报「未开启」这个与事实相反的假状态
    enabled: String(props['management-server-enabled']).toLowerCase() === 'true',
    // MC 的默认是 true，故「键不存在」要按 true 读，否则界面会在键缺失时报「未启用 TLS」
    tlsEnabled: String(props['management-server-tls-enabled']).toLowerCase() !== 'false',
    host: props['management-server-host'] || DEFAULT_MSMP_HOST,
    port: Number.parseInt(props['management-server-port'] ?? '0', 10) || 0,
    secretConfigured: isValidMsmpSecret(props['management-server-secret']),
  };
}

/**
 * 版本是否支持这条通道（MC >= MSMP_MIN_MC_VERSION）。
 *
 * 解析口径与前端 `lib/mc-version.ts` 一致（取第一段连续数字及其后的点分段，缺失段按 0），
 * 但**只用到一处**：面板不替不支持的版本写无用键。解析器本身只该有一份，收进契约包属跨包
 * 重构，已登记待办、未在本轮夹带。
 */
function isMsmpSupportedVersion(version) {
  const parse = (v) => {
    const m = String(v ?? '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
  };
  const a = parse(version);
  const b = parse(MSMP_MIN_MC_VERSION);
  if (!a || !b) return false; // 版本未知或读不懂 ⇒ 不写（宁可不配置，也不往用户文件里塞无用键）
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * 启动前自动补齐推送配置（幂等，返回写入结果或 null）。
 *
 * **为什么默认开启、不给用户选择**：用户要的是「状态变化及时到达」这个结果，MSMP 只是实现，
 * 30 秒轮询是兜底——把实现摊到用户面前（开关 + 监听/凭据字段 + 手改警告）对零代码用户是纯噪音。
 * 配置在**启动前**补齐，服务器本次启动即读到，于是「运行中改动要重启才生效」这条实现细节
 * 根本不必进入界面。
 *
 * 两条边界：
 * - **只在 `management-server-enabled` 键缺失时写**：键存在＝用户或面板已表过态（含显式关闭），
 *   必须尊重——否则用户关了又被自动打开。
 * - **版本不够就不写**：没有这条通道的版本，写进去只是往用户文件里塞无用键。
 *
 * 写入复用 `setPushChannel`：三项必须一次性写成自洽组合（否则会踩「TLS 开 + 证书空」那组必崩组合）。
 */
export function ensureMsmpConfigured(instance) {
  // 先重读磁盘再判「用户是否表过态」：内存缓存是构造时快照，面板运行期间文件可能被
  // 面板之外改过（SSH 手改），用陈旧缓存判会把用户的显式关闭又改回开启
  if (instance) reloadProperties(instance);
  const props = instance?.properties ?? {};
  if (props['management-server-enabled'] !== undefined) return null;
  if (!isMsmpSupportedVersion(instance?.mcVersion)) return null;
  const result = setPushChannel(instance, true);
  logger.info(`[${instance.id}] 已自动开启实时推送（management-server-* 三项），本次启动即生效`);
  return result;
}

/**
 * 开关推送通道。返回 `{ enabled, restartRequired, secretGenerated }`。
 *
 * 关闭时**只写 enabled=false**，保留 tls/secret：它们在不监听时是惰性的，而保留下来
 * 能让用户日后自己手改 `enabled=true` 时**也不会再踩 TLS 那个坑**。
 */
export function setPushChannel(instance, enabled) {
  const state = readPushChannelState(instance);
  const updates = { 'management-server-enabled': enabled ? 'true' : 'false' };
  let secretGenerated = false;

  if (enabled) {
    if (!state.secretConfigured) {
      updates['management-server-secret'] = generateMsmpSecret();
      secretGenerated = true;
    }
    // 已有可用 keystore（且用户显式开了 TLS）时尊重用户的配置；
    // 否则必须关掉 TLS——「TLS 开 + keystore 空」是那组必崩组合
    const keystoreConfigured = Boolean(instance.properties?.['management-server-tls-keystore']);
    if (!(state.tlsEnabled && keystoreConfigured)) {
      updates['management-server-tls-enabled'] = 'false';
    }
    // host / allowed-origins 一律不动，理由见文件头
  }

  instance.saveProperties(updates);

  return {
    enabled,
    // MSMP 只在服务端启动时读取 ⇒ 运行中改动需重启才生效
    restartRequired: Boolean(instance.isRunning),
    secretGenerated,
  };
}
