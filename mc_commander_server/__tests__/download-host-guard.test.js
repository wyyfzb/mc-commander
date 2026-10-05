/**
 * 下载域白名单（部署路径与升级路径共用）。
 *
 * 承重点：下载 URL **全部来自上游响应**（Piston 详情、paper v3、
 * UnifiedBuild），上游被污染即可让面板去任意主机取 jar 并落进实例目录。两条路径
 * 必须都守——只守升级等于留了部署这个更大的口子（部署是常规入口，升级是低频动作）。
 *
 * 夹具用各加载器的**真实域**（静态核对：本仓常量 + 各上游的 URL 模板 +
 * paper v3 实测响应）。少一个域会让该加载器部署直接失败，故每个类型都要有正向用例。
 */
import { describe, it, expect } from 'vitest';
import {
  DOWNLOAD_HOSTS_BY_TYPE,
  allowedDownloadHosts,
  assertAllowedDownloadHost,
} from '../utils/jar-download-guard.js';

/** 五个部署类型与各自真实下载 URL（部署链路支持的全部类型，一个都不能少） */
const REAL_DOWNLOAD_URLS = {
  vanilla: 'https://piston-data.mojang.com/v1/objects/abc/server.jar',
  paper: 'https://fill-data.papermc.io/v3/objects/paper/1.21.4.jar',
  purpur: 'https://api.purpurmc.org/v2/purpur/1.21.4/latest/download',
  fabric: 'https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.16.10/1.0.1/server/jar',
  forge:
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.4/forge-1.21.4-installer.jar',
};

describe('下载域白名单', () => {
  it.each(Object.entries(REAL_DOWNLOAD_URLS))(
    '五个部署类型各自的真实下载域都放行：%s',
    (type, url) => {
      expect(() => assertAllowedDownloadHost(url, allowedDownloadHosts([type]))).not.toThrow();
    },
  );

  it.each(Object.entries(REAL_DOWNLOAD_URLS))(
    '同一 URL 用在别的类型上应被拒绝（白名单按类型收窄，不是一个大集合）：%s',
    (type, url) => {
      // 取一个确定不含该域的其它类型
      const other = Object.keys(REAL_DOWNLOAD_URLS).find(
        (t) => t !== type && !allowedDownloadHosts([t]).has(new URL(url).hostname),
      );
      if (!other) return; // 该域恰好被所有类型共用时跳过（当前无此情况）
      expect(() => assertAllowedDownloadHost(url, allowedDownloadHosts([other]))).toThrow(
        /Download host not allowed/,
      );
    },
  );

  it('非白名单域一律拒绝（VALIDATION_ERROR 语义）', () => {
    for (const bad of [
      'https://evil.example.com/server.jar',
      'https://piston-data.mojang.com.evil.example.com/server.jar', // 后缀混淆
      'https://127.0.0.1:8080/server.jar',
      'http://localhost/server.jar',
      'file:///etc/passwd',
    ]) {
      expect(() => assertAllowedDownloadHost(bad, allowedDownloadHosts(['vanilla'])), bad).toThrow(
        /Download host not allowed|Invalid download URL/,
      );
    }
  });

  it('畸形 URL 拒绝且报 Invalid download URL（不静默放行）', () => {
    expect(() => assertAllowedDownloadHost('not a url', allowedDownloadHosts(['vanilla']))).toThrow(
      /Invalid download URL/,
    );
  });

  it('升级路径的类型子集不含 fabric/forge 域（不给并集，避免白名单被悄悄放宽）', () => {
    const upgradeHosts = allowedDownloadHosts(['vanilla', 'paper', 'purpur']);
    expect(upgradeHosts.has('meta.fabricmc.net')).toBe(false);
    expect(upgradeHosts.has('maven.minecraftforge.net')).toBe(false);
    // 但它必须有自己三个类型的域
    expect(upgradeHosts.has('piston-data.mojang.com')).toBe(true);
    expect(upgradeHosts.has('fill-data.papermc.io')).toBe(true);
    expect(upgradeHosts.has('api.purpurmc.org')).toBe(true);
  });

  it('声明了哪五个类型（漏一个会让该加载器部署直接失败）', () => {
    expect(Object.keys(DOWNLOAD_HOSTS_BY_TYPE).sort()).toEqual([
      'fabric',
      'forge',
      'paper',
      'purpur',
      'vanilla',
    ]);
  });

  it('未知类型不给任何域（不因拼错类型名而放行全部）', () => {
    expect(allowedDownloadHosts(['typo']).size).toBe(0);
    expect(() =>
      assertAllowedDownloadHost('https://evil.example.com/x.jar', allowedDownloadHosts(['typo'])),
    ).toThrow();
  });
});
