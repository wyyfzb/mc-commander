// 轻量结构化日志系统（issue #325，audit D-P0-2 / A2-1）：
// console 包装器四级日志（debug/info/warn/error）+ error 分流独立文件 + 简单轮转
//
// 设计约束（C 甄别方案，不引 pino）：
// - 零依赖：纯 Node 内置模块，延续项目极简依赖哲学（utils/password.js 注释自证）
// - 级别过滤：消费 config.logLevel（LOG_LEVEL 环境变量，config.js 唯一来源），
//   低于设定级别的日志不输出（debug < info < warn < error）
// - 流选择与 console 原生习惯一致：debug/info → stdout，warn/error → stderr
// - error 分流：独立 error.log 文件；单文件 20MB × 5 份简单轮转（上限 ~100MB）
// - stderr 白名单：启动横幅等安全/引导输出走 banner()（stderr 直写，不受级别
//   过滤、不落盘）——部署排障时启动信息必须始终可见（journalctl 场景同理）
// - 故障降级：日志目录不可写等文件系统故障静默降级为仅 stderr 输出一次告警，
//   自托管场景日志故障不允许拖垮主服务
import fs from 'fs';
import path from 'path';
import { format as formatUtil } from 'util';
import config from '../config.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const LEVEL_TAGS = Object.freeze({ debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' });
const ERROR_FILE_NAME = 'error.log';

// dataDir 容错：测试 vi.mock(config) 可能缺 dataDir 字段，模块加载期不得抛错。
// 缺省时先跟随 DATA_DIR 环境变量（测试注入临时目录），最后才落仓库相对路径；
// 真实运行 config.dataDir 恒有值（config.js 默认 './data'），此分支不可达
function defaultLogDir() {
  if (config.dataDir) return path.join(config.dataDir, 'logs');
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'logs');
  return path.resolve('./data/logs');
}

const DEFAULTS = Object.freeze({
  level: config.logLevel, // ← LOG_LEVEL 环境变量（config.js: logLevel）
  dir: defaultLogDir(),
  maxSizeBytes: 20 * 1024 * 1024, // 单文件上限 20MB
  maxFiles: 5, // 轮转保留份数：error.log.1 ~ error.log.5
});

let current = { ...DEFAULTS };
let fileFailureWarned = false;

function normalizeLevel(value) {
  const lv = String(value || '').trim().toLowerCase();
  return Object.hasOwn(LEVELS, lv) ? lv : 'info';
}

function enabled(level) {
  return LEVELS[level] >= LEVELS[normalizeLevel(current.level)];
}

// util.format 保留 console 原生占位符与多参数行为（%s/%d/%j、对象 inspect、err.stack）
function formatLine(level, args) {
  const message = formatUtil(...args);
  return `[${new Date().toISOString()}] [${LEVEL_TAGS[level]}] ${message}`;
}

// 写前轮转：error.log ≥ maxSizeBytes 时整体后移（.4→.5、.3→.4 … error.log→.1），
// 最旧的 error.log.maxFiles 删除。同步实现（error 量级低频，与 better-sqlite3 同步风格一致）
function rotateIfNeeded(targetFile) {
  const st = fs.statSync(targetFile);
  if (st.size < current.maxSizeBytes) return;
  const oldest = `${targetFile}.${current.maxFiles}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let i = current.maxFiles - 1; i >= 1; i--) {
    const from = `${targetFile}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${targetFile}.${i + 1}`);
  }
  fs.renameSync(targetFile, `${targetFile}.1`);
}

function appendErrorFile(line) {
  const targetFile = path.join(current.dir, ERROR_FILE_NAME);
  try {
    fs.mkdirSync(current.dir, { recursive: true });
    try { rotateIfNeeded(targetFile); } catch { /* 首次写入文件不存在等情况 */ }
    fs.appendFileSync(targetFile, line + '\n', 'utf-8');
    if (fileFailureWarned) fileFailureWarned = false; // 恢复后重置告警标志
  } catch (err) {
    // 文件系统故障降级：仅 stderr 告警一次，避免每次 error 都刷告警（防递归刷屏）
    if (!fileFailureWarned) {
      fileFailureWarned = true;
      process.stderr.write(`[logger] error 日志文件写入失败（降级为仅 stderr）：${err.message}\n`);
    }
  }
}

function emit(stream, level, args) {
  const line = formatLine(level, args);
  stream.write(line + '\n');
  if (level === 'error') appendErrorFile(line);
}

export const logger = {
  debug: (...args) => { if (enabled('debug')) emit(process.stdout, 'debug', args); },
  info: (...args) => { if (enabled('info')) emit(process.stdout, 'info', args); },
  warn: (...args) => { if (enabled('warn')) emit(process.stderr, 'warn', args); },
  error: (...args) => { if (enabled('error')) emit(process.stderr, 'error', args); },
  // stderr 白名单通道：启动横幅等安全/引导输出。不受级别过滤（始终可见）、不落盘
  banner: (...args) => { process.stderr.write(formatLine('info', args) + '\n'); },
};

// ── 测试注入通道（生产代码勿用）────────────────────────
export function __configureLogger(overrides = {}) {
  current = { ...DEFAULTS, ...overrides };
  fileFailureWarned = false;
}

export function __resetLogger() {
  current = { ...DEFAULTS };
  fileFailureWarned = false;
}

export function __loggerState() {
  return {
    level: normalizeLevel(current.level),
    dir: current.dir,
    maxSizeBytes: current.maxSizeBytes,
    maxFiles: current.maxFiles,
    defaultsLevel: normalizeLevel(DEFAULTS.level),
    defaultsDir: DEFAULTS.dir,
  };
}

export { LEVELS };
