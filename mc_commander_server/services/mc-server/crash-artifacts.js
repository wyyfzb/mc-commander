/**
 * 崩溃诊断产物域：读取并解析 MC 崩溃报告与 JVM 崩溃日志，供实例页呈现。
 *
 * 为什么需要它：这两类产物此前**只出现在备份排除清单里**（`backup.service.js` 认识它们），
 * 却从不呈现给用户——排查崩溃时用户被推回「请检查日志」，而这两份恰是最有价值的诊断文件。
 *
 * 格式依据（**对照真实产物核实，不凭记忆写字段**）：
 * - MC 崩溃报告：<https://minecraft.wiki/w/Tutorial:Obtaining_a_crash_report> 与
 *   <https://docs.fabricmc.net/players/troubleshooting/crash-reports>。实测样本为 MC 26.1
 *   启动期崩溃：头部 `---- Minecraft Crash Report ----` + 一行玩笑注释，随后 `Time:` /
 *   `Description:` / 顶层异常与栈（可含 `Caused by:` 链）；分隔句
 *   `A detailed walkthrough of the error...` 之后是 `-- <段名> --` 上下文段，每段含 tab 缩进的
 *   `Key: value`。⚠️ `-- Affected level --` **只在确实推进到世界/刻循环的崩溃里出现**，
 *   启动期崩溃没有 ⇒ 所有段与字段一律按可选处理。
 * - JVM 崩溃日志（`hs_err_pid*.log`）：Java 自身故障（段错误 / OOM 一类）产出的是它**而非**
 *   崩溃报告，故两类都要覆盖。实测两种头部形态：`#  SIGSEGV (0xb) at pc=...`（信号型）与
 *   `#  Internal Error (...)` + `#  fatal error: OutOfMemory encountered: ...`（OOM 型），
 *   后者**没有** `# Problematic frame:` 段 ⇒ 同样按可选处理。
 *   26.1 起堆栈不再混淆，可直接读，无需 retrace。
 *
 * 只读展示，不进备份（`backup.service.js` 的排除维持不变，避免快照被诊断产物撑大）。
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { diagnoseCrash } from './crash-diagnosis.js';

/** 崩溃报告目录（与 `backup.service.js` 的排除项同名） */
const CRASH_REPORT_DIR = 'crash-reports';

/** 崩溃报告文件名：crash-<yyyy-mm-dd>_<hh.mm.ss>-<client|server>.txt */
const CRASH_REPORT_RE = /^crash-.*-(client|server)\.txt$/;

/** 单个产物最多读取的字节数：hs_err 可达数十 KB，取头部足够覆盖已核实字段 */
const MAX_READ_BYTES = 256 * 1024;

/** 头部节选上限（其余整体呈现给用户） */
const EXCERPT_MAX_CHARS = 4000;

/** 崩溃报告头部签名 */
const CRASH_REPORT_HEADER = '---- Minecraft Crash Report ----';

/** hs_err 头部签名（两种形态共用这一行） */
const HS_ERR_HEADER = '# A fatal error has been detected by the Java Runtime Environment:';

/**
 * 列出实例目录下的崩溃产物并按 mtime 降序返回（最新的在前）。
 * 只做「存在性 + 时间」判断，不解析内容。
 */
export function _listCrashArtifacts() {
  const found = [];

  const reportDir = path.join(this.serverPath, CRASH_REPORT_DIR);
  try {
    for (const name of fs.readdirSync(reportDir)) {
      if (!CRASH_REPORT_RE.test(name)) continue;
      const filePath = path.join(reportDir, name);
      if (!this._crashArtifactContained(reportDir, filePath)) continue;
      const st = this._crashArtifactStat(filePath);
      if (st) found.push({ kind: 'crash-report', fileName: name, filePath, ...st });
    }
  } catch {
    // 目录不存在＝从未崩溃过，不是错误
  }

  // hs_err_pid*.log 落在实例根
  try {
    for (const name of fs.readdirSync(this.serverPath)) {
      if (!(name.startsWith('hs_err_pid') && name.endsWith('.log'))) continue;
      const filePath = path.join(this.serverPath, name);
      if (!this._crashArtifactContained(this.serverPath, filePath)) continue;
      const st = this._crashArtifactStat(filePath);
      if (st) found.push({ kind: 'jvm-crash', fileName: name, filePath, ...st });
    }
  } catch {
    // 实例目录不可读：由调用方按「无产物」降级
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/**
 * 产物路径的包含性断言。
 *
 * 两步：先做**词法**包含（不碰磁盘），再对已存在的文件做 **realpath** 比对。
 * 只做词法检查挡不住符号链接——实例目录里放一个指向外部的软链，词法上它仍在目录内，
 * 读取却会落到实例之外。
 */
export function _crashArtifactContained(rootDir, filePath) {
  const within = (root, target) => {
    const rel = path.relative(root, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (!within(path.resolve(rootDir), path.resolve(filePath))) return false;
  try {
    return within(fs.realpathSync(rootDir), fs.realpathSync(filePath));
  } catch {
    // 取不到真实路径（不存在 / 权限 / 竞争中被删）→ 不读
    return false;
  }
}

/** 取产物的 stat；非常规文件或读不到时返回 null */
export function _crashArtifactStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, sizeBytes: st.size };
  } catch {
    return null;
  }
}

/** 读取产物头部文本（超长文件只读前 maxBytes 字节；历史摘要只需头部，传更小的窗口即可） */
function readHead(filePath, maxBytes = MAX_READ_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 顶层异常行判据（含包名的类名 + 异常/错误）：解析与历史摘要共用一份，避免两处规则漂移 */
const TOP_EXCEPTION_RE = /^[\w.$]+(Exception|Error|Throwable)\b/;

/** 在给定范围内找第一条顶层异常行 */
function findTopException(lines, endIndex = lines.length) {
  for (let i = 0; i < endIndex; i++) {
    const trimmed = lines[i].trim();
    if (TOP_EXCEPTION_RE.test(trimmed)) return trimmed;
  }
  return null;
}

/** 从 `Key: value` 形态的行里取字段（崩溃报告的上下文段即此形态） */
function fieldFrom(lines, key) {
  const prefix = `${key}:`;
  for (const line of lines) {
    const trimmed = line.replace(/^\t+/, '');
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      if (value) return value;
    }
  }
  return null;
}

/** 解析 MC 崩溃报告；无法识别时返回 { parseError } */
export function parseCrashReport(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => l.startsWith(CRASH_REPORT_HEADER))) {
    return { parseError: '未找到崩溃报告头部标识，无法按崩溃报告解析' };
  }

  // 顶层异常：分隔句之前的第一个看起来像异常/错误行（含包名的类名 + 冒号）
  const walkthroughAt = lines.findIndex((l) => l.startsWith('A detailed walkthrough of the error'));
  const headEnd = walkthroughAt === -1 ? lines.length : walkthroughAt;
  let exception = null;
  const stack = [];
  const causedBy = [];
  for (let i = 0; i < headEnd; i++) {
    const line = lines[i];
    if (line.startsWith('Caused by: ')) {
      causedBy.push(line.slice('Caused by: '.length).trim());
      continue;
    }
    if (!exception && TOP_EXCEPTION_RE.test(line.trim())) {
      exception = line.trim();
      continue;
    }
    if (exception && /^\s+at\s/.test(line)) stack.push(line.trim());
  }

  // `-- <段名> --` 上下文段
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^-- (.+) --$/.exec(lines[i]);
    if (m) sections.push(m[1]);
  }

  // System Details 的 Details 块（tab 缩进的 Key: value）
  const detailsStart = lines.findIndex((l) => l.trim() === 'Details:');
  const detailsBlock = detailsStart === -1 ? [] : lines.slice(detailsStart + 1);

  const summary = [];
  const push = (label, value) => {
    if (value) summary.push({ label, value });
  };
  push('时间', fieldFrom(lines, 'Time'));
  push('描述', fieldFrom(lines, 'Description'));
  push('Minecraft 版本', fieldFrom(detailsBlock, 'Minecraft Version'));
  push('Java 版本', fieldFrom(detailsBlock, 'Java Version'));
  push('操作系统', fieldFrom(detailsBlock, 'Operating System'));
  push('内存', fieldFrom(detailsBlock, 'Memory'));
  push('CPU 数', fieldFrom(detailsBlock, 'CPUs'));
  // Affected level 段只在推进到世界/刻循环的崩溃里出现
  push('服务端品牌', fieldFrom(lines, 'Server brand'));
  push('崩溃时在线玩家', fieldFrom(lines, 'All players'));

  return {
    summary,
    // 诊断映射的锚：Description 是固定词表，值得作为一等字段（不再靠 summary 的标签去取）
    description: fieldFrom(lines, 'Description'),
    // 崩溃报告自己写的版本，比 DB/jar 更贴近「是谁崩的」
    minecraftVersion: fieldFrom(detailsBlock, 'Minecraft Version'),
    exception,
    stack,
    causedBy,
    sections,
  };
}

/** 解析 JVM 崩溃日志；无法识别时返回 { parseError } */
export function parseHsErr(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => l.startsWith(HS_ERR_HEADER))) {
    return { parseError: '未找到 JVM 崩溃日志头部标识，无法按 hs_err 解析' };
  }

  // 故障行：头部之后以 `#  `（两空格）缩进的行——信号型是 SIGSEGV 那行，
  // OOM 型是 `Internal Error (...)` 与其后的 `fatal error: ...` 两行
  const headerAt = lines.findIndex((l) => l.startsWith(HS_ERR_HEADER));
  const failure = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#  ')) {
      if (line.startsWith('# JRE version:')) break;
      continue;
    }
    // 两空格缩进行里，故障描述与 `pid=/tid=` 同行的都算故障行
    failure.push(line.slice(2).trim());
    if (failure.length >= 3) break;
  }

  // 问题帧：`# Problematic frame:` 的下一行（OOM 型没有这一段）
  const frameAt = lines.findIndex((l) => l.startsWith('# Problematic frame:'));
  let problematicFrame = null;
  if (frameAt !== -1) {
    for (let i = frameAt + 1; i < lines.length; i++) {
      const m = /^#\s+(\S.*)$/.exec(lines[i]);
      if (m) {
        problematicFrame = m[1].trim();
        break;
      }
      if (lines[i].trim() === '#') continue;
      break;
    }
  }

  const findLine = (prefix) => {
    const hit = lines.find((l) => l.startsWith(prefix));
    return hit ? hit.slice(prefix.length).trim() : null;
  };

  const summary = [];
  const push = (label, value) => {
    if (value) summary.push({ label, value });
  };
  push('故障', failure.join('；') || null);
  push('JRE 版本', findLine('# JRE version:'));
  push('Java VM', findLine('# Java VM:'));
  push('问题帧', problematicFrame);

  return { summary, failure, problematicFrame };
}

/** 头部节选：给用户「其余整体呈现」的原文（不解析，避免凭记忆扩展字段） */
function excerptOf(text) {
  return text.length > EXCERPT_MAX_CHARS
    ? `${text.slice(0, EXCERPT_MAX_CHARS)}\n…（已截断）`
    : text;
}

/** 历史摘要只需头部：崩溃报告的 Time/Description 与 hs_err 的故障行都在前几行 */
const HISTORY_HEAD_BYTES = 8 * 1024;

/**
 * 崩溃产物**历史**（最新的在前）。
 *
 * 为什么要有它：`crash-reports/` 与 `hs_err_pid*.log` 本就跨面板重启留着，但此前只暴露「最新
 * 一份」——反复崩溃的实例在界面上和偶尔崩一次没有区别，用户看不到「什么时候崩过几次、每次
 * 为什么」。这里不新建存储：产物文件本身就是持久面，只是把它读出来。
 *
 * 每份只读头部小窗口并只取「时间 + 原因 + 顶层异常/问题帧」：列表要的是可扫读的原因，
 * 不是每份的完整解析（点开单份仍走 getCrashArtifact）。读不到就留空字段，**不猜**。
 */
export function getCrashArtifactHistory({ limit = 20 } = {}) {
  let artifacts;
  try {
    artifacts = this._listCrashArtifacts();
  } catch (e) {
    logger.warn(`[${this.id}] 枚举崩溃产物失败:`, e.message);
    return { items: [], total: 0, hasMore: false };
  }

  const items = [];
  for (const artifact of artifacts.slice(0, limit)) {
    const item = {
      kind: artifact.kind,
      fileName: artifact.fileName,
      mtimeMs: artifact.mtimeMs,
      sizeBytes: artifact.sizeBytes,
      time: null,
      reason: null,
      detail: null,
    };
    try {
      const text = readHead(artifact.filePath, HISTORY_HEAD_BYTES);
      const lines = text.split(/\r?\n/);
      if (artifact.kind === 'crash-report') {
        item.time = fieldFrom(lines, 'Time');
        item.reason = fieldFrom(lines, 'Description');
        item.detail = findTopException(lines);
      } else {
        // hs_err 的头部即故障描述；问题帧只有信号型才有（OOM 型没有该段）
        const parsed = parseHsErr(text);
        item.reason = parsed.failure && parsed.failure.length ? parsed.failure.join('；') : null;
        item.detail = parsed.problematicFrame ?? null;
      }
    } catch (e) {
      // 单份读不到不影响整列：元信息仍在，原因留空由界面回落到文件名
      logger.warn(`[${this.id}] 读取崩溃产物 ${artifact.fileName} 失败:`, e.message);
    }
    items.push(item);
  }

  return { items, total: artifacts.length, hasMore: artifacts.length > limit };
}

/**
 * 取最新的一份崩溃诊断产物并解析。
 * 无产物返回 null（正常的空态，不是错误）；解析失败如实降级为 parseError，不静默给空。
 */
export function getCrashArtifact() {
  let latest;
  try {
    latest = this._listCrashArtifacts()[0];
  } catch (e) {
    logger.warn(`[${this.id}] 枚举崩溃产物失败:`, e.message);
    return { available: false, parseError: `枚举崩溃产物失败: ${e.message}` };
  }
  if (!latest) return null;

  const base = {
    available: true,
    kind: latest.kind,
    fileName: latest.fileName,
    mtimeMs: latest.mtimeMs,
    sizeBytes: latest.sizeBytes,
  };

  let text;
  try {
    text = readHead(latest.filePath);
  } catch (e) {
    // 如实降级：读不到就说读不到，不显示空内容让用户以为「没有报错」
    logger.warn(`[${this.id}] 读取崩溃产物 ${latest.fileName} 失败:`, e.message);
    return { ...base, parseError: `读取失败: ${e.message}` };
  }

  const parsed = latest.kind === 'crash-report' ? parseCrashReport(text) : parseHsErr(text);
  // 版本优先取崩溃报告自己写的：它才是「崩的那一份」；取不到再回落实例版本（unknown 视同未知）
  const instanceVersion = parsed.minecraftVersion || this._getMcVersion?.() || null;
  const mcVersion = instanceVersion === 'unknown' ? null : instanceVersion;
  // hs_err 没有可锚的键（故障行不属于允许的键类型）⇒ 必然未命中，原样展示已解析字段
  const diagnosis = diagnoseCrash({
    description: parsed.description ?? null,
    exception: parsed.exception ?? null,
    mcVersion,
  });
  return { ...base, ...parsed, excerpt: excerptOf(text), diagnosis };
}

export default {
  _listCrashArtifacts,
  _crashArtifactContained,
  _crashArtifactStat,
  getCrashArtifact,
  getCrashArtifactHistory,
  parseCrashReport,
  parseHsErr,
};
