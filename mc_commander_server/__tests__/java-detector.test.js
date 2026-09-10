/**
 * java-detector 专项单测（issue #406 —— stmts 0.68% 覆盖率洼地专项）
 *
 * 测试策略（fs / 子进程 / 平台全部 mock 注入，不依赖宿主机 Java 环境）：
 * - 纯函数矩阵经导出入口间接驱动（源文件未导出私有函数，业务代码零改动）：
 *   parseMcVersion / getRecommendedJavaVersion → getRecommendedJavaVersion
 *   getJavaVersionFromPath / parseJavaVersionOutput → getAllJavaVersions 的
 *   JAVA_HOME 探测链
 * - 文件系统探测注入内存文件树（files/dirs/entries/broken 四集合）替换
 *   fs.existsSync / fs.statSync / fs.readdirSync，expandGlob 的通配展开、
 *   中间目录校验、读取失败跳过等分支全部可达
 * - os.platform 注入 linux / win32 / darwin 覆盖三平台探测分支
 * - which / where 经 child_process.execSync 注入，java -version 经
 *   execFileSync 注入（stdout 正常路径 / stderr 异常路径 / 无输出路径）
 *
 * 行为锚定说明：expandGlob 对绝对 glob 模式按相对 CWD 语义逐段展开
 * （walk 自空串起拼段，'/usr/...' 模式实际探测 'usr/...'），本文件按该
 * 现行为构建探测树，固定单元逻辑本身（通配展开与存在性校验）。
 *
 * 平台约束：探测树的键、expandGlob 的展开结果、which/where 的输出三者都按
 * **宿主分隔符**归一（夹具与 mock 用 path.normalize，命令输出用 path.sep），
 * 实现内部 path.join 的产物因此与夹具始终一致——本文件在 Windows 宿主上同样
 * 成立，不再按平台 skip（此前 5 个 describe 在 win32 上零覆盖）。
 */
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** 夹具键与断言值统一归一：实现用 path.join 拼路径，Windows 产物是 '\' */
const norm = (p) => path.normalize(p);
/** which/where 的真实输出带宿主分隔符，且实现按原样消费（不参与 join） */
const hostPath = (p) => p.split('/').join(path.sep);

const fsState = vi.hoisted(() => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  files: new Set(),
  dirs: new Set(),
  entries: new Map(),
  broken: new Set(),
}));

const osState = vi.hoisted(() => ({ platform: vi.fn(() => 'linux') }));

const cpState = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: fsState.existsSync,
      statSync: fsState.statSync,
      readdirSync: fsState.readdirSync,
    },
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, platform: osState.platform } };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, execSync: cpState.execSync, execFileSync: cpState.execFileSync },
    execSync: cpState.execSync,
    execFileSync: cpState.execFileSync,
  };
});

import { logger } from '../utils/logger.js';
import { getRecommendedJavaVersion, getAllJavaVersions, findJavaPath } from '../utils/java-detector.js';

// ── 内存文件树工具（键一律经 norm，宿主无关）────────────────
function addDir(p) {
  fsState.dirs.add(norm(p));
}

function addFile(p) {
  fsState.files.add(norm(p));
}

function addBroken(p) {
  fsState.broken.add(norm(p));
}

// kind: 'dir' | 'file' | 'none'（isDirectory/isFile 均为 false 的异常项）
function addEntries(dir, list) {
  fsState.dirs.add(norm(dir));
  fsState.entries.set(norm(dir), list.map(([name, kind]) => ({
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  })));
}

// java -version 输出按路径注入：{ out } 走 stdout 正常路径，{ err } 走异常 stderr 路径，
// 未注册的路径走「无 stderr」异常路径（版本解析返回 null）
const versionByPath = new Map();
function setVersionOutput(javaPath, spec) {
  versionByPath.set(norm(javaPath), spec);
}

beforeEach(() => {
  fsState.files.clear();
  fsState.dirs.clear();
  fsState.entries.clear();
  fsState.broken.clear();
  versionByPath.clear();

  fsState.existsSync.mockImplementation(
    (p) => [fsState.files, fsState.dirs, fsState.broken].some((set) => set.has(norm(p)))
  );
  fsState.statSync.mockImplementation((p) => {
    if (fsState.broken.has(norm(p))) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
    if (fsState.files.has(norm(p))) return { isFile: () => true, isDirectory: () => false };
    if (fsState.dirs.has(norm(p))) return { isFile: () => false, isDirectory: () => true };
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  });
  fsState.readdirSync.mockImplementation((p) => {
    const entries = fsState.entries.get(norm(p));
    if (!entries) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return entries;
  });

  osState.platform.mockImplementation(() => 'linux');

  cpState.execSync.mockReset();
  cpState.execFileSync.mockReset();
  // 默认：PATH 探测失败（which 不存在）；java -version 按注册表分发——
  // 未注册路径走「执行失败且无 stderr」路径（版本解析返回 null）
  cpState.execSync.mockImplementation(() => {
    throw new Error('command not found');
  });
  cpState.execFileSync.mockImplementation((javaPath) => {
    const spec = versionByPath.get(norm(javaPath));
    if (!spec) throw new Error(`spawn ${javaPath} failed`);
    if (spec.err !== undefined) {
      throw Object.assign(new Error('exit 1'), { stderr: spec.err });
    }
    return spec.out;
  });

  delete process.env.JAVA_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getRecommendedJavaVersion —— MC 版本到推荐 Java 的映射矩阵', () => {
  it('新版本格式（major >= 20）一律推荐 25', () => {
    expect(getRecommendedJavaVersion('26.1.2')).toBe('25');
    expect(getRecommendedJavaVersion('26.1')).toBe('25');
    expect(getRecommendedJavaVersion('20.0')).toBe('25');
    expect(getRecommendedJavaVersion('30.4.1')).toBe('25');
  });

  it('1.7.x - 1.16.x 推荐 8', () => {
    expect(getRecommendedJavaVersion('1.7.10')).toBe('8');
    expect(getRecommendedJavaVersion('1.8.9')).toBe('8');
    expect(getRecommendedJavaVersion('1.12.2')).toBe('8');
    expect(getRecommendedJavaVersion('1.16.5')).toBe('8');
  });

  it('1.17.x - 1.19.x 推荐 17', () => {
    expect(getRecommendedJavaVersion('1.17.0')).toBe('17');
    expect(getRecommendedJavaVersion('1.17.1')).toBe('17');
    expect(getRecommendedJavaVersion('1.18.0')).toBe('17');
    expect(getRecommendedJavaVersion('1.19.4')).toBe('17');
  });

  it('1.20.x 以 patch 5 为界：1.20.0-1.20.4 → 17，1.20.5+ → 21', () => {
    expect(getRecommendedJavaVersion('1.20.0')).toBe('17');
    expect(getRecommendedJavaVersion('1.20.4')).toBe('17');
    expect(getRecommendedJavaVersion('1.20.5')).toBe('21');
    expect(getRecommendedJavaVersion('1.20.6')).toBe('21');
  });

  it('1.21.x 推荐 21', () => {
    expect(getRecommendedJavaVersion('1.21.0')).toBe('21');
    expect(getRecommendedJavaVersion('1.21.11')).toBe('21');
  });

  it('矩阵未覆盖的版本段回退默认 17', () => {
    expect(getRecommendedJavaVersion('1.6.4')).toBe('17');
    expect(getRecommendedJavaVersion('2.0.0')).toBe('17');
    expect(getRecommendedJavaVersion('19.9.9')).toBe('17');
  });

  it('pre 后缀按 parseInt 截断语义解析', () => {
    expect(getRecommendedJavaVersion('1.20.4-pre2')).toBe('17');
    expect(getRecommendedJavaVersion('1.21-pre1')).toBe('21');
  });

  it('异常输入（空值 / 非字符串 / 段不足 / 非数字段）回退默认 17', () => {
    expect(getRecommendedJavaVersion(null)).toBe('17');
    expect(getRecommendedJavaVersion(undefined)).toBe('17');
    expect(getRecommendedJavaVersion('')).toBe('17');
    expect(getRecommendedJavaVersion('   ')).toBe('17');
    expect(getRecommendedJavaVersion('abc')).toBe('17');
    expect(getRecommendedJavaVersion('1')).toBe('17');
    expect(getRecommendedJavaVersion('1.x.2')).toBe('17');
    expect(getRecommendedJavaVersion('..')).toBe('17');
    expect(getRecommendedJavaVersion(123)).toBe('17');
  });

  it('首尾空白容忍与 patch 缺省补 0', () => {
    expect(getRecommendedJavaVersion('  1.20.4  ')).toBe('17');
    expect(getRecommendedJavaVersion('1.20')).toBe('17');
    expect(getRecommendedJavaVersion('1.20.4.5')).toBe('17');
  });
});

describe('getAllJavaVersions · JAVA_HOME 探测与 java -version 输出解析', () => {
  const JDK17 = '/opt/jdk-17';

  function setupJavaHome(home, javaBin, spec) {
    process.env.JAVA_HOME = home;
    addDir(home);
    addDir(`${home}/bin`);
    addFile(javaBin);
    if (spec) setVersionOutput(javaBin, spec);
  }

  it('openjdk 新格式输出解析主版本（成功路径 stdout）', () => {
    setupJavaHome(JDK17, `${JDK17}/bin/java`, { out: 'openjdk version "17.0.1" 2021-10-19' });
    expect(getAllJavaVersions()).toEqual([
      { version: '17', path: norm(`${JDK17}/bin/java`) },
    ]);
  });

  it('短版本号与最新版本号解析（21 / 25）', () => {
    setupJavaHome(JDK17, `${JDK17}/bin/java`, { out: 'openjdk version "21"' });
    expect(getAllJavaVersions()[0].version).toBe('21');

    setupJavaHome(JDK17, `${JDK17}/bin/java`, { out: 'openjdk version "25" 2025-09-16' });
    expect(getAllJavaVersions()[0].version).toBe('25');
  });

  it('旧式 1.x 版本串取次级版本号（1.8.0_292 → 8）', () => {
    setupJavaHome(JDK17, `${JDK17}/bin/java`, {
      out: 'java version "1.8.0_292"\nJava(TM) SE Runtime Environment',
    });
    expect(getAllJavaVersions()[0].version).toBe('8');
  });

  it('execFileSync 异常但 stderr 携带版本串时仍可解析（java -version 走 stderr 的真实行为）', () => {
    setupJavaHome(JDK17, `${JDK17}/bin/java`, { err: 'openjdk version "11.0.2" 2019-01-15' });
    expect(getAllJavaVersions()).toEqual([
      { version: '11', path: norm(`${JDK17}/bin/java`) },
    ]);
  });

  it('输出无 version 串或执行异常且无 stderr → 版本为 null → 不收录', () => {
    setupJavaHome(JDK17, `${JDK17}/bin/java`, { out: 'Total garbage, no version here' });
    expect(getAllJavaVersions()).toEqual([]);

    setupJavaHome(JDK17, `${JDK17}/bin/java`, null);
    expect(getAllJavaVersions()).toEqual([]);
  });

  it('java -version 返回空输出（null / 空串）→ 容错不收录', () => {
    setupJavaHome(JDK17, `${JDK17}/bin/java`, { out: null });
    expect(getAllJavaVersions()).toEqual([]);

    setupJavaHome(JDK17, `${JDK17}/bin/java`, { out: '' });
    expect(getAllJavaVersions()).toEqual([]);
  });

  it('JAVA_HOME 未设置或指向不存在的可执行文件 → 不收录', () => {
    expect(getAllJavaVersions()).toEqual([]);

    process.env.JAVA_HOME = '/opt/missing-jdk';
    expect(getAllJavaVersions()).toEqual([]);
  });
});

// Linux glob 探测树（expandGlob 相对 CWD 语义的现行为锚定，见文件头说明）
function buildLinuxTree() {
  addDir('usr');
  addDir('usr/lib');
  addDir('usr/lib/jvm');
  addEntries('usr/lib/jvm', [
    ['java-17-openjdk-amd64', 'dir'],
    ['java-19-openjdk-amd64', 'dir'],
    ['java-30-openjdk-broken', 'dir'],
    ['java-8-amazon-corretto', 'dir'],
    ['temurin-25-jre', 'dir'],
    ['jdk-11', 'dir'],
    ['README', 'none'],
  ]);

  // 命中通配的发行版目录（readdir 注入）
  addDir('usr/lib/jvm/java-17-openjdk-amd64');
  addDir('usr/lib/jvm/java-17-openjdk-amd64/bin');
  addFile('usr/lib/jvm/java-17-openjdk-amd64/bin/java');
  setVersionOutput('usr/lib/jvm/java-17-openjdk-amd64/bin/java', { out: 'openjdk version "17.0.1"' });

  addDir('usr/lib/jvm/java-8-amazon-corretto');
  addDir('usr/lib/jvm/java-8-amazon-corretto/bin');
  addFile('usr/lib/jvm/java-8-amazon-corretto/bin/java');
  setVersionOutput('usr/lib/jvm/java-8-amazon-corretto/bin/java', { out: 'java version "1.8.0_292"' });

  addDir('usr/lib/jvm/temurin-25-jre');
  addDir('usr/lib/jvm/temurin-25-jre/bin');
  addFile('usr/lib/jvm/temurin-25-jre/bin/java');
  setVersionOutput('usr/lib/jvm/temurin-25-jre/bin/java', { out: 'openjdk version "25"' });

  addDir('usr/lib/jvm/jdk-11');
  addDir('usr/lib/jvm/jdk-11/bin');
  addFile('usr/lib/jvm/jdk-11/bin/java');
  setVersionOutput('usr/lib/jvm/jdk-11/bin/java', { out: 'openjdk version "11"' });

  // java-19：目录与 bin 存在但 java 可执行文件不存在 → 终点 fileExists false 不收录
  addDir('usr/lib/jvm/java-19-openjdk-amd64');
  addDir('usr/lib/jvm/java-19-openjdk-amd64/bin');
  // java-30：通配命中但 readdir 失败 → 该分支静默跳过
}

describe('getAllJavaVersions · Linux glob 探测（expandGlob 注入）', () => {
  it('多发行版目录经通配展开全部识别，未命中/空壳/损坏目录全部排除', () => {
    buildLinuxTree();
    const found = getAllJavaVersions();
    const paths = found.map((x) => x.path).sort();
    expect(paths).toEqual([
      norm('usr/lib/jvm/java-17-openjdk-amd64/bin/java'),
      norm('usr/lib/jvm/java-8-amazon-corretto/bin/java'),
      norm('usr/lib/jvm/jdk-11/bin/java'),
      norm('usr/lib/jvm/temurin-25-jre/bin/java'),
    ]);
    expect(found.map((x) => x.version).sort()).toEqual(['11', '17', '25', '8']);
  });

  it('通配命中目录但 java 可执行文件不存在 → 不收录（java-19 空壳）', () => {
    buildLinuxTree();
    const paths = getAllJavaVersions().map((x) => x.path);
    expect(paths).not.toContain(norm('usr/lib/jvm/java-19-openjdk-amd64/bin/java'));
  });

  it('JAVA_HOME 指向存在但版本解析失败的 java → 该项不收录，glob 结果不受影响', () => {
    buildLinuxTree();
    process.env.JAVA_HOME = '/opt/broken-jdk';
    addDir('/opt/broken-jdk');
    addDir('/opt/broken-jdk/bin');
    addFile('/opt/broken-jdk/bin/java');
    const paths = getAllJavaVersions().map((x) => x.path);
    expect(paths).not.toContain(norm('/opt/broken-jdk/bin/java'));
    expect(paths).toHaveLength(4);
  });

  it('PATH 探测：已收录路径去重跳过，新路径追加', () => {
    buildLinuxTree();
    addFile('/usr/local/bin/java');
    setVersionOutput('/usr/local/bin/java', { out: 'openjdk version "21"' });
    cpState.execSync.mockImplementation(
      () =>
        [hostPath('usr/lib/jvm/jdk-11/bin/java'), hostPath('/usr/local/bin/java')].join('\n')
    );
    const paths = getAllJavaVersions().map((x) => x.path);
    expect(paths.filter((p) => p === norm('usr/lib/jvm/jdk-11/bin/java'))).toHaveLength(1);
    expect(paths).toContain(norm('/usr/local/bin/java'));
    expect(paths).toHaveLength(5);
  });

  it('PATH 探测命令失败（which 不存在）→ 静默忽略，glob 结果照常返回', () => {
    buildLinuxTree();
    expect(getAllJavaVersions()).toHaveLength(4);
  });

  it('中间字面目录存在但 statSync 抛错 → 整支跳过不崩溃', () => {
    buildLinuxTree();
    // jdk-11 经 jdk-* 通配段进入后，bin 为字面量中间段：existsSync true 但 statSync 抛错
    addBroken('usr/lib/jvm/jdk-11/bin');
    const paths = getAllJavaVersions().map((x) => x.path);
    expect(paths).not.toContain(norm('usr/lib/jvm/jdk-11/bin/java'));
    expect(paths).toHaveLength(3);
  });

  it('终点文件存在但 statSync 抛错 → fileExists 容错返回 false 不收录', () => {
    buildLinuxTree();
    addBroken('usr/lib/jvm/temurin-25-jre/bin/java');
    const paths = getAllJavaVersions().map((x) => x.path);
    expect(paths).not.toContain(norm('usr/lib/jvm/temurin-25-jre/bin/java'));
    expect(paths).toHaveLength(3);
  });

  it('通配段 readdir 失败 → 该层全部跳过不崩溃', () => {
    buildLinuxTree();
    fsState.entries.delete(norm('usr/lib/jvm'));
    expect(getAllJavaVersions()).toEqual([]);
  });
});

describe('getAllJavaVersions · Windows 平台分支', () => {
  it('JAVA_HOME / Program Files 通配 / where 多行去重', () => {
    osState.platform.mockImplementation(() => 'win32');
    process.env.JAVA_HOME = 'C:/jdk-21';
    addDir('C:/jdk-21');
    addDir('C:/jdk-21/bin');
    addFile('C:/jdk-21/bin/java.exe');
    setVersionOutput('C:/jdk-21/bin/java.exe', { out: 'openjdk version "21"' });

    addDir('C:');
    addDir('C:/Program Files');
    addDir('C:/Program Files/Java');
    addEntries('C:/Program Files/Java', [['jdk-17', 'dir']]);
    addDir('C:/Program Files/Java/jdk-17');
    addDir('C:/Program Files/Java/jdk-17/bin');
    addFile('C:/Program Files/Java/jdk-17/bin/java.exe');
    setVersionOutput('C:/Program Files/Java/jdk-17/bin/java.exe', { out: 'java version "1.17.0_1"' });

    addFile('C:/Windows/system32/java.exe');
    setVersionOutput('C:/Windows/system32/java.exe', { out: 'openjdk version "17"' });
    cpState.execSync.mockImplementation(
      () =>
        [hostPath('C:/Windows/system32/java.exe'), hostPath('C:/nowhere/java.exe')].join('\n')
    );

    const paths = getAllJavaVersions().map((x) => x.path);
    expect(paths).toEqual([
      norm('C:/jdk-21/bin/java.exe'),
      norm('C:/Program Files/Java/jdk-17/bin/java.exe'),
      norm('C:/Windows/system32/java.exe'),
    ]);
  });
});

describe('getAllJavaVersions · macOS 平台分支', () => {
  it('JavaVirtualMachines 通配探测', () => {
    osState.platform.mockImplementation(() => 'darwin');
    addDir('Library');
    addDir('Library/Java');
    addDir('Library/Java/JavaVirtualMachines');
    addEntries('Library/Java/JavaVirtualMachines', [['zulu-21', 'dir']]);
    addDir('Library/Java/JavaVirtualMachines/zulu-21');
    addDir('Library/Java/JavaVirtualMachines/zulu-21/Contents');
    addDir('Library/Java/JavaVirtualMachines/zulu-21/Contents/Home');
    addDir('Library/Java/JavaVirtualMachines/zulu-21/Contents/Home/bin');
    addFile('Library/Java/JavaVirtualMachines/zulu-21/Contents/Home/bin/java');
    setVersionOutput('Library/Java/JavaVirtualMachines/zulu-21/Contents/Home/bin/java', {
      out: 'openjdk version "21" 2023-09-19',
    });

    expect(getAllJavaVersions()).toEqual([
      { version: '21', path: norm('Library/Java/JavaVirtualMachines/zulu-21/Contents/Home/bin/java') },
    ]);
  });
});

describe('findJavaPath —— 精确匹配 / 较新回退 / 默认回退三级策略', () => {
  it('存在精确匹配版本 → 直接返回该路径', () => {
    process.env.JAVA_HOME = '/opt/jdk-17';
    addDir('/opt/jdk-17');
    addDir('/opt/jdk-17/bin');
    addFile('/opt/jdk-17/bin/java');
    setVersionOutput('/opt/jdk-17/bin/java', { out: 'openjdk version "17.0.1"' });
    expect(findJavaPath('17')).toBe(norm('/opt/jdk-17/bin/java'));
  });

  it('无精确匹配但有多个较新版本 → 返回其中最小版本', () => {
    buildLinuxTree();
    const got = findJavaPath('9');
    // 较新集合 {11, 17, 25, 8→排除} 的最小为 11
    expect(got).toBe(norm('usr/lib/jvm/jdk-11/bin/java'));
  });

  it('环境无任何可用 Java → 回退系统 java 命令并告警', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(findJavaPath('17')).toBe('java');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('17');
    warnSpy.mockRestore();
  });
});
