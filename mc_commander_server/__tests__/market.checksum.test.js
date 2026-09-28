/**
 * 市场安装 sha512 完整性校验测试（issue 537）
 *
 * 网络隔离：got 全量 mock（与 market.test.js 同范式）。
 * - 元数据 .json 链：fixture 直接内联真实 hashes.sha512（对 JAR 字节预计算）
 * - got.stream(...)：推送真实 zip 字节（adm-zip 产物）
 *
 * 核心场景（行为级，真实字节流）：
 * - 哈希比对通过 → 放行落盘
 * - 篡改 1 字节后预计算的哈希 vs 原始字节 → 不匹配拒绝（40014），临时文件清理
 * - 上游缺 hashes → 降级放行（不新增阻断面）+ logger.info 留痕
 * - 大小写归一：官方哈希大写形式也能比对通过（Modrinth 实际下发小写 hex）
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Readable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';

vi.mock('got', () => {
  const gotFn = vi.fn();
  gotFn.stream = vi.fn();
  return { default: gotFn };
});

import got from 'got';
import {
  getMarketProjectVersions,
  installPluginFromMarket,
  clearMarketCache,
} from '../services/market.service.js';
import { ErrorCodes } from '../utils/response.js';
import { logger } from '../utils/logger.js';

// ── fixture ──────────────────────────────────────────────────────────

const SLUG = 'essentialsx';
const FILENAME = 'ess.jar';
const URL = 'https://cdn.modrinth.com/data/x/versions/a/ess.jar';

function jarBytes(yml) {
  const zip = new AdmZip();
  zip.addFile('plugin.yml', Buffer.from(yml, 'utf8'));
  return zip.toBuffer();
}

const JAR = jarBytes(
  'name: EssentialsX\nversion: 2.21.0\nmain: net.essentialsx.Essentials\napi-version: "1.21"\n',
);
const JAR_SHA512 = crypto.createHash('sha512').update(JAR).digest('hex');
// 篡改 1 字节后的产物哈希：精确复刻「位翻转即拒绝」的供应链污染场景
const TAMPERED = Buffer.from(JAR);
TAMPERED[20] ^= 0x01;
const TAMPERED_SHA512 = crypto.createHash('sha512').update(TAMPERED).digest('hex');

function versionsFixture(sha512) {
  return [
    {
      name: 'EssentialsX 2.21.0',
      version_number: '2.21.0',
      version_type: 'release',
      changelog: null,
      date_published: '2026-01-01T00:00:00Z',
      downloads: 1,
      game_versions: ['1.21.4'],
      loaders: ['paper'],
      files: [
        {
          url: URL,
          filename: FILENAME,
          primary: true,
          size: JAR.length,
          ...(sha512 === undefined ? {} : { hashes: { sha512 } }),
        },
      ],
    },
  ];
}

function mockJsonResponse(fixture) {
  return { json: async () => fixture };
}

function streamFrom(bytes) {
  return Readable.from([bytes]);
}

/** 组装一次安装的上游 mock：元数据 1 次 + CDN 流 1 次（推送真实 JAR 字节） */
function mockUpstream(sha512) {
  vi.mocked(got).mockReturnValueOnce(mockJsonResponse(versionsFixture(sha512)));
  vi.mocked(got.stream).mockReturnValueOnce(streamFrom(JAR));
}

// ── 临时实例目录 ─────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-market-checksum-'));
const serverPath = path.join(tmpRoot, 'inst1');
const pluginsDir = path.join(serverPath, 'plugins');

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  clearMarketCache();
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

function tmpLeftovers() {
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('.market-download.tmp-'));
}

// ── 版本映射透传 ─────────────────────────────────────────────────────

describe('getMarketProjectVersions - hashes.sha512 透传（issue 537）', () => {
  it('上游提供 hashes.sha512 → file.sha512 原样透传', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(versionsFixture(JAR_SHA512)));

    const { versions } = await getMarketProjectVersions(SLUG);
    expect(versions).toHaveLength(1);
    expect(versions[0].file.sha512).toBe(JAR_SHA512);
    expect(versions[0].file.url).toBe(URL);
  });

  it('上游缺 hashes 字段 / hashes 非 string → file.sha512 置 null（不炸）', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(versionsFixture(undefined)));
    const missing = await getMarketProjectVersions(SLUG);
    expect(missing.versions[0].file.sha512).toBeNull();

    clearMarketCache();
    const fixture = versionsFixture(undefined);
    fixture[0].files[0].hashes = { sha512: 12345 }; // 非法类型
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(fixture));
    const invalid = await getMarketProjectVersions(SLUG);
    expect(invalid.versions[0].file.sha512).toBeNull();
  });
});

// ── 安装链完整性闸门 ─────────────────────────────────────────────────

describe('installPluginFromMarket - sha512 完整性校验（issue 537）', () => {
  it('哈希比对通过 → 放行落盘（官方哈希大写形式亦归一通过）', async () => {
    mockUpstream(JAR_SHA512.toUpperCase());

    const result = await installPluginFromMarket(serverPath, {
      slug: SLUG,
      versionNumber: '2.21.0',
    });

    expect(result).toMatchObject({
      file: FILENAME,
      slug: SLUG,
      versionNumber: '2.21.0',
      source: 'modrinth',
    });
    expect(fs.existsSync(path.join(pluginsDir, FILENAME))).toBe(true);
    expect(fs.readFileSync(path.join(pluginsDir, FILENAME))).toEqual(JAR);
    expect(tmpLeftovers()).toHaveLength(0);
  });

  it('篡改 1 字节哈希不匹配 → 40014 拒绝安装，文案含文件名不含哈希，临时文件已清理', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    mockUpstream(TAMPERED_SHA512);

    await expect(
      installPluginFromMarket(serverPath, { slug: SLUG, versionNumber: '2.21.0' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MARKET_CHECKSUM_MISMATCH.code,
      status: 400,
      message: `File integrity check failed: ${FILENAME}`,
    });

    // 拒绝路径：目标文件不存在、无降级留痕、无临时文件残留
    expect(fs.existsSync(pluginsDir)).toBe(false);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(tmpLeftovers()).toHaveLength(0);
    infoSpy.mockRestore();
  });

  it('上游缺 hashes → 降级放行（现有行为），logger.info 留痕', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    mockUpstream(undefined);

    const result = await installPluginFromMarket(serverPath, {
      slug: SLUG,
      versionNumber: '2.21.0',
    });

    expect(result.source).toBe('modrinth');
    expect(fs.existsSync(path.join(pluginsDir, FILENAME))).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toContain(FILENAME);
    expect(infoSpy.mock.calls[0][0]).toContain('sha512');
    infoSpy.mockRestore();
  });
});
