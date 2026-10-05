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
 * 监听面口径（同样来自实测，见清单任务 3）：
 * - `host` **不写**：MC 默认 `localhost` ⇒ 仅 loopback 监听（`ss` 实测 `[::ffff:127.0.0.1]:port`）。
 *   这是主要防护面，**绝不能**替用户改成 `0.0.0.0`。
 * - `allowed-origins` **不写**：实测它**不拦截**带任意 `Origin` 的 WS 握手
 *   （设成具体值后，`Origin: http://evil.example` 照常成功）⇒ 写它反而像有防护，属误导。
 *   真实防护＝loopback + 服务端随机端口 + 面板生成的 40 位 secret。
 */
import crypto from 'crypto';
import { reloadProperties } from './instance-properties.service.js';

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
    enabled: props['management-server-enabled'] === 'true',
    // MC 的默认是 true，故「键不存在」要按 true 读，否则界面会在键缺失时报「未启用 TLS」
    tlsEnabled: props['management-server-tls-enabled'] !== 'false',
    host: props['management-server-host'] || DEFAULT_MSMP_HOST,
    port: Number.parseInt(props['management-server-port'] ?? '0', 10) || 0,
    secretConfigured: isValidMsmpSecret(props['management-server-secret']),
  };
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
