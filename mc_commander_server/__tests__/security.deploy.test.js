import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
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

    it('不再内嵌预期 sha256（摘要改从同一 Release 现取）', () => {
      // 内嵌值会把安装版本钉死在脚本里，与 VERSION 默认 latest 自相矛盾（latest 每次取到的
      // 内容都不同，固定摘要必然错配）。故整个脚本不得再出现内嵌摘要与 64 位十六进制字面量
      expect(script).not.toContain('EXPECTED_PACKAGE_SHA256');
      expect(script).not.toContain('PACKAGE_SHA256=');
      expect(script).not.toMatch(/[0-9a-f]{64}/);
    });

    it('代码包与摘要同源：都从 RELEASE_BASE 派生', () => {
      // 摘要若来自别处，就只能防传输损坏、防不了资产被单方面替换
      expect(script).toContain('PACKAGE_URL="${PACKAGE_URL:-$RELEASE_BASE/$ASSET_NAME}"');
      expect(script).toContain('SHA256SUMS_URL="${SHA256SUMS_URL:-$RELEASE_BASE/SHA256SUMS.txt}"');
    });

    it('按下载地址的 basename 从摘要文件里取目标条目（自定义 URL 同样适用）', () => {
      expect(script).toContain('PKG_BASENAME=$(basename "$PACKAGE_URL")');
      expect(script).toMatch(/awk -v f="\$PKG_BASENAME"/);
    });

    it('摘要解析能吃两种 sha256sum 行格式（两空格 / 星号二进制前缀）', () => {
      // 直接执行脚本里的那个 awk，而不是在测试里复述一份——复述版会在脚本逻辑被改坏时依然全绿。
      // Git-bash 的 coreutils 实测输出 `*<file>` 二进制前缀，CI 的 GNU 版输出两空格，两种都要能取到
      const program = script.match(/awk -v f="\$PKG_BASENAME" '([^']+)'/)?.[1];
      expect(program).toBeTruthy();

      const runAwk = (sumsLines, assetName) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-sums-'));
        try {
          const sumsPath = path.join(dir, 'SHA256SUMS.txt');
          writeFileSync(sumsPath, sumsLines.join('\n') + '\n');
          const r = spawnSync(
            BASH_BIN,
            ['-c', `awk -v f='${assetName}' '${program}' '${sumsPath}'`],
            {
              encoding: 'utf8',
            },
          );
          expect(r.error).toBeUndefined();
          return r.stdout.trim();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };

      const asset = 'mc-commander-server.tar.gz';
      const hash = 'a'.repeat(64);

      // 两空格（CI/GNU 形态）
      expect(runAwk([`${hash}  ${asset}`], asset)).toBe(hash);
      // 星号二进制前缀（Git-bash 实测形态）
      expect(runAwk([`${hash} *${asset}`], asset)).toBe(hash);
      // 多资产条目：只取目标那个，不被别的条目带跑
      expect(runAwk([`${'b'.repeat(64)}  other.zip`, `${hash}  ${asset}`], asset)).toBe(hash);
      // 摘要里没有目标资产：必须取不到（调用方据此 fail-closed 中止）
      expect(runAwk([`${'b'.repeat(64)}  other.zip`], asset)).toBe('');
      // 自定义 PACKAGE_URL 的文件名同样能取到
      expect(runAwk([`${hash}  custom.tar.gz`], 'custom.tar.gz')).toBe(hash);
    });

    it('摘要中找不到目标资产即中止（不允许静默跳过校验）', () => {
      expect(script).toContain('SHA256SUMS.txt 中未找到 $PKG_BASENAME 的摘要条目');
      // 守卫必须发生在比对之前：若把比对包进 `[ -n "$EXPECTED_SHA256" ] && [ ... != ... ]`，
      // 漏条目时会静默跳过校验而不是中止——那等于没有校验
      expect(script).toMatch(
        /if \[ -z "\$EXPECTED_SHA256" \]; then[\s\S]*?exit 1\nfi\nACTUAL_SHA256=/,
      );
    });

    it('每一条清理路径都删除全部三个临时文件', () => {
      // 漏掉 TMP_SUMS 会在安装目录残留 .tmp_SHA256SUMS.txt；逐条断言，防止只锁住其中一条
      const rmLines = [...script.matchAll(/rm -rf [^\n]*TMP_TGZ[^\n]*/g)].map((m) => m[0]);
      expect(rmLines.length).toBeGreaterThanOrEqual(8);
      expect(rmLines.every((l) => l.includes('"$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"'))).toBe(true);
    });

    it('摘要下载失败也是 fail-closed（不能因取不到摘要就放行）', () => {
      const block = script.split('SHA256SUMS.txt 下载失败')[1];
      expect(block).toBeDefined();
      expect(block).toContain('exit 1');
      expect(block).toContain('rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"');
    });

    it('校验失败即中止并删除全部临时文件（fail-closed）', () => {
      const failBlock = script
        .split('代码包 sha256 校验失败')[1]
        ?.split('\n')
        .slice(0, 12)
        .join('\n');
      expect(failBlock).toBeDefined();
      expect(failBlock).toContain('exit 1');
      // 三个临时文件都必须清掉：漏掉 TMP_SUMS 会在安装目录残留 .tmp_SHA256SUMS.txt
      expect(failBlock).toContain('rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"');
      expect(failBlock).toContain('ACTUAL_SHA256');
    });

    it('VERSION 默认 latest，BRANCH 保留为兼容别名', () => {
      // latest 让部署零维护；BRANCH 是旧名，老用户 BRANCH=v1.2.0 形式的调用不能被打断
      expect(script).toContain('VERSION="${VERSION:-${BRANCH:-latest}}"');
      expect(script).not.toMatch(/BRANCH="\$\{BRANCH:-v\d+\.\d+\.\d+\}"/);
      expect(script).not.toContain('BRANCH="${BRANCH:-master}"');
    });

    it('latest 与显式 tag 走不同 download 前缀', () => {
      // releases/latest/download 无法预知 tag，故 latest 与显式 tag 必须分开拼前缀
      expect(script).toContain(
        'RELEASE_BASE="https://github.com/wyyfzb/mc-commander/releases/latest/download"',
      );
      expect(script).toContain(
        'RELEASE_BASE="https://github.com/wyyfzb/mc-commander/releases/download/$VERSION"',
      );
      expect(script).toMatch(/if \[ "\$VERSION" = "latest" \]; then/);
    });

    it('资产名固定不含 tag（否则 latest/download 不可用）', () => {
      expect(script).toContain('ASSET_NAME="mc-commander-server.tar.gz"');
      // 资产名不得再由版本号拼接而成
      expect(script).not.toMatch(/mc-commander-server-\$\{?[A-Za-z_]+\}?\.tar\.gz/);
      expect(script).not.toContain('mc-commander-server-${BRANCH}.tar.gz');
    });

    it('latest 取到无产物版本时，报错指向可执行动作', () => {
      expect(script).toContain('VERSION=latest 取到的最新发布版没有可用的 $ASSET_NAME 产物');
      expect(script).toContain('VERSION=<tag> 显式指定一个含产物的版本');
    });

    it('不含 gitee 镜像下载路径', () => {
      // mirror job 只推 tags 与 branches、不推 Release 资产，gitee 取预打包 tarball 的前提不成立
      expect(script.toLowerCase()).not.toContain('gitee');
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

  describe('SETUP_TOKEN 首访设密所有权证明（#309）', () => {
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

  describe('API Key 日志掩码（issue 324）', () => {
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
