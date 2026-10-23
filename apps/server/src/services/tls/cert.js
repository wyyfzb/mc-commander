/**
 * 内置 HTTPS：本地 CA + 服务端证书的生成、续用与信任检测。
 *
 * 面板默认监听一个端口同时接受明文与 TLS（首字节 0x16 分流），因此启用 HTTPS
 * 不需要用户新开端口或改防火墙——对「不碰终端」的用户，多一个要放行的端口
 * 等于多一道过不去的墙。
 *
 * CA 有效 100 年、服务端证书有效期跟随 CA：用户每台设备装一次根证书后，
 * 服务器换 IP / 换机器只需重签服务端证书，CA 指纹不变，客户端无需重装。
 * 这是「一劳永逸」的技术支点——换成需要周期性续期的公共证书，
 * 面板就会长出一条会自己坏掉的常驻链路（续期失败 = 面板直接打不开）。
 *
 * 证书生成走 openssl 子进程而非引入证书库：openssl 在目标发行版（Ubuntu/Debian/
 * CentOS）属基线包，部署脚本本就在用；缺它时内置 HTTPS 停用并说明原因，
 * 面板其余功能不受影响。
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../../config.js';
import { ensureDir } from '../../utils/fs-utils.js';
import { logger } from '../../utils/logger.js';

// CA 与服务端证书的有效期（天）。100 年：远超人、机器与证书链任一方的预期寿命，
// 等价于「不再续期」。取 36500 而非 99999 是避开部分客户端对超大 notAfter 的
// 溢出处理（32 位 time_t 上限约到 2038 年，现代 TLS 栈不受此限）。
const CERT_DAYS = 36500;

// CA 主题：出现在各平台「证书信任设置」列表里，必须让用户认得出这是什么
const CA_COMMON_NAME = 'MC Commander 面板本地 CA';

/** 证书目录（var/data/tls）：随面板数据目录一起被灾备覆盖 */
export function getTlsDir() {
  return path.join(config.dataDir, 'tls');
}

const caKeyPath = () => path.join(getTlsDir(), 'ca.key');
const caCertPath = () => path.join(getTlsDir(), 'ca.crt');
const serverKeyPath = () => path.join(getTlsDir(), 'server.key');
const serverCertPath = () => path.join(getTlsDir(), 'server.crt');

/** openssl 是否可用（不可用时内置 HTTPS 停用，面板其余功能照常） */
let opensslAvailable = null;
export function isOpensslAvailable() {
  if (opensslAvailable !== null) return opensslAvailable;
  const r = spawnSync('openssl', ['version'], { encoding: 'utf-8', timeout: 10_000 });
  opensslAvailable = r.status === 0;
  if (!opensslAvailable) {
    logger.warn('[TLS] 未找到 openssl 命令，内置 HTTPS 不可用（面板其余功能不受影响）');
  }
  return opensslAvailable;
}

/** 跑一条 openssl 子命令；失败时把 stderr 首行带进错误，便于部署排障 */
function runOpenssl(args, input) {
  const r = spawnSync('openssl', args, { encoding: 'utf-8', timeout: 30_000, input });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n')[0] || `exit=${r.status}`;
    throw new Error(`openssl ${args[0]} 失败：${detail}`);
  }
  return r.stdout;
}

/**
 * 本机全部可用地址（IPv4/IPv6 + 回环 + 主机名），作为服务端证书的 SAN。
 *
 * 必须把用户可能用的每种访问方式都签进去：面板是自托管的，用户既可能用
 * 公网 IP、也可能用内网 IP 或主机名访问，漏签哪一种，那一种就会撞上
 * 证书名称不匹配的红色拦截页——比不开 HTTPS 更劝退。
 * 换 IP 后由 ensureServerCert 重签，CA 不变。
 */
export function collectServerNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1', os.hostname()]);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list || []) {
        if (addr.address) names.add(addr.address);
      }
    }
  } catch {
    /* 网卡枚举失败不阻断：回环与主机名足够本机访问 */
  }
  // 部署时探测到的公网 IP（.env 的 PUBLIC_IP）是用户最可能粘贴的地址；
  // 与 mc_server 读同一个键，避免两处各自推导出不同的「这台机器是谁」
  const publicIp = process.env.PUBLIC_IP?.trim();
  if (publicIp) names.add(publicIp);
  return [...names].filter(Boolean);
}

/** 生成 subjectAltName 扩展内容 */
function sanExtension(names) {
  const entries = names.map((n) => {
    const v6 = n.includes(':');
    return v6 ? `IP:${n}` : /^\d+\.\d+\.\d+\.\d+$/.test(n) ? `IP:${n}` : `DNS:${n}`;
  });
  return `subjectAltName=${entries.join(',')}`;
}

/** 生成 CA（已存在则复用，绝不覆盖——覆盖会让所有已装过的设备全部失效） */
function ensureCa() {
  if (fs.existsSync(caKeyPath()) && fs.existsSync(caCertPath())) return;
  ensureDir(getTlsDir());
  runOpenssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    String(CERT_DAYS),
    '-keyout',
    caKeyPath(),
    '-out',
    caCertPath(),
    '-subj',
    `/CN=${CA_COMMON_NAME}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  // CA 私钥是全套信任的根：留在 0600，同组/其他用户不可读
  fs.chmodSync(caKeyPath(), 0o600);
  fs.chmodSync(caCertPath(), 0o644);
  logger.info('[TLS] 已生成本地面板 CA');
}

/**
 * 签发服务端证书（覆盖当前全部地址）。
 * 每次调用都重新生成密钥对：换 IP 后重签是常态，复用旧密钥没有收益，
 * 而旧密钥一旦泄露，重签正是把它换掉的机会。
 */
export function issueServerCert() {
  ensureCa();
  const names = collectServerNames();
  const extFile = path.join(getTlsDir(), 'san.cnf');
  fs.writeFileSync(
    extFile,
    [
      sanExtension(names),
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'),
  );
  const csrPath = path.join(getTlsDir(), 'server.csr');
  try {
    runOpenssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      serverKeyPath(),
      '-out',
      csrPath,
      '-subj',
      '/CN=MC Commander',
    ]);
    runOpenssl([
      'x509',
      '-req',
      '-in',
      csrPath,
      '-CA',
      caCertPath(),
      '-CAkey',
      caKeyPath(),
      '-CAcreateserial',
      '-out',
      serverCertPath(),
      '-days',
      String(CERT_DAYS),
      '-extfile',
      extFile,
    ]);
  } finally {
    // CSR 与 SAN 扩展是签发过程的中间物，留在目录里只会让用户困惑于该下载哪个
    for (const p of [csrPath, extFile]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* 未创建 */
      }
    }
  }
  fs.chmodSync(serverKeyPath(), 0o600);
  fs.chmodSync(serverCertPath(), 0o644);
  logger.info(`[TLS] 已签发面板证书（覆盖 ${names.length} 个地址）`);
  return { names };
}

/**
 * 现有服务端证书是否仍覆盖当前全部地址。
 * 不覆盖（换了 IP / 新网卡 / PUBLIC_IP 变更）时重签，CA 保持不变，
 * 已装过根证书的设备无需任何操作。
 */
export function ensureServerCert() {
  if (!fs.existsSync(serverCertPath()) || !fs.existsSync(serverKeyPath())) {
    issueServerCert();
    return { reissued: true, reason: 'missing' };
  }
  const names = collectServerNames();
  let cert;
  try {
    cert = new crypto.X509Certificate(fs.readFileSync(serverCertPath()));
  } catch (e) {
    logger.warn('[TLS] 现有证书无法解析，重新签发：', e.message);
    issueServerCert();
    return { reissued: true, reason: 'unparsable' };
  }
  // 逐个地址核对：subjectAltName 缺失任一当前地址，那个地址访问就会报名称不匹配。
  // checkIP 遇到主机名会抛「Invalid IP」，故两种判定各自兜住异常——
  // 抛错即「该形态不匹配」，交给另一种判定
  const covered = (n) => {
    try {
      if (cert.checkIP(n)) return true;
    } catch {
      /* 不是 IP：交给主机名判定 */
    }
    try {
      return cert.checkHost(n) !== undefined;
    } catch {
      return false;
    }
  };
  const missing = names.filter((n) => !covered(n));
  if (missing.length > 0) {
    issueServerCert();
    return { reissued: true, reason: 'address-changed', missing };
  }
  // 证书有效期短于 30 天也重签（正常不会发生：签发即 100 年）
  if (new Date(cert.validTo).getTime() - Date.now() < 30 * 86400_000) {
    issueServerCert();
    return { reissued: true, reason: 'expiring' };
  }
  return { reissued: false };
}

/** 读取证书材料供 https.createServer 使用；不可用时返回 null */
export function loadCertMaterial() {
  try {
    return {
      key: fs.readFileSync(serverKeyPath()),
      cert: fs.readFileSync(serverCertPath()),
    };
  } catch {
    return null;
  }
}

/** CA 证书 PEM 文本（供下载端点） */
export function readCaCert() {
  try {
    return fs.readFileSync(caCertPath(), 'utf-8');
  } catch {
    return null;
  }
}

/** 服务端证书的到期时间与覆盖地址；证书缺失或不可解析时两项为空 */
export function readServerCertFacts() {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(serverCertPath()));
    const san = cert.subjectAltName || '';
    return {
      expiresAt: new Date(cert.validTo).toISOString(),
      // subjectAltName 形如「DNS:a, IP Address:1.2.3.4」，剥掉类型前缀后
      // 与设置页展示的地址列表同形态
      serverNames: san ? san.split(/,\s*/).map((s) => s.replace(/^(DNS|IP Address):/, '')) : [],
    };
  } catch {
    return { expiresAt: null, serverNames: [] };
  }
}

/**
 * CA 证书的 SHA-256 指纹（大写冒号分隔，与 openssl x509 -fingerprint 同格式）。
 *
 * 用户在设备上导入根证书后，浏览器/系统里显示的指纹必须与面板这里给出的一致——
 * 这是判断「拿到的是不是本面板的 CA」的唯一手段，因此展示口径要与各平台的
 * 证书查看界面完全对齐，不能自创格式。
 */
export function caFingerprint() {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(caCertPath()));
    return cert.fingerprint256;
  } catch {
    return null;
  }
}
