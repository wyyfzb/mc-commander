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

describe('deploy-mc-commander.sh 安全修复回归', () => {
  it('脚本语法检查通过（bash -n）', () => {
    const result = spawnSync('bash', ['-n', SCRIPT_PATH], { encoding: 'utf8' });
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
      const failBlock = script.split('代码包 sha256 校验失败')[1]?.split('\n').slice(0, 10).join('\n');
      expect(failBlock).toBeDefined();
      expect(failBlock).toContain('exit 1');
      expect(failBlock).toContain('rm -rf "$TMP_TGZ" "$TMP_EXTRACT"');
    });

    it('PACKAGE_URL 默认锁定具体 tag 而非可变 master 分支', () => {
      // 默认分支变量不再是 master
      expect(script).toContain('BRANCH="${BRANCH:-v0.1.0}"');
      expect(script).not.toContain('BRANCH="${BRANCH:-master}"');
      // 默认 PACKAGE_URL 使用 BRANCH 变量（因此默认解析为固定 tag 的 GitHub Release 资产）
      expect(script).toContain('PACKAGE_URL="${PACKAGE_URL:-https://github.com/wyyfzb/mc-commander/releases/download/${BRANCH}/mc-commander-server-${BRANCH}.tar.gz}"');
    });

    it('保留 BRANCH / PACKAGE_SHA256 环境变量覆盖能力', () => {
      expect(script).toContain('BRANCH="${BRANCH:-v0.1.0}"');
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
});
