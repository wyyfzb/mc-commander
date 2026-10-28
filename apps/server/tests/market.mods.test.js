/**
 * 模组市场：Fabric/Forge 实例按 project_type=mod 检索并落 mods/
 *
 * 夹具取自真实上游响应，字段与取值原样搬入：
 * - 搜索：modrinth-search-mod-100.json —— 不带 server_side facet 的默认结果，
 *   头部即含纯客户端 Sodium（server_side=unsupported）与 Chunky（optional）
 * - 版本：modrinth-versions-chunky.json —— Chunky 1.5.3 是 fabric 构建，
 *   dependencies 里 required 指向 Fabric API（P7dR8mSH），version_id 为 null
 * - 批量项目：modrinth-projects-ids.json —— /v2/projects?ids=[...] 的响应形态
 *
 * 网络层离线语义与 market.test.js 一致：httpJson 按 URL 路由 fixture，
 * httpStream 推真实 zip 字节（install 落盘走 uploadPlugin 的魔数/白名单校验）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Readable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';

vi.mock('../src/utils/http-client.js', () => ({
  httpJson: vi.fn(),
  httpStream: vi.fn(),
  httpPost: vi.fn(),
}));

vi.mock('../src/utils/audit.js', () => ({
  AuditActions: {
    PLUGIN_UPLOAD: 'PLUGIN_UPLOAD',
    PLUGIN_ENABLE: 'PLUGIN_ENABLE',
    PLUGIN_DISABLE: 'PLUGIN_DISABLE',
    PLUGIN_DELETE: 'PLUGIN_DELETE',
    PLUGIN_MARKET_INSTALL: 'PLUGIN_MARKET_INSTALL',
    MOD_UPLOAD: 'MOD_UPLOAD',
    MOD_DELETE: 'MOD_DELETE',
  },
  recordAudit: vi.fn(),
}));

import { httpJson, httpStream } from '../src/utils/http-client.js';
import { recordAudit } from '../src/utils/audit.js';
import { createPluginRoutes } from '../src/routes/plugins.js';
import { errorHandler } from '../src/middleware/error_handler.js';
import {
  searchMarketPlugins,
  installPluginFromMarket,
  clearMarketCache,
} from '../src/services/market.service.js';
import { ErrorCodes } from '../src/utils/response.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-market-mods-'));
const serverPath = path.join(tmpRoot, 'inst1');
const modsDir = path.join(serverPath, 'mods');
const pluginsDir = path.join(serverPath, 'plugins');

/** 真实 jar 字节形态：mods/ 与 plugins/ 都要过 zip 魔数校验 */
function makeJar(descriptor = 'fabric.mod.json') {
  const zip = new AdmZip();
  zip.addFile(descriptor, Buffer.from('{"id":"chunky","version":"1.5.3"}', 'utf8'));
  return zip.toBuffer();
}

const JAR = makeJar();
/// 官方哈希只对上游那一份字节成立：夹具字节变了就得重算，否则会撞上完整性闸门
const JAR_SHA512 = crypto.createHash('sha512').update(JAR).digest('hex');

/** 搜索结果：Sodium 纯客户端 + Chunky 服务端可用（字段形态与上游响应一致） */
const MOD_SEARCH_FIXTURE = {
  total_hits: 2,
  hits: [
    {
      project_id: 'AANobbMI',
      project_type: 'mod',
      slug: 'sodium',
      title: 'Sodium',
      description: 'A high-performance rendering engine replacement',
      author: 'jellysquid3',
      downloads: 255631722,
      follows: 42201,
      icon_url: 'https://cdn.modrinth.com/data/AANobbMI/icon.png',
      date_modified: '2026-10-15T17:51:36.063140+00:00',
      display_categories: ['fabric', 'optimization'],
      server_side: 'unsupported',
      client_side: 'required',
    },
    {
      project_id: 'fALzjamp',
      project_type: 'mod',
      slug: 'chunky',
      title: 'Chunky',
      description: 'Pre-generate chunks',
      author: 'pop4959',
      downloads: 1314311,
      follows: 1200,
      icon_url: 'https://cdn.modrinth.com/data/fALzjamp/icon.png',
      date_modified: '2026-05-04T05:47:16.215347+00:00',
      display_categories: ['fabric', 'utility'],
      server_side: 'optional',
      client_side: 'optional',
    },
  ],
};

/** 版本列表：Chunky 1.5.3（真实 fabric 构建 + required 依赖 Fabric API） */
function chunkyVersions() {
  return [
    {
      id: '4Eotm6ov',
      project_id: 'fALzjamp',
      name: 'Chunky 1.5.3',
      version_number: '1.5.3',
      version_type: 'release',
      changelog: null,
      date_published: '2026-05-04T05:47:16.215347Z',
      downloads: 1314311,
      game_versions: ['26.1', '26.1.1', '26.1.2', '26.2', '26.3'],
      loaders: ['fabric'],
      dependencies: [
        { version_id: null, project_id: 'P7dR8mSH', file_name: null, dependency_type: 'required' },
      ],
      files: [
        {
          id: '1H7wRpeN',
          // 响应里是上游给的 sha512（真实样本有该字段）；值按本夹具字节重算
          hashes: { sha1: 'fc1f2f374c5c82117599071ed18b6ef9bba2c7fb', sha512: JAR_SHA512 },
          url: 'https://cdn.modrinth.com/data/fALzjamp/versions/4Eotm6ov/Chunky-Fabric-1.5.3.jar',
          filename: 'Chunky-Fabric-1.5.3.jar',
          primary: true,
          size: JAR.length,
        },
      ],
    },
  ];
}

/** 只有一个 optional 依赖的版本（依赖条目形态同真实响应，类型取 optional） */
function optionalOnlyVersions() {
  const versions = chunkyVersions();
  versions[0].version_number = '1.5.4';
  versions[0].name = 'Chunky 1.5.4';
  versions[0].dependencies = [
    { version_id: null, project_id: 'Bh37bMuy', file_name: null, dependency_type: 'optional' },
  ];
  versions[0].files[0].filename = 'Chunky-Fabric-1.5.4.jar';
  versions[0].files[0].url =
    'https://cdn.modrinth.com/data/fALzjamp/versions/4Eotm6ov/Chunky-Fabric-1.5.4.jar';
  return versions;
}

/** /v2/projects?ids 响应（真实项目对象的关键字段） */
const PROJECTS_BY_IDS_FIXTURE = [
  {
    id: 'P7dR8mSH',
    slug: 'fabric-api',
    title: 'Fabric API',
    project_type: 'mod',
    server_side: 'optional',
    client_side: 'optional',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearMarketCache();
  fs.rmSync(serverPath, { recursive: true, force: true });
  fs.mkdirSync(serverPath, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('searchMarketPlugins：模组只保留服务端可用的项目', () => {
  it('facets 带 server_side 维度组，且纯客户端模组被剔除（上游即使返回也不透出）', async () => {
    httpJson.mockResolvedValueOnce(MOD_SEARCH_FIXTURE);

    const result = await searchMarketPlugins({
      query: 'chunky',
      projectType: 'mod',
      loader: 'fabric',
    });

    const [, opts] = httpJson.mock.calls[0];
    expect(JSON.parse(opts.searchParams.facets)).toEqual([
      ['project_type:mod'],
      ['server_side:required', 'server_side:optional'],
      ['loaders:fabric'],
    ]);
    expect(result.hits.map((h) => h.slug)).toEqual(['chunky']);
  });

  it('插件搜索不受影响：facets 里没有 server_side 组（Bukkit 行为逐字不变）', async () => {
    httpJson.mockResolvedValueOnce({ total_hits: 0, hits: [] });

    await searchMarketPlugins({ query: 'vault' });

    const [, opts] = httpJson.mock.calls[0];
    expect(JSON.parse(opts.searchParams.facets)).toEqual([['project_type:plugin']]);
  });
});

describe('installPluginFromMarket({kind:"mod"})', () => {
  it('按实例 loader 过滤版本并落 mods/；required 依赖解析成名称随结果返回', async () => {
    httpJson.mockResolvedValueOnce(chunkyVersions()).mockResolvedValueOnce(PROJECTS_BY_IDS_FIXTURE);
    httpStream.mockReturnValueOnce(Readable.from([JAR]));

    const result = await installPluginFromMarket(
      serverPath,
      { slug: 'chunky', versionNumber: '1.5.3' },
      { kind: 'mod', loader: 'fabric' },
    );

    // 版本查询带 loader 过滤：否则同 version_number 的 forge 构建会装错地方
    const [versionsUrl, versionsOpts] = httpJson.mock.calls[0];
    expect(versionsUrl).toContain('/project/chunky/version');
    expect(versionsOpts.searchParams.loaders).toBe('["fabric"]');

    expect(fs.existsSync(path.join(modsDir, 'Chunky-Fabric-1.5.3.jar'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'Chunky-Fabric-1.5.3.jar'))).toBe(false);
    expect(result).toMatchObject({
      kind: 'mod',
      installedTo: 'mods',
      file: 'Chunky-Fabric-1.5.3.jar',
      requiredDependencies: [{ projectId: 'P7dR8mSH', slug: 'fabric-api', title: 'Fabric API' }],
    });
    // 依赖只按 project_id 批量查，不自动下载
    const [, depsOpts] = httpJson.mock.calls[1];
    expect(depsOpts.searchParams.ids).toBe('["P7dR8mSH"]');
  });

  it('只有 optional 依赖时不报「缺前置」，也不发起依赖解析请求', async () => {
    httpJson.mockResolvedValueOnce(optionalOnlyVersions());
    httpStream.mockReturnValueOnce(Readable.from([JAR]));

    const result = await installPluginFromMarket(
      serverPath,
      { slug: 'chunky', versionNumber: '1.5.4' },
      { kind: 'mod', loader: 'fabric' },
    );

    expect(result.requiredDependencies).toEqual([]);
    expect(httpJson).toHaveBeenCalledTimes(1);
  });

  it('依赖名解析失败不阻断安装：仍保留 projectId，名称置 null', async () => {
    httpJson
      .mockResolvedValueOnce(chunkyVersions())
      .mockRejectedValueOnce(new Error('upstream down'));
    httpStream.mockReturnValueOnce(Readable.from([JAR]));

    const result = await installPluginFromMarket(
      serverPath,
      { slug: 'chunky', versionNumber: '1.5.3' },
      { kind: 'mod', loader: 'fabric' },
    );

    expect(fs.existsSync(path.join(modsDir, 'Chunky-Fabric-1.5.3.jar'))).toBe(true);
    expect(result.requiredDependencies).toEqual([
      { projectId: 'P7dR8mSH', slug: null, title: null },
    ]);
  });

  it('mods/ 同名冲突默认 40912，显式 overwrite 才替换', async () => {
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(modsDir, 'Chunky-Fabric-1.5.3.jar'), 'old-bytes');
    httpJson.mockResolvedValueOnce(chunkyVersions()).mockResolvedValueOnce(PROJECTS_BY_IDS_FIXTURE);
    httpStream.mockReturnValueOnce(Readable.from([JAR]));

    await expect(
      installPluginFromMarket(
        serverPath,
        { slug: 'chunky', versionNumber: '1.5.3' },
        { kind: 'mod', loader: 'fabric' },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.PLUGIN_FILE_EXISTS.code });

    // 第二次安装是独立请求：清缓存让它真的重取版本（否则队列错位会把夹具当版本列表）
    clearMarketCache();
    httpJson.mockResolvedValueOnce(chunkyVersions()).mockResolvedValueOnce(PROJECTS_BY_IDS_FIXTURE);
    httpStream.mockReturnValueOnce(Readable.from([JAR]));
    const overwritten = await installPluginFromMarket(
      serverPath,
      { slug: 'chunky', versionNumber: '1.5.3' },
      { kind: 'mod', loader: 'fabric', overwrite: true },
    );
    expect(overwritten.overwritten).toBe(true);
    expect(fs.readFileSync(path.join(modsDir, 'Chunky-Fabric-1.5.3.jar')).equals(JAR)).toBe(true);
  });

  it('非法装载目标在发起任何上游请求前拒绝（不能把目录名当输入）', async () => {
    await expect(
      installPluginFromMarket(
        serverPath,
        { slug: 'chunky', versionNumber: '1.5.3' },
        { kind: 'mods' },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR.code });
    expect(httpJson).not.toHaveBeenCalled();
    expect(httpStream).not.toHaveBeenCalled();
  });

  it('插件安装结果与既有一致：installedTo=plugins、无依赖回执', async () => {
    httpJson.mockResolvedValueOnce([
      {
        version_number: '2.21.0',
        version_type: 'release',
        name: 'EssentialsX 2.21.0',
        date_published: '2026-01-01T00:00:00Z',
        downloads: 1,
        game_versions: ['1.21.4'],
        loaders: ['paper'],
        files: [
          {
            url: 'https://cdn.modrinth.com/data/x/versions/a/EssentialsX-2.21.0.jar',
            filename: 'EssentialsX-2.21.0.jar',
            primary: true,
            size: JAR.length,
          },
        ],
      },
    ]);
    httpStream.mockReturnValueOnce(Readable.from([JAR]));

    const result = await installPluginFromMarket(serverPath, {
      slug: 'essentialsx',
      versionNumber: '2.21.0',
    });

    expect(result).toMatchObject({
      kind: 'plugin',
      installedTo: 'plugins',
      requiredDependencies: [],
    });
    expect(fs.existsSync(path.join(pluginsDir, 'EssentialsX-2.21.0.jar'))).toBe(true);
  });
});

// ── 路由层：装载目标由实例的 mod_loader 推导 ──────────────────────────

let app;
let mockManager;
/** 实例事实：装载目标只看这里的 modLoader（部署类型写入、小写下发） */
let fakeInstance;

beforeEach(() => {
  app = express();
  app.use(express.json());
  fakeInstance = { serverPath, modLoader: null };
  mockManager = { getInstance: vi.fn(() => fakeInstance) };
  app.use('/api/v1', createPluginRoutes(mockManager));
  app.use(errorHandler);
});

afterEach(() => {
  vi.mocked(recordAudit).mockClear();
});

describe('routes/plugins.js：装载目标来自实例 mod_loader', () => {
  it('GET market/profile：Fabric 实例返回 mod + 自身 loader；Paper 实例返回 plugin', async () => {
    fakeInstance.modLoader = 'fabric';
    const fabric = await request(app).get('/api/v1/instances/fabric1/plugins/market/profile');
    expect(fabric.status).toBe(200);
    expect(fabric.body.data).toEqual({ kind: 'mod', loader: 'fabric' });

    fakeInstance.modLoader = 'paper';
    const paper = await request(app).get('/api/v1/instances/paper1/plugins/market/profile');
    expect(paper.body.data).toEqual({ kind: 'plugin', loader: null });
  });

  it('GET market/profile：实例不存在 → 404（不能给出一个默认目标）', async () => {
    mockManager.getInstance.mockReturnValue(null);
    const res = await request(app).get('/api/v1/instances/nope/plugins/market/profile');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCodes.INSTANCE_NOT_FOUND.code);
  });

  it('GET market/search：模组实例固定用自身 loader，客户端传的 forge 被忽略', async () => {
    fakeInstance.modLoader = 'fabric';
    httpJson.mockResolvedValueOnce({ total_hits: 0, hits: [] });

    const res = await request(app)
      .get('/api/v1/instances/fabric1/plugins/market/search')
      .query({ q: 'chunky', loader: 'forge' });

    expect(res.status).toBe(200);
    const [, opts] = httpJson.mock.calls[0];
    expect(JSON.parse(opts.searchParams.facets)).toEqual([
      ['project_type:mod'],
      ['server_side:required', 'server_side:optional'],
      ['loaders:fabric'],
    ]);
  });

  it('GET market/versions：模组实例的版本查询同样带 loader 过滤', async () => {
    fakeInstance.modLoader = 'fabric';
    httpJson.mockResolvedValueOnce(chunkyVersions());

    const res = await request(app).get(
      '/api/v1/instances/fabric1/plugins/market/projects/chunky/versions',
    );

    expect(res.status).toBe(200);
    const [, opts] = httpJson.mock.calls[0];
    expect(opts.searchParams.loaders).toBe('["fabric"]');
  });

  it('POST market/install：Fabric 实例落 mods/ 且审计目标为 mod', async () => {
    fakeInstance.modLoader = 'fabric';
    httpJson.mockResolvedValueOnce(chunkyVersions()).mockResolvedValueOnce(PROJECTS_BY_IDS_FIXTURE);
    httpStream.mockReturnValueOnce(Readable.from([JAR]));

    const res = await request(app)
      .post('/api/v1/instances/fabric1/plugins/market/install')
      .send({ slug: 'chunky', versionNumber: '1.5.3' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      file: 'Chunky-Fabric-1.5.3.jar',
      kind: 'mod',
      installedTo: 'mods',
    });
    expect(fs.existsSync(path.join(modsDir, 'Chunky-Fabric-1.5.3.jar'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'fabric1',
        targetType: 'mod',
        targetId: 'Chunky-Fabric-1.5.3.jar',
        detail: expect.objectContaining({ installedTo: 'mods' }),
      }),
    );
  });

  it('POST market/install：Paper 实例仍落 plugins/（Bukkit 路径不变）', async () => {
    fakeInstance.modLoader = 'paper';
    httpJson.mockResolvedValueOnce([
      {
        version_number: '2.21.0',
        version_type: 'release',
        name: 'EssentialsX 2.21.0',
        date_published: '2026-01-01T00:00:00Z',
        downloads: 1,
        game_versions: ['1.21.4'],
        loaders: ['paper'],
        files: [
          {
            url: 'https://cdn.modrinth.com/data/x/versions/a/EssentialsX-2.21.0.jar',
            filename: 'EssentialsX-2.21.0.jar',
            primary: true,
            size: JAR.length,
          },
        ],
      },
    ]);
    httpStream.mockReturnValueOnce(Readable.from([JAR]));

    const res = await request(app)
      .post('/api/v1/instances/paper1/plugins/market/install')
      .send({ slug: 'essentialsx', versionNumber: '2.21.0' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'plugin', installedTo: 'plugins' });
    expect(fs.existsSync(path.join(pluginsDir, 'EssentialsX-2.21.0.jar'))).toBe(true);
    expect(fs.existsSync(path.join(modsDir, 'EssentialsX-2.21.0.jar'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'plugin' }));
  });
});
