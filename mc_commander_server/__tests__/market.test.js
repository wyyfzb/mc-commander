/**
 * 插件市场服务测试（feat-8 延伸：Modrinth 代理 + 一键安装）
 *
 * 网络隔离：got 全量 mock（离线语义）。
 * - got(...)（元数据 .json 链）：按 URL 前缀路由到 fixture
 * - got.stream(...)（CDN 下载）：返回推送真实 zip 字节的可读流（adm-zip 产物）
 * 安装链路不做任何网络 mock 放行——落盘复用 uploadPlugin 的 zip 魔数/白名单校验，
 * 即测试里下载到临时目录的是"真 jar"。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Readable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

vi.mock('got', () => {
  const gotFn = vi.fn();
  gotFn.stream = vi.fn();
  return { default: gotFn };
});

import got from 'got';
import {
  searchMarketPlugins,
  getMarketProjectVersions,
  installPluginFromMarket,
  sanitizeMarketFileName,
  clearMarketCache,
} from '../services/market.service.js';
import { ErrorCodes } from '../utils/response.js';

// ── fixture ──────────────────────────────────────────────────────────

const SEARCH_FIXTURE = {
  total_hits: 140,
  hits: [
    {
      project_id: 'hXiIvTyT',
      slug: 'essentialsx',
      title: 'EssentialsX',
      description: 'The essential plugin suite for Minecraft servers',
      author: 'EssentialsX Team',
      downloads: 757014,
      follows: 100,
      icon_url: 'https://cdn.modrinth.com/icons/hXiIvTyT/icon.png',
      date_modified: '2026-01-01T00:00:00Z',
      display_categories: ['bukkit', 'paper', 'economy'],
      server_side: 'required',
      client_side: 'unsupported',
    },
    {
      project_id: 'bad',
      slug: 'weird-icon',
      title: 'Weird',
      description: 'x',
      author: 'a',
      downloads: 'not-a-number', // 非法类型 → 应归零
      follows: 0,
      icon_url: 'javascript:alert(1)', // 非 https → 应置 null
      date_modified: null,
      display_categories: ['paper', 42, null], // 非字符串 → 应被过滤
      server_side: null,
      client_side: null,
    },
  ],
};

const VERSIONS_FIXTURE = [
  {
    name: 'EssentialsX 2.21.0',
    version_number: '2.21.0',
    version_type: 'release',
    changelog: 'fix bugs',
    date_published: '2026-01-01T00:00:00Z',
    downloads: 12345,
    game_versions: ['1.21.4', '1.21.3'],
    loaders: ['paper', 'spigot', 'bukkit'],
    files: [
      {
        url: 'https://cdn.modrinth.com/data/hXiIvTyT/versions/SKQw/EssentialsX-2.21.0.jar',
        filename: 'EssentialsX-2.21.0.jar',
        primary: true,
        size: 4605977,
      },
    ],
  },
  {
    name: 'EssentialsX 2.20.1',
    version_number: '2.20.1',
    version_type: 'beta',
    changelog: null,
    date_published: '2025-06-01T00:00:00Z',
    downloads: 5,
    game_versions: ['1.20.4'],
    loaders: ['paper'],
    files: [], // 无文件 → 应被过滤（不可安装）
  },
];

function jarBytes(yml) {
  const zip = new AdmZip();
  zip.addFile('plugin.yml', Buffer.from(yml, 'utf8'));
  return zip.toBuffer();
}

function mockJsonResponse(fixture) {
  return { json: async () => fixture };
}

/**
 * 模拟 got(...).json() 链式拒绝：got v15 返回 promise-like（带 .json 方法），
 * 拒绝发生在 .json() 内部而非 got(...) 调用本身。
 * 若用 mockRejectedValueOnce，got(...) 返回原生 Promise，服务侧 .json() 访问
 * 会先触发 TypeError，被 catch 后错误形态失真（拿不到 response.statusCode）。
 */
function mockJsonRejection(err) {
  return { json: async () => { throw err; } };
}

/** 构造一个推送 bytes 后自动 end 的伪下载流 */
function streamFrom(bytes) {
  return Readable.from([bytes]);
}

// ── 临时实例目录 ─────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-market-'));
const serverPath = path.join(tmpRoot, 'inst1');
const pluginsDir = path.join(serverPath, 'plugins');

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // resetAllMocks（而非 clearAllMocks）：同时清掉上一用例残留的 once 队列与
  // 默认实现，避免 mockReturnValueOnce 未被消费导致的跨用例污染
  vi.resetAllMocks();
  clearMarketCache();
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

// ── searchMarketPlugins ──────────────────────────────────────────────

describe('market.service - searchMarketPlugins', () => {
  it('搜索：组装 facets（project_type=plugin）并映射字段白名单', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(SEARCH_FIXTURE));

    const result = await searchMarketPlugins({ query: 'essentials' });

    expect(got).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(got).mock.calls[0];
    expect(url).toBe('https://api.modrinth.com/v2/search');
    const facets = JSON.parse(opts.searchParams.facets);
    expect(facets).toEqual([['project_type:plugin']]);
    expect(opts.searchParams.query).toBe('essentials');
    expect(opts.headers['User-Agent']).toContain('MC_Commander');

    expect(result.totalHits).toBe(140);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({
      slug: 'essentialsx',
      title: 'EssentialsX',
      downloads: 757014,
      iconUrl: 'https://cdn.modrinth.com/icons/hXiIvTyT/icon.png',
      categories: ['bukkit', 'paper', 'economy'],
    });
    // 第二条：类型清洗（downloads 归零 / 非法 icon 置 null / categories 过滤）
    expect(result.hits[1].downloads).toBe(0);
    expect(result.hits[1].iconUrl).toBeNull();
    expect(result.hits[1].categories).toEqual(['paper']);
    expect(result.cached).toBe(false);
  });

  it('版本/加载器过滤进入 facets；命中 60s TTL 缓存时不再请求上游', async () => {
    vi.mocked(got).mockReturnValue(mockJsonResponse(SEARCH_FIXTURE));

    await searchMarketPlugins({ query: 'ess', gameVersion: '1.21.4', loader: 'paper' });
    const [, opts] = vi.mocked(got).mock.calls[0];
    const facets = JSON.parse(opts.searchParams.facets);
    expect(facets).toContainEqual(['game_versions:1.21.4']);
    expect(facets).toContainEqual(['loaders:paper']);

    // 相同参数第二次：缓存命中，got 不再调用
    const again = await searchMarketPlugins({ query: 'ess', gameVersion: '1.21.4', loader: 'paper' });
    expect(got).toHaveBeenCalledTimes(1);
    expect(again.cached).toBe(true);
  });

  it('空关键词浏览模式：index=downloads 且不带 query 参数', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(SEARCH_FIXTURE));

    await searchMarketPlugins({ query: '' });
    const [, opts] = vi.mocked(got).mock.calls[0];
    expect(opts.searchParams.index).toBe('downloads');
    expect(opts.searchParams.query).toBeUndefined();
  });

  it('非法参数：超长查询 / 非法加载器 / 非法版本号 → 40000', async () => {
    await expect(searchMarketPlugins({ query: 'x'.repeat(101) })).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
    await expect(searchMarketPlugins({ query: 'ok', loader: 'fabric' })).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
    await expect(searchMarketPlugins({ query: 'ok', gameVersion: '1.21.x' })).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
    await expect(searchMarketPlugins({ query: 123 })).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
    expect(got).not.toHaveBeenCalled();
  });

  it('上游 500 → 50301 MARKET_UPSTREAM_ERROR（保留 502 语义）', async () => {
    const err = new Error('boom');
    err.response = { statusCode: 500 };
    vi.mocked(got).mockReturnValueOnce(mockJsonRejection(err));

    await expect(searchMarketPlugins({ query: 'ess' })).rejects.toMatchObject({
      code: ErrorCodes.MARKET_UPSTREAM_ERROR.code,
      status: 502,
    });
  });
});

// ── getMarketProjectVersions ─────────────────────────────────────────

describe('market.service - getMarketProjectVersions', () => {
  it('版本列表：映射 primary 文件，过滤无可下载文件的版本', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(VERSIONS_FIXTURE));

    const { projectSlug, versions } = await getMarketProjectVersions('essentialsx');

    expect(projectSlug).toBe('essentialsx');
    expect(got).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(got).mock.calls[0];
    expect(url).toBe('https://api.modrinth.com/v2/project/essentialsx/version');

    // 2.20.1 无 files → 被过滤，只剩 2.21.0
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      versionNumber: '2.21.0',
      versionType: 'release',
      loaders: ['paper', 'spigot', 'bukkit'],
    });
    expect(versions[0].file.url).toContain('cdn.modrinth.com');
    expect(versions[0].file.filename).toBe('EssentialsX-2.21.0.jar');
  });

  it('项目不存在（404）→ 40412 MARKET_PROJECT_NOT_FOUND', async () => {
    const err = new Error('not found');
    err.response = { statusCode: 404 };
    vi.mocked(got).mockReturnValueOnce(mockJsonRejection(err));

    await expect(getMarketProjectVersions('ghost-project')).rejects.toMatchObject({
      code: ErrorCodes.MARKET_PROJECT_NOT_FOUND.code,
      status: 404,
    });
  });

  it('非法 slug → 40000（不发请求）', async () => {
    await expect(getMarketProjectVersions('../etc')).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
    expect(got).not.toHaveBeenCalled();
  });
});

// ── sanitizeMarketFileName ───────────────────────────────────────────

describe('market.service - sanitizeMarketFileName', () => {
  it('常规文件名原样保留', () => {
    expect(sanitizeMarketFileName('EssentialsX-2.21.0.jar', { slug: 'essentialsx', versionNumber: '2.21.0' }))
      .toBe('EssentialsX-2.21.0.jar');
  });

  it('空格折叠为 -、白名单外字符删除、扩展名统一小写', () => {
    expect(sanitizeMarketFileName('My Plugin (v1).jar', { slug: 'my-plugin', versionNumber: '1' }))
      .toBe('My-Plugin-v1.jar');
    expect(sanitizeMarketFileName('Plugin..JAR', { slug: 'p', versionNumber: '1' }))
      .toBe('Plugin..jar'); // 大写扩展名统一为小写，满足上传白名单
    expect(sanitizeMarketFileName('../../etc/passwd.jar', { slug: 'p', versionNumber: '1' }))
      .toBe('passwd.jar'); // basename 防路径逃逸
  });

  it('回退名：空/全非法字符输入 → slug-version.jar（回退名同样净化）', () => {
    expect(sanitizeMarketFileName('', { slug: 'ess', versionNumber: '2.0' })).toBe('ess-2.0.jar');
    expect(sanitizeMarketFileName('???', { slug: 'ess', versionNumber: '2.0+build.1' })).toBe('ess-2.0build.1.jar');
    // 全非法回退 → 终极兜底
    expect(sanitizeMarketFileName('///', { slug: '??', versionNumber: '+' })).toBe('modrinth-plugin.jar');
  });
});

// ── installPluginFromMarket（安装全链路，真实 zip 字节）───────────────

describe('market.service - installPluginFromMarket', () => {
  const JAR = jarBytes('name: EssentialsX\nversion: 2.21.0\nmain: net.essentialsx.Essentials\napi-version: "1.21"\n');

  function mockUpstream({ versionNumber = '2.21.0', url = 'https://cdn.modrinth.com/data/x/versions/a/ess.jar', filename = 'ess.jar', bytes = JAR } = {}) {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(VERSIONS_FIXTURE.map((v) => ({
      ...v,
      version_number: versionNumber,
      files: [{ url, filename, primary: true, size: bytes.length }],
    }))));
    vi.mocked(got.stream).mockReturnValueOnce(streamFrom(bytes));
  }

  it('安装成功：下载→魔数校验→落盘→元数据读取→返回市场字段', async () => {
    mockUpstream({ filename: 'EssentialsX-2.21.0.jar' });

    const result = await installPluginFromMarket(serverPath, { slug: 'essentialsx', versionNumber: '2.21.0' });

    // 上游调用：versions 元数据 1 次 + stream 下载 1 次
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.stream).toHaveBeenCalledTimes(1);
    const [streamUrl, streamOpts] = vi.mocked(got.stream).mock.calls[0];
    expect(streamUrl).toBe('https://cdn.modrinth.com/data/x/versions/a/ess.jar');
    expect(streamOpts.headers['User-Agent']).toContain('MC_Commander');

    expect(result).toMatchObject({
      file: 'EssentialsX-2.21.0.jar',
      slug: 'essentialsx',
      versionNumber: '2.21.0',
      source: 'modrinth',
      overwritten: false,
    });
    expect(result.meta).toMatchObject({ name: 'EssentialsX', version: '2.21.0' });
    expect(fs.existsSync(path.join(pluginsDir, 'EssentialsX-2.21.0.jar'))).toBe(true);
    // 临时下载文件已清理
    const tmpFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('.market-download.tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('同名冲突默认 40912；overwrite=true 覆盖并返回 overwritten=true', async () => {
    mockUpstream();
    await installPluginFromMarket(serverPath, { slug: 'essentialsx', versionNumber: '2.21.0' });

    // 不带 overwrite → 40912
    mockUpstream();
    await expect(
      installPluginFromMarket(serverPath, { slug: 'essentialsx', versionNumber: '2.21.0' }),
    ).rejects.toMatchObject({ code: ErrorCodes.PLUGIN_FILE_EXISTS.code });

    // overwrite=true → 200 语义 overwritten
    mockUpstream();
    const result = await installPluginFromMarket(
      serverPath, { slug: 'essentialsx', versionNumber: '2.21.0' }, { overwrite: true },
    );
    expect(result.overwritten).toBe(true);
  });

  it('下载 URL 非 Modrinth CDN 白名单 → 50301（SSRF/任意下载防护，不落盘）', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse([{
      ...VERSIONS_FIXTURE[0],
      files: [{ url: 'https://evil.example.com/payload.jar', filename: 'evil.jar', primary: true, size: 1 }],
    }]));
    // stream 不应被调用
    await expect(
      installPluginFromMarket(serverPath, { slug: 'essentialsx', versionNumber: '2.21.0' }),
    ).rejects.toMatchObject({ code: ErrorCodes.MARKET_UPSTREAM_ERROR.code, status: 502 });
    expect(got.stream).not.toHaveBeenCalled();
    expect(fs.existsSync(pluginsDir)).toBe(false);
  });

  it('版本不存在 → 40413 MARKET_VERSION_NOT_FOUND；非法 slug/版本号 → 40000', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(VERSIONS_FIXTURE));
    await expect(
      installPluginFromMarket(serverPath, { slug: 'essentialsx', versionNumber: '9.9.9' }),
    ).rejects.toMatchObject({ code: ErrorCodes.MARKET_VERSION_NOT_FOUND.code });

    await expect(
      installPluginFromMarket(serverPath, { slug: '../x', versionNumber: '1.0' }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
    await expect(
      installPluginFromMarket(serverPath, { slug: 'essentialsx', versionNumber: '' }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
  });

  it('下载中断（流错误）→ 50301 且无残留临时文件/目标文件', async () => {
    vi.mocked(got).mockReturnValueOnce(mockJsonResponse(VERSIONS_FIXTURE));
    const badStream = new Readable({
      read() {
        process.nextTick(() => this.destroy(new Error('connection reset')));
      },
    });
    vi.mocked(got.stream).mockReturnValueOnce(badStream);

    await expect(
      installPluginFromMarket(serverPath, { slug: 'essentialsx', versionNumber: '2.21.0' }),
    ).rejects.toMatchObject({ code: ErrorCodes.MARKET_UPSTREAM_ERROR.code });
    const tmpFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('.market-download.tmp-'));
    expect(tmpFiles).toHaveLength(0);
    expect(fs.existsSync(path.join(pluginsDir, 'ess.jar'))).toBe(false);
  });
});
