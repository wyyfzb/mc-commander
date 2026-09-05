/**
 * URL SSRF 防护单元测试（url-guard）
 * 测试数据全部使用 RFC 5737 文档保留地址与虚构主机名
 */
import { describe, it, expect } from 'vitest';
import { isPrivateIp, isLocalHostname, checkPublicUrl } from '../utils/url-guard.js';

// 注入的假 lookup：恒定返回给定地址列表（不触网）
function fakeLookup(addresses) {
  return async () => addresses.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
}

describe('isPrivateIp IPv4 字面量', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254',       // 环回
    '10.0.0.1', '10.255.0.1',             // 私网
    '172.16.0.1', '172.31.255.255',       // 私网（含边界内最大值）
    '192.168.0.1', '192.168.255.255',     // 私网
    '169.254.169.254',                    // 链路本地（云元数据端点）
    '0.0.0.0',                            // 未指定
    '100.64.0.1',                         // CGNAT
    '224.0.0.1', '255.255.255.255',       // 组播/广播
  ];
  for (const ip of blocked) {
    it(`应判定 ${ip} 为私网/保留地址`, () => {
      expect(isPrivateIp(ip)).toBe(true);
    });
  }

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',    // RFC 6685 示例段（公网）
    '172.32.0.1',       // 私网段外首个地址（边界外）
    '172.15.255.255',   // 私网段前一个地址
    '11.0.0.1',         // 10/8 段外
    '100.63.255.255',   // CGNAT /10 段前一个地址（段外）
    '100.128.0.1',      // CGNAT /10 段后首个地址（段外，段内末址为 100.127.255.255）
  ];
  for (const ip of allowed) {
    it(`应判定 ${ip} 为公网地址`, () => {
      expect(isPrivateIp(ip)).toBe(false);
    });
  }
});

describe('isPrivateIp IPv6 字面量', () => {
  it('应判定 ::1（环回）为私网', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });
  it('应判定 ::（未指定）为私网', () => {
    expect(isPrivateIp('::')).toBe(true);
  });
  it('应判定带方括号形式 [::1] 为私网', () => {
    expect(isPrivateIp('[::1]')).toBe(true);
  });
  it('应判定 fc00::/7 唯一本地地址为私网', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
  });
  it('应判定 fe80::/10 链路本地地址为私网', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('febf::1')).toBe(true);
  });
  it('应判定 ff00::/8 组播地址为私网', () => {
    expect(isPrivateIp('ff02::1')).toBe(true);
  });
  it('应判定 IPv4-mapped 私网地址为私网', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
  });
  it('应判定 IPv4-mapped 公网地址为公网', () => {
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });
  it('CGNAT /10 段内地址（含末址）应判定为私网', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
  });
  it('应判定公网 IPv6 为公网', () => {
    expect(isPrivateIp('2606:4700::1111')).toBe(false);
  });
  it('应判定十六进制形式的 IPv4-mapped 私网地址为私网（URL 规范化形态）', () => {
    // WHATWG URL 把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIp('::ffff:a00:1')).toBe(true); // 10.0.0.1
  });
});

describe('isLocalHostname', () => {
  it('localhost 及其子域应判定为本机', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('LOCALHOST')).toBe(true);
    expect(isLocalHostname('api.localhost')).toBe(true);
    expect(isLocalHostname('localhost.localdomain')).toBe(true);
  });
  it('普通域名不应判定为本机', () => {
    expect(isLocalHostname('example.com')).toBe(false);
    expect(isLocalHostname('notlocalhost.com')).toBe(false);
  });
});

describe('checkPublicUrl 协议与格式', () => {
  it('非 http/https 协议应拒绝', async () => {
    for (const url of ['ftp://example.com/hook', 'file:///etc/passwd', 'gopher://example.com']) {
      const result = await checkPublicUrl(url);
      expect(result.ok).toBe(false);
    }
  });
  it('格式无效应拒绝', async () => {
    expect((await checkPublicUrl('not-a-url')).ok).toBe(false);
    expect((await checkPublicUrl('')).ok).toBe(false);
  });
});

describe('checkPublicUrl 主机名校验', () => {
  it('localhost 应拒绝且不触网', async () => {
    const result = await checkPublicUrl('http://localhost:8080/hook');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('localhost');
  });
  it('子域 localhost 应拒绝', async () => {
    expect((await checkPublicUrl('http://api.localhost/hook')).ok).toBe(false);
  });
  it('私网 IPv4 字面量应拒绝', async () => {
    expect((await checkPublicUrl('http://127.0.0.1/hook')).ok).toBe(false);
    expect((await checkPublicUrl('http://10.1.2.3/hook')).ok).toBe(false);
    expect((await checkPublicUrl('http://192.168.1.100/hook')).ok).toBe(false);
    expect((await checkPublicUrl('http://172.20.0.5/hook')).ok).toBe(false);
    expect((await checkPublicUrl('http://169.254.169.254/latest/meta-data')).ok).toBe(false);
  });
  it('公网 IPv4 字面量应放行', async () => {
    const result = await checkPublicUrl('http://93.184.216.34/hook');
    expect(result.ok).toBe(true);
    expect(result.resolved).toEqual(['93.184.216.34']);
  });
  it('IPv6 环回字面量应拒绝', async () => {
    expect((await checkPublicUrl('http://[::1]/hook')).ok).toBe(false);
  });
  it('IPv4-mapped 环回字面量应拒绝', async () => {
    expect((await checkPublicUrl('http://[::ffff:127.0.0.1]/hook')).ok).toBe(false);
  });
});

describe('checkPublicUrl DNS rebinding 防护', () => {
  it('域名解析结果全为公网 IP 应放行', async () => {
    const result = await checkPublicUrl('https://example.com/hook', {
      lookup: fakeLookup(['93.184.216.34']),
    });
    expect(result.ok).toBe(true);
    expect(result.resolved).toEqual(['93.184.216.34']);
  });
  it('域名解析结果含任一私网 IP 应拒绝', async () => {
    const result = await checkPublicUrl('https://evil.example.com/hook', {
      lookup: fakeLookup(['93.184.216.34', '10.0.0.5']),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('私网');
  });
  it('域名解析为环回地址应拒绝', async () => {
    const result = await checkPublicUrl('https://rebind.example.com/hook', {
      lookup: fakeLookup(['127.0.0.1']),
    });
    expect(result.ok).toBe(false);
  });
  it('域名解析为 IPv6 私网地址应拒绝', async () => {
    const result = await checkPublicUrl('https://rebind6.example.com/hook', {
      lookup: fakeLookup(['fd00::5']),
    });
    expect(result.ok).toBe(false);
  });
  it('域名解析失败应拒绝', async () => {
    const result = await checkPublicUrl('https://nonexistent.example.com/hook', {
      lookup: async () => { throw new Error('ENOTFOUND'); },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('解析失败');
  });
  it('域名解析结果为空应拒绝', async () => {
    const result = await checkPublicUrl('https://empty.example.com/hook', {
      lookup: fakeLookup([]),
    });
    expect(result.ok).toBe(false);
  });
});
