/**
 * services/tls：内置 HTTPS 的证书生成、续用与单端口分流。
 *
 * 承重点（每条都对应一个会让用户走不下去的失败形态）：
 *  - CA 复用而非重签：CA 变了等于所有已装设备的信任作废，用户得重装一遍；
 *  - 地址变化触发重签：漏签的地址会撞上证书名称不匹配的整页红色拦截；
 *  - 有效期足够长：续期失败的直接后果是面板打不开（不是降级）；
 *  - 分流按首字节判定：判错会把 TLS 握手交给明文解析器，连接直接断。
 *
 * 这些用例跑真实 openssl 子进程（依赖在目标发行版属基线包）；缺 openssl 的环境
 * 整组跳过而不是伪装成通过——跳过会显式可见，假装通过不会。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const hasOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf-8' }).status === 0;
const suite = hasOpenssl ? describe : describe.skip;

describe('mux 分流判定', () => {
  it('首字节 0x16 判为 TLS，其余判为明文', async () => {
    const { createProtocolMux } = await import('../src/services/tls/mux.js');
    const seen = [];
    const mux = createProtocolMux(
      () => seen.push('plain'),
      () => seen.push('tls'),
    );
    await new Promise((r) => mux.listen(0, '127.0.0.1', r));
    const port = mux.address().port;

    const send = (bytes) =>
      new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(Buffer.from(bytes)));
        sock.on('error', () => {});
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 60);
      });

    await send([0x16, 0x03, 0x01, 0x00, 0x05]); // TLS handshake 记录头
    await send('GET / HTTP/1.1\r\n\r\n'); // 明文
    await new Promise((r) => setTimeout(r, 120));
    mux.close();

    expect(seen).toEqual(['tls', 'plain']);
  });
});

suite('services/tls 证书生命周期', () => {
  let tmpDir;
  let cert;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-tls-'));
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    cert = await import('../src/services/tls/cert.js');
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('首次调用生成 CA 与服务端证书，两者有效期都是 100 年量级', () => {
    cert.issueServerCert();
    const ca = new crypto.X509Certificate(fs.readFileSync(path.join(cert.getTlsDir(), 'ca.crt')));
    const leaf = new crypto.X509Certificate(
      fs.readFileSync(path.join(cert.getTlsDir(), 'server.crt')),
    );
    const years = (iso) => (new Date(iso).getTime() - Date.now()) / (365 * 86400_000);
    // 100 年：远超人/机器/证书链任一方的预期寿命，等价于「不再续期」
    expect(years(ca.validTo)).toBeGreaterThan(90);
    expect(years(leaf.validTo)).toBeGreaterThan(90);
    // 服务端证书必须由本 CA 签发，否则客户端会判不受信
    expect(leaf.checkIssued(ca)).toBe(true);
  });

  it('再次调用复用同一个 CA（CA 变了等于作废全部已装设备的信任）', () => {
    const before = cert.caFingerprint();
    cert.issueServerCert();
    expect(cert.caFingerprint()).toBe(before);
  });

  it('服务端证书覆盖当前全部本机地址（漏签的地址会撞名称不匹配）', () => {
    const leaf = new crypto.X509Certificate(
      fs.readFileSync(path.join(cert.getTlsDir(), 'server.crt')),
    );
    for (const name of cert.collectServerNames()) {
      const ok = /^[\d.]+$|:/.test(name) ? leaf.checkIP(name) : leaf.checkHost(name);
      expect(ok, name).toBeTruthy();
    }
  });

  it('地址未变时不重签（避免每次重启都换密钥）', () => {
    const r = cert.ensureServerCert();
    expect(r.reissued).toBe(false);
  });

  it('私钥落 0600、证书 0644（私钥可读即可冒充面板）', () => {
    const mode = (f) => fs.statSync(path.join(cert.getTlsDir(), f)).mode & 0o777;
    expect(mode('ca.key')).toBe(0o600);
    expect(mode('server.key')).toBe(0o600);
    expect(mode('ca.crt')).toBe(0o644);
  });

  it('CA 指纹为 SHA-256 冒号分隔格式（与各平台证书查看界面同口径）', () => {
    expect(cert.caFingerprint()).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('证书缺失时 ensureServerCert 重新签发并报告原因', () => {
    fs.rmSync(path.join(cert.getTlsDir(), 'server.crt'));
    const r = cert.ensureServerCert();
    expect(r).toMatchObject({ reissued: true, reason: 'missing' });
    expect(cert.readServerCertFacts().expiresAt).toBeTruthy();
  });
});
