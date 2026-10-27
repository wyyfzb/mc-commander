/**
 * 面板自供 Java 运行时（services/java-runtime.service.js）单测。
 *
 * 上游一律替身：all.json / runtime manifest 走 httpJson 替身，文件字节走 httpStream
 * 替身；JRE 落盘用真实文件系统（临时目录），这样能真正断言「逐文件 sha1、可执行位、
 * staging 清理、路径穿越不越界」——这些都是本服务存在的理由，mock 掉就不承重了。
 *
 * 平台与 Java 探测注入：os.platform/arch 决定平台 key，java-detector 的四个入口
 * （findJavaPathStrict / getJavaVersionFromPath / isJavaSatisfied / getPanelJreDir）替身化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'node:stream';

const osState = vi.hoisted(() => ({ platform: 'linux', arch: 'x64' }));
const jreState = vi.hoisted(() => ({ dir: null }));
const javaState = vi.hoisted(() => ({ strict: null, probed: '21', satisfied: true }));
const metaState = vi.hoisted(() => ({ value: null }));
const jsonState = vi.hoisted(() => ({ table: {} }));
const streamState = vi.hoisted(() => ({
  plans: new Map(),
  attempts: new Map(),
  calls: new Map(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      platform: () => osState.platform,
      arch: () => osState.arch,
    },
  };
});

vi.mock('../src/utils/http-client.js', () => ({
  httpJson: vi.fn(async (url) => {
    const entry = jsonState.table[String(url)];
    if (entry === undefined) throw new Error(`unexpected json url: ${url}`);
    return entry;
  }),
  httpStream: vi.fn((url) => {
    const key = String(url);
    streamState.calls.set(key, (streamState.calls.get(key) ?? 0) + 1);
    const attempt = (streamState.attempts.get(key) ?? 0) + 1;
    streamState.attempts.set(key, attempt);
    const plan = streamState.plans.get(key) ?? [{ bytes: Buffer.alloc(0) }];
    const spec = plan[Math.min(attempt - 1, plan.length - 1)];
    const pt = new PassThrough();
    queueMicrotask(() => {
      if (spec.error) {
        pt.destroy(spec.error);
        return;
      }
      pt.emit('downloadProgress', {
        percent: 1,
        transferred: spec.bytes.length,
        total: spec.bytes.length,
      });
      pt.end(spec.bytes);
    });
    return pt;
  }),
  httpPost: vi.fn(),
}));

vi.mock('../src/utils/java-detector.js', () => ({
  findJavaPathStrict: vi.fn(() => javaState.strict),
  getJavaVersionFromPath: vi.fn(() => javaState.probed),
  isJavaSatisfied: vi.fn(() => javaState.satisfied),
  getPanelJreDir: vi.fn(() => jreState.dir),
}));

vi.mock('../src/services/vanilla-manifest.js', () => ({
  resolveVanillaJavaRuntime: vi.fn(async () => metaState.value),
}));

import { httpJson } from '../src/utils/http-client.js';
import { isJavaSatisfied } from '../src/utils/java-detector.js';
import { resolveVanillaJavaRuntime } from '../src/services/vanilla-manifest.js';
import {
  ensureJavaRuntime,
  javaComponentForMajor,
  runtimePlatformKey,
  JAVA_RUNTIME_MANIFEST_URL,
} from '../src/services/java-runtime.service.js';

const MANIFEST_URL = 'https://piston-meta.mojang.com/v1/packages/abc/manifest.json';

/** 造一份 all.json + runtime manifest + 文件字节流 */
function setupComponent({ component = 'java-runtime-delta', files = {} } = {}) {
  jsonState.table[JAVA_RUNTIME_MANIFEST_URL] = {
    linux: { [component]: [{ manifest: { url: MANIFEST_URL, sha1: 'abc', size: 1 } }] },
  };
  const fileMap = {};
  for (const [key, content] of Object.entries(files)) {
    if (content && content.type) {
      fileMap[key] = content;
      continue;
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
    const url = `https://piston-data.mojang.com/v1/objects/${sha1}/${key.split('/').pop()}`;
    fileMap[key] = {
      type: 'file',
      executable: key === 'bin/java',
      downloads: { raw: { url, sha1, size: bytes.length } },
    };
    streamState.plans.set(url, [{ bytes }]);
  }
  jsonState.table[MANIFEST_URL] = { files: fileMap };
}

function jreFiles() {
  return fs.readdirSync(jreState.dir);
}

beforeEach(() => {
  vi.clearAllMocks();
  osState.platform = 'linux';
  osState.arch = 'x64';
  jreState.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-jre-'));
  javaState.strict = null;
  javaState.probed = '21';
  javaState.satisfied = true;
  metaState.value = null;
  jsonState.table = {};
  streamState.plans = new Map();
  streamState.attempts = new Map();
  streamState.calls = new Map();
});

afterEach(() => {
  fs.rmSync(jreState.dir, { recursive: true, force: true });
});

describe('平台与组件映射', () => {
  it('平台 key 覆盖官方清单的取值，linux/arm64 没有对应产物', () => {
    expect(runtimePlatformKey('linux', 'x64')).toBe('linux');
    expect(runtimePlatformKey('linux', 'ia32')).toBe('linux-i386');
    expect(runtimePlatformKey('linux', 'arm64')).toBeNull();
    expect(runtimePlatformKey('win32', 'x64')).toBe('windows-x64');
    expect(runtimePlatformKey('win32', 'ia32')).toBe('windows-x86');
    expect(runtimePlatformKey('win32', 'arm64')).toBe('windows-arm64');
    expect(runtimePlatformKey('darwin', 'x64')).toBe('mac-os');
    expect(runtimePlatformKey('darwin', 'arm64')).toBe('mac-os-arm64');
    expect(runtimePlatformKey('freebsd', 'x64')).toBeNull();
  });

  it('主版本 → 组件只在取样范围内有值', () => {
    expect(javaComponentForMajor(8)).toBe('jre-legacy');
    expect(javaComponentForMajor(16)).toBe('java-runtime-alpha');
    expect(javaComponentForMajor(17)).toBe('java-runtime-gamma');
    expect(javaComponentForMajor(21)).toBe('java-runtime-delta');
    expect(javaComponentForMajor(25)).toBe('java-runtime-epsilon');
    expect(javaComponentForMajor(11)).toBeNull();
    expect(javaComponentForMajor('abc')).toBeNull();
  });
});

describe('ensureJavaRuntime', () => {
  it('已有满足要求的 Java → 直接返回，不触达上游、不推进度', async () => {
    javaState.strict = '/usr/lib/jvm/java-21/bin/java';
    const onProgress = vi.fn();
    await expect(ensureJavaRuntime('21', { onProgress })).resolves.toBe(
      '/usr/lib/jvm/java-21/bin/java',
    );
    expect(httpJson).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('不支持的平台 → 中文可操作错误，且不下载', async () => {
    osState.arch = 'arm64';
    await expect(ensureJavaRuntime('21')).rejects.toThrow(
      /无法自动准备 Java 21.*linux\/arm64.*自行安装 Java 21/,
    );
    expect(httpJson).not.toHaveBeenCalled();
  });

  it('缺 Java → 下载并落地到 var/jre/<major>/，逐文件校验且 bin/java 可执行', async () => {
    setupComponent({
      files: {
        'bin/java': 'fake-java-binary',
        'lib/modules': 'fake-modules',
        'lib/server/libjvm.so': 'fake-libjvm',
      },
    });
    const onProgress = vi.fn();

    const javaPath = await ensureJavaRuntime('21', { onProgress });

    expect(javaPath).toBe(path.join(jreState.dir, '21', 'bin', 'java'));
    expect(fs.readFileSync(javaPath, 'utf-8')).toBe('fake-java-binary');
    expect(fs.readFileSync(path.join(jreState.dir, '21', 'lib', 'modules'), 'utf-8')).toBe(
      'fake-modules',
    );
    if (os.platform() !== 'win32') {
      expect(fs.statSync(javaPath).mode & 0o111).not.toBe(0);
    }
    // staging 不残留；进度从 0 起步、以 1 收尾
    expect(jreFiles()).toEqual(['21']);
    expect(onProgress.mock.calls[0][0]).toBe(0);
    expect(onProgress.mock.calls.at(-1)[0]).toBe(1);
    expect(isJavaSatisfied).toHaveBeenCalledWith(path.join(jreState.dir, '21', 'bin', 'java'), 21);
  });

  it('文件 sha1 不匹配 → 校验失败且清理 staging', async () => {
    setupComponent({ files: { 'bin/java': 'fake-java-binary' } });
    const entry = jsonState.table[MANIFEST_URL].files['bin/java'];
    entry.downloads.raw.sha1 = 'deadbeef';

    await expect(ensureJavaRuntime('21')).rejects.toThrow(/运行时文件校验失败/);
    expect(jreFiles()).toEqual([]);
  });

  it('清单含路径穿越键 → 拒绝，且不写到临时目录之外', async () => {
    setupComponent({ files: { '../evil.txt': 'pwned' } });
    await expect(ensureJavaRuntime('21')).rejects.toThrow(/不安全路径/);
    expect(fs.existsSync(path.join(jreState.dir, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(jreState.dir), 'evil.txt'))).toBe(false);
    expect(jreFiles()).toEqual([]);
  });

  it('真实清单形状（file/directory/link 三类）：合法相对链接按原样复刻，安装成功', async () => {
    setupComponent({
      files: {
        bin: { type: 'directory' },
        'bin/java': 'fake-java-binary',
        'legal/java.base': { type: 'directory' },
        'legal/java.base/LICENSE': 'license-text',
        'legal/java.compiler': { type: 'directory' },
        'legal/java.compiler/LICENSE': { type: 'link', target: '../java.base/LICENSE' },
      },
    });

    const javaPath = await ensureJavaRuntime('21');

    const linkPath = path.join(jreState.dir, '21', 'legal', 'java.compiler', 'LICENSE');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // 目标必须原样保留相对字符串：解析成绝对路径后同一份 JRE 换目录就失效
    expect(fs.readlinkSync(linkPath)).toBe('../java.base/LICENSE');
    expect(fs.readFileSync(linkPath, 'utf-8')).toBe('license-text');
    expect(fs.readFileSync(javaPath, 'utf-8')).toBe('fake-java-binary');
  });

  it('link 目标解析后越出安装根 → 拒绝并清理 staging', async () => {
    setupComponent({
      files: {
        'bin/java': 'fake-java-binary',
        'legal/LICENSE': { type: 'link', target: '../../etc/passwd' },
      },
    });
    await expect(ensureJavaRuntime('21')).rejects.toThrow(/指向安装目录之外/);
    expect(jreFiles()).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(jreState.dir), 'etc', 'passwd'))).toBe(false);
  });

  it('link 目标为绝对路径 → 拒绝（绝对目标直接逃出安装根）', async () => {
    setupComponent({
      files: {
        'bin/java': 'fake-java-binary',
        'legal/LICENSE': { type: 'link', target: '/etc/passwd' },
      },
    });
    await expect(ensureJavaRuntime('21')).rejects.toThrow(/指向安装目录之外/);
    expect(jreFiles()).toEqual([]);
  });

  it('未知条目类型（如 fifo）→ 仍按不支持拒绝', async () => {
    setupComponent({ files: { 'bin/java': 'fake-java-binary', 'bin/fifo': { type: 'fifo' } } });
    await expect(ensureJavaRuntime('21')).rejects.toThrow(/不支持的条目/);
    expect(jreFiles()).toEqual([]);
  });

  it('悬空 link（目标文件不在清单里）不阻断安装：读不到根外内容', async () => {
    setupComponent({
      files: {
        'bin/java': 'fake-java-binary',
        'legal/java.compiler/LICENSE': { type: 'link', target: '../java.base/MISSING' },
      },
    });

    await ensureJavaRuntime('21');

    const linkPath = path.join(jreState.dir, '21', 'legal', 'java.compiler', 'LICENSE');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe('../java.base/MISSING');
  });

  it('单个文件响应体中断 → 自动重试该文件一次后成功', async () => {
    setupComponent({ files: { 'bin/java': 'fake-java-binary' } });
    const url = jsonState.table[MANIFEST_URL].files['bin/java'].downloads.raw.url;
    streamState.plans.set(url, [
      { error: new Error('socket hang up') },
      { bytes: Buffer.from('fake-java-binary') },
    ]);

    const javaPath = await ensureJavaRuntime('21');

    expect(fs.readFileSync(javaPath, 'utf-8')).toBe('fake-java-binary');
    expect(streamState.calls.get(url)).toBe(2);
  });

  it('装完实测主版本不符 → 报错并清理 staging', async () => {
    setupComponent({ files: { 'bin/java': 'fake-java-binary' } });
    javaState.probed = '17';

    await expect(ensureJavaRuntime('21')).rejects.toThrow(/版本校验失败（实际 17）/);
    expect(jreFiles()).toEqual([]);
  });

  it('装完面板扫描不到 → 报错（下齐了但选不到不能算成功）', async () => {
    setupComponent({ files: { 'bin/java': 'fake-java-binary' } });
    javaState.satisfied = false;

    await expect(ensureJavaRuntime('21')).rejects.toThrow(/已下载但面板未能识别/);
  });

  it('组件优先取版本元数据的权威值', async () => {
    metaState.value = { component: 'java-runtime-gamma', majorVersion: 17 };
    setupComponent({ component: 'java-runtime-gamma', files: { 'bin/java': 'fake-java-17' } });
    javaState.probed = '17';

    await expect(ensureJavaRuntime('17', { mcVersion: '1.20.4' })).resolves.toBe(
      path.join(jreState.dir, '17', 'bin', 'java'),
    );
    expect(resolveVanillaJavaRuntime).toHaveBeenCalledWith('1.20.4');
  });

  it('元数据主版本与要求不一致 → 退回主版本表（以 jar 要求的版本为准）', async () => {
    metaState.value = { component: 'java-runtime-gamma', majorVersion: 17 };
    setupComponent({ component: 'java-runtime-delta', files: { 'bin/java': 'fake-java-21' } });

    await expect(ensureJavaRuntime('21', { mcVersion: '1.20.4' })).resolves.toBe(
      path.join(jreState.dir, '21', 'bin', 'java'),
    );
  });

  it('同主版本并发只下载一次', async () => {
    setupComponent({ files: { 'bin/java': 'fake-java-binary' } });
    const [a, b] = await Promise.all([ensureJavaRuntime('21'), ensureJavaRuntime('21')]);
    const manifestCalls = httpJson.mock.calls.filter(([url]) => url === JAVA_RUNTIME_MANIFEST_URL);
    expect(manifestCalls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('清单里没有该平台的组件 → 中文可操作错误', async () => {
    jsonState.table[JAVA_RUNTIME_MANIFEST_URL] = { linux: {} };
    await expect(ensureJavaRuntime('21')).rejects.toThrow(/没有 linux 平台的 java-runtime-delta/);
  });

  it('本机一档可用 Java 都没有 → 进入下载分支（检测器判空由 java-detector 用例锁定）', async () => {
    // javaState.strict = null 是检测器对空机器的结论（真实实现见 java-detector.test.js
    // 「空文件树」用例），这里验证调用方据此真的去下载，而不是回落系统 java
    javaState.strict = null;
    setupComponent({ files: { 'bin/java': 'fake-java-binary' } });

    const javaPath = await ensureJavaRuntime('21');

    expect(httpJson.mock.calls.some(([url]) => url === JAVA_RUNTIME_MANIFEST_URL)).toBe(true);
    expect(javaPath).toBe(path.join(jreState.dir, '21', 'bin', 'java'));
  });
});
