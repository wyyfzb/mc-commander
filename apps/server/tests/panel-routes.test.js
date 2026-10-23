import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';

vi.mock('../src/config.js', () => ({
  default: {
    rootDir: '/opt/mc-commander',
    get serversDir() {
      return path.join(globalThis.__testRoot ?? '/tmp/none', 'servers');
    },
    get dataDir() {
      return path.join(globalThis.__testRoot ?? '/tmp/none', 'data');
    },
    get backupsDir() {
      return path.join(globalThis.__testRoot ?? '/tmp/none', 'backups');
    },
  },
}));

vi.mock('../src/utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: { PANEL_STOP: 'PANEL_STOP', PANEL_EXPORT: 'PANEL_EXPORT' },
}));

// 账号与第二因子由用例控制：密码校验用固定口令，2FA 开关决定是否要动态口令
const mockAccount = { password_hash: 'right', totp_enabled: false };
vi.mock('../src/db/index.js', () => ({
  AdminAccountModel: {
    get: () => mockAccount,
    getTotpState: () => ({ enabled: mockAccount.totp_enabled, secret: null, lastStep: 0 }),
    setTotpLastStep: vi.fn(),
  },
  AdminRecoveryCodeModel: { verifyAndConsume: () => false },
}));

vi.mock('../src/utils/password.js', () => ({
  verifyPassword: (plain, hash) => plain === hash,
}));

vi.mock('../src/utils/totp.js', () => ({
  verifyTotpCode: () => ({ ok: false }),
  normalizeTotpCode: () => null,
}));

const { createPanelRoutes } = await import('../src/routes/panel.js');

/**
 * 用假 sudo 替换 PATH 里的那个：真实 sudo 的行为取决于这台机器装了什么、是不是 root，
 * 断言会随环境变。假 sudo 把收到的参数写文件并按指定退出码返回，两个分支都能稳定复现。
 */
function withFakeSudo({ status = 0, stderr = '' } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sudo-'));
  const argvFile = path.join(bin, 'argv');
  fs.writeFileSync(
    path.join(bin, 'sudo'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvFile}"\nprintf '%s' "${stderr}" >&2\nexit ${status}\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  return {
    argv: () => fs.readFileSync(argvFile, 'utf8').trim().split('\n'),
    restore: () => {
      process.env.PATH = originalPath;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

let root;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createPanelRoutes());
  return app;
}

describe('面板去留端点', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-routes-'));
    globalThis.__testRoot = root;
    mockAccount.totp_enabled = false;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete globalThis.__testRoot;
  });

  it('GET /panel/data 返回三项数据清点', async () => {
    const res = await request(buildApp()).get('/api/panel/data');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.items.map((i) => i.key)).toEqual(['servers', 'data', 'backups']);
  });

  it('没有任何数据时导出返回 404 并说明原因', async () => {
    const res = await request(buildApp()).get('/api/panel/export');
    expect(res.status).toBe(404);
    // 空目录上给出可下载的空包，用户会以为备份成功
    expect(res.body.message).toContain('没有可导出的数据');
  });

  it('有实例数据时导出返回 gzip 流', async () => {
    fs.mkdirSync(path.join(root, 'servers', 'inst-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'servers', 'inst-1', 'server.jar'), 'jar-bytes');
    const res = await request(buildApp()).get('/api/panel/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('gzip');
    expect(res.headers['content-disposition']).toContain('mc-commander-backup-');
  });

  it('POST /panel/stop 先回确认文案（停服务在响应之后）', async () => {
    const res = await request(buildApp()).post('/api/panel/stop').send({});
    expect(res.status).toBe(200);
    // 先停会让用户拿不到这句确认，只看到连接中断
    expect(res.body.message).toContain('数据全部保留');
  });

  it('GET /panel/removal-preview 给出 2FA 状态与数据清单', async () => {
    const res = await request(buildApp()).get('/api/panel/removal-preview');
    expect(res.status).toBe(200);
    expect(res.body.data.totpEnabled).toBe(false);
    expect(res.body.data.items).toHaveLength(3);
  });

  /* 面板可能在公网，一次误点就删光存档：三道确认缺一不可 */
  it('未给密码 → 401，不触发清理', async () => {
    const res = await request(buildApp())
      .post('/api/panel/removal')
      .send({ confirmText: '彻底删除' });
    expect(res.status).toBe(401);
  });

  it('确认文本不对 → 400，不触发清理', async () => {
    const res = await request(buildApp())
      .post('/api/panel/removal')
      .send({ password: 'right', confirmText: '删除' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('彻底删除');
  });

  it('配了 2FA 但没给验证码 → 401', async () => {
    mockAccount.totp_enabled = true;
    const res = await request(buildApp())
      .post('/api/panel/removal')
      .send({ password: 'right', confirmText: '彻底删除' });
    expect(res.status).toBe(401);
  });

  /* 删除触发失败必须当场回错：回「已开始清理」而实际没动，用户会一直等一个不会来的结果 */
  it('删除执行单元缺失 → 500 且说明该走哪条路，不回成功文案', async () => {
    const fake = withFakeSudo({
      status: 5,
      stderr:
        'Failed to start mc-commander-removal.service: Unit mc-commander-removal.service not found.',
    });
    try {
      const res = await request(buildApp())
        .post('/api/panel/removal')
        .send({ password: 'right', confirmText: '彻底删除' });
      expect(res.status).toBe(500);
      expect(res.body.message).not.toContain('已开始清理');
      expect(res.body.message).toContain('--uninstall');
    } finally {
      fake.restore();
    }
  });

  it('sudo 白名单缺失 → 500 且指出是权限问题', async () => {
    const fake = withFakeSudo({ status: 1, stderr: 'sudo: a password is required' });
    try {
      const res = await request(buildApp())
        .post('/api/panel/removal')
        .send({ password: 'right', confirmText: '彻底删除' });
      expect(res.status).toBe(500);
      expect(res.body.message).toContain('sudo');
    } finally {
      fake.restore();
    }
  });

  it('触发成功才回「已开始清理」，且用 --no-block 让 oneshot 单元不阻塞', async () => {
    const fake = withFakeSudo();
    try {
      const res = await request(buildApp())
        .post('/api/panel/removal')
        .send({ password: 'right', confirmText: '彻底删除' });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('已开始清理');
      expect(fake.argv()).toEqual([
        '-n',
        '/usr/bin/systemctl',
        'start',
        '--no-block',
        'mc-commander-removal.service',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('勾了保留存档 → 指向 keep 单元', async () => {
    const fake = withFakeSudo();
    try {
      await request(buildApp())
        .post('/api/panel/removal')
        .send({ password: 'right', confirmText: '彻底删除', keepData: true });
      expect(fake.argv()).toContain('mc-commander-removal-keep.service');
    } finally {
      fake.restore();
    }
  });
});

/* 面板删完之后，用户机器上还剩什么由清理脚本决定。这里直接跑脚本本体：
   只断言脚本里有某段字符串，写错逻辑照样全绿 */
const REPO = path.resolve(import.meta.dirname, '../../..');
const REMOVAL = path.join(REPO, 'apps/server/src/services/panel-removal.sh');
const BASH_BIN = process.env.BASH_BIN || 'bash';

function runRemoval(installDir, mode = '--keep-data', tmpDir, extraEnv) {
  // 临时目录也要指向沙箱：脚本按 TMPDIR 收安装清单残件，不隔离就会动到真实的 /tmp
  const r = spawnSync(BASH_BIN, [REMOVAL, mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MC_COMMANDER_DIR: installDir,
      TMPDIR: tmpDir ?? os.tmpdir(),
      // 软件源文件的合法目录也是沙箱：否则用例只能靠 /etc 下的真实文件验证，
      // 而它非 root 写不了，判定对不对都测不出来
      REPO_FILE_ROOTS: installDir,
      ...extraEnv,
    },
  });
  if (r.error) throw new Error(`无法启动 bash（${BASH_BIN}）：${r.error.message}`);
  return { status: r.status, out: r.stdout + r.stderr };
}

describe('清理脚本收尾本项目自己的残留', () => {
  let dir;
  let tmpHome;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-removal-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-tmp-'));
    // 安装目录里放一个能跑的最小骨架，脚本走完 keep-data 分支不碰系统
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('清掉装包阶段留在临时目录里的安装清单残件', () => {
    // 安装中途失败时 mktemp 出来的清单留在 /tmp，内容是「这台机器装了什么」
    const leftover = path.join(tmpHome, 'mc-commander-manifest.Ab12Cd');
    fs.writeFileSync(leftover, 'pkg-installed\topenjdk-17-jre-headless\n');
    const keep = path.join(tmpHome, 'unrelated-file');
    fs.writeFileSync(keep, 'x');

    const r = runRemoval(dir, '--keep-data', tmpHome);
    expect(r.status).toBe(0);
    expect(fs.existsSync(leftover)).toBe(false);
    // 只按本项目的前缀收：同目录下别人的文件不能被带走
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('按清单里的 repo-file 撤掉第三方软件源与密钥', () => {
    // 两个文件都落在沙箱的软件源根目录下：路径形态与生产一致（/etc/apt/sources.list.d 或
    // /usr/share/keyrings 下的 .list / .gpg），只是根换成了临时目录
    const keyring = path.join(dir, 'corretto-keyring.gpg');
    const aptList = path.join(dir, 'corretto.list');
    fs.writeFileSync(keyring, 'key');
    fs.writeFileSync(aptList, 'deb ...');
    fs.writeFileSync(
      path.join(dir, '.install-manifest'),
      `repo-file\t${keyring}\nrepo-file\t${aptList}\n`,
    );

    const r = runRemoval(dir);
    expect(r.status).toBe(0);
    expect(fs.existsSync(keyring)).toBe(false);
    expect(fs.existsSync(aptList)).toBe(false);
  });

  it('repo-file 只删软件源目录内的文件，清单里的任意路径一律不动', () => {
    // 清单是可写文件：把值当无条件 rm 的入参，等于给「清单被改过」开了删任意文件的口子。
    // 世界存档不在软件源目录内，这正是要拦的那一类。
    const victim = path.join(tmpHome, 'servers/world/level.dat');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'world');
    fs.writeFileSync(path.join(dir, '.install-manifest'), `repo-file\t${victim}\n`);

    const r = runRemoval(dir);
    expect(r.status).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);
    // 拒绝要说出来，不能静默跳过——用户以为清理了，实际文件还在
    expect(r.out).toContain('清单外路径');
  });

  it('repo-file 的值带上跳段时拒绝执行，不允许穿出软件源目录', () => {
    // 用字符串拼而不是 path.join：join 会把 .. 归一化掉，那样测的就不是上跳段本身了。
    // 这个形态真的会越界——rm -f <root>/../../shadow 删的是 /etc/shadow
    const escape = `${dir}/../escape.list`;
    const victim = path.resolve(escape);
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'x');
    fs.writeFileSync(path.join(dir, '.install-manifest'), `repo-file\t${escape}\n`);

    const r = runRemoval(dir);
    expect(r.status).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);
    expect(r.out).toContain('清单外路径');
  });

  it('清单里的包名只按名字传给包管理器，不被拆成额外参数', () => {
    // 清单在面板可写的安装目录内：一行 -o DPkg::Pre-Invoke::=… 就能把面板权限提成 root
    const bin = path.join(tmpHome, 'bin');
    const argvFile = path.join(tmpHome, 'apt-argv');
    const pwned = path.join(tmpHome, 'pwned');
    fs.mkdirSync(bin, { recursive: true });
    // 假 apt-get：记下收到的每个参数，便于断言包名是逐个传入而不是被拆开
    fs.writeFileSync(
      path.join(bin, 'apt-get'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvFile}"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(dir, '.install-manifest'),
      `pkg-installed\topenjdk-17-jre-headless\npkg-installed\t-o\npkg-installed\tDPkg::Pre-Invoke::=touch ${pwned}\n`,
    );

    const r = runRemoval(dir, '--keep-data', tmpHome, {
      PATH: `${bin}:${process.env.PATH}`,
      argvFile,
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
      'remove',
      '-y',
      '--purge',
      'openjdk-17-jre-headless',
    ]);
    expect(fs.existsSync(pwned)).toBe(false);
  });
});
