/**
 * vanilla 构建解析（部署与升级的**唯一实现**）。
 *
 * 承重点：这是两条路径共用的取数口，取错一处会同时影响部署与升级。三条不变量：
 * ① 摘要只认 Piston 的 `downloads.server.sha1`（不做多级字段回退——回退会让
 *    「读到哪个字段」随上游形状漂移，而校验一旦静默跳过，下载损坏就变成「装上了但起不来」）
 * ② 只认 `type === 'release'`（按 id 命中快照会让用户部署到非正式版）
 * ③ 取不到地址/版本时**抛错**而不是返回半成品（调用方据此 502，不静默降级）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { jsonImpl } = vi.hoisted(() => ({ jsonImpl: { current: null } }));

vi.mock('../utils/http-client.js', () => ({
  httpJson: vi.fn((...args) => jsonImpl.current(...args)),
  httpStream: vi.fn(),
  httpPost: vi.fn(),
}));

const { resolveVanillaDownload, listVanillaReleases, PISTON_MANIFEST_URL } = await import(
  '../services/vanilla-manifest.js'
);

const DETAIL_URL = 'https://piston-meta.mojang.com/v1/packages/abc/1.21.4.json';

/** 默认上游：manifest 含正式版与快照同 id 的干扰项 */
function defaultUpstream({ serverJar } = {}) {
  return (url) => {
    if (url === PISTON_MANIFEST_URL) {
      return Promise.resolve({
        latest: { release: '1.21.4' },
        versions: [
          { id: '1.21.4', type: 'release', url: DETAIL_URL },
          { id: '26.1', type: 'release', url: DETAIL_URL },
        ],
      });
    }
    if (url === DETAIL_URL) {
      return Promise.resolve({ downloads: { server: serverJar } });
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jsonImpl.current = defaultUpstream({
    serverJar: { url: 'https://piston-data.mojang.com/jar/server.jar', sha1: 'a'.repeat(40) },
  });
});

describe('resolveVanillaDownload', () => {
  it('取到地址与 sha1 摘要', async () => {
    expect(await resolveVanillaDownload('1.21.4')).toEqual({
      url: 'https://piston-data.mojang.com/jar/server.jar',
      expectedHash: { algorithm: 'sha1', digest: 'a'.repeat(40) },
    });
  });

  it('上游未给 sha1 → expectedHash 为 null（按无摘要处理，不拿别的字段顶替）', async () => {
    jsonImpl.current = defaultUpstream({
      serverJar: { url: 'https://piston-data.mojang.com/jar/server.jar' },
    });
    const r = await resolveVanillaDownload('1.21.4');
    expect(r.expectedHash).toBe(null);
    expect(r.url).toBe('https://piston-data.mojang.com/jar/server.jar');
  });

  it('详情里有别的摘要字段（sha256）但没有 sha1 → 仍按无摘要，不拿别的字段顶替', async () => {
    // 这条钉住「不做多级字段回退」：旧实现是 `artifact.hash || build.sha256 || build.sha1`，
    // 回退会让「读到哪个字段」随上游形状漂移；而拿 sha256 当 sha1 比对必然误报损坏。
    // 诱饵要放在**所有可能被回退读到的地方**，否则这条用例对「回退实现」不承重：
    // 只在一处放诱饵时，回退实现读另一处照样返回 null，用例会假绿（探针实测过）。
    const decoy = 'b'.repeat(64);
    jsonImpl.current = (url) =>
      url === PISTON_MANIFEST_URL
        ? Promise.resolve({ versions: [{ id: '1.21.4', type: 'release', url: DETAIL_URL }] })
        : Promise.resolve({
            sha256: decoy, // 详情顶层
            downloads: {
              sha256: decoy, // downloads 层
              server: { url: 'https://piston-data.mojang.com/jar/server.jar', sha256: decoy }, // server 对象里
            },
          });
    expect((await resolveVanillaDownload('1.21.4')).expectedHash).toBe(null);
  });

  it('manifest 为 null → 抛错而不是崩在属性读取上', async () => {
    jsonImpl.current = () => Promise.resolve(null);
    await expect(resolveVanillaDownload('1.21.4')).rejects.toThrow(/not found/);
  });

  it('只认 release：版本不在正式版列表里 → 抛错（不能部署快照）', async () => {
    jsonImpl.current = (url) =>
      url === PISTON_MANIFEST_URL
        ? Promise.resolve({ versions: [{ id: '26w1a', type: 'snapshot', url: DETAIL_URL }] })
        : Promise.resolve({ downloads: { server: { url: 'https://x/y.jar' } } });
    await expect(resolveVanillaDownload('26w1a')).rejects.toThrow(/not found/);
  });

  it('版本存在但没有 url → 抛错', async () => {
    jsonImpl.current = (url) =>
      url === PISTON_MANIFEST_URL
        ? Promise.resolve({ versions: [{ id: '1.21.4', type: 'release' }] })
        : Promise.reject(new Error('不该请求详情'));
    await expect(resolveVanillaDownload('1.21.4')).rejects.toThrow(/not found/);
  });

  it('详情里没有 downloads.server.url → 抛错（不返回半成品）', async () => {
    jsonImpl.current = defaultUpstream({ serverJar: undefined });
    await expect(resolveVanillaDownload('1.21.4')).rejects.toThrow(/No server JAR download/);
  });

  it('manifest 形状异常（缺 versions）→ 抛错而不是崩在 .find 上', async () => {
    jsonImpl.current = () => Promise.resolve({});
    await expect(resolveVanillaDownload('1.21.4')).rejects.toThrow(/not found/);
  });
});

describe('listVanillaReleases', () => {
  it('只列 release，保持清单顺序（由新到旧），并按上限截断', async () => {
    jsonImpl.current = (url) => {
      if (url !== PISTON_MANIFEST_URL) return Promise.reject(new Error('不该请求详情'));
      return Promise.resolve({
        versions: [
          { id: '26.3', type: 'release' },
          { id: '26.2', type: 'release' },
          { id: '26w1a', type: 'snapshot' },
          { id: '1.21.4', type: 'release' },
        ],
      });
    };
    expect(await listVanillaReleases()).toEqual(['26.3', '26.2', '1.21.4']);
    expect(await listVanillaReleases(2)).toEqual(['26.3', '26.2']);
  });

  it('manifest 缺 versions → 返回空数组（列表为空是正常态，不是错误）', async () => {
    jsonImpl.current = () => Promise.resolve({});
    expect(await listVanillaReleases()).toEqual([]);
  });

  it('manifest 为 null → 同样返回空数组而不是抛错', async () => {
    jsonImpl.current = () => Promise.resolve(null);
    expect(await listVanillaReleases()).toEqual([]);
  });
});
