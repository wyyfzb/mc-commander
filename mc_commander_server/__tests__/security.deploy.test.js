import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 部署脚本安全回归测试（下载完整性 / systemd 低权限 / NODE_ENV 门控）
// 部署脚本是 bash 发布脚本，不直接执行（避免真实安装副作用），
// 采用 bash -n 语法检查 + 静态断言验证安全修复点。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../scripts/deploy-mc-commander.sh');
const script = readFileSync(SCRIPT_PATH, 'utf8');

// bash 定位：Git for Windows 的 bash 常不在 PATH 上（可执行文件在 <Git 安装目录>/usr/bin/bash.exe），
// 故支持 BASH_BIN 指定绝对路径；缺省按 PATH 查找。
const BASH_BIN = process.env.BASH_BIN || 'bash';

/**
 * 运行 bash，并在**无法启动**（ENOENT 等）时抛出带指引的错误。
 * 归因约束：spawnSync 启动失败时 status=null 且 error 有值，若只断言 status===0，
 * 报错显示为「expected null to be +0」——把「本机没有 bash」误读成「脚本有语法错误」。
 * 故启动失败必须先单独归因，并把处置办法写进错误信息。
 */
function runBash(args) {
  const result = spawnSync(BASH_BIN, args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `无法启动 bash（${BASH_BIN}）：${result.error.code || result.error.message}。` +
        '这是本机环境缺失，不是 deploy-mc-commander.sh 的问题。' +
        '处置：把 Git 安装目录下的 usr/bin（或 bin）加入 PATH，' +
        '或用 BASH_BIN 指定绝对路径重跑，例如：BASH_BIN=<Git 安装目录>/bin/bash.exe npm test',
    );
  }
  return result;
}

describe('deploy-mc-commander.sh 安全修复回归', () => {
  it('脚本语法检查通过（bash -n）', () => {
    const result = runBash(['-n', SCRIPT_PATH]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  describe('下载完整性', () => {
    it('移除第三方 nodesource curl|bash 引导脚本', () => {
      expect(script).not.toContain('deb.nodesource.com');
      // 不允许任何 "curl ... | bash" 形式的管道执行（注释中的用法示例除外，单独排除）
      const execPipes = script
        .split('\n')
        .filter((line) => line.includes('| bash') && !line.trim().startsWith('#'));
      expect(execPipes).toHaveLength(0);
    });

    it('内嵌预期 sha256（64 位十六进制）并在下载后强制校验', () => {
      const match = script.match(/EXPECTED_PACKAGE_SHA256="\$\{PACKAGE_SHA256:-([0-9a-f]{64})\}"/);
      expect(match).not.toBeNull();
      expect(script).toContain('sha256sum "$TMP_TGZ" | awk');
      expect(script).toContain('if [ "$ACTUAL_SHA256" != "$EXPECTED_PACKAGE_SHA256" ]');
    });

    it('校验失败即中止并删除临时文件（fail-closed）', () => {
      const failBlock = script
        .split('代码包 sha256 校验失败')[1]
        ?.split('\n')
        .slice(0, 10)
        .join('\n');
      expect(failBlock).toBeDefined();
      expect(failBlock).toContain('exit 1');
      expect(failBlock).toContain('rm -rf "$TMP_TGZ" "$TMP_EXTRACT"');
    });

    it('PACKAGE_URL 默认锁定具体 tag 而非可变 master 分支', () => {
      // 默认分支变量不再是 master；默认值锁定具体发布 tag（版本随 Release 回写演进，按模式断言防漂移）
      expect(script).toMatch(/BRANCH="\$\{BRANCH:-v\d+\.\d+\.\d+\}"/);
      expect(script).not.toContain('BRANCH="${BRANCH:-master}"');
      // 默认 PACKAGE_URL 使用 BRANCH 变量（因此默认解析为固定 tag 的 GitHub Release 资产）
      expect(script).toContain(
        'PACKAGE_URL="${PACKAGE_URL:-https://github.com/wyyfzb/mc-commander/releases/download/${BRANCH}/mc-commander-server-${BRANCH}.tar.gz}"',
      );
    });

    it('保留 BRANCH / PACKAGE_SHA256 环境变量覆盖能力', () => {
      expect(script).toMatch(/BRANCH="\$\{BRANCH:-v\d+\.\d+\.\d+\}"/);
      expect(script).toMatch(/EXPECTED_PACKAGE_SHA256="\$\{PACKAGE_SHA256:-/);
    });
  });

  describe('Node.js 安装不执行未校验引导脚本', () => {
    it('优先使用发行版官方源安装 Node.js', () => {
      expect(script).toContain('install_pkg nodejs npm');
      expect(script).toMatch(/先尝试发行版官方源/);
    });

    it('兜底使用官方二进制包并校验 SHASUMS256.txt', () => {
      expect(script).toContain('SHASUMS256.txt');
      expect(script).toContain('sha256sum "$tmp_dir/$file"');
      expect(script).toContain('Node.js 二进制包 sha256 校验失败');
      // 固定版本号默认可被 NODE_VERSION 环境变量覆盖
      expect(script).toContain('NODE_VERSION="${NODE_VERSION:-v22.');
    });
  });

  describe('systemd 低权限运行', () => {
    it('systemd unit 不再以 root 运行', () => {
      expect(script).not.toContain('User=root');
      expect(script).toContain('User=mc-commander');
    });

    it('创建专用低权限用户并移交目录属主', () => {
      expect(script).toContain('useradd --system');
      expect(script).toContain('mc-commander');
      expect(script).toContain('chown -R mc-commander:mc-commander');
    });

    it('安装完成后给出降权说明', () => {
      expect(script).toContain('服务以专用低权限用户 mc-commander 运行');
    });
  });

  describe('NODE_ENV 门控确定化', () => {
    it('systemd unit 设置 Environment=NODE_ENV=production', () => {
      expect(script).toContain('Environment=NODE_ENV=production');
    });

    it('pm2 与 nohup 分支同样显式设置 NODE_ENV=production', () => {
      expect(script).toContain('NODE_ENV=production pm2 start index.js');
      expect(script).toContain('NODE_ENV=production nohup node index.js');
    });
  });

  it('原有 gzip 魔术字节校验与 package.json 结构校验仍保留', () => {
    expect(script).toContain('GZ_MAGIC');
    expect(script).toContain('1f8b');
    expect(script).toContain('解压后未找到 package.json');
  });

  describe('SETUP_TOKEN 首访设密所有权证明（audit S-P0-1 / #309）', () => {
    it('首次部署生成一次性 SETUP_TOKEN（openssl rand -hex 32）并写入 .env', () => {
      expect(script).toContain('SETUP_TOKEN=$(openssl rand -hex 32)');
      expect(script).toContain('SETUP_TOKEN=$SETUP_TOKEN');
    });

    it('部署完成输出展示 SETUP_TOKEN（与 API Key 同位置）并说明一次性语义', () => {
      // 横幅里 token/Key 独占一行原样输出（值长 64/76 字符，塞不进带右边框的一行）
      expect(script).toContain('► SETUP_TOKEN');
      expect(script).toContain('echo "║     $SETUP_TOKEN"');
      expect(script).toContain('用后作废');
    });

    it('令牌仅在本次生成时展示（更新部署不重复暴露一次性凭据）', () => {
      // 更新分支不读取/不生成 SETUP_TOKEN（仅首启 .env 创建时生成），banner 有值才打印
      expect(script).toContain('SETUP_TOKEN=""');
      expect(script).toMatch(/if \[ -n "\$SETUP_TOKEN" \]; then/);
    });
  });

  describe('API Key 日志掩码（audit P2-10 / issue 324）', () => {
    it('首次部署 log 行不再完整打印 Key（掩码保留前 4 位）', () => {
      // 「已生成 API Key」日志必须走掩码，防完整 Key 进入部署日志长期留存
      expect(script).toMatch(/已生成 API Key: \$\{API_KEY:0:4\}\*\*\*\*/);
      expect(script).not.toMatch(/已生成 API Key: \$API_KEY/);
    });

    it('完整 Key 仅在部署完成横幅一次性展示（交付通道保留）', () => {
      // 横幅的独占行 echo 是唯一完整展示点（用户取 Key 的交付通道，有意保留）
      expect(script).toContain('► API Key');
      expect(script).toContain('echo "║     $API_KEY"');
    });
  });
});
