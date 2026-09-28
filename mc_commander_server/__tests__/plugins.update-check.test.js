/**
 * 插件更新检测测试（延伸：已装插件 vs Modrinth 最新版）
 * - comparePluginVersions：semver 主段/缺段补零/预发布/非数字回退
 * - checkPluginUpdates：名称命中（title/slugify）、版本比对、未命中保守报告、
 *   上游失败不拖垮整批、20 个上限
 * - POST /plugins/check-updates 路由：200 信封 / 404 实例不存在
 * got 全量 mock（与 market.routes.test.js 同模式，离线语义）
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

vi.mock('got', () => {
  const gotFn = vi.fn();
  gotFn.stream = vi.fn();
  return { default: gotFn };
});

vi.mock('../utils/audit.js', () => ({
  AuditActions: {},
  recordAudit: vi.fn(),
}));

import got from 'got';
import { createPluginRoutes } from '../routes/plugins.js';
import { errorHandler } from '../middleware/error_handler.js';
import { clearMarketCache, comparePluginVersions } from '../services/market.service.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-updates-'));
const serverPath = path.join(tmpRoot, 'inst1');

/** 造含 plugin.yml 的真实 jar（meta 链路全真） */
function writePluginJar(name, version) {
  const zip = new AdmZip();
  zip.addFile(
    'plugin.yml',
    Buffer.from(`name: ${name}\nversion: ${version}\nmain: com.example.${name}\n`, 'utf8'),
  );
  const dir = path.join(serverPath, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-${version}.jar`), zip.toBuffer());
}

/** Modrinth /search 响应 fixture */
function searchFixture(hits) {
  return { total_hits: hits.length, hits };
}

function hit({ slug, title }) {
  return {
    project_id: `id-${slug}`,
    slug,
    title,
    description: 'd',
    author: 'a',
    downloads: 10,
    follows: 1,
    icon_url: 'https://cdn.modrinth.com/i.png',
    date_modified: '2026-01-01T00:00:00Z',
    display_categories: ['paper'],
    server_side: 'required',
    client_side: 'unsupported',
  };
}

/** Modrinth /project/:slug/version 响应（首条为最新版本） */
function versionsFixture(versionNumber) {
  return [
    {
      name: `v${versionNumber}`,
      version_number: versionNumber,
      version_type: 'release',
      changelog: null,
      date_published: '2026-01-01T00:00:00Z',
      downloads: 1,
      game_versions: ['1.21.4'],
      loaders: ['paper'],
      files: [
        {
          url: 'https://cdn.modrinth.com/data/x/a.jar',
          filename: 'a.jar',
          primary: true,
          size: 100,
        },
      ],
    },
  ];
}

/** got mock 按 URL 分发：search → QUERY_TO_HITS；version → SLUG_TO_VERSIONS */
function routeUpstream({ queryToHits = {}, slugToVersions = {} } = {}) {
  vi.mocked(got).mockImplementation((url, opts = {}) => {
    if (url.endsWith('/search')) {
      const q = opts.searchParams?.query ?? '';
      const hits = queryToHits[q];
      if (!hits) return { json: async () => ({ total_hits: 0, hits: [] }) };
      return { json: async () => searchFixture(hits) };
    }
    const m = /\/project\/([^/]+)\/version$/.exec(url);
    if (m) {
      const versions = slugToVersions[m[1]];
      return { json: async () => (versions ? versionsFixture(versions) : []) };
    }
    return {
      json: async () => {
        throw new Error('unexpected url: ' + url);
      },
    };
  });
}

let app;
let mockManager;

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  clearMarketCache();
  fs.rmSync(path.join(serverPath, 'plugins'), { recursive: true, force: true });
  app = express();
  app.use(express.json());
  mockManager = { getInstance: vi.fn().mockReturnValue({ serverPath }) };
  app.use('/api/v1', createPluginRoutes(mockManager));
  app.use(errorHandler);
});

describe('comparePluginVersions（轻量 semver）', () => {
  it('主段数字逐段比较；缺段补零（2.0 == 2.0.0）', () => {
    expect(comparePluginVersions('2.21.0', '2.21.0')).toBe(0);
    expect(comparePluginVersions('2.0', '2.0.0')).toBe(0);
    expect(comparePluginVersions('1.9.9', '1.10.0')).toBe(-1);
    expect(comparePluginVersions('2.21.0', '2.20.9')).toBe(1);
  });

  it('忽略 v 前缀与 build 元数据', () => {
    expect(comparePluginVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(comparePluginVersions('1.2.3+build.42', '1.2.3')).toBe(0);
  });

  it('release > 预发布；同为预发布字典序', () => {
    expect(comparePluginVersions('1.0.0', '1.0.0-beta')).toBe(1);
    expect(comparePluginVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });

  it('非数字段回退字符串精确比较', () => {
    expect(comparePluginVersions('1.0-SNAPSHOT', '1.0-SNAPSHOT')).toBe(0);
    expect(comparePluginVersions('1.0-SNAPSHOT', '2.0-RELEASE')).toBe(-1);
    expect(comparePluginVersions('abc', 'abd')).toBe(-1);
  });
});

describe('checkPluginUpdates（服务端聚合）', () => {
  it('name 命中 + 版本落后 → matched/updateAvailable/hasNewer 全真', async () => {
    writePluginJar('EssentialsX', '2.20.0');
    routeUpstream({
      queryToHits: { EssentialsX: [hit({ slug: 'essentialsx', title: 'EssentialsX' })] },
      slugToVersions: { essentialsx: '2.21.0' },
    });

    const res = await request(app).post('/api/v1/instances/i1/plugins/check-updates');
    expect(res.status).toBe(200);
    const r = res.body.data.results[0];
    expect(r).toMatchObject({
      file: 'EssentialsX-2.20.0.jar',
      name: 'EssentialsX',
      installedVersion: '2.20.0',
      matched: true,
      slug: 'essentialsx',
      title: 'EssentialsX',
      latestVersion: '2.21.0',
      updateAvailable: true,
      hasNewer: true,
    });
  });

  it('版本相同（缺段补零）→ updateAvailable=false', async () => {
    writePluginJar('Vault', '2.20');
    routeUpstream({
      queryToHits: { Vault: [hit({ slug: 'vault', title: 'Vault' })] },
      slugToVersions: { vault: '2.20.0' },
    });

    const res = await request(app).post('/api/v1/instances/i1/plugins/check-updates');
    expect(res.body.data.results[0]).toMatchObject({
      matched: true,
      updateAvailable: false,
      hasNewer: false,
    });
  });

  it('Modrinth 未收录 → matched=false（保守报告，不猜测）', async () => {
    writePluginJar('ObscurePlugin', '1.0.0');
    routeUpstream({ queryToHits: {} }); // 全部空结果

    const res = await request(app).post('/api/v1/instances/i1/plugins/check-updates');
    expect(res.body.data.results[0]).toMatchObject({
      name: 'ObscurePlugin',
      matched: false,
      slug: null,
      updateAvailable: false,
    });
  });

  it('搜索命中但 title/slug 均不匹配前 5 候选 → 不误配', async () => {
    writePluginJar('MyPlugin', '1.0.0');
    routeUpstream({
      queryToHits: {
        MyPlugin: [
          hit({ slug: 'my-plugin-plus', title: 'MyPlugin Plus' }),
          hit({ slug: 'not-my-plugin', title: 'Not My Plugin' }),
          hit({ slug: 'other', title: 'Other' }),
          hit({ slug: 'another', title: 'Another' }),
          hit({ slug: 'yet-another', title: 'Yet Another' }),
          hit({ slug: 'myplugin', title: 'MyPlugin' }), // 第 6 位：超出候选窗口
        ],
      },
      slugToVersions: { myplugin: '9.9.9' },
    });

    const res = await request(app).post('/api/v1/instances/i1/plugins/check-updates');
    expect(res.body.data.results[0].matched).toBe(false);
  });

  it('单插件上游抛错不拖垮整批（其余插件正常报告）', async () => {
    writePluginJar('BrokenUpstream', '1.0.0');
    writePluginJar('GoodPlugin', '1.0.0');
    vi.mocked(got).mockImplementation((url, opts = {}) => {
      const q = url.endsWith('/search') ? (opts.searchParams?.query ?? '') : '';
      if (q === 'BrokenUpstream') {
        return {
          json: async () => {
            throw new Error('upstream 502');
          },
        };
      }
      if (q === 'GoodPlugin') {
        return {
          json: async () => searchFixture([hit({ slug: 'goodplugin', title: 'GoodPlugin' })]),
        };
      }
      return { json: async () => [] };
    });

    const res = await request(app).post('/api/v1/instances/i1/plugins/check-updates');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.results.map((r) => [r.name, r]));
    expect(byName.BrokenUpstream.matched).toBe(false);
    expect(byName.GoodPlugin).toMatchObject({ matched: true, latestVersion: null });
  });

  it('无插件 → results 空数组 + checkedAt', async () => {
    routeUpstream({});
    const res = await request(app).post('/api/v1/instances/i1/plugins/check-updates');
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(typeof res.body.data.checkedAt).toBe('string');
  });
});

describe('路由契约', () => {
  it('实例不存在 → 404 INSTANCE_NOT_FOUND', async () => {
    mockManager.getInstance.mockReturnValueOnce(null);
    const res = await request(app).post('/api/v1/instances/ghost/plugins/check-updates');
    expect(res.status).toBe(404);
  });
});
