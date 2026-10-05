/**
 * 加载器上游（fabric / purpur）的版本发现。
 *
 * 形态依据是**打真实请求核过的**（不是照记忆写的）：
 * - fabric `GET /v2/versions/game` → `[{ version, stable }]`，**由新到旧**，快照/rc 也在列表里；
 * - purpur `GET /v2/purpur` → `{ versions: [...] }`，**由旧到新**（与 fabric 相反）。
 *
 * 承重点是「先反向再截断」：先截断会永远只拿到最旧那几档，而列表看起来仍然「有内容」，
 * 是那种不会报错、只会悄悄给错答案的缺陷。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { jsonImpl } = vi.hoisted(() => ({ jsonImpl: { current: null } }));

vi.mock('../utils/http-client.js', () => ({
  httpJson: vi.fn((...args) => jsonImpl.current(...args)),
  httpStream: vi.fn(),
  httpPost: vi.fn(),
}));

const {
  listFabricGameVersions,
  listPurpurVersions,
  resolvePurpurDownload,
  resolveForgeInstallerDownload,
  resolveFabricDownload,
} = await import('../services/loader-upstreams.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listFabricGameVersions', () => {
  it('只取 stable，保持上游顺序（由新到旧）', async () => {
    jsonImpl.current = () =>
      Promise.resolve([
        { version: '26.4-snapshot-1', stable: false },
        { version: '26.3', stable: true },
        { version: '26.3-rc-2', stable: false },
        { version: '1.21.4', stable: true },
      ]);
    expect(await listFabricGameVersions()).toEqual(['26.3', '1.21.4']);
  });

  it('stable 缺失/非布尔一律不取（宁可少给，不把快照塞进部署选项）', async () => {
    jsonImpl.current = () =>
      Promise.resolve([
        { version: 'x' },
        { version: 'y', stable: 'true' },
        { version: 'z', stable: true },
      ]);
    expect(await listFabricGameVersions()).toEqual(['z']);
  });

  it('缺 version 字段的项跳过', async () => {
    jsonImpl.current = () => Promise.resolve([{ stable: true }, { version: 'ok', stable: true }]);
    expect(await listFabricGameVersions()).toEqual(['ok']);
  });

  it('上游返回非数组 → 空列表（异常形态不抛错）', async () => {
    jsonImpl.current = () => Promise.resolve({ unexpected: true });
    expect(await listFabricGameVersions()).toEqual([]);
  });

  it('按上限截断（取前 N 个＝最新的 N 个）', async () => {
    jsonImpl.current = () =>
      Promise.resolve(Array.from({ length: 5 }, (_, i) => ({ version: `v${i}`, stable: true })));
    expect(await listFabricGameVersions(2)).toEqual(['v0', 'v1']);
  });
});

describe('listPurpurVersions', () => {
  it('上游由旧到新 → **先反向再截断**（先截断只会拿到最旧那几档）', async () => {
    jsonImpl.current = () =>
      Promise.resolve({
        project: 'purpur',
        metadata: { current: '26.2' },
        versions: ['1.20.4', '1.21.4', '26.1', '26.2'],
      });
    expect(await listPurpurVersions()).toEqual(['26.2', '26.1', '1.21.4', '1.20.4']);
    // 上限 2 时必须是「最新两个」，而不是「最旧两个反转」
    expect(await listPurpurVersions(2)).toEqual(['26.2', '26.1']);
  });

  it('缺 versions 键 / 非数组 → 空列表', async () => {
    jsonImpl.current = () => Promise.resolve({ project: 'purpur' });
    expect(await listPurpurVersions()).toEqual([]);
    jsonImpl.current = () => Promise.resolve({ versions: 'nope' });
    expect(await listPurpurVersions()).toEqual([]);
  });

  it('非字符串项跳过', async () => {
    jsonImpl.current = () => Promise.resolve({ versions: ['a', 42, null, 'b'] });
    expect(await listPurpurVersions()).toEqual(['b', 'a']);
  });
});

describe('resolvePurpurDownload', () => {
  it('有 build 时用具体构建号下载（与查询到的摘要同源）', async () => {
    jsonImpl.current = () => Promise.resolve({ build: 2416, md5: 'a'.repeat(32) });
    expect(await resolvePurpurDownload('1.21.4')).toEqual({
      url: 'https://api.purpurmc.org/v2/purpur/1.21.4/2416/download',
      expectedHash: { algorithm: 'md5', digest: 'a'.repeat(32) },
    });
  });

  it('没有 build 时退到 latest/download（不拼出 undefined 路径）', async () => {
    jsonImpl.current = () => Promise.resolve({ md5: 'a'.repeat(32) });
    const r = await resolvePurpurDownload('1.21.4');
    expect(r.url).toBe('https://api.purpurmc.org/v2/purpur/1.21.4/latest/download');
  });

  it('没有 md5 → expectedHash 为 null（如实表达「上游没给」，不拿别的字段凑）', async () => {
    jsonImpl.current = () => Promise.resolve({ build: 2416 });
    expect((await resolvePurpurDownload('1.21.4')).expectedHash).toBe(null);
  });
});

describe('resolveForgeInstallerDownload', () => {
  it('优先 recommended，地址是 maven 的 <mc>-<forge> 路径', async () => {
    jsonImpl.current = () =>
      Promise.resolve({
        promos: { '1.21.4-recommended': '51.0.0', '1.21.4-latest': '52.0.0' },
      });
    expect(await resolveForgeInstallerDownload('1.21.4')).toEqual({
      url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.4-51.0.0/forge-1.21.4-51.0.0-installer.jar',
      expectedHash: null,
    });
  });

  it('只有 latest 时用 latest', async () => {
    jsonImpl.current = () => Promise.resolve({ promos: { '1.21.4-latest': '52.0.0' } });
    expect((await resolveForgeInstallerDownload('1.21.4')).url).toContain('1.21.4-52.0.0');
  });

  it('该 MC 版本没有 forge 构建 → 抛错（不给出一个必然 404 的地址）', async () => {
    jsonImpl.current = () => Promise.resolve({ promos: {} });
    await expect(resolveForgeInstallerDownload('1.21.4')).rejects.toThrow(/No Forge build/);
  });
});

describe('resolveFabricDownload', () => {
  it('按 loader 版本拼固定路径；上游不提供摘要 ⇒ 恒为 null', async () => {
    expect(await resolveFabricDownload('1.21.4', '0.16.10')).toEqual({
      url: 'https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.16.10/1.0.1/server/jar',
      expectedHash: null,
    });
  });

  it('loader 缺失时用默认值（不该让整条部署失败）', async () => {
    expect((await resolveFabricDownload('1.21.4', undefined)).url).toContain('/1.21.4/0.16.10/');
  });
});
