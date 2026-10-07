/**
 * 结构化日志通道：面板自带一份 log4j2 配置，让实例同时吐出「人类可读纯文本」与「逐行 JSON」。
 *
 * 为什么要有它：MC 用 log4j2 输出，而 Mojang 随包的配置只有纯文本 ⇒ 面板只能靠正则从文本里
 * **剥**出线程名/级别/前缀（解析出来的，不是读到的），前缀形态一变就静默失效。本模块在实例目录
 * 写一份自己的配置、并让服务端从它启动（`-Dlog4j.configurationFile`），于是同一批日志多出一份
 * 字段是**读到**的 JSON 行；纯文本通道逐字节保持不变。
 *
 * 三条选型依据（均为实测，不是推断）：
 * - **不引新依赖**：26.3 的 `libraries/` 里没有 Jackson、也没有 `log4j-layout-template-json`，但
 *   `log4j-core` 的 `PatternLayout` 支持 `%encode{...}{json}`（**只转义、不加引号、不产生结构**）
 *   ⇒ 手写 JSON 骨架 + 该转义即可产出合法 JSON 行。实测 log4j 2.24.1（1.21.6）与 2.26.0（26.3）
 *   两档都通过，且 `%n` 必须放在 encode **之外**，否则换行被转义成字面 `\n`、不再分行。
 * - **不复用 Mojang 配置里的 `Queue`/`Listener` appender**：它们是 `com.mojang:logging` 的自有插件类，
 *   版本间可能增删，而**配置初始化失败会让 log4j 退回默认配置**（只剩 ERROR 级）⇒ 面板连带丢掉
 *   全部 INFO。故本配置只用 `log4j-core` 自带的 appender/filter，跨版本自洽。
 * - **纯文本格式原样照抄 Mojang**（`[%d{HH:mm:ss}] [%t/%level]: %msg{nolookups}`）：它是面板既有
 *   正则、以及 `logs/latest.log` 全部消费方（接管续读、面板重启回填）的既有契约，改它等于同时改
 *   三处消费侧；日志**展示**要继续给人看，所以 JSON 走**另一个文件**而不是替换 latest.log。
 *
 * 版本门槛：`%encode` 在更老的 log4j 上未经验证，而配置初始化失败会连带丢掉日志 ⇒ 只在实例自带的
 * log4j-core 版本 ≥ 已验证下限时启用；取不到版本（Paper/Forge 等非标准 libraries 布局）同样不启用。
 * **不启用即今天的行为**，实例可用性不受影响。
 */
import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from '../../utils/fs-utils.js';
import { logger } from '../../utils/logger.js';

/** 配置文件名：带面板标识，避免与用户自备的 log4j2.xml 混淆 */
export const STRUCTURED_LOG_CONFIG_FILE = 'log4j2-mc-commander.xml';

/** JSONL 通道（相对实例目录；log4j 的 file appender 按 cwd 解析，而 cwd 就是实例目录） */
export const STRUCTURED_LOG_JSONL = 'logs/mc-commander.jsonl';

/**
 * 覆盖配置用的系统属性名：取 Mojang 官方 per-version JSON 里 `logging.client.argument` 用的
 * `log4j.configurationFile`（2.0 起就支持），而不是 2.10 才有的 `log4j2.configurationFile`
 * ——兼容面更宽。实测 2.24.1 / 2.26.0 上两者都生效。
 */
export const STRUCTURED_LOG_PROPERTY = 'log4j.configurationFile';

/** 已验证下限（1.21.6 的 log4j 版本）；低于它不启用，见文件头的版本门槛 */
const MIN_VERIFIED_LOG4J = [2, 24, 1];

/** 面板要读的字段；`msg` 仍是自由文本，但不再需要从行首形态里剥 */
const JSONL_PATTERN =
  '{"ts":"%d{yyyy-MM-dd HH:mm:ss}","lvl":"%level","thr":"%t","logger":"%logger","msg":"%encode{%msg}{json}"}%n';

/** 纯文本 pattern：与 Mojang 随包配置逐字符一致，是面板既有解析的契约 */
const PLAIN_PATTERN = '[%d{HH:mm:ss}] [%t/%level]: %msg{nolookups}%n';

/** 渲染覆盖配置。无用户输入参与拼接，故无需转义。 */
export function renderStructuredLogConfig() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Configuration status="WARN">
  <Appenders>
    <Console name="SysOut" target="SYSTEM_OUT">
      <PatternLayout pattern="${PLAIN_PATTERN}"/>
    </Console>
    <RollingRandomAccessFile name="File" fileName="logs/latest.log" filePattern="logs/%d{yyyy-MM-dd}-%i.log.gz">
      <PatternLayout pattern="${PLAIN_PATTERN}"/>
      <Policies>
        <TimeBasedTriggeringPolicy/>
        <OnStartupTriggeringPolicy/>
      </Policies>
    </RollingRandomAccessFile>
    <RollingRandomAccessFile name="Jsonl" fileName="${STRUCTURED_LOG_JSONL}" filePattern="logs/mc-commander-%d{yyyy-MM-dd}-%i.jsonl.gz">
      <PatternLayout pattern='${JSONL_PATTERN}'/>
      <Policies>
        <TimeBasedTriggeringPolicy/>
        <OnStartupTriggeringPolicy/>
      </Policies>
    </RollingRandomAccessFile>
  </Appenders>
  <Loggers>
    <Root level="info">
      <filters>
        <MarkerFilter marker="NETWORK_PACKETS" onMatch="DENY" onMismatch="NEUTRAL"/>
      </filters>
      <AppenderRef ref="SysOut"/>
      <AppenderRef ref="File"/>
      <AppenderRef ref="Jsonl"/>
    </Root>
  </Loggers>
</Configuration>
`;
}

/** 比较形如 `2.24.1` 的版本号；无法解析的片段按 0 处理 */
function compareVersion(version, minVersion) {
  const parse = (v) =>
    String(v)
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = minVersion;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * 读实例自带的 log4j-core 版本。
 * 布局为 `libraries/org/apache/logging/log4j/log4j-core/<版本>/log4j-core-<版本>.jar`；
 * 取不到（非标准布局、未解包、无 libraries 目录）返回 null ⇒ 调用方按「不启用」处理。
 */
export function readLog4jCoreVersion(serverPath) {
  const coreDir = path.join(
    serverPath,
    'libraries',
    'org',
    'apache',
    'logging',
    'log4j',
    'log4j-core',
  );
  if (!fs.existsSync(coreDir)) return null;
  for (const name of fs.readdirSync(coreDir)) {
    if (/^\d+(\.\d+)*$/.test(name)) return name;
  }
  return null;
}

/** 版本是否落在已验证区间内 */
export function isLog4jVersionSupported(version) {
  if (!version) return false;
  return compareVersion(version, MIN_VERIFIED_LOG4J) >= 0;
}

/**
 * 把覆盖配置的 `-D` 参数并进启动参数。
 *
 * 插在**最前**而不是附在末尾：JVM 选项必须在主类之前，而 Forge/Fabric 这类启动方式把主类藏在
 * `@argfile` 里，附在末尾会被当成应用程序参数传给 MC（实测无 `-jar` 的形态确实存在）。
 * 用户自己已指定过该属性（两种属性名都认）时不覆盖——面板不跟用户的显式配置抢。
 */
export function _withStructuredLogArg(args) {
  const configPath = this._structuredLogConfigPath;
  if (!configPath) return args;
  const specified = args.some((a) => {
    const arg = String(a);
    return (
      arg.startsWith(`-D${STRUCTURED_LOG_PROPERTY}=`) ||
      arg.startsWith('-Dlog4j2.configurationFile=')
    );
  });
  if (specified) return args;
  return [`-D${STRUCTURED_LOG_PROPERTY}=${configPath}`, ...args];
}

/**
 * 启动前置阶段：确保实例内有可用的覆盖配置，并把绝对路径记到实例上（`_structuredLogConfigPath`）。
 * 任何异常都当成「不启用」——写不了文件、布局不认识都绝不能挡住实例启动。
 */
export function _ensureStructuredLogConfig() {
  this._structuredLogConfigPath = null;
  try {
    const version = readLog4jCoreVersion(this.serverPath);
    if (!isLog4jVersionSupported(version)) {
      // 静默回落：老版本/非标准布局继续走纯文本解析，能力不降级也不报错刷屏
      logger.debug(
        `[${this.id}] structured log channel disabled (log4j-core: ${version ?? 'unknown'})`,
      );
      return null;
    }
    const configPath = path.join(this.serverPath, STRUCTURED_LOG_CONFIG_FILE);
    const content = renderStructuredLogConfig();
    let existing = null;
    try {
      existing = fs.readFileSync(configPath, 'utf-8');
    } catch {
      // 不存在即需写入
    }
    if (existing !== content) atomicWriteFile(configPath, content);
    this._structuredLogConfigPath = configPath;
    return configPath;
  } catch (e) {
    logger.warn(`[${this.id}] structured log channel unavailable: ${e.message}`);
    return null;
  }
}
