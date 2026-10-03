/**
 * market.service.js 分支补测（issue 518：缓存行为/下载安全臂/清洗回退/错误翻译）
 *
 * 范式与 market.test.js 同构：http-client 全量 mock（离线语义），本文件聚焦既有用例
 * 未触达的分支面——cacheGet 过期清理臂、cacheSet 近似 LRU 淘汰、下载超限中断流、
 * tmp dir 创建失败、文件名清洗 fallback 双臂、translateUpstreamError 非常规臂。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../utils/http-client.js', () => ({
  httpJson: vi.fn(),
  httpStream: vi.fn(),
  httpPost: vi.fn(),
}));

import { httpJson, httpStream } from '../utils/http-client.js';
import {
  searchMarketPlugins,
  getMarketProjectVersions,
  installPluginFromMarket,
  downloadMarketFile,
  sanitizeMarketFileName,
  clearMarketCache,
} from '../services/market.service.js';
import { AppError, ErrorCodes } from '../utils/response.js';

const SEARCH_FIXTURE = {
  total_hits: 1,
  hits: [
    {
      project_id: 'abc',
      slug: 'demo',
      title: 'Demo',
      description: 'd',
      author: 'a',
      downloads: 1,
      follows: 0,
      icon_url: null,
      date_modified: null,
      display_categories: [],
      server_side: null,
      client_side: null,
    },
  ],
};

describe('market.service 分支补测', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMarketCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('缓存行为（cacheGet 过期清理 + cacheSet 近似 LRU 淘汰）', () => {
    it('TTL 过期条目被清理并重新请求上游（cacheGet 过期臂）', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      httpJson.mockResolvedValue(SEARCH_FIXTURE);

      await searchMarketPlugins({ query: 'cache-exp' });
      expect(httpJson).toHaveBeenCalledTimes(1);

      // 未过期：命中缓存
      const hit = await searchMarketPlugins({ query: 'cache-exp' });
      expect(hit.cached).toBe(true);
      expect(httpJson).toHaveBeenCalledTimes(1);

      // 越过 60s TTL：过期条目删除 → 重新请求
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      const refetched = await searchMarketPlugins({ query: 'cache-exp' });
      expect(refetched.cached).toBe(false);
      expect(httpJson).toHaveBeenCalledTimes(2);
    });

    it('容量 200：未满不淘汰，满后触发近似 LRU（最早过期条目出局）', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      httpJson.mockResolvedValue(SEARCH_FIXTURE);

      // 填满 200 条（CACHE_MAX_ENTRIES）
      for (let i = 0; i < 200; i++) {
        await searchMarketPlugins({ query: `lru-${i}` });
      }
      expect(httpJson).toHaveBeenCalledTimes(200);

      // 容量恰好未超：最早条目仍在缓存（命中不增请求）
      const oldestHit = await searchMarketPlugins({ query: 'lru-0' });
      expect(oldestHit.cached).toBe(true);
      expect(httpJson).toHaveBeenCalledTimes(200);

      // 第 201 条：触发淘汰循环，删除最早过期条目（lru-0）
      await searchMarketPlugins({ query: 'lru-200' });
      expect(httpJson).toHaveBeenCalledTimes(201);

      // 次早条目仍命中（证明只淘汰一个最早者）
      const survivor = await searchMarketPlugins({ query: 'lru-1' });
      expect(survivor.cached).toBe(true);
      expect(httpJson).toHaveBeenCalledTimes(201);

      // 被淘汰条目重新请求（miss）；重插本身占满容量，再淘汰下一个最早者（lru-1）
      const evicted = await searchMarketPlugins({ query: 'lru-0' });
      expect(evicted.cached).toBe(false);
      expect(httpJson).toHaveBeenCalledTimes(202);
      const reEvicted = await searchMarketPlugins({ query: 'lru-1' });
      expect(reEvicted.cached).toBe(false);
      expect(httpJson).toHaveBeenCalledTimes(203);
    });
  });

  describe('downloadMarketFile 安全臂', () => {
    const tmpUploadsDir = path.join(os.tmpdir(), 'mc-commander-uploads');

    it('非 CDN 白名单 URL → 50301 且不创建临时文件', async () => {
      await expect(downloadMarketFile('https://evil.example.com/x.jar')).rejects.toMatchObject({
        code: 50301,
      });
      expect(httpStream).not.toHaveBeenCalled();
    });

    it('tmp dir 创建失败 → 50000 SERVER_ERROR（附失败原因）', async () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      await expect(downloadMarketFile('https://cdn.modrinth.com/x.jar')).rejects.toMatchObject({
        code: ErrorCodes.SERVER_ERROR.code,
        message: expect.stringContaining('Failed to create tmp dir: disk full'),
      });
      expect(httpStream).not.toHaveBeenCalled();
      mkdirSpy.mockRestore();
    });

    it('流式超限（>100MB）：计数中间层断流 → 50301 且半成品清理', async () => {
      const before = new Set(fs.existsSync(tmpUploadsDir) ? fs.readdirSync(tmpUploadsDir) : []);
      httpStream.mockImplementation(() => {
        const src = new PassThrough();
        (async () => {
          try {
            const chunk = Buffer.alloc(1_048_576, 0x41); // 1MB
            for (let i = 0; i < 102 && !src.destroyed; i++) src.write(chunk);
            if (!src.destroyed) src.end();
          } catch {
            /* 下游断流后的写入可忽略 */
          }
        })();
        return src;
      });

      await expect(downloadMarketFile('https://cdn.modrinth.com/big.jar')).rejects.toMatchObject({
        code: 50301,
        message: expect.stringContaining('exceeds download size limit (100MB)'),
      });

      // 半成品清理：无新增 .market-download.tmp-* 残留
      const after = fs.readdirSync(tmpUploadsDir);
      const leftovers = after.filter(
        (f) => f.startsWith('.market-download.tmp-') && !before.has(f),
      );
      expect(leftovers).toEqual([]);
    });
  });

  describe('sanitizeMarketFileName 回退臂（导出函数直测）', () => {
    const opts = { slug: 'essentialsx', versionNumber: '2.21.0' };

    it('basename 提取：正斜杠与反斜杠路径均取末段', () => {
      expect(sanitizeMarketFileName('dir/sub/My Plugin (1).jar', opts)).toBe('My-Plugin-1.jar');
      expect(sanitizeMarketFileName('dir\\back\\file.jar', opts)).toBe('file.jar');
    });

    it('非字母数字开头补 mc- 前缀（满足上传白名单首字符要求）', () => {
      expect(sanitizeMarketFileName('-weird.jar', opts)).toBe('mc--weird.jar');
    });

    it('空/全白名单外字符文件名 → slug-version.jar 回退名', () => {
      expect(sanitizeMarketFileName(null, opts)).toBe('essentialsx-2.21.0.jar');
      expect(sanitizeMarketFileName('', opts)).toBe('essentialsx-2.21.0.jar');
      expect(sanitizeMarketFileName(';;;', opts)).toBe('essentialsx-2.21.0.jar');
    });

    it('净化后无 .jar 后缀 → 最终白名单校验失败走回退（终检臂）', () => {
      expect(sanitizeMarketFileName('readme.txt', opts)).toBe('essentialsx-2.21.0.jar');
    });

    it('超长文件名（>255）→ 回退（长度臂）', () => {
      expect(sanitizeMarketFileName(`${'a'.repeat(300)}.jar`, opts)).toBe('essentialsx-2.21.0.jar');
    });

    it('slug/versionNumber 全非法 → 二级回退 modrinth-plugin.jar', () => {
      expect(sanitizeMarketFileName(null, { slug: ';;;', versionNumber: ';;;' })).toBe(
        'modrinth-plugin.jar',
      );
    });
  });

  describe('translateUpstreamError 非常规臂（经 search 间接驱动）', () => {
    // httpJson 契约：上游失败以 reject 到达（无 .json() 链），mock 需返回被拒的 Promise
    it('AppError 原样透传（不换码不换语义）', async () => {
      const passthrough = new AppError(ErrorCodes.RATE_LIMITED, 'rate limited');
      httpJson.mockImplementation(async () => {
        throw passthrough;
      });

      await expect(searchMarketPlugins({ query: 'x' })).rejects.toMatchObject({
        code: 42900,
        message: 'rate limited',
      });
    });

    it('search 404：notFoundCode 亦为 50301（搜索域无独立 404 码）', async () => {
      const notFound = Object.assign(new Error('HTTPError'), { response: { statusCode: 404 } });
      httpJson.mockImplementation(async () => {
        throw notFound;
      });

      await expect(searchMarketPlugins({ query: 'x' })).rejects.toMatchObject({
        code: 50301,
        message: 'Not found on Modrinth',
      });
    });

    it('普通错误 → 50301 携带原始 message', async () => {
      httpJson.mockImplementation(async () => {
        throw new Error('boom');
      });

      await expect(searchMarketPlugins({ query: 'x' })).rejects.toMatchObject({
        code: 50301,
        message: 'Modrinth upstream error: boom',
      });
    });

    it('无 message 异常 → 50301 兜底 unknown', async () => {
      httpJson.mockImplementation(async () => {
        throw {};
      });

      await expect(searchMarketPlugins({ query: 'x' })).rejects.toMatchObject({
        code: 50301,
        message: 'Modrinth upstream error: unknown',
      });
    });
  });

  describe('installPluginFromMarket 补充臂', () => {
    it('版本 primary 文件 url 非 string → 40413「无可下载文件」且不发起下载', async () => {
      httpJson.mockResolvedValue([
        {
          version_number: '1.0.0',
          version_type: 'release',
          name: 'v1',
          files: [{ primary: true, filename: 'x.jar', url: 123 }], // url 非法 → 映射为 null
        },
      ]);

      await expect(
        installPluginFromMarket('/tmp/some-server', { slug: 'demo', versionNumber: '1.0.0' }),
      ).rejects.toMatchObject({
        code: ErrorCodes.MARKET_VERSION_NOT_FOUND.code,
        message: 'Version has no downloadable file',
      });
      expect(httpStream).not.toHaveBeenCalled();
    });
  });
});

// ── 更新检测域补测（comparePluginVersions / matchProjectByPluginName / checkPluginUpdates）──

vi.mock('../services/plugin.service.js', () => ({
  listPlugins: vi.fn(),
  uploadPlugin: vi.fn(),
}));

import { listPlugins } from '../services/plugin.service.js';
import { comparePluginVersions, checkPluginUpdates } from '../services/market.service.js';

const HIT_FIXTURE = {
  project_id: 'abc',
  slug: 'essentialsx',
  title: 'EssentialsX',
  description: 'd',
  author: 'a',
  downloads: 1,
  follows: 0,
  icon_url: null,
  date_modified: null,
  display_categories: [],
  server_side: null,
  client_side: null,
};
const VERSION_LATEST = [
  {
    version_number: '2.21.0',
    version_type: 'release',
    name: 'v2.21.0',
    files: [{ primary: true, filename: 'e.jar', url: 'https://cdn.modrinth.com/e.jar' }],
  },
];

const HIT_LIST = { total_hits: 1, hits: [HIT_FIXTURE] };

function routeUpstream({ search = HIT_LIST, versions = VERSION_LATEST } = {}) {
  // httpJson 是 async：mock 实现同样用 async，throw 即等价于 reject（与真实契约一致）
  return async (url) => {
    const u = String(url);
    if (u.includes('/search')) return search;
    if (u.includes('/version')) return versions;
    throw new Error(`unexpected upstream url: ${u}`);
  };
}

// 追加段位于顶层 describe 作用域外，需自带与顶层一致的 mock/缓存隔离
beforeEach(() => {
  vi.clearAllMocks();
  clearMarketCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('comparePluginVersions 单元（导出函数直测）', () => {
  it('前缀 v/V 与 build 元数据归一化后相等 → 0', () => {
    expect(comparePluginVersions('v1.0', '1.0+build.1')).toBe(0);
    expect(comparePluginVersions('V2.0', '2.0')).toBe(0);
    expect(comparePluginVersions(' 1.2.3 ', '1.2.3')).toBe(0);
  });

  it('空串/缺失侧：有值侧更大', () => {
    expect(comparePluginVersions('', '1.0')).toBe(-1);
    expect(comparePluginVersions('1.0', '')).toBe(1);
    expect(comparePluginVersions(null, '1.0')).toBe(-1);
    expect(comparePluginVersions(undefined, null)).toBe(0);
  });

  it('缺段补 0（2.0 == 2.0.0）；逐段数字比较', () => {
    expect(comparePluginVersions('2.0', '2.0.0')).toBe(0);
    expect(comparePluginVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(comparePluginVersions('1.10.0', '1.9.0')).toBe(1);
    expect(comparePluginVersions('3.0.0', '2.21.0')).toBe(1);
  });

  it('非数字段退化为字符串比较（保守报告）', () => {
    expect(comparePluginVersions('a.b', 'a.c')).toBe(-1);
    expect(comparePluginVersions('b.0', 'a.0')).toBe(1);
  });

  it('主段相等后 release > 预发布；同预发布按字典序', () => {
    expect(comparePluginVersions('1.0', '1.0-beta')).toBe(1);
    expect(comparePluginVersions('1.0-rc1', '1.0')).toBe(-1);
    expect(comparePluginVersions('1.0-alpha', '1.0-beta')).toBe(-1);
    expect(comparePluginVersions('1.0-beta', '1.0-alpha')).toBe(1);
  });
});

describe('checkPluginUpdates 行为级（更新检测域收口）', () => {
  const plugin = (overrides = {}) => ({
    file: 'EssentialsX.jar',
    meta: { name: 'EssentialsX', version: '2.20.0' },
    enabled: true,
    ...overrides,
  });

  it('命中且有新版：matched + updateAvailable + hasNewer 全量呈现', async () => {
    listPlugins.mockReturnValue({ plugins: [plugin()] });
    httpJson.mockImplementation(routeUpstream());

    const res = await checkPluginUpdates('/tmp/server');

    expect(res.results).toHaveLength(1);
    const r = res.results[0];
    expect(r.matched).toBe(true);
    expect(r.slug).toBe('essentialsx');
    expect(r.title).toBe('EssentialsX');
    expect(r.latestVersion).toBe('2.21.0');
    expect(r.updateAvailable).toBe(true);
    expect(r.hasNewer).toBe(true);
  });

  it('已最新 / 本地更新 / 上游无版本三条比对臂', async () => {
    listPlugins.mockReturnValue({
      plugins: [
        plugin({ file: 'a.jar', meta: { name: 'EssentialsX', version: '2.21.0' } }),
        plugin({ file: 'b.jar', meta: { name: 'NewerPlug', version: '3.0.0' } }),
        plugin({ file: 'c.jar', meta: { name: 'NoVer', version: '9.9.9' } }),
      ],
    });
    httpJson.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/search')) {
        // 三个插件名都能在结果里命中（slug 随插件名路由）
        return {
          total_hits: 3,
          hits: [
            HIT_FIXTURE,
            { ...HIT_FIXTURE, slug: 'newerplug', title: 'NewerPlug' },
            { ...HIT_FIXTURE, slug: 'nover', title: 'NoVer' },
          ],
        };
      }
      if (u.includes('/version')) {
        // nover 的版本列表为空 → latest null → cmp 0
        return u.includes('/project/nover/version') ? [] : VERSION_LATEST;
      }
      throw new Error('unexpected');
    });

    const res = await checkPluginUpdates('/tmp/server');
    const byFile = Object.fromEntries(res.results.map((r) => [r.file, r]));
    // 同版本：updateAvailable false 且 hasNewer false
    expect(byFile['a.jar'].updateAvailable).toBe(false);
    expect(byFile['a.jar'].hasNewer).toBe(false);
    // 本地比上游新：有差异但非「有新版」
    expect(byFile['b.jar'].updateAvailable).toBe(true);
    expect(byFile['b.jar'].hasNewer).toBe(false);
    // 上游空版本列表：latest null → cmp 0 → 无更新
    expect(byFile['c.jar'].matched).toBe(true);
    expect(byFile['c.jar'].latestVersion).toBeNull();
    expect(byFile['c.jar'].updateAvailable).toBe(false);
  });

  it('未命中（前 5 候选外/字段非法/名称差异）保持 matched:false', async () => {
    listPlugins.mockReturnValue({ plugins: [plugin()] });
    // 6 个候选均不匹配标题；匹配项排在第 6 位（超出审视窗口）
    const filler = (n) => ({ project_id: `p${n}`, slug: `other-${n}`, title: `Other ${n}` });
    httpJson.mockImplementation(
      routeUpstream({
        search: {
          total_hits: 6,
          hits: [filler(1), filler(2), filler(3), filler(4), filler(5), HIT_FIXTURE],
        },
      }),
    );

    const res = await checkPluginUpdates('/tmp/server');

    expect(res.results[0].matched).toBe(false);
    expect(res.results[0].slug).toBeNull();
  });

  it('slugify 命中：标题不同但 slug 归一化一致', async () => {
    listPlugins.mockReturnValue({
      plugins: [plugin({ meta: { name: 'Vault Unlocked', version: '1.0' } })],
    });
    httpJson.mockImplementation(
      routeUpstream({
        search: {
          total_hits: 1,
          hits: [{ ...HIT_FIXTURE, slug: 'VaultUnlocked', title: 'Totally Different' }],
        },
      }),
    );

    const res = await checkPluginUpdates('/tmp/server');

    expect(res.results[0].matched).toBe(true);
    expect(res.results[0].slug).toBe('VaultUnlocked');
  });

  it('候选字段非法被跳过后仍可命中后续项（continue 臂）', async () => {
    listPlugins.mockReturnValue({ plugins: [plugin()] });
    httpJson.mockImplementation(
      routeUpstream({
        search: { total_hits: 2, hits: [{ title: 42, slug: null }, HIT_FIXTURE] },
      }),
    );

    const res = await checkPluginUpdates('/tmp/server');

    expect(res.results[0].matched).toBe(true);
  });

  it('上游异常单插件失败不拖垮整批（catch 臂）', async () => {
    listPlugins.mockReturnValue({
      plugins: [
        plugin({ file: 'bad.jar', meta: { name: 'Boom', version: '1.0' } }),
        plugin({ file: 'good.jar', meta: { name: 'EssentialsX', version: '2.20.0' } }),
      ],
    });
    httpJson.mockImplementation(async (url, options) => {
      const u = String(url);
      if (u.includes('/search')) {
        // 按 query 区分（参数在 options.searchParams）：Boom → 抛错；EssentialsX → 正常
        if (options?.searchParams?.query === 'Boom') throw new Error('upstream 500');
        return HIT_LIST;
      }
      if (u.includes('/version')) return VERSION_LATEST;
      throw new Error('unexpected');
    });

    const res = await checkPluginUpdates('/tmp/server');
    const byFile = Object.fromEntries(res.results.map((r) => [r.file, r]));
    expect(byFile['bad.jar'].matched).toBe(false);
    expect(byFile['good.jar'].matched).toBe(true);
    expect(res.results).toHaveLength(2);
  });

  it('未启用插件被过滤；候选数上限 20 截断', async () => {
    const plugins = [
      plugin({ file: 'disabled.jar', enabled: false }),
      plugin({ file: 'nometa.jar', meta: {} }),
      ...Array.from({ length: 25 }, (_, i) =>
        plugin({ file: `p${i}.jar`, meta: { name: `Plug ${i}`, version: '1.0' } }),
      ),
    ];
    listPlugins.mockReturnValue({ plugins });
    httpJson.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/search')) {
        // 无候选命中（Plug i 不在 fixture）→ 全部 matched:false
        return { total_hits: 0, hits: [] };
      }
      throw new Error('unexpected');
    });

    const res = await checkPluginUpdates('/tmp/server');

    // 25 个候选截断为 20（disabled 与无 meta 名者不参与）
    expect(res.results).toHaveLength(20);
    expect(res.results.some((r) => r.file === 'disabled.jar')).toBe(false);
    expect(res.results.some((r) => r.file === 'nometa.jar')).toBe(false);
    expect(res.results.some((r) => r.file === 'p24.jar')).toBe(false);
    expect(res.results.some((r) => r.file === 'p4.jar')).toBe(true);
  });
});

describe('字段映射 null 臂与参数净化补充', () => {
  it('搜索结果字段缺失/类型非法 → 白名单归 null/0/[]', async () => {
    httpJson.mockResolvedValue({
      total_hits: 'not-number',
      hits: [
        {
          downloads: 'x',
          follows: 'x',
          display_categories: 'not-array',
          icon_url: 'http://insecure',
        },
      ],
    });

    const res = await searchMarketPlugins({ query: 'degenerate' });

    expect(res.totalHits).toBe(0); // total_hits 非数字 → 0
    const h = res.hits[0];
    expect(h.projectId).toBeNull();
    expect(h.slug).toBeNull();
    expect(h.title).toBeNull();
    expect(h.description).toBeNull();
    expect(h.author).toBeNull();
    expect(h.downloads).toBe(0);
    expect(h.follows).toBe(0);
    expect(h.iconUrl).toBeNull(); // 非 https → null
    expect(h.categories).toEqual([]); // 非数组 → []
  });

  it('版本结果字段缺失/类型非法 → 白名单归 null/0/[]', async () => {
    httpJson.mockResolvedValue([
      {
        version_number: 42,
        version_type: 'dev',
        name: 42,
        changelog: 42,
        downloads: 'x',
        game_versions: 'not-array',
        loaders: 'not-array',
        files: [],
      },
    ]);

    const res = await getMarketProjectVersions('demo', {});
    expect(res.versions).toEqual([]); // 无 primary 文件 → 过滤出局（映射分支已执行）
  });

  it('offset/limit 非法值回退默认（非整数/负值/超限）', async () => {
    httpJson.mockResolvedValue(SEARCH_FIXTURE);

    // 独立 query 隔离缓存键（同 query 同收敛参数会命中缓存不发请求）
    await searchMarketPlugins({ query: 'p1', offset: 1.5, limit: 0 });
    let params = httpJson.mock.calls[0][1].searchParams;
    expect(params.offset).toBe(0);
    expect(params.limit).toBe(20);

    await searchMarketPlugins({ query: 'p2', offset: -5, limit: 999 });
    params = httpJson.mock.calls[1][1].searchParams;
    expect(params.offset).toBe(0);
    expect(params.limit).toBe(20);

    await searchMarketPlugins({ query: 'p3', offset: 50_000, limit: 10 });
    params = httpJson.mock.calls[2][1].searchParams;
    expect(params.offset).toBe(10_000); // 上限收敛
    expect(params.limit).toBe(10);
  });

  it('fallback 名缺省：slug/versionNumber 均缺省 → plugin-file.jar', () => {
    expect(sanitizeMarketFileName(null, {})).toBe('plugin-file.jar');
  });

  it('下载流普通错误 → 包装 50301「Failed to download plugin」且半成品清理', async () => {
    const tmpUploadsDir = path.join(os.tmpdir(), 'mc-commander-uploads');
    const before = new Set(fs.existsSync(tmpUploadsDir) ? fs.readdirSync(tmpUploadsDir) : []);
    httpStream.mockImplementation(() => {
      const src = new PassThrough();
      process.nextTick(() => src.destroy(new Error('conn reset')));
      return src;
    });

    await expect(downloadMarketFile('https://cdn.modrinth.com/x.jar')).rejects.toMatchObject({
      code: 50301,
      message: expect.stringContaining('Failed to download plugin: conn reset'),
    });

    const after = fs.readdirSync(tmpUploadsDir);
    expect(after.filter((f) => f.startsWith('.market-download.tmp-') && !before.has(f))).toEqual(
      [],
    );
  });
});
