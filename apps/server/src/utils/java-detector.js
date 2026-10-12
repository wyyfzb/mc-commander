import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

// 默认推荐的 Java 版本
const DEFAULT_JAVA_VERSION = '17';

/**
 * 解析 MC 版本字符串为 [major, minor, patch] 数字数组
 * 支持旧格式（1.20.4）和新格式（26.1.2）
 * @param {string} mcVersion
 * @returns {[number, number, number]|null}
 */
function parseMcVersion(mcVersion) {
  if (!mcVersion || typeof mcVersion !== 'string') {
    return null;
  }
  const parts = mcVersion
    .trim()
    .split('.')
    .map((p) => parseInt(p, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) {
    return null;
  }
  return [parts[0], parts[1], parts[2] || 0];
}

/**
 * 根据 MC 版本返回推荐 Java 版本号（整数字符串）
 * 参考 HeadlessMC 版本矩阵：
 * - MC 1.7.10 - 1.16.5 → '8'
 * - MC 1.17.0 - 1.17.1 → '17'（最低需 16，但推荐 17）
 * - MC 1.18.0 - 1.20.4 → '17'
 * - MC 1.20.5 - 1.21.11 → '21'
 * - MC 26.1+ (新版本格式) → '25'
 * - 默认 → '17'
 *
 * 新版本格式（major >= 20，例如 26.x）直接返回 '25'
 * @param {string} mcVersion MC 版本字符串，例如 '1.20.4' 或 '26.1.2'
 * @returns {string} Java 主版本号字符串
 */
export function getRecommendedJavaVersion(mcVersion) {
  const parsed = parseMcVersion(mcVersion);
  if (!parsed) {
    return DEFAULT_JAVA_VERSION;
  }
  const [major, minor, patch] = parsed;

  // 新版本格式（major >= 20，例如 26.x），直接返回 '25'
  if (major >= 20) {
    return '25';
  }

  // 旧版本格式（1.x）
  if (major === 1) {
    // MC 1.7.10 - 1.16.5 → '8'
    if (minor >= 7 && minor <= 16) {
      return '8';
    }
    // MC 1.17.0 - 1.17.1 → '17'
    if (minor === 17) {
      return '17';
    }
    // MC 1.18.0 - 1.20.4 → '17'
    if (minor >= 18 && minor <= 20) {
      if (minor === 20) {
        // MC 1.20.5+ → '21'，1.20.0 - 1.20.4 → '17'
        return patch >= 5 ? '21' : '17';
      }
      return '17';
    }
    // MC 1.21.x → '21'（1.21.0-1.21.11 使用 Java 21）
    if (minor >= 21) {
      return '21';
    }
  }

  return DEFAULT_JAVA_VERSION;
}

/**
 * 获取指定 Java 可执行文件的版本号
 * 通过执行 `java -version` 解析版本，输出位于 stderr
 * @param {string} javaPath java 可执行文件路径
 * @returns {string|null} Java 主版本号字符串，失败时返回 null
 */
function getJavaVersionFromPath(javaPath) {
  // java -version 把版本写到 **stderr** 且**退出码为 0**，故不能只读 stdout：
  // execFileSync 在成功路径丢弃 stderr，返回空串 ⇒ 解析恒得 null，且 catch 永不触发
  // （实测：默认 java=17 时面板仍判「未找到 Java」，用 17 启动 26.3 会 UnsupportedClassVersionError）。
  // spawnSync 不抛错、stdout/stderr 都在手上，合并后解析对两种输出位置都成立。
  const res = spawnSync(javaPath, ['-version'], { encoding: 'utf-8', timeout: 10000 });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  return parseJavaVersionOutput(output);
}

/**
 * 从 `java -version` 输出中解析 Java 主版本号
 * 支持多种格式：
 * - 旧格式：java version "1.8.0_292"
 * - 新格式：openjdk version "17.0.1" / "21" / "25"
 * @param {string} output
 * @returns {string|null}
 */
function parseJavaVersionOutput(output) {
  if (!output || typeof output !== 'string') {
    return null;
  }
  // 匹配 version "x.y.z" 或 version "x.y.z_build"
  const match = output.match(/version\s+"(\d+(?:\.\d+)*)/);
  if (!match) {
    return null;
  }
  const versionStr = match[1];
  const parts = versionStr.split('.');
  let major;
  if (parts[0] === '1' && parts.length >= 2) {
    // 旧格式 1.8.0_292 → 主版本 8
    major = parseInt(parts[1], 10);
  } else {
    major = parseInt(parts[0], 10);
  }
  return Number.isNaN(major) ? null : String(major);
}

/**
 * 检查文件是否存在且可执行
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 通过 glob 模式展开路径并返回存在的 java 可执行文件列表
 * @param {string} pattern glob 模式（使用 / 分隔符）
 * @returns {string[]}
 */
function expandGlob(pattern) {
  const results = [];
  const segments = pattern.split('/');

  function walk(index, currentPath) {
    if (index >= segments.length) {
      if (fileExists(currentPath)) {
        results.push(currentPath);
      }
      return;
    }
    const seg = segments[index];
    if (!seg) {
      walk(index + 1, currentPath);
      return;
    }
    // 包含通配符
    if (seg.includes('*') || seg.includes('?')) {
      const regexStr = seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`^${regexStr}$`);
      let entries = [];
      try {
        entries = fs.readdirSync(currentPath || '.', { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isFile()) {
          if (regex.test(entry.name)) {
            const next = currentPath ? path.join(currentPath, entry.name) : entry.name;
            walk(index + 1, next);
          }
        }
      }
    } else {
      const next = currentPath ? path.join(currentPath, seg) : seg;
      // 如果是路径最后一段，检查是否文件；否则检查目录是否存在
      if (index === segments.length - 1) {
        if (fileExists(next)) {
          results.push(next);
        }
      } else {
        try {
          if (fs.existsSync(next) && fs.statSync(next).isDirectory()) {
            walk(index + 1, next);
          }
        } catch {
          // 忽略
        }
      }
    }
  }

  // 绝对模式必须以 '/' 起拼：pattern.split('/') 的首段是空串（代表根），
  // 从 '' 起拼会让 path.join('', 'usr') 丢掉根变成相对路径 'usr/...'，
  // 于是所有硬编码的绝对 glob（Linux/macOS 那几组）只在 cwd 恰为 '/' 时命中。
  walk(0, pattern.startsWith('/') ? '/' : '');
  return results;
}

// 扫描系统已安装的 Java 版本
// 返回数组 [{ version: '17', path: '/usr/lib/jvm/...' }, ...]
// 检测路径（按优先级）：
// 1. JAVA_HOME 环境变量
// 2. Linux: /usr/lib/jvm/java-X-openjdk-X/bin/java, /usr/lib/jvm/java-X-amazon-corretto/bin/java, /usr/lib/jvm/jdk-X/bin/java
// 3. Windows: C:\Program Files\Java\jdk-X/bin/java.exe, C:\Program Files\Eclipse Adoptium\jdk-X/bin/java.exe
// 4. macOS: /Library/Java/JavaVirtualMachines/X/Contents/Home/bin/java
// 5. PATH 中的 java
// @returns {Array<{version: string, path: string}>}
export function getAllJavaVersions() {
  const found = new Map(); // path → version，去重
  const platform = os.platform();
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';

  // 1. JAVA_HOME 环境变量
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    const javaBin = path.join(javaHome, 'bin', isWindows ? 'java.exe' : 'java');
    if (fileExists(javaBin)) {
      const version = getJavaVersionFromPath(javaBin);
      if (version) {
        found.set(javaBin, version);
      }
    }
  }

  // 2. Linux 检测路径
  if (isLinux) {
    const linuxPatterns = [
      // OpenJDK: /usr/lib/jvm/java-17-openjdk-amd64/bin/java
      '/usr/lib/jvm/java-*-openjdk-*/bin/java',
      // Amazon Corretto (CentOS/RHEL): /usr/lib/jvm/java-25-amazon-corretto.x86_64/bin/java
      '/usr/lib/jvm/java-*-amazon-corretto*/bin/java',
      // Amazon Corretto (Ubuntu/Debian, JRE headless): /usr/lib/jvm/java-25-amazon-corretto-25.0.x.x-linux-x64/jre/bin/java
      '/usr/lib/jvm/java-*-amazon-corretto*/jre/bin/java',
      // Eclipse Temurin (Adoptium): /usr/lib/jvm/temurin-17-jre/bin/java
      '/usr/lib/jvm/temurin-*-jre/bin/java',
      // 通用 jdk 目录: /usr/lib/jvm/jdk-17/bin/java
      '/usr/lib/jvm/jdk-*/bin/java',
    ];
    for (const pattern of linuxPatterns) {
      const paths = expandGlob(pattern);
      for (const p of paths) {
        if (!found.has(p)) {
          const version = getJavaVersionFromPath(p);
          if (version) {
            found.set(p, version);
          }
        }
      }
    }
  }

  // 3. Windows 检测路径
  if (isWindows) {
    const winPatterns = [
      'C:/Program Files/Java/jdk-*/bin/java.exe',
      'C:/Program Files/Eclipse Adoptium/jdk-*/bin/java.exe',
      // Amazon Corretto on Windows: C:\Program Files\Amazon\Corretto\jdk25\bin\java.exe
      'C:/Program Files/Amazon/Corretto/jdk*/bin/java.exe',
      // Eclipse Temurin legacy path
      'C:/Program Files/Temurin/jdk-*/bin/java.exe',
    ];
    for (const pattern of winPatterns) {
      const paths = expandGlob(pattern);
      for (const p of paths) {
        if (!found.has(p)) {
          const version = getJavaVersionFromPath(p);
          if (version) {
            found.set(p, version);
          }
        }
      }
    }
  }

  // 4. macOS 检测路径
  if (isMac) {
    const macPattern = '/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java';
    const paths = expandGlob(macPattern);
    for (const p of paths) {
      if (!found.has(p)) {
        const version = getJavaVersionFromPath(p);
        if (version) {
          found.set(p, version);
        }
      }
    }
  }

  // 5. PATH 中的 java
  const pathJava = isWindows ? 'java.exe' : 'java';
  try {
    // 使用 where (Windows) 或 which (Unix) 定位 PATH 中的 java
    const cmd = isWindows ? `where ${pathJava}` : `which java`;
    const result = execSync(cmd, {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (result) {
      // where 可能返回多行
      const lines = result.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const javaPath = line.trim();
        if (fileExists(javaPath) && !found.has(javaPath)) {
          const version = getJavaVersionFromPath(javaPath);
          if (version) {
            found.set(javaPath, version);
          }
        }
      }
    }
  } catch {
    // PATH 中无 java，忽略
  }

  // 转换为数组
  const versions = [];
  for (const [p, v] of found.entries()) {
    versions.push({ version: v, path: p });
  }
  return versions;
}

/**
 * 找到合适 Java 路径，支持回退策略：
 * 1. 精确匹配：在 getAllJavaVersions() 结果中找 version === requiredVersion
 * 2. 回退到较新版本：找 version >= requiredVersion 的最小版本
 * 3. 默认：返回 'java' 并 console.warn 警告
 * @param {string} requiredVersion 需要的 Java 主版本号字符串，例如 '17'
 * @returns {string} Java 可执行文件路径
 */
export function findJavaPath(requiredVersion) {
  const all = getAllJavaVersions();
  const required = parseInt(requiredVersion, 10);

  // 1. 精确匹配
  for (const item of all) {
    if (parseInt(item.version, 10) === required) {
      return item.path;
    }
  }

  // 2. 回退到较新版本中的最小版本
  const newer = all
    .filter((item) => parseInt(item.version, 10) >= required)
    .sort((a, b) => parseInt(a.version, 10) - parseInt(b.version, 10));
  if (newer.length > 0) {
    return newer[0].path;
  }

  // 3. 默认返回 'java' 并警告
  logger.warn(`[java-detector] 未找到 Java ${requiredVersion} 或更新版本，回退到系统 'java' 命令`);
  return 'java';
}

/**
 * 严格版查找：**找不到满足要求的 Java 时返回 null**，不回落系统 `java`。
 *
 * 为什么与 `findJavaPath` 分开：部署路径要保持「回落系统 java」的既有行为
 * （用户机器上只有系统 java 时也得能装上），而升级路径必须能区分「确实找到了」
 * 与「只能碰运气」——后者意味着升级完极可能起不来，此时应当中止而不是照升。
 * @param {string} requiredVersion 需要的 Java 主版本号字符串
 * @returns {string|null}
 */
export function findJavaPathStrict(requiredVersion) {
  const all = getAllJavaVersions();
  const required = parseInt(requiredVersion, 10);
  if (!Number.isInteger(required)) return null;
  for (const item of all) {
    if (parseInt(item.version, 10) === required) return item.path;
  }
  const newer = all
    .filter((item) => parseInt(item.version, 10) >= required)
    .sort((a, b) => parseInt(a.version, 10) - parseInt(b.version, 10));
  return newer.length > 0 ? newer[0].path : null;
}

/**
 * 判断给定 javaPath 是否满足目标 Java 主版本要求。
 *
 * `javaPath` 可能是裸命令 `java`（部署的回落值），此时先解析成真实绝对路径再比对，
 * 否则会把「系统 java 其实够新」误判成不满足并触发一次不必要的重选。
 * @param {string} javaPath
 * @param {string} requiredVersion
 * @returns {boolean}
 */
export function isJavaSatisfied(javaPath, requiredVersion) {
  const required = parseInt(requiredVersion, 10);
  if (!Number.isInteger(required)) return true; // 要求未知 ⇒ 不阻塞
  if (!javaPath) return false;
  const all = getAllJavaVersions();
  const resolved = all.find((item) => item.path === javaPath);
  const version = resolved ? parseInt(resolved.version, 10) : null;
  return version !== null && version >= required;
}

export default {
  getRecommendedJavaVersion,
  getAllJavaVersions,
  findJavaPath,
};
