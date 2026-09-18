/**
 * 实例 server.properties 域 service（issue 514 分层治理）
 *
 * 自 routes/status.js 原位搬移：域校验常量（运行期命令映射/可写白名单/布尔/
 * 数值/敏感键）、单键值校验、GET 展示视图（重读文件 + 运行状态覆盖 + 敏感键
 * 掩码）与 PUT 写盘及重启联动编排。路由层降为薄编排（参数解析 → service
 * 调用 → 响应包装），对齐 routes/players.js 薄路由分层惯例。
 * 端点行为零变化：校验顺序、拒绝理由、日志文本、diff 与运行中命令下发语义逐项保持。
 */
import { logger } from '../utils/logger.js';

// 支持运行中通过斜杠命令修改的 server.properties 属性 → 命令构造。
// MC 服务器运行时不重新加载 server.properties 文件（启动时读取），
// 仅以下属性可通过命令运行中生效；其余属性（pvp、max-players、online-mode 等）
// 修改后需重启服务器。
export const RUNTIME_COMMAND_MAP = {
  'white-list': (v) =>
    String(v).toLowerCase() === 'true' ? 'whitelist on' : 'whitelist off',
  'enforce-whitelist': (v) =>
    String(v).toLowerCase() === 'true'
      ? 'whitelist enforce on'
      : 'whitelist enforce off',
  'difficulty': (v) => `difficulty ${v}`,
  'gamemode': (v) => `defaultgamemode ${v}`,
};

// ── PUT /properties 键白名单与值校验 ──
// 普通可写属性键白名单（前端世界属性页暴露 + MC 26.x 常用键，保持新旧版本
// 兼容的宽松策略：对已知属性尽量放行，未知键才拒绝）。
export const WRITABLE_PROPERTIES = new Set([
  // 世界
  'level-name', 'level-type', 'level-seed', 'generator-settings',
  'difficulty', 'gamemode', 'force-gamemode', 'hardcore', 'pvp',
  'allow-flight', 'allow-nether', 'spawn-monsters', 'spawn-npcs',
  'spawn-animals', 'spawn-protection', 'max-world-size', 'generate-structures',
  // 玩家/性能
  'max-players', 'view-distance', 'simulation-distance',
  'player-idle-timeout', 'max-tick-time', 'network-compression-threshold',
  'rate-limit', 'entity-broadcast-range-percentage', 'function-permission-level',
  'op-permission-level', 'sync-chunk-writes', 'use-native-transport',
  'enable-jmx-monitoring',
  // 展示/交互
  'motd', 'hide-online-players', 'enforce-secure-profile',
  'prevent-proxy-connections', 'log-ips', 'broadcast-console-to-ops',
  'broadcast-rcon-to-ops', 'snooper-enabled',
  // 资源包/内容过滤
  'require-resource-pack', 'resource-pack', 'resource-pack-sha1',
  'resource-pack-prompt', 'initial-enabled-packs', 'initial-disabled-packs',
  'text-filtering-config',
]);

// 布尔型属性：仅接受 true/false
export const BOOLEAN_PROPERTIES = new Set([
  'white-list', 'enforce-whitelist', 'force-gamemode', 'hardcore', 'pvp',
  'allow-flight', 'allow-nether', 'spawn-monsters', 'spawn-npcs',
  'spawn-animals', 'generate-structures', 'hide-online-players',
  'enforce-secure-profile', 'prevent-proxy-connections', 'log-ips',
  'sync-chunk-writes', 'use-native-transport', 'broadcast-console-to-ops',
  'broadcast-rcon-to-ops', 'snooper-enabled', 'enable-jmx-monitoring',
  'require-resource-pack',
]);

// 数值型属性：仅接受整数（max-tick-time / network-compression-threshold
// 允许 -1 表示禁用/不限制）
export const NUMERIC_PROPERTIES = new Set([
  'max-players', 'view-distance', 'simulation-distance',
  'player-idle-timeout', 'max-tick-time', 'network-compression-threshold',
  'rate-limit', 'entity-broadcast-range-percentage', 'function-permission-level',
  'op-permission-level', 'spawn-protection', 'max-world-size',
]);

// 敏感属性禁止 API 写入：enable-rcon/rcon.password/rcon.port 为 RCON
// 远程控制通道，enable-query/enable-status 暴露服务器信息，enable-command-block
// 绕过命令权限分级，online-mode 为正版验证，server-port/server-ip 控制
// 网络暴露面。GET 时以占位符掩码返回，PUT 提交占位符视为未修改
// （沿用磁盘现值），提交其余值一律 400 拒绝。
export const SENSITIVE_PROPERTIES = new Set([
  'enable-rcon', 'rcon.password', 'rcon.port',
  'enable-query', 'enable-status', 'enable-command-block',
  'online-mode', 'server-port', 'server-ip',
]);
export const SENSITIVE_PLACEHOLDER = '********';

// 可写键 = 普通可写键 + 运行期命令键（并集，保证 RUNTIME_COMMAND_MAP
// 四键即使未出现在普通键集中也允许写入）
export const ALLOWED_PROPERTY_KEYS = new Set([
  ...WRITABLE_PROPERTIES,
  ...Object.keys(RUNTIME_COMMAND_MAP),
]);

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
  // 运行期命令键的值会拼入下发给 MC 控制台的命令，限制字符集防命令注入
  // （white-list/enforce-whitelist 已在布尔分支处理；difficulty/gamemode 走这里）
  if (RUNTIME_COMMAND_MAP[key] && !/^[a-zA-Z0-9_:-]+$/.test(value)) {
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

  // 对比新旧属性，区分「可运行中生效（下发命令）」与「需重启服务器」
  const changedKeys = Object.keys(validated).filter(
    (k) => oldProps[k] !== validated[k],
  );
  const runtimeChanged = changedKeys.filter((k) => RUNTIME_COMMAND_MAP[k]);
  // 仅在服务器运行时才提示需重启（未运行时下次启动自然生效）
  const restartRequired = instance.isRunning
    ? changedKeys.filter((k) => !RUNTIME_COMMAND_MAP[k])
    : [];

  // 服务器运行时，对支持运行中修改的属性下发斜杠命令，保证客户端修改立即生效
  if (instance.isRunning && runtimeChanged.length > 0) {
    for (const key of runtimeChanged) {
      const cmd = RUNTIME_COMMAND_MAP[key](validated[key]);
      try {
        await instance.sendCommand(cmd);
        logger.info(`[PUT properties] 下发运行中命令: ${cmd}`);
      } catch (e) {
        logger.warn(`[PUT properties] 命令 ${cmd} 下发失败: ${e.message}`);
      }
    }
  }

  return { ok: true, restartRequired, applied: true };
}
