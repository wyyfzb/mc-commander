/**
 * 实例 server.properties 域 service（分层治理）
 *
 * 域校验常量（运行期命令映射/可写白名单/布尔/
 * 数值/敏感键）、单键值校验、GET 展示视图（重读文件 + 运行状态覆盖 + 敏感键
 * 掩码）与 PUT 写盘及重启联动编排。路由层降为薄编排（参数解析 → service
 * 调用 → 响应包装），对齐 routes/players.js 薄路由分层惯例。
 */
import { logger } from '../utils/logger.js';

// 运行期可热改的属性键与它们背后的结构化方法，都在方法面模块里（`SERVER_SETTING_METHODS`）：
// 那张表逐条实测过「setter 回读＝落盘值」，命令只作为 MSMP 不可用时的等价回退。
// MC 服务器运行时不重新加载 server.properties 文件（启动时读取），故未被热改的键
// （pvp、online-mode 等）仍需重启。
import { SERVER_SETTING_KEYS, SERVER_SETTING_METHODS } from './mc-server/msmp-methods.js';

/** 带命令回退的键：只有这些键的值会被拼进控制台命令，需要字符集守卫 */
const RUNTIME_COMMAND_FALLBACK_KEYS = new Set(
  Object.entries(SERVER_SETTING_METHODS)
    .filter(([, spec]) => spec.fallbackCommand)
    .map(([key]) => key),
);

// ── PUT /properties 键白名单与值校验 ──
// 普通可写属性键白名单（前端世界属性页暴露 + MC 26.x 常用键，保持新旧版本
// 兼容的宽松策略：对已知属性尽量放行，未知键才拒绝）。
export const WRITABLE_PROPERTIES = new Set([
  // 世界
  'level-name',
  'level-type',
  'level-seed',
  'generator-settings',
  'difficulty',
  'gamemode',
  'force-gamemode',
  'hardcore',
  'pvp',
  'allow-flight',
  'allow-nether',
  'spawn-monsters',
  'spawn-npcs',
  'spawn-animals',
  'spawn-protection',
  'max-world-size',
  'generate-structures',
  // 玩家/性能
  'max-players',
  'view-distance',
  'simulation-distance',
  'player-idle-timeout',
  'max-tick-time',
  'network-compression-threshold',
  'rate-limit',
  'entity-broadcast-range-percentage',
  'function-permission-level',
  'op-permission-level',
  'sync-chunk-writes',
  'use-native-transport',
  'enable-jmx-monitoring',
  // 展示/交互
  'motd',
  'hide-online-players',
  'enforce-secure-profile',
  'prevent-proxy-connections',
  'log-ips',
  'broadcast-console-to-ops',
  'broadcast-rcon-to-ops',
  'snooper-enabled',
  // 资源包/内容过滤
  'require-resource-pack',
  'resource-pack',
  'resource-pack-sha1',
  'resource-pack-prompt',
  'initial-enabled-packs',
  'initial-disabled-packs',
  'text-filtering-config',
  // 白名单/状态展示与模板键：white-list/enforce-whitelist 亦在热改键表里，并轨到普通白名单后
  // 「并集」只兜底其余热改键；query.port 与 texture-pack 由本仓实例模板（server-jar.js）写入，
  // 不纳入则任何按整份文件回传的调用方都会被它们整批 400
  'white-list',
  'enforce-whitelist',
  'query.port',
  'texture-pack',
  // 26.3 官方默认清单键（属性页会渲染成一行，引擎首启也会把缺的键补齐进文件）：
  // 同样遵循「对已知属性尽量放行、未知键才拒绝」的宽松策略
  'pause-when-empty-seconds',
  'max-chained-neighbor-updates',
  'resource-pack-id',
  'text-filtering-version',
  'chat-spam-threshold-seconds',
  'command-spam-threshold-seconds',
  'status-heartbeat-interval',
]);

// 布尔型属性：仅接受 true/false
export const BOOLEAN_PROPERTIES = new Set([
  'white-list',
  'enforce-whitelist',
  'force-gamemode',
  'hardcore',
  'pvp',
  'allow-flight',
  'allow-nether',
  'spawn-monsters',
  'spawn-npcs',
  'spawn-animals',
  'generate-structures',
  'hide-online-players',
  'enforce-secure-profile',
  'prevent-proxy-connections',
  'log-ips',
  'sync-chunk-writes',
  'use-native-transport',
  'broadcast-console-to-ops',
  'broadcast-rcon-to-ops',
  'snooper-enabled',
  'enable-jmx-monitoring',
  'require-resource-pack',
]);

// 数值型属性：接受整数，区间见 NUMERIC_PROPERTY_RANGES（max-tick-time /
// network-compression-threshold 允许 -1 表示禁用/不限制）
export const NUMERIC_PROPERTIES = new Set([
  'max-players',
  'view-distance',
  'simulation-distance',
  'player-idle-timeout',
  'max-tick-time',
  'network-compression-threshold',
  'rate-limit',
  'entity-broadcast-range-percentage',
  'function-permission-level',
  'op-permission-level',
  'spawn-protection',
  'max-world-size',
  // 26.3 键与模板键里的整数项。负整数默认放行：各键含义不统一，
  // max-chained-neighbor-updates / pause-when-empty-seconds 的负数本身就是「不限制/不暂停」
  'query.port',
  'pause-when-empty-seconds',
  'max-chained-neighbor-updates',
  'text-filtering-version',
  'chat-spam-threshold-seconds',
  'command-spam-threshold-seconds',
  'status-heartbeat-interval',
]);

// 数值属性的生效区间；不在表内的数值键一律放行。
//
// 判据是「服务端会不会按写入值生效」，不是「文档写了多少」：26.3 对这些越界值既不报错也不
// 拒绝启动，而是**静默钳制**或**整段失效**——用户看到「已保存」，实际生效的是另一个数，
// 或这项能力直接被关掉。故每项都取服务端真正接受的那一段：
// - query.port 0~65535：查询线程只拒 <0 与 >65535，越界即 queries disabled
//   （实测 65536 命中该警告，1 与 65535 正常起 GS4 监听）。
// - view-distance 2~32：ChunkMap 里对写入值做 Mth.clamp(2,32)，写 100 会原样留在
//   server.properties 而内存里是 32（实测重启后磁盘仍是 100）。
// - max-players 0~2147483647：PlayerList 以「已在线 >= max-players」判满，负数即永远
//   满员——没人能进服，原版对此零提示。超过 int 上界的值会在解析期静默退回默认值。
// - max-world-size 1~29999984、entity-broadcast-range-percentage 10~1000：
//   属性构造期的 lambda 就是 Mth.clamp，实测越界值被读入后写回钳制结果
//   （-5→1、999999999→29999984、5→10）。
// - op-permission-level / function-permission-level 0~4：权限等级走 ByIdMap 的 CLAMP，
//   越界被改写成 0 或 4（实测 MSMP setter 与磁盘写回同）。
// - text-filtering-version 0~1：文本过滤只认 0（legacy）与 1（player-safety），其余值打
//   unsupported text filtering version 警告且过滤整体不启用（实测 7 命中该警告）。
//
// 刻意不收录：max-tick-time / network-compression-threshold / rate-limit /
// pause-when-empty-seconds / chat-spam-threshold-seconds / command-spam-threshold-seconds /
// status-heartbeat-interval 的非正值都是有意的关闭语义，不存在「被静默改写」；
// simulation-distance 与 spawn-protection 在 26.3 上未找到任何钳制（写 100 原样保留），
// 没有证据就不猜边界。
export const NUMERIC_PROPERTY_RANGES = Object.freeze({
  'query.port': { min: 0, max: 65535 },
  'view-distance': { min: 2, max: 32 },
  'max-players': { min: 0, max: 2147483647 },
  'max-world-size': { min: 1, max: 29999984 },
  'entity-broadcast-range-percentage': { min: 10, max: 1000 },
  'op-permission-level': { min: 0, max: 4 },
  'function-permission-level': { min: 0, max: 4 },
  'text-filtering-version': { min: 0, max: 1 },
});

// 敏感属性禁止 API 写入：enable-rcon/rcon.password/rcon.port 为 RCON
// 远程控制通道，enable-query/enable-status 暴露服务器信息，enable-command-block
// 绕过命令权限分级，online-mode 为正版验证，server-port/server-ip 控制
// 网络暴露面。GET 时以占位符掩码返回，PUT 提交占位符视为未修改
// （沿用磁盘现值），提交其余值一律 400 拒绝。
//
// management-server-secret 与 management-server-tls-keystore-password 是凭据：
// MC 服务端开启 MSMP 且该键留空时会**自动生成** secret 并写回 server.properties，
// 面板属性页即可读到密钥明文（与 rcon.password 的保护口径不一致）。
// 前端 mc-properties.ts 的 SENSITIVE_PROPERTY_KEYS 必须同步增补——只改一侧会让
// 前端把占位符当真实值参与重算/回写。
export const SENSITIVE_PROPERTIES = new Set([
  'enable-rcon',
  'rcon.password',
  'rcon.port',
  'enable-query',
  'enable-status',
  'enable-command-block',
  'online-mode',
  'server-port',
  'server-ip',
  'management-server-secret',
  'management-server-tls-keystore-password',
]);
export const SENSITIVE_PLACEHOLDER = '********';

// 可写键 = 普通可写键 + 热改键并集（热改键表在 mc-server/msmp-methods.js，单一来源，本文件不复制）。
// 当前 15 个热改键已全部落在普通白名单内，并集留作漂移兜底——那边将来新增热改键时
// 不必同步改这里也不会被拒。
export const ALLOWED_PROPERTY_KEYS = new Set([...WRITABLE_PROPERTIES, ...SERVER_SETTING_KEYS]);

// 单键值校验。返回 { ok: true, value } 或 { ok: false, reason }
export function validatePropertyValue(key, rawValue) {
  if (rawValue === null || rawValue === undefined || typeof rawValue === 'object') {
    return { ok: false, reason: '值必须是标量' };
  }
  const value = String(rawValue);
  if (BOOLEAN_PROPERTIES.has(key)) {
    const lowered = value.toLowerCase();
    if (lowered !== 'true' && lowered !== 'false') {
      return { ok: false, reason: '布尔属性仅接受 true/false' };
    }
    return { ok: true, value };
  }
  if (NUMERIC_PROPERTIES.has(key)) {
    if (!/^-?\d+$/.test(value)) {
      return { ok: false, reason: '数值属性仅接受整数' };
    }
    // 越界值在服务端不会报错，只会被钳制或让整项能力失效 ⇒ 保存前就拦下来，
    // 否则界面报「已保存」而实际生效的是另一个数
    const range = NUMERIC_PROPERTY_RANGES[key];
    if (range) {
      const numeric = Number(value);
      if (numeric < range.min || numeric > range.max) {
        return {
          ok: false,
          reason: `${key} 仅接受 ${range.min}~${range.max} 之间的整数`,
        };
      }
    }
    // 通用数值分支允许负整数，但挂机超时以分钟计、0 即禁用，负数无意义：
    // 放行会拼出 `setidletimeout -5`，服务端拒绝后只留一条警告，用户以为已生效。
    if (key === 'player-idle-timeout' && !/^\d+$/.test(value)) {
      return { ok: false, reason: '挂机超时仅接受非负整数（分钟，0=禁用）' };
    }
    return { ok: true, value };
  }
  if (key === 'level-name') {
    // 根治路径穿越入口：level-name 会拼入世界目录路径
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      return { ok: false, reason: 'level-name 仅接受字母数字、下划线与连字符' };
    }
    return { ok: true, value };
  }
  // 字符串属性拒绝真实换行（防 server.properties 行注入；
  // motd 的字面 \n 转义序列不包含真实换行，不受影响）
  if (/[\n\r]/.test(value)) {
    return { ok: false, reason: '字符串属性不允许包含换行符' };
  }
  // 带命令回退的键，其值在回退分支会拼入下发给 MC 控制台的命令，限制字符集防命令注入
  // （white-list/enforce-whitelist 已在布尔分支处理；difficulty/gamemode 走这里）
  if (RUNTIME_COMMAND_FALLBACK_KEYS.has(key) && !/^[a-zA-Z0-9_:-]+$/.test(value)) {
    return { ok: false, reason: '值包含非法字符' };
  }
  return { ok: true, value };
}

// 敏感属性（rcon.password 等）以占位符掩码返回，防止密码与
// 网络配置泄露给 API 调用方；客户端原样回传占位符时 PUT 视为未修改。
export function maskSensitiveProperties(props) {
  const masked = { ...props };
  for (const key of Object.keys(masked)) {
    if (SENSITIVE_PROPERTIES.has(key)) {
      masked[key] = SENSITIVE_PLACEHOLDER;
    }
  }
  return masked;
}

// 重读磁盘并刷新内存缓存：游戏内命令（如 /whitelist on）或 files 路由编辑
// 会写回 server.properties，内存缓存不会自动更新。每次读写都重读文件而非
// 直接返回内存缓存，才能同步磁盘真实状态。
export function reloadProperties(instance) {
  try {
    const fresh = instance._loadProperties();
    if (fresh && Object.keys(fresh).length > 0) {
      instance.properties = fresh;
    }
  } catch {}
}

// GET /instances/:id/properties 展示视图：重读文件 → 运行状态型属性覆盖
// → 敏感键掩码。
//
// 运行状态型属性：游戏内 /difficulty、/defaultgamemode 只改 level.dat，
// 不写回 server.properties，读取运行中真实值覆盖，否则客户端读到旧值（多端同步）。
// difficulty 优先 RCON 实时查询、level.dat 兜底；gamemode 读 level.dat。
// readDifficulty 服务层已捕获 RCON/level.dat 预期失败并回退文件值，此处再兜底
// 意外异常：难度缺失不影响 properties 主体响应（Express 4 下未捕获 rejection
// 会挂起请求并可能终止进程，见路由层 asyncHandler 注释）。
export async function getPropertiesView(instance) {
  reloadProperties(instance);
  const props = { ...instance.properties };
  try {
    const difficulty = await instance.readDifficulty();
    if (difficulty) props['difficulty'] = difficulty;
  } catch {}
  const gameMode = instance._readGameTypeFromLevelDat();
  if (gameMode) props['gamemode'] = gameMode;
  return maskSensitiveProperties(props);
}

// PUT 校验阶段：逐键执行敏感键占位符短路 → 键白名单 → 值校验。
// 返回 { validated, rejectedKeys }；rejectedKeys 非空时路由层整体 400
// 拒绝（原子性，不落盘部分修改）。
export function validatePropertySubmission(newProps) {
  const validated = {};
  const rejectedKeys = [];
  for (const [key, rawValue] of Object.entries(newProps)) {
    // 敏感键：提交占位符视为未修改（沿用磁盘现值），其余值一律拒绝写入
    if (SENSITIVE_PROPERTIES.has(key)) {
      if (rawValue === SENSITIVE_PLACEHOLDER) continue;
      rejectedKeys.push(key);
      logger.warn(`[PUT properties] 拒绝写入敏感属性: ${key}`);
      continue;
    }
    // 键白名单：仅允许世界属性页暴露的键 + 运行期命令键
    if (!ALLOWED_PROPERTY_KEYS.has(key)) {
      rejectedKeys.push(key);
      logger.warn(`[PUT properties] 拒绝未知属性键: ${key}`);
      continue;
    }
    const result = validatePropertyValue(key, rawValue);
    if (!result.ok) {
      rejectedKeys.push(key);
      logger.warn(`[PUT properties] 属性值校验失败 ${key}: ${result.reason}`);
      continue;
    }
    validated[key] = result.value;
  }
  return { validated, rejectedKeys };
}

// PUT 写盘与重启联动编排。调用前提：请求体形状与 saveProperties 可用性
// 已由路由层校验。内部以重读后的磁盘快照为 diff 基线，保存后区分
// 「可运行中生效（下发命令）」与「需重启服务器」，并保证运行中命令逐条
// 下发（单条失败仅警告，不影响保存与响应）。
// 返回 { ok: false, rejectedKeys }（存在非法键/值，整体拒绝）
//    | { ok: true, restartRequired, applied }（applied=false 表示无实际变更）
export async function applyPropertyUpdates(instance, newProps) {
  reloadProperties(instance);
  const oldProps = { ...instance.properties };

  const { validated, rejectedKeys } = validatePropertySubmission(newProps);
  if (rejectedKeys.length > 0) {
    return { ok: false, rejectedKeys };
  }
  // 全部为占位符/空提交：无实际变更，不触发写入
  if (Object.keys(validated).length === 0) {
    return { ok: true, restartRequired: [], applied: false };
  }

  instance.saveProperties(validated);

  // 对比新旧属性，区分「可运行中生效」与「需重启服务器」
  const changedKeys = Object.keys(validated).filter((k) => oldProps[k] !== validated[k]);
  const runtimeChanged = changedKeys.filter((k) => SERVER_SETTING_KEYS.has(k));

  // 运行中逐键应用：成功与否由**实际生效**决定，不看「这张表里有没有它」——
  // 表里有、但这条实例的 MSMP 不可用又无命令回退时，该键仍要重启才生效
  const appliedKeys = new Set();
  if (instance.isRunning) {
    for (const key of runtimeChanged) {
      try {
        const via = await instance.applyServerSetting(key, validated[key]);
        if (via === 'skipped') {
          logger.warn(`[PUT properties] ${key} 本次未在运行中生效（无可用通道），需重启`);
          continue;
        }
        appliedKeys.add(key);
        logger.info(`[PUT properties] ${key} 运行中生效 via ${via}`);
      } catch (e) {
        logger.warn(`[PUT properties] ${key} 运行中应用失败: ${e.message}`);
      }
    }
  }
  // 仅在服务器运行时才提示需重启（未运行时下次启动自然生效）
  const restartRequired = instance.isRunning
    ? changedKeys.filter((k) => !SERVER_SETTING_KEYS.has(k) || !appliedKeys.has(k))
    : [];

  return { ok: true, restartRequired, applied: true };
}
