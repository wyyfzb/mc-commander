import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivateIp } from '../src/utils/url-guard.js';
// 安装侧的唯一事实源：卸载清单要与之对拍，任一侧漂移都会红
import { PAYLOAD } from '../../../tools/deploy/stage-payload.mjs';

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
  /**
   * 取 sudoers 规则正文（那行 ALL=(root) NOPASSWD:）。
   *
   * 锚点找不到时抛错而不是返回空串：空串上的 toContain / not.toMatch 永远通过，
   * 脚本形态一改断言就静默失效——曾因锚点指向已删除的变量名而假绿。
   */
  function sudoersRule() {
    const at = script.indexOf('cat > /etc/sudoers.d/mc-commander <<EOF');
    expect(at, '未能在部署脚本中定位 sudoers 白名单').toBeGreaterThan(-1);
    const end = script.indexOf('\nEOF', at);
    expect(end, '未能在部署脚本中定位 sudoers 白名单结尾').toBeGreaterThan(at);
    const line = script
      .slice(at, end)
      .split('\n')
      .find((l) => l.includes('NOPASSWD:'));
    expect(line, '白名单里没有 NOPASSWD 规则').toBeTruthy();
    return line;
  }

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

    it('latest 下载失败时，报错指向可执行动作', () => {
      // 文案须说「从发布版下载代码包失败」并在同一句交代「两个源都试过」——
      // 只说「网络到 GitHub 不稳定」会误导用户去排查一个已不成立的假设
      expect(script).toContain('从发布版下载代码包失败');
      expect(script).toContain('两个源');
      expect(script).toContain('显式指定版本');
      // 出路必须包含「自行取包 + SKIP_DOWNLOAD」——弱网下这是用户唯一的自助手段
      expect(script).toContain('SKIP_DOWNLOAD=1 bash deploy-mc-commander.sh');
    });

    it('报错分支按「用户是否显式设过 PACKAGE_URL」分流，不用变量非空判定', () => {
      // 回归点：默认值赋值会让 PACKAGE_URL 恒非空，`[ -n "$PACKAGE_URL" ]` 恒真，
      // 于是默认安装失败时用户被告知「自定义 PACKAGE_URL 下载失败」——而他从没设过，
      // 真正有用的 VERSION=<tag> 提示被吞成死代码。
      expect(script).toContain('CUSTOM_PACKAGE_URL=0');
      expect(script).toMatch(/\[ -n "\$\{PACKAGE_URL:-\}" \] && CUSTOM_PACKAGE_URL=1/);
      expect(script).toContain('[ "$CUSTOM_PACKAGE_URL" -eq 1 ]');
      expect(script).not.toMatch(/if \[ -n "\$\{PACKAGE_URL:-\}" \]; then/);
    });

    it('每处代码包/摘要下载都走带停滞检测与续传的封装', () => {
      // 回归点：--connect-timeout 只管建连，连上后零字节会无限挂死（实测 197s 不退出）。
      // 故依赖下载必须经 download_with_resume（内含 --speed-limit/--speed-time 与 -C -）
      expect(script).toContain('download_with_resume()');
      expect(script).toMatch(/--speed-limit 1024 --speed-time 60/);
      expect(script).toMatch(/-C -/);
      // 主下载点与摘要下载点都必须走封装，不得残留裸 curl 直下
      expect(script).not.toMatch(/curl -fSL --connect-timeout 15 --retry 2 -o "\$TMP_TGZ"/);
      expect(script).not.toMatch(/curl -fSL --connect-timeout 15 --retry 2 -o "\$TMP_SUMS"/);
    });

    it('SKIP_DOWNLOAD 开关存在且校验代码完整性（缺 package.json/index.js 即失败）', () => {
      expect(script).toContain('SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-0}"');
      expect(script).toMatch(/\[ "\$SKIP_DOWNLOAD" = "1" \]/);
      expect(script).toMatch(
        /-f "\$MC_COMMANDER_DIR\/package\.json" \] && \[ -f "\$MC_COMMANDER_DIR\/src\/index\.js" \]/,
      );
    });

    it('给出的 sudo 用法把变量写在 sudo 之后（写在前面会被 env_reset 丢掉）', () => {
      // `VERSION=x sudo cmd` 只给 sudo 自己设了变量，sudo 默认 env_reset 会丢掉它，
      // 脚本仍按 latest 跑——用户以为指定了版本、实际没有，属静默失效。
      // 只看真正会被打印的 err 行：注释里会引用反面写法当例子，不能一并算进去
      const hintLines = script
        .split('\n')
        .filter((l) => l.trim().startsWith('err '))
        .join('\n');
      expect(hintLines).not.toMatch(/VERSION=\S+\s+sudo/);
      expect(hintLines).toMatch(/sudo VERSION=\S+ bash/);
    });

    // 这里不禁止脚本出现 gitee——release.yml 的 sync-gitee job 会把产物与 SHA256SUMS 一并
    // 同步到 Gitee（仓库镜像不同步 release，所以必须由 workflow 显式上传附件）。
    // 要守的性质是「默认下载源」与「权威兜底」各是谁，不是「脚本里能不能出现 gitee」。
    it('默认首选 Gitee（用户实际链路在国内），GitHub 仍作权威兜底', () => {
      // 权威源仍是 GitHub（CI 构建产物 + Immutable Releases 签名），Gitee 只是分发镜像；
      // 但**默认下载源**是 Gitee：用户链路在国内，实测两者相差约 460 倍。
      expect(script).toContain('SOURCE_PREFERENCE="${SOURCE_PREFERENCE:-gitee}"');
      expect(script).toMatch(/RELEASE_BASE="https:\/\/github\.com\/wyyfzb\/mc-commander/);
      // 兜底必须存在且可探：Gitee 不可用时回 GitHub（latest 直接可用，无需解析 tag）
      expect(script).toMatch(/use_github\(\) \{/);
      // 兼容别名：ALLOW_GITEE_FALLBACK=0 等价于强制首选 GitHub
      expect(script).toContain(
        '[ "${ALLOW_GITEE_FALLBACK:-}" = "0" ] && SOURCE_PREFERENCE="github"',
      );
    });

    it('两个源切向对称：use_github 与 use_gitee 都先探资产、再同源改写两个地址', () => {
      // 方向翻转后，兜底那一侧（GitHub）承担与 use_gitee 完全相同的两条不变式：
      // ① 不探测就切，会把「原源还能装上」的场景做成 404 失败；② 摘要与包跨源 = 没校验。
      for (const fn of [
        script.match(/use_github\(\) \{[\s\S]*?\n\}/),
        script.match(/use_gitee\(\) \{[\s\S]*?\n\}/),
      ]) {
        expect(fn, '切源函数未找到').toBeTruthy();
        expect(fn[0]).toContain('source_reachable');
        expect(fn[0]).toContain('PACKAGE_URL=');
        expect(fn[0]).toContain('SHA256SUMS_URL=');
        expect(fn[0]).toMatch(/return 1/);
      }
    });

    it('Gitee 源不允许出现 releases/latest/download（该路径在 Gitee 实测 404）', () => {
      // Gitee 会把 latest 当 archive ref：302 到 repository/archive/latest/download/... 再 404，
      // 即使该版本确实有 release。故 latest 必须先用匿名 API 解析出真实 tag。
      const giteeBase = script.match(/echo "https:\/\/gitee\.com\/[^"]*"/g) || [];
      for (const line of giteeBase) {
        expect(line).not.toContain('releases/latest/download');
      }
      expect(script).toContain('gitee_release_base');
      expect(script).toContain('$GITEE_API/releases/latest');
    });

    it('切换前先确认目标源真有产物（否则会把能装上的场景做成失败）', () => {
      // Gitee 的 release 可能只有元数据而无附件（手工占位建的、或同步尚未跑过）。
      // 切过去必然 404，而留在原源重试或许能成功 ⇒ use_gitee 必须先探测资产可达性。
      const fn = script.match(/use_gitee\(\) \{[\s\S]*?\n\}/);
      expect(fn, 'use_gitee 未找到').toBeTruthy();
      expect(fn[0]).toContain('source_reachable "$base/$ASSET_NAME"');
      expect(fn[0]).toMatch(/return 1/);
    });

    it('切换源时包与摘要必须同源（跨源校验同一版本的前提）', () => {
      // 摘要只是校验输入，但「包来自 A、摘要来自 B」会让校验失去意义
      // （B 的摘要在原理上无法证明 A 的字节正确）。use_gitee 必须同时改两个 URL。
      const fn = script.match(/use_gitee\(\) \{[\s\S]*?\n\}/);
      expect(fn, 'use_gitee 未找到').toBeTruthy();
      expect(fn[0]).toContain('PACKAGE_URL="$base/$ASSET_NAME"');
      expect(fn[0]).toContain('SHA256SUMS_URL="$base/SHA256SUMS.txt"');
    });

    it('跨源重试前删除半截文件（否则两个源的字节会被 -C - 拼接成损坏包）', () => {
      // download_with_resume 的续传依赖 -C -，而续传只对「同一文件的未完成下载」成立。
      // 换源后若保留旧源的部分字节，会拼出损坏的 tar.gz，且魔术字节来自第一个源，
      // 后端检查未必拦得住 ⇒ 切换前必须 rm。
      const block = script.match(/Gitee 源下载失败，改用 GitHub[\s\S]{0,200}/);
      expect(block, '兜底分支未找到').toBeTruthy();
      expect(block[0]).toContain('rm -f "$TMP_TGZ"');
    });

    it('用户显式指定 PACKAGE_URL 时不介入自动选路（尊重明确意图）', () => {
      // 自动回退只在「脚本自己填的默认源」上生效；用户给了 URL 就按他的来，
      // 否则会把「我指了地址却下了别的源」变成新的困惑来源。
      const guards =
        script.match(
          /\[ "\$CUSTOM_PACKAGE_URL" -eq 0 \] && \[ "\$ALLOW_SOURCE_FALLBACK" = "1" \]/g,
        ) || [];
      expect(guards.length).toBeGreaterThanOrEqual(2); // 至少覆盖探测分支与下载失败分支
    });

    it('探测不可达时快速失败而非等到下载停滞检测（60s）', () => {
      expect(script).toContain('source_reachable');
      expect(script).toMatch(/PROBE_TIMEOUT="\$\{PROBE_TIMEOUT:-[0-9]+\}"/);
      // 探测用范围请求只读 1 字节，几乎不耗流量
      expect(script).toMatch(/curl -fsSL -r 0-0 --max-time "\$PROBE_TIMEOUT"/);
    });
  });

  /* 装包函数恒返回 0 时，调用点的 `|| warn ...` 与 JAVA25_MISSING=1 全是死代码：
     Java 25 装不上用户得不到任何提示，部署 MC 26.x 实例起不来还找不到原因。 */
  describe('装包失败必须能被调用点看见', () => {
    const fnSrc = script.match(/install_pkg_recorded\(\) \{[\s\S]*?\n\}/);
    if (!fnSrc) throw new Error('未能在部署脚本中定位 install_pkg_recorded');
    const pkgSrc = script.match(/pkg_installed\(\) \{[\s\S]*?\n\}/);
    if (!pkgSrc) throw new Error('未能在部署脚本中定位 pkg_installed');

    /** 用桩跑一遍装包：FAKE_RC 控制 install_pkg 的退出码 */
    function runRecorded(rc) {
      const staging = path.join(mkdtempSync(path.join(os.tmpdir(), 'mcs-pkg-')), 'staging');
      const r = spawnSync(
        BASH_BIN,
        ['-c', 'eval "$FN"\ninstall_pkg_recorded nodejs; echo "RC=$?"; cat "$STAGING"'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            STAGING: staging,
            FAKE_RC: String(rc),
            FN: [
              'MANIFEST=/nonexistent/.install-manifest',
              'MANIFEST_STAGING="$STAGING"',
              'MC_COMMANDER_DIR=/nonexistent',
              'PKG_MANAGER=apt',
              'record_change() { printf "%s\t%s\n" "$1" "$2" >> "$MANIFEST_STAGING"; }',
              'install_pkg() { return "$FAKE_RC"; }',
              pkgSrc[0],
              fnSrc[0],
              // 桩必须排在真实定义之后：同名的后定义者生效
              'pkg_installed() { return 1; }',
            ].join('\n'),
          },
        },
      );
      rmSync(path.dirname(staging), { recursive: true, force: true });
      return r.stdout;
    }

    it('装包成功：返回 0 且清单记 pkg-installed', () => {
      const out = runRecorded(0);
      expect(out).toContain('RC=0');
      expect(out).toContain('pkg-installed\tnodejs');
    });

    it('装包失败：返回非 0 且清单记 pkg-failed（不冒充已装）', () => {
      const out = runRecorded(100);
      expect(out).toContain('RC=100');
      expect(out).toContain('pkg-failed\tnodejs');
      expect(out).not.toContain('pkg-installed');
    });

    it('失败经 || 分叉能置位 JAVA25_MISSING（否则该告警是死代码）', () => {
      const r = spawnSync(
        BASH_BIN,
        [
          '-c',
          'eval "$FN"\ninstall_pkg_recorded java-25 || JAVA25_MISSING=1; echo "MISSING=${JAVA25_MISSING:-0}"',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            FAKE_RC: '100',
            FN: [
              'MANIFEST=/nonexistent/.install-manifest',
              'MANIFEST_STAGING=/tmp/mcs-pkg-unused',
              'MC_COMMANDER_DIR=/nonexistent',
              'PKG_MANAGER=apt',
              'record_change() { :; }',
              'install_pkg() { return "$FAKE_RC"; }',
              pkgSrc[0],
              fnSrc[0],
              'pkg_installed() { return 1; }',
            ].join('\n'),
          },
        },
      );
      expect(r.stdout).toContain('MISSING=1');
    });

    it('预装判定跟着包管理器走：Alpine 不能用 dpkg/rpm 探测', () => {
      // Alpine 上 dpkg/rpm 不存在，恒假会把每个包都记成「本项目装的」，
      // 卸载时 apk del 把用户原本就有的 openjdk/nodejs 一起删掉
      expect(pkgSrc[0]).toContain('apk info -e');
      expect(pkgSrc[0]).toContain('dpkg -s');
      expect(pkgSrc[0]).toContain('rpm -q');
      // apk 也要更新索引，否则全新 Alpine 上 apk add 报 package not found
      expect(script).toMatch(/apk\) apk update/);
    });
  });

  describe('Node.js 安装不执行未校验引导脚本', () => {
    it('优先使用发行版官方源安装 Node.js', () => {
      expect(script).toContain('install_pkg_recorded nodejs npm');
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
    it('面板服务不以 root 运行', () => {
      // 只判面板本体那个单元：删除执行单元必须以 root 运行才能删专用用户与系统单元，
      // 它只能由面板经 sudoers 白名单触发，权限面由白名单收窄
      // 面板单元的 User= 必须紧跟其后、且在删除执行单元定义之前
      const at = script.indexOf('cat > /etc/systemd/system/mc-commander.service');
      const removalAt = script.indexOf('mc-commander-removal.service <<EOF');
      const panelUnit = script.slice(at, removalAt);
      expect(panelUnit).toContain('User=mc-commander');
      expect(panelUnit).not.toContain('User=root');
    });

    it('删除执行单元以 root 运行，但 sudoers 只放行启动它', () => {
      const start = script.indexOf('mc-commander-removal.service <<EOF');
      const removalUnit = script.slice(start, start + 400);
      expect(removalUnit).toContain('User=root');
      // 白名单只给 start，不给 stop/restart 等其它能力。
      // --no-block 是参数序列的一部分：sudoers 逐参数匹配，面板调用少一个词就不放行
      const sudoBlock = sudoersRule();
      // 整词匹配：子串匹配会被 `restart` 绕过（rest-art 里含 `art` 更含 `start` 的尾巴）
      expect(sudoBlock).toMatch(
        /\/usr\/bin\/systemctl start --no-block mc-commander-removal\.service/,
      );
      // 判据只针对删除单元：stop/restart/disable 若落在它身上，面板就能绕过删除流程。
      // 停面板自身是另一条白名单项（面板以非 root 身份运行，不授权就必然停不掉）
      const removalEntries = sudoBlock;
      expect(removalEntries).not.toMatch(/systemctl (stop|restart|disable) mc-commander-removal/);
      // 面板发的命令必须与白名单里的参数序列逐字一致，否则线上永远匹配不上
      const panelRoute = readFileSync(
        path.resolve(import.meta.dirname, '../src/routes/panel.js'),
        'utf8',
      );
      expect(panelRoute).toContain("'start', '--no-block', unit");
    });

    it('白名单确实存在（锚点找不到时上面的断言不得在空串上通过）', () => {
      // sudoersRule() 取不到规则时会抛错；这条用来证明锚点本身指向真实内容
      expect(sudoersRule()).toContain('ALL=(root) NOPASSWD:');
    });

    it('停面板自身在 sudoers 白名单内，且面板调用序列逐字一致', () => {
      // 面板以 mc-commander 身份运行：不授权时 systemctl stop 要交互式认证，
      // 面板内点「停用面板」必然失败（实测退出码 1），而 API 却回成功
      const sudoersLine = sudoersRule();
      expect(sudoersLine).toContain('/usr/bin/systemctl stop mc-commander.service');
      const panelRoute = readFileSync(
        path.resolve(import.meta.dirname, '../src/routes/panel.js'),
        'utf8',
      );
      // 权限校验与真正执行必须是同一串参数，否则线上匹配不上
      expect(panelRoute).toContain("'stop', 'mc-commander.service'");
      expect(panelRoute).toContain(
        "'-n', '-l', '/usr/bin/systemctl', 'stop', 'mc-commander.service'",
      );
    });

    /* root 执行的脚本若留在面板可写目录里，面板拿到任意写文件能力就等于拿到 root */
    it('删除单元执行的是 root 独占目录里的副本，不是安装目录里那份', () => {
      expect(script).toContain('REMOVAL_LIB_DIR="/usr/local/lib/mc-commander"');
      expect(script).toMatch(
        /install -o root -g root -m 0755 \\?\s*"\$MC_COMMANDER_DIR\/src\/services\/panel-removal\.sh" "\$REMOVAL_SCRIPT"/,
      );
      // 单元只认副本路径：写回安装目录就退化成「面板可改 root 要跑的代码」
      const heredocStart = script.indexOf('mc-commander-removal.service <<EOF');
      // 从 heredoc 起始行之后再找结束标记：'EOF' 三个字母本身就在起始行里
      const unitBlock = script.slice(
        heredocStart,
        script.indexOf('\nEOF', heredocStart + 'mc-commander-removal.service <<EOF'.length),
      );
      expect(unitBlock).toContain('ExecStart=/bin/bash $REMOVAL_SCRIPT --purge');
      expect(unitBlock).not.toContain('$MC_COMMANDER_DIR/src/services');
    });

    it('卸载删掉全部自建单元（含更新与迁移），不留可被再次触发的 root 单元', () => {
      // 清单回滚只处理 pkg-installed / repo-file / node-symlink，systemd-unit 那条
      // 记录不会被它消费；不在卸载段显式列举就会残留——实测两个新单元留在了
      // /etc/systemd/system/ 下，而卸载已经报了「系统已无本项目残留」。
      const at = script.indexOf('停止并禁用 systemd 服务');
      expect(at).toBeGreaterThan(-1);
      const block = script.slice(at, script.indexOf('rm -rf "$REMOVAL_LIB_DIR"', at));
      for (const unit of [
        'mc-commander-removal.service',
        'mc-commander-removal-keep.service',
        'mc-commander-update.service',
        'mc-commander-migrate.service',
      ]) {
        expect(block, `卸载段漏删 ${unit}`).toContain(unit);
      }
    });

    it('卸载与自删都清掉 root 副本，不留一个可被再次触发的 root 脚本', () => {
      expect(script).toContain('rm -rf "$REMOVAL_LIB_DIR"');
      const removal = readFileSync(
        path.resolve(import.meta.dirname, '../src/services/panel-removal.sh'),
        'utf8',
      );
      expect(removal).toContain('rm -rf /usr/local/lib/mc-commander');
    });

    it('创建专用低权限用户并移交目录属主', () => {
      expect(script).toContain('useradd --system');
      expect(script).toContain('mc-commander');
      expect(script).toContain('chown -R mc-commander:mc-commander');
    });

    it('安装完成后给出降权说明', () => {
      expect(script).toContain('服务以专用低权限用户 mc-commander 运行');
    });

    it('同机已有另一份部署时中止，不静默顶掉它', () => {
      // unit 名与专用用户全局唯一，覆盖写入会让上一份部署变成「目录还在、服务没了」的孤儿。
      // 判据取 WorkingDirectory 而不是「目录是否存在」：同一目录重装/升级是正常路径。
      const fnStart = script.indexOf(
        'if command -v systemctl &>/dev/null; then\n  # 同机第二份安装',
      );
      const body = script.slice(fnStart, fnStart + 1200);
      expect(body).toContain('WorkingDirectory=');
      expect(body).toContain('EXISTING_DIR" != "$MC_COMMANDER_DIR"');
      expect(body).toContain('exit 1');
    });

    it('互斥判定发生在写 unit 之前（否则覆盖已经发生，检查没有意义）', () => {
      const guardAt = script.indexOf('EXISTING_DIR" != "$MC_COMMANDER_DIR"');
      const writeAt = script.indexOf('cat > /etc/systemd/system/mc-commander.service <<EOF');
      expect(guardAt).toBeGreaterThan(0);
      expect(guardAt).toBeLessThan(writeAt);
    });
  });

  describe('NODE_ENV 门控确定化', () => {
    it('systemd unit 设置 Environment=NODE_ENV=production', () => {
      expect(script).toContain('Environment=NODE_ENV=production');
    });

    it('pm2 与 nohup 分支同样显式设置 NODE_ENV=production', () => {
      expect(script).toContain('NODE_ENV=production pm2 start src/index.js');
      expect(script).toContain('NODE_ENV=production nohup node src/index.js');
    });
  });

  it('原有 gzip 魔术字节校验与 package.json 结构校验仍保留', () => {
    expect(script).toContain('GZ_MAGIC');
    expect(script).toContain('1f8b');
    expect(script).toContain('解压后未找到 package.json');
  });

  describe('SETUP_TOKEN 首访设密所有权证明', () => {
    it('首次部署生成一次性 SETUP_TOKEN（openssl rand -hex 32）并写入 .env', () => {
      expect(script).toContain('SETUP_TOKEN=$(openssl rand -hex 32)');
      expect(script).toContain('SETUP_TOKEN=$SETUP_TOKEN');
    });

    it('部署完成输出展示 SETUP_TOKEN，并说明它是首访设密要粘的那串', () => {
      // 横幅里 token 独占一行原样输出（64 位 hex，塞不进带右边框的一行）
      expect(script).toContain('echo "    $SETUP_TOKEN"');
      expect(script).toContain('首次进入要设管理员密码');
      expect(script).toContain('粘到设密页');
    });

    it('令牌仅在本次生成时展示（更新部署不重复暴露一次性凭据）', () => {
      // 更新分支不读取/不生成 SETUP_TOKEN（仅首启 .env 创建时生成），banner 有值才打印
      expect(script).toContain('SETUP_TOKEN=""');
      expect(script).toMatch(/if \[ -n "\$SETUP_TOKEN" \]; then/);
    });
  });

  describe('重装补齐 .env 缺失键', () => {
    // 老 .env 缺 HOST 时面板只监听 127.0.0.1：用户重装后「看起来装好了」却打不开，
    // 比直接报错更难查。补齐只写缺失的键，已有值一律不动。
    const backfill = script.slice(
      script.indexOf('ENV_ADDED=""'),
      script.indexOf('log "已补齐 .env'),
    );

    it('补齐函数只在键缺失时追加', () => {
      expect(backfill).toContain('grep -qE "^[[:space:]]*${key}=" .env');
      expect(backfill).toContain('printf \'%s=%s\\n\' "$key" "$value" >> .env');
    });

    it('覆盖会决定面板能否被远程访问的键', () => {
      expect(backfill).toContain('env_backfill HOST 0.0.0.0');
      expect(backfill).toContain('env_backfill PORT 25566');
      expect(backfill).toContain('env_backfill SERVERS_DIR ./var/servers');
      expect(backfill).toContain('env_backfill DATA_DIR ./var/data');
      expect(backfill).toContain('env_backfill BACKUPS_DIR ./var/backups');
    });

    it('补齐发生在「.env 已存在」分支内，不覆盖首次生成', () => {
      const firstBranch = script.slice(
        script.indexOf('if [ ! -f .env ]'),
        script.indexOf('else\n  log ".env 已存在'),
      );
      expect(firstBranch).not.toContain('env_backfill');
    });
  });

  describe('API Key 不进终端交付面', () => {
    it('部署日志不打印 Key 明文', () => {
      // 日志长期留存；Key 面板内随时可重新生成，没必要在这里出现
      expect(script).not.toMatch(/已生成 API Key: \$API_KEY/);
      expect(script).not.toMatch(/已生成 API Key: \$\{API_KEY:0:4\}/);
    });

    it('完成横幅不打印 Key，改为指路面板内生成', () => {
      // 浏览器走会话鉴权用不到它；印出来只会让用户多一个要保管的东西
      expect(script).not.toContain('echo "    $API_KEY"');
      expect(script).toContain('想接自动化工具');
      expect(script).toContain('浏览器用不到它');
    });
  });

  // 私网判定是「这个地址能不能发给玩家」的唯一判据，脚本（决定写不写进 .env、
  // 要不要告警）与服务端（决定 addressType、要不要标注「内网地址」）各持一份实现。
  // 两侧曾漂移：脚本漏了 100.64.0.0/10 等段 ⇒ 同一个 100.64.0.1 在脚本侧算「公网」、
  // 在服务端算「内网」，CGNAT 出口的用户拿不到任何警示。
  // 故此处不只断言脚本自身，而是**把 bash 真的跑起来与服务端逐段对拍**：
  // 任何一侧改段表而另一侧没跟上，这里都会红。
  describe('私网判定段表：脚本与服务端必须一致', () => {
    const fnSource = script.match(
      /PRIVATE_IPV4_RE='[^']+'\n[\s\S]*?is_private_ip\(\) \{[\s\S]*?\n\}/,
    );
    if (!fnSource) throw new Error('未能在部署脚本中定位 PRIVATE_IPV4_RE / is_private_ip');

    /** 把脚本里的判定函数原样搬到 bash 里批量求值（不执行脚本其余部分） */
    function classifyByScript(ips) {
      const result = runBash([
        '-c',
        `${fnSource[0]}\n${ips.map((ip) => `is_private_ip "${ip}" && echo private || echo public`).join('\n')}`,
      ]);
      expect(result.status).toBe(0);
      return result.stdout
        .trim()
        .split('\n')
        .map((s) => s.trim());
    }

    it('覆盖全部保留段与边界：两侧判定逐个一致', () => {
      const ips = [
        // 各段内部 + 段外相邻地址（错一个段或边界就会在这里分叉）
        '0.0.0.0',
        '0.255.255.255',
        '1.0.0.0',
        '10.0.0.0',
        '10.255.255.255',
        '11.0.0.0',
        '100.63.255.255',
        '100.64.0.0',
        '100.64.0.1',
        '100.127.255.255',
        '100.128.0.0',
        '127.0.0.1',
        '127.255.255.255',
        '128.0.0.1',
        '169.254.0.0',
        '169.254.169.254',
        '169.255.0.0',
        '172.15.255.255',
        '172.16.0.0',
        '172.31.255.255',
        '172.32.0.0',
        '192.0.0.0',
        '192.0.0.255',
        '192.0.1.0',
        '192.0.2.0',
        '192.0.2.255',
        '192.0.3.0',
        '192.88.99.0',
        '192.88.99.255',
        '192.88.100.0',
        '192.168.0.0',
        '192.168.255.255',
        '192.169.0.0',
        '198.17.255.255',
        '198.18.0.0',
        '198.19.255.255',
        '198.20.0.0',
        '198.51.100.0',
        '198.51.100.255',
        '198.51.101.0',
        '203.0.113.0',
        '203.0.113.255',
        '203.0.114.0',
        '223.255.255.255',
        '224.0.0.0',
        '239.255.255.255',
        '240.0.0.0',
        '255.255.255.255',
        // 公网样本（真实可达地址，全部虚构/文档段以外）
        '1.2.3.4',
        '8.8.8.8',
        '93.184.216.34',
        '110.40.207.3',
      ];
      const byScript = classifyByScript(ips);
      const bad = ips.filter((ip, i) => (isPrivateIp(ip) ? 'private' : 'public') !== byScript[i]);
      expect(bad, `以下地址两侧判定不一致（服务端 vs 脚本）：${bad.join(', ')}`).toEqual([]);
    });

    it('CGNAT（100.64.0.0/10）被两侧一致判为私网——本轮修复的具体缺口', () => {
      // 修复前脚本侧返回 public，故该地址会被写进 .env 且面板不标注「内网地址」
      const byScript = classifyByScript(['100.64.0.1']);
      expect(byScript[0]).toBe('private');
      expect(isPrivateIp('100.64.0.1')).toBe(true);
    });
  });

  // 就绪判定是「这次部署成没成」的唯一出口：判错会把崩溃重启中的服务报成部署完成。
  // 这里不只断言脚本里有某段字符串——把函数原样抽出来灌响应真跑，否则逻辑写错照样全绿。
  describe('就绪判定：认得出「这不是本次装的面板」', () => {
    const fnSource = script.match(/wait_until_ready\(\) \{[\s\S]*?\n\}/);
    if (!fnSource) throw new Error('未能在部署脚本中定位 wait_until_ready');

    /**
     * 灌入一次就绪判定的全部外部输入。
     * 等待预算压到 1 秒：判据不成立的用例必须走完整条超时路径才算数，
     * 而默认 30 秒会让几个用例白等一分钟以上。
     */
    function runReady({ body = '', curlExit = 0, hasPackage = true, svcState = 'active' } = {}) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-ready-'));
      try {
        const stub = path.join(dir, 'bin');
        mkdirSync(stub);
        const curlStub =
          '#!/bin/sh\nif [ "$FAKE_CURL_EXIT" -eq 0 ]; then printf "%s" "$FAKE_CURL_BODY"; fi\nexit "$FAKE_CURL_EXIT"\n';
        writeFileSync(path.join(stub, 'curl'), curlStub);
        // systemctl 必须也替身：判据里「unit 真的 active」这一路如果落到机器上的真 unit，
        // 用例结果就跟着跑测试的机器漂移了
        writeFileSync(
          path.join(stub, 'systemctl'),
          '#!/bin/sh\nprintf "%s\\n" "$FAKE_SVC_STATE"\n',
        );
        chmodSync(path.join(stub, 'curl'), 0o755);
        chmodSync(path.join(stub, 'systemctl'), 0o755);
        const appDir = path.join(dir, 'app');
        mkdirSync(appDir);
        if (hasPackage) {
          writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: '0.9.0' }));
        }
        const prog = [
          'MC_COMMANDER_DIR=' + appDir,
          'SERVER_PORT=25566',
          'READY_TIMEOUT=1',
          fnSource[0],
          'wait_until_ready; RC=$?; echo "SEEN=$SEEN_VERSION"; echo "STATE=$SERVICE_STATE"; exit $RC',
        ].join('\n');
        const r = spawnSync(BASH_BIN, ['-c', prog], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: stub + ':' + process.env.PATH,
            FAKE_CURL_BODY: body,
            FAKE_CURL_EXIT: String(curlExit),
            FAKE_SVC_STATE: svcState,
          },
        });
        expect(r.error).toBeUndefined();
        return { status: r.status, stdout: r.stdout };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('响应版本与本次安装一致 → 就绪', () => {
      const r = runReady({ body: '{"status":"ok","data":{"version":"0.9.0"}}' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('SEEN=0.9.0');
    });

    it('端口上有 2xx 但版本不符 → 判未就绪', () => {
      // 旧版本面板、无关服务都能回 2xx：只判状态码就会把它们认成本次安装成功
      const r = runReady({ body: '{"status":"ok","data":{"version":"9.9.9"}}' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('SEEN=9.9.9');
    });

    it('响应里没有版本字段 → 判未就绪', () => {
      const r = runReady({ body: '{"status":"ok"}' });
      expect(r.status).toBe(1);
    });

    it('端口无人响应 → 判未就绪', () => {
      const r = runReady({ curlExit: 7 });
      expect(r.status).toBe(1);
    });

    it('磁盘读不到版本号时退回「有响应即就绪」', () => {
      // 没有可比对的基准时判死，会把「面板其实好好的」装成失败
      const r = runReady({ body: '{"data":{"version":"1.2.3"}}', hasPackage: false });
      expect(r.status).toBe(0);
    });

    it('响应版本对得上、但 unit 正在崩溃重启 → 判未就绪', () => {
      // 版本相符不等于本次启动成功：systemd 反复拉起时旧进程仍会答同一个端口
      const r = runReady({
        body: '{"status":"ok","data":{"version":"0.9.0"}}',
        svcState: 'activating',
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('STATE=activating');
    });

    it('版本相符且 unit active → 就绪', () => {
      const r = runReady({ body: '{"data":{"version":"0.9.0"}}', svcState: 'active' });
      expect(r.status).toBe(0);
    });

    it('等待请求带 --max-time：对端 accept 却不回包时不会卡死在第 1 轮', () => {
      expect(fnSource[0]).toContain('--max-time');
    });

    it('就绪失败必须阻断：exit 1，且不再打印完成横幅', () => {
      // 判据不可靠也不致命，致命的是判完还往下走
      const after = script.split('if ! wait_until_ready; then')[1];
      expect(after, '就绪失败分支未找到').toBeTruthy();
      const branch = after.split('# 12.')[0];
      expect(branch).toContain('exit 1');
      expect(branch).not.toContain('部署完成');
    });

    it('失败分支只交付 SETUP_TOKEN（Key 面板内可重新生成）', () => {
      const branch = script.split('if ! wait_until_ready; then')[1].split('# 12.')[0];
      expect(branch).toContain('echo "  $SETUP_TOKEN"');
      expect(branch).not.toContain('echo "  $API_KEY"');
    });
  });

  // 失败兜底：脚本任何一步失败都要说人话。ERR trap 是这套兜底的唯一承重点，
  // 而它很容易被后续改动破坏（漏 set -o errtrace、被 err 标志挡住、日志不留存）。
  describe('失败兜底：任何一步失败都要说清卡在哪', () => {
    const trapSource = script.match(/on_error\(\) \{[\s\S]*?\n\}/);
    if (!trapSource) throw new Error('未能在部署脚本中定位 on_error');

    /** 把 log/err/trap 三者原样抽出来，在隔离环境里跑一段会失败的脚本 */
    function runWithTrap(steps) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-trap-'));
      try {
        const logFn = script.match(/^log\(\) {2}\{[\s\S]*?^\}/m);
        const errFn = script.match(/^err\(\) {2}\{[^\n]*\}/m);
        const warnFn = script.match(/^warn\(\) \{[^\n]*\}/m);
        if (!logFn || !errFn || !warnFn) throw new Error('未能在部署脚本中定位 log/err/warn');
        const prog = [
          'set -euo pipefail',
          'set -o errtrace',
          'LOG_LINES=()',
          'LOG_LINES_MAX=200',
          'ERR_SHOWN=0',
          logFn[0],
          warnFn[0],
          errFn[0],
          trapSource[0],
          'trap on_error ERR',
          steps,
        ].join('\n');
        const r = spawnSync(BASH_BIN, ['-c', prog], { encoding: 'utf8' });
        expect(r.error).toBeUndefined();
        return { status: r.status, stdout: r.stdout + r.stderr };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('命令失败 → 打印中断块、回放进度、保留非 0 退出码', () => {
      const r = runWithTrap('log "第一步完成"\nlog "第二步开始"\nfalse');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('安装中断');
      expect(r.stdout).toContain('第一步完成');
      expect(r.stdout).toContain('第二步开始');
    });

    it('函数内的失败同样被兜住（没有 errtrace 时函数内失败不会触发 ERR）', () => {
      const r = runWithTrap('inner() { log "函数内一步"; false; }\ninner');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('安装中断');
      expect(r.stdout).toContain('函数内一步');
    });

    it('已经用 err 给出专门解释的失败，不再叠一套通用文案', () => {
      const r = runWithTrap('err "专门的失败说明"\nexit 1');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('专门的失败说明');
      expect(r.stdout).not.toContain('安装中断');
    });

    it('正常退出不打印中断块', () => {
      const r = runWithTrap('log "全部完成"');
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('安装中断');
    });

    it('进度回放只取最近几行，不会把整段日志重打一遍', () => {
      // 安装全程上百行；回放整段等于让用户在几百行里再找一次出错点
      const r = runWithTrap('for i in $(seq 1 250); do log "第 $i 步"; done\nfalse');
      expect(r.status).toBe(1);
      const replay = r.stdout.split('最后几行进度：')[1].split('出错位置：')[0];
      const bullets = replay.split('\n').filter((l) => l.trim().startsWith('·'));
      expect(bullets).toHaveLength(3);
      expect(bullets[2]).toContain('第 250 步');
    });

    it('脚本自身真的装了这套兜底：errtrace 已开、trap 已挂、err 短路在位', () => {
      // 上面的用例跑的是抽出来的函数体，接线错了它们照样全绿（已用变异验证过）。
      // 故接线本身必须单独锁：缺 errtrace 则函数内失败不触发，漏 trap 则整套失效。
      expect(script).toMatch(/^set -o errtrace$/m);
      expect(script).toMatch(/^trap on_error ERR$/m);
      expect(script).toContain('[ "$ERR_SHOWN" -eq 1 ] && return 0');
      // trap 必须在任何可能失败的步骤之前挂上：挂在文件末尾等于没挂
      expect(script.indexOf('trap on_error ERR')).toBeLessThan(
        script.indexOf('# 0. root 权限检查'),
      );
    });

    it('apt 索引更新失败只降级为警告，不中止安装', () => {
      // 已装的包不需要索引；真装不上时随后的 install 会失败并给出更准确的解释
      expect(script).toMatch(/apt-get update \|\| warn/);
      expect(script).not.toMatch(/^\s*apt\) apt-get update ;;$/m);
    });

    it('Java 25 装不上不中断安装，但完成横幅要写明影响', () => {
      expect(script).toContain('JAVA25_MISSING=1');
      expect(script).toContain('MC 26.x 及更新版本的实例将无法启动');
      // 横幅里也必须出现：装完不看日志的人只读横幅
      const banner = script.split('# 12. 输出部署信息')[1];
      expect(banner).toContain('缺少 Java 25');
    });
  });

  // 横幅是装完之后唯一的交付界面：说错一句，用户就照着错的去操作。
  describe('完成横幅：每一句都要是真的', () => {
    // 只取横幅本体（从第一条边框开始）：地址计算段在它之前，属另一件事
    const banner = script.split('# 12. 输出部署信息')[1].split('echo "╔')[1].split('常用命令：')[0];

    it('面板地址只在探测到公网地址时给出，否则让用户去控制台看', () => {
      // localhost 指向用户自己的电脑，写成「在浏览器打开这个地址」他必然打不开
      expect(script).not.toContain('PANEL_URL="http://localhost:$SERVER_PORT/"');
      expect(script).toMatch(/if \[ -n "\$\{PUBLIC_IP_DETECTED:-\}" \] && ! is_private_ip/);
      expect(banner).toContain('在浏览器里打开面板');
      expect(banner).toContain('公网 IP 在云服务器控制台 → 实例列表里看');
    });

    it('不出现「客户端」——本项目是浏览器面板，没有客户端可输入', () => {
      expect(banner).not.toContain('客户端');
      expect(banner).toContain('在浏览器里打开');
    });

    it('明确交代游戏服务器地址不在这里', () => {
      // 横幅里两个端口并排出现时，用户会拿 25566 去连 MC
      expect(banner).toContain('游戏服务器地址不在这里');
      expect(banner).toContain('默认端口 25565');
    });

    it('横幅每一行的显示宽度一致（中文字符按 2 列算）', () => {
      // 宽度不齐时右边框参差，用户会以为输出被截断；中文占 2 列，按字符数算必错。
      // 变量要按运行时实际值代入：按 $SERVER_PORT 字面量算会把 13 个字符当成实际宽度
      const WIDE =
        /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
      const width = (s) => [...s].reduce((n, c) => n + (WIDE.test(c) ? 2 : 1), 0);
      const rows = script
        .split('\n')
        .filter((l) => l.startsWith('echo "║') && !l.includes('printf'))
        .map((l) => l.slice(l.indexOf('║') + 1, l.lastIndexOf('║')))
        .map((s) =>
          s.replace(/\$SERVER_PORT/g, '25566').replace(/\$MC_COMMANDER_DIR/g, '/opt/mc-commander'),
        );
      expect(rows.length).toBeGreaterThan(10);
      const widths = [...new Set(rows.map(width))];
      expect(widths).toEqual([51]);
    });

    // printf 的 %-51s 按**字节**补齐，中文一个字 3 字节 ⇒ 用 printf 拼中文行必然错位
    it('printf 边框行的实参必须是纯 ASCII', () => {
      const bad = [];
      for (const l of script.split('\n')) {
        const m = l.match(/printf "║%-51s║\\n" "([^"]*)"/);
        if (!m) continue;
        if ([...m[1]].some((c) => c.charCodeAt(0) > 127)) bad.push(m[1]);
      }
      expect(bad).toEqual([]);
    });

    it('防火墙按实际状态说话，不把「跳过已有规则」说成「已开放」', () => {
      expect(script).toContain('FIREWALL_STATE="ufw-inactive"');
      expect(banner).toContain('本机未启用防火墙');
      // 旧的「已通过 ufw 开放端口」是把 inactive 下的 0 返回当成功
      expect(script).not.toContain('已通过 ufw 开放端口');
    });

    // 实测（腾讯云轻量）：ufw inactive 但安全组拦着，端口照样连不进来。
    // 此时说「端口未被拦截」是假话，用户会转而去怀疑面板本身。
    // 判据必须是实测可达性，不是「本机防火墙开没开」。
    it('可达性按实测结果说话，不按本机防火墙状态推断', () => {
      expect(script).toContain('REACHABLE="unknown"');
      expect(script).toContain(
        'curl -sf -o /dev/null --connect-timeout 5 --max-time 8 "$PANEL_URL"',
      );
      // 连不进来时必须明说「卡在云平台」，并给出放行位置
      expect(banner).toContain('从外面还连不进来');
      expect(banner).toContain('面板本身是好的');
      // 说「端口未被拦截」在有安全组的情况下是假话
      expect(banner).not.toContain('端口未被拦截');
    });

    it('确认可达时才说可以访问，且提示收紧来源', () => {
      expect(banner).toContain('已确认可以从外网访问');
      expect(banner).toContain('建议只放行你自己的 IP');
    });
  });

  // 横幅是装完之后唯一的交付界面：用户照着它做，所以它必须给出可执行的动作。
  describe('横幅对用户的实际可执行性', () => {
    // 只取横幅本体（第一条边框到常用命令之间）
    const banner = script.split('# 12. 输出部署信息')[1].split('echo "╔')[1].split('常用命令：')[0];

    it('探测到公网地址时第①步给的是真链接，不是 localhost', () => {
      // localhost 指向用户自己的电脑；写成「在浏览器打开这个地址」他必然打不开
      expect(script).toContain('PANEL_URL="http://$PUBLIC_IP_DETECTED:$SERVER_PORT/"');
      expect(banner).toContain('在浏览器里打开这个地址');
    });

    it('探测不到公网地址时指路控制台，不留一条打不开的链接', () => {
      expect(banner).toContain('公网 IP 在云服务器控制台 → 实例列表里看');
      expect(banner).not.toContain('localhost:25566');
    });

    it('API Key 不在终端出现，改为指路面板内生成', () => {
      // 浏览器走会话鉴权用不到它；面板内「设置 → 连接设置」可随时重新生成
      expect(banner).toContain('想接自动化工具');
      expect(banner).toContain('浏览器用不到它');
      expect(script).not.toContain('echo "    $API_KEY"');
    });
  });

  /* 用户重跑安装命令的诉求就是「换到新版」；全程只有 VERSION=latest 的话，
     他既不知道装的是什么、也不知道这次到底有没有升上去。 */
  describe('版本跃迁要说出来', () => {
    /** 在假安装目录上跑一遍版本播报，看它怎么描述这次安装 */
    function runVersionReport(previous, seen) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-ver-'));
      try {
        if (previous) writeFileSync(path.join(dir, 'package.json'), `{"version":"${previous}"}\n`);
        const lines = script.split('\n');
        const prevAt = lines.findIndex((l) => l.startsWith('PREVIOUS_VERSION='));
        if (prevAt < 0) throw new Error('未能在部署脚本中定位 PREVIOUS_VERSION 读取');
        const prevSrc = lines.slice(prevAt, prevAt + 2).join('\n');
        const reportAt = lines.findIndex((l) => l.includes('本次为首次安装'));
        if (reportAt < 0) throw new Error('未能在部署脚本中定位版本播报');
        const reportSrc = lines.slice(reportAt - 5, reportAt + 6).join('\n');
        const r = spawnSync(BASH_BIN, ['-c', `eval "$PREV_SRC"\neval "$REPORT_SRC"`], {
          encoding: 'utf8',
          env: {
            ...process.env,
            MC_COMMANDER_DIR: dir,
            SEEN_VERSION: seen,
            PREV_SRC: `log() { echo "[INFO] $*"; }\n${prevSrc}`,
            REPORT_SRC: reportSrc,
          },
        });
        return r.stdout;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('首次安装：说清是首次，并给出装上的版本', () => {
      expect(runVersionReport('', '0.10.3')).toContain('首次安装，版本 v0.10.3');
    });

    it('版本变了：报出从 X 到 Y', () => {
      const out = runVersionReport('0.10.0', '0.10.3');
      expect(out).toContain('从 v0.10.0 升级到 v0.10.3');
    });

    it('版本没变：如实说没变，不伪装成升级', () => {
      const out = runVersionReport('0.10.3', '0.10.3');
      expect(out).toContain('版本未变（v0.10.3）');
      expect(out).not.toContain('升级到');
    });

    it('旧版本号在覆盖代码之前读取（覆盖后再读只能读到新版本）', () => {
      const readAt = script.indexOf('PREVIOUS_VERSION=');
      const copyAt = script.indexOf('cp -rf "$TMP_EXTRACT/."');
      expect(readAt).toBeGreaterThan(0);
      expect(readAt).toBeLessThan(copyAt);
    });
  });

  describe('凭据交付：用户拿得走、丢了找得回', () => {
    // 令牌行不套边框：三击选行会把两侧 ║ 一起复制（实测 70 字符），粘进设密页必失败
    it('SETUP_TOKEN 独占行不带边框字符', () => {
      const lines = script.split('\n');
      const tokenLine = lines.find((l) => l.includes('echo "    $SETUP_TOKEN"'));
      expect(tokenLine).toBeDefined();
      expect(tokenLine).not.toContain('║');
    });

    it('横幅写明「没存下来就重跑同一条命令」', () => {
      // 重跑是低代码用户唯一会想到的找回动作；sudo 读 .env 他做不到
      expect(script).toContain('重新运行同一条安装命令即可再显示');
    });

    it('重跑时从 .env 读回未作废的令牌并再次展示', () => {
      expect(script).toMatch(/SETUP_TOKEN=\$\(sed -n 's\/\^SETUP_TOKEN=\/\/p' \.env/);
      expect(script).toContain('沿用 .env 里的 SETUP_TOKEN');
    });

    it('已设密的机器上重跑不会复活令牌', () => {
      // 设密成功时服务端删除该行，故读回只可能发生在「还没设过密」的机器上
      expect(script).not.toMatch(
        /if \[ -f \.env \]; then[\s\S]*?SETUP_TOKEN=\$\(openssl rand -hex 32\)[\s\S]*?else/,
      );
    });
  });

  describe('服务器地址探测：先问权威源，再退猜测', () => {
    const fn = script.match(/get_public_ip\(\) \{[\s\S]*?\n\}/);
    if (!fn) throw new Error('未能在部署脚本中定位 get_public_ip');

    it('云厂商元数据排在出口探测之前', () => {
      // 元数据 public-ipv4 是入站地址；出口探测拿到的是出站地址，NAT 池下两者不等
      const body = fn[0];
      const metaAt = body.indexOf('metadata.tencentyun.com');
      const egressAt = body.indexOf('ifconfig.me');
      expect(metaAt).toBeGreaterThan(-1);
      expect(egressAt).toBeGreaterThan(-1);
      expect(metaAt).toBeLessThan(egressAt);
    });

    /**
     * 把 get_public_ip 原样抽出来灌假 curl 跑：
     * 只断言脚本里有 `[ -n "$ip" ]` 挡不住「把它删了照样通过」。
     */
    function runDetect({ meta = '', aliyun = '', egress = '', nic = '' } = {}) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-detect-'));
      try {
        const stub = path.join(dir, 'bin');
        mkdirSync(stub);
        // 按 URL 分派：元数据空 body 也必须退出 0（真实腾讯云就是 200 + 空）
        const curl = [
          '#!/bin/sh',
          'url=""',
          'while [ $# -gt 0 ]; do case "$1" in http*) url="$1" ;; esac; shift; done',
          'case "$url" in',
          '  *metadata.tencentyun.com*) printf "%s" "$FAKE_META" ;;',
          '  *100.100.100.200*) printf "%s" "$FAKE_ALIYUN" ;;',
          '  *) printf "%s" "$FAKE_EGRESS" ;;',
          'esac',
          // 真实 curl 在 -f 下对空响应体仍退出 0，故这里也退 0：被测的正是「空 body」
          'exit 0',
        ].join('\n');
        writeFileSync(path.join(stub, 'curl'), curl);
        writeFileSync(path.join(stub, 'hostname'), `#!/bin/sh\nprintf '%s\\n' "$FAKE_NIC"\n`);
        chmodSync(path.join(stub, 'curl'), 0o755);
        chmodSync(path.join(stub, 'hostname'), 0o755);
        // is_private_ip 与函数同源：一并抽出，避免测试里另写一份判据
        const priv = script.match(/PRIVATE_IPV4_RE='[^']+'/)[0];
        const isPriv = script.match(/is_private_ip\(\) \{[\s\S]*?\n\}/)[0];
        // pipefail 必须带上：真实脚本是 set -euo pipefail，`curl | grep | head` 的空输入
        // 靠它才会让整条管道返回非 0；缺了它测出来的行为与线上不一致
        const prog = ['set -euo pipefail', priv, isPriv, fn[0], 'get_public_ip'].join('\n');
        const r = spawnSync(BASH_BIN, ['-c', prog], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: stub + ':' + process.env.PATH,
            FAKE_META: meta,
            FAKE_ALIYUN: aliyun,
            FAKE_EGRESS: egress,
            FAKE_NIC: nic,
          },
        });
        expect(r.error).toBeUndefined();
        return r.stdout.trim();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('元数据返回空时继续往下找，不拿空串当结果', () => {
      // 腾讯云在「没有弹性公网 IP」时返回 200 + 空 body：只判 curl 退出码会返回空串
      const out = runDetect({ meta: '', egress: '203.0.113.9', nic: '10.0.0.5' });
      expect(out).toBe('203.0.113.9 egress');
    });

    it('元数据有值时优先采信，并标 metadata', () => {
      const out = runDetect({ meta: '198.51.100.7', egress: '203.0.113.9' });
      expect(out).toBe('198.51.100.7 metadata');
    });

    it('全部探测都失败时退回网卡地址', () => {
      // 必须用真公网地址：TEST-NET 段（203.0.113.0/24 等）本身就在私网/保留表里，会被跳过
      const out = runDetect({ nic: '1.2.3.4' });
      expect(out).toBe('1.2.3.4 nic');
    });

    it('回显带来源标记，调用方据此决定能不能写进 .env', () => {
      expect(fn[0]).toContain('echo "$ip metadata"');
      expect(fn[0]).toContain('echo "$ip egress"');
      expect(script).toContain('PUBLIC_IP_DETECTED=""');
    });
  });
  // 卸载删目录前必须先把仍在跑的实例停干净：实例是 detached 进程，面板停了它们还在写世界。
  // 直接 rm -rf 会把存档从进程底下抽走——进程不报错、文件已消失，玩家看到区块加载失败，
  // 而存档已经救不回来。故这里把函数真的跑起来，用一个真进程冒充实例进程。
  describe('卸载前停止运行中的实例', () => {
    const fnSource = script.match(/stop_running_instances\(\) \{[\s\S]*?\n\}/);
    if (!fnSource) throw new Error('未能在部署脚本中定位 stop_running_instances');
    // 数据目录由 .env 决定（用户可能把它指到别的分区），抽取函数时一并带上解析器
    const dirResolverSource = script.match(/resolve_data_dir\(\) \{[\s\S]*?\n\}/);
    if (!dirResolverSource) throw new Error('未能在部署脚本中定位 resolve_data_dir');
    // 无 pidfile 的实例靠进程命令行识别，该判据也是被抽取函数的一部分
    const orphanFn = script.match(/stop_orphan_instances\(\) \{[\s\S]*?\n\}/);
    if (!orphanFn) throw new Error('未能在部署脚本中定位 stop_orphan_instances');
    const javaPidFn = script.match(/instance_java_pids\(\) \{[\s\S]*?\n\}/);
    if (!javaPidFn) throw new Error('未能在部署脚本中定位 instance_java_pids');

    /**
     * 进程是否真的还在跑。
     * 不能用 kill(pid, 0)：被测进程是本测试的直接子进程，退出后变僵尸，
     * 僵尸仍能通过 kill(pid,0) 探活 ⇒ 断言会假红。故读 /proc/<pid>/stat 的
     * 状态字段，Z 与读不到都算「已不在运行」。
     */
    function isRunning(pid) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // 状态是 comm 之后的第一个字段；comm 可能含空格，从最后一个 ')' 之后切
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
      } catch {
        return false;
      }
    }

    /** 建一个假安装目录：var/servers/<name>/.mc-commander-pid 指向一个真在跑的进程 */
    function setupInstance(dir, pid, name = 'inst1') {
      const instDir = path.join(dir, 'var', 'servers', name);
      mkdirSync(instDir, { recursive: true });
      writeFileSync(
        path.join(instDir, '.mc-commander-pid'),
        JSON.stringify({ pid, startedAt: Date.now() }),
      );
      return instDir;
    }

    /**
     * 起一个命令行里带 instDir 的进程，模拟 MC 实例。
     * 用 node 而非 bash/sleep：bash 对单条命令会 exec 优化、把额外参数丢掉，
     * 那样命令行里就没有实例目录，验活判定恒不命中（探针会假绿）。
     * 形态对齐真实实例：命令行里带着自己实例目录下的 jar 路径。
     */
    function spawnFakeInstance(instDir, jarName = 'server.jar') {
      // 显式监听 TERM 并退出：默认 TERM 处理在 detached 子进程里不可靠，
      // 探针会因为「信号发了但进程还在」而红，掩盖掉判定逻辑本身是对的这个事实
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 60000)",
          path.join(instDir, jarName),
        ],
        { stdio: 'ignore', detached: true },
      );
      child.unref();
      return child;
    }

    // log/warn 不在被抽取的函数体里，必须补桩：缺了它们，函数内的提示行会被
    // 「command not found」吞到 stderr，断言 stdout 就永远看不到「已停止」。
    // 函数体走环境变量传入而不是位置参数——位置参数在拼好的脚本里不会被再展开，
    // 传进去的是一行字面量，函数根本不会被定义。
    function runStop(dir) {
      return spawnSync(BASH_BIN, ['-c', 'eval "$FN_SRC"\nstop_running_instances; echo DONE'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          MC_COMMANDER_DIR: dir,
          FN_SRC:
            'log() { echo "[INFO] $*"; }\nwarn() { echo "[WARN] $*"; }\n' +
            dirResolverSource[0] +
            '\n' +
            javaPidFn[0] +
            '\n' +
            orphanFn[0] +
            '\n' +
            fnSource[0],
        },
      });
    }

    /** 跑「无 pidfile 实例」那条路径（卸载里与 pidfile 停止并列调用） */
    function runStopOrphans(dir) {
      return spawnSync(
        BASH_BIN,
        ['-c', 'eval "$FN_SRC"\nstop_orphan_instances "$DIR"; echo DONE'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            MC_COMMANDER_DIR: dir,
            DIR: path.join(dir, 'var', 'servers'),
            FN_SRC:
              'log() { echo "[INFO] $*"; }\nwarn() { echo "[WARN] $*"; }\n' +
              javaPidFn[0] +
              '\n' +
              orphanFn[0],
          },
        },
      );
    }

    it('实例在跑 → 发 TERM 并等它退出', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-purge-'));
      try {
        const instDir = setupInstance(dir, 0);
        const child = spawnFakeInstance(instDir);
        // pid 文件写真实 pid
        writeFileSync(
          path.join(instDir, '.mc-commander-pid'),
          JSON.stringify({ pid: child.pid, startedAt: Date.now() }),
        );
        const r = runStop(dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('停止仍在运行的实例进程');
        expect(r.stdout).toContain('DONE');
        // 进程必须真的停了。runStop 内的等待循环已保证这一点，这里只确认结果
        expect(isRunning(child.pid)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('pid 已被复用给别的进程（命令行不含实例目录）→ 不误杀', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-purge-'));
      try {
        // 指向一个真实存在、但命令行与实例目录无关的进程（本进程自己）
        setupInstance(dir, process.pid);
        const r = runStop(dir);
        expect(r.status).toBe(0);
        expect(r.stdout).not.toContain('停止仍在运行的实例进程');
        expect(r.stdout).toContain('DONE');
        // 自己还活着
        expect(() => process.kill(process.pid, 0)).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('没有 var/servers 目录 → 直接返回，不报错', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-purge-'));
      try {
        const r = runStop(dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('DONE');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('卸载前无条件尝试停实例：不按 server.jar 计数做前置门禁', () => {
      // 面板自己生成的 jar 叫 server-<版本>.jar / forge-*.jar，按 server.jar 数会数到 0
      // 而整段跳过——实例继续写存档，userdel 也必然失败
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      expect(body).not.toMatch(/-name server\.jar/);
      expect(body).toContain('stop_running_instances');
      expect(body).toContain('stop_orphan_instances');
    });

    it('卸载只在 --purge 时停实例，非 purge 保留数据不动实例', () => {
      // 非 purge 分支删的是代码不是数据，实例还能被用户手工接管，不该被静默杀掉
      const purgeBranch = script.slice(script.indexOf('if [ "$purge" -eq 1 ]'));
      expect(purgeBranch).toContain('stop_running_instances');
    });

    /**
     * 起一个真 java 进程（命令行带 -jar <实例目录>/<jar 名>）。
     * 不能用改名过的 bash 冒充：判定读 /proc/<pid>/exe，而 bash 执行脚本时
     * exe 会指回 /usr/bin/bash，桩会假绿。
     */
    function spawnJavaInstance(instDir, jarName) {
      const jarPath = path.join(instDir, jarName);
      const work = mkdtempSync(path.join(os.tmpdir(), 'java-stub-'));
      writeFileSync(
        path.join(work, 'Main.java'),
        'public class Main { public static void main(String[] a) throws Exception { Thread.sleep(60000); } }\n',
      );
      const built = spawnSync('javac', ['-d', work, path.join(work, 'Main.java')], {
        encoding: 'utf8',
      });
      if (built.status !== 0) return null;
      writeFileSync(path.join(work, 'MANIFEST.MF'), 'Main-Class: Main\n');
      const jarred = spawnSync(
        'jar',
        ['cfm', jarPath, path.join(work, 'MANIFEST.MF'), '-C', work, 'Main.class'],
        { encoding: 'utf8' },
      );
      if (jarred.status !== 0) return null;
      const child = spawn('java', ['-jar', jarPath], { stdio: 'ignore', detached: true });
      child.unref();
      child._work = work;
      return child;
    }

    it('无 pidfile 的实例按进程命令行识别：面板自己生成的 server-<版本>.jar 也要命中', () => {
      // 面板升级后的 jar 叫 server-<mcVersion>.jar、Forge 是 forge-*.jar，
      // 按 server.jar 写死名字会一个都认不出来——实例继续写存档，userdel 必然失败
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-orphan-'));
      try {
        const instDir = path.join(dir, 'var', 'servers', 'inst1');
        mkdirSync(instDir, { recursive: true });
        // 不写 pidfile：走「按命令行识别」这条路
        const child = spawnJavaInstance(instDir, 'server-1.21.4.jar');
        if (!child) return; // 本机无 JDK：该断言依赖真 JVM，跳过而非假绿
        // 等 JVM 起来再扫，避免时序抖动
        spawnSync('sleep', ['1.5']);
        const r = runStopOrphans(dir);
        expect(r.stdout).toContain('停止无 pidfile 的实例进程');
        expect(isRunning(child.pid)).toBe(false);
        rmSync(child._work, { recursive: true, force: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('命令行里带 jar 路径但不是 java 的进程不误杀（tail/rsync 备份该目录）', () => {
      // 判据只按路径子串匹配时，备份/看日志这类进程会被一起 SIGTERM 掉
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-notjava-'));
      try {
        const instDir = path.join(dir, 'var', 'servers', 'inst1');
        mkdirSync(instDir, { recursive: true });
        const child = spawnFakeInstance(instDir, 'server-1.21.4.jar');
        const r = runStopOrphans(dir);
        expect(r.stdout).not.toContain('停止无 pidfile 的实例进程');
        expect(isRunning(child.pid)).toBe(true);
        process.kill(child.pid, 'SIGKILL');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('数据目录改到别处（.env 里指绝对路径）时，仍能停到那里的实例', () => {
      // 用户把实例目录换到大盘是常态；按 var/servers 硬编码会「停了个空目录」，
      // 真实实例继续写存档，随后 --purge 从底下抽走文件。
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-purge-custom-'));
      const outside = mkdtempSync(path.join(os.tmpdir(), 'mcs-servers-outside-'));
      try {
        writeFileSync(path.join(dir, '.env'), `SERVERS_DIR=${outside}\n`);
        const instDir = path.join(outside, 'inst1');
        mkdirSync(instDir, { recursive: true });
        const child = spawnFakeInstance(instDir);
        writeFileSync(
          path.join(instDir, '.mc-commander-pid'),
          JSON.stringify({ pid: child.pid, startedAt: Date.now() }),
        );
        const r = runStop(dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('停止仍在运行的实例进程');
        expect(isRunning(child.pid)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('数据目录解析四档都按服务端口径：绝对路径原样、相对路径锚安装目录、带引号去壳、缺省回退', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-rdd-'));
      const run = (envLine) => {
        writeFileSync(path.join(dir, '.env'), envLine);
        const r = spawnSync(
          BASH_BIN,
          ['-c', 'eval "$FN_SRC"\nresolve_data_dir SERVERS_DIR ./var/servers'],
          {
            encoding: 'utf8',
            env: { ...process.env, MC_COMMANDER_DIR: dir, FN_SRC: dirResolverSource[0] },
          },
        );
        return r.stdout.trim();
      };
      try {
        // 服务端把相对路径锚定包根（安装目录），不是 cwd——两侧必须同一口径
        expect(run('SERVERS_DIR=/mnt/big/servers\n')).toBe('/mnt/big/servers');
        expect(run('SERVERS_DIR=./var/servers\n')).toBe(path.join(dir, 'var', 'servers'));
        expect(run('SERVERS_DIR=data/srv\n')).toBe(path.join(dir, 'data', 'srv'));
        expect(run('SERVERS_DIR="/mnt/x/y"\n')).toBe('/mnt/x/y');
        expect(run('')).toBe(path.join(dir, 'var', 'servers'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  // 卸载清单必须与安装时铺下的条目一一对应：漏一项就留下几十 MB 与含凭据的 .env，
  // 而用户按「已卸载」理解。这里把清单与载荷白名单对拍，任一侧新增条目而另一侧没跟上都会红。
  describe('非 purge 卸载的删除清单完整性', () => {
    /** 从卸载分支里取出 for item in ... 的条目表 */
    function uninstallItems() {
      const m = script.match(/for item in ([^;]+); do/);
      if (!m) throw new Error('未能在部署脚本中定位卸载删除清单');
      return m[1].trim().split(/\s+/);
    }

    it('安装时铺到根目录的每一项都在删除清单里（漏一项即残留）', () => {
      const items = uninstallItems();
      // 载荷白名单是安装侧的唯一事实源：它铺什么，卸载就得删什么
      for (const entry of PAYLOAD.serverFiles) expect(items, entry).toContain(entry);
      for (const entry of PAYLOAD.serverDirs) expect(items, entry).toContain(entry);
      expect(items).toContain(PAYLOAD.schemasDirName);
      // 安装期现场生成的依赖树与 lock：不清掉就是几十 MB 残留
      expect(items).toContain('node_modules');
      expect(items).toContain('package-lock.json');
    });

    it('保留 .env 但必须提示它含凭据（不能静默留下也不提）', () => {
      const items = uninstallItems();
      // .env 刻意不删（用户可能留档），但绝不能悄悄留下
      expect(items).not.toContain('.env');
      expect(script).toContain('含 API Key 摘要');
    });

    it('三个数据目录一个都不在删除清单里（那是玩家的世界）', () => {
      const items = uninstallItems();
      for (const d of ['var', 'var/servers', 'var/data', 'var/backups']) {
        expect(items, d).not.toContain(d);
      }
    });
  });
  // 端口只有一个事实源：.env 的 PORT。用户改过端口后，就绪检查与横幅地址必须跟着变，
  // 否则「面板明明起来了」会被判成「部署未完成」——用户于是去修一个不存在的问题。
  describe('端口取自 .env 而非写死', () => {
    /** 取脚本里解析端口的片段，喂不同的 .env 看结果 */
    function resolvePort(envContent) {
      const lines = script.split('\n');
      const idx = lines.findIndex((l) => l.includes('SERVER_PORT=$(sed -n'));
      if (idx < 0) throw new Error('端口解析不是从 .env 读的');
      const snippet = lines.slice(idx, idx + 2).join('\n');
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mcs-port-'));
      try {
        writeFileSync(path.join(dir, '.env'), envContent);
        // 片段走环境变量传入：位置参数在拼好的脚本里不会被再展开，传进去的是一行字面量
        const r = spawnSync(BASH_BIN, ['-c', 'eval "$SNIPPET"\necho "PORT=$SERVER_PORT"'], {
          encoding: 'utf8',
          env: { ...process.env, MC_COMMANDER_DIR: dir, SNIPPET: snippet },
        });
        return (r.stdout.match(/PORT=(\d+)/) || [])[1];
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('.env 里改过的端口被采信（不再判成部署未完成）', () => {
      expect(resolvePort('PORT=3000\nHOST=0.0.0.0\n')).toBe('3000');
    });

    it('.env 里没有 PORT 时退回 25566（首装与老配置都覆盖）', () => {
      expect(resolvePort('HOST=0.0.0.0\n')).toBe('25566');
    });

    it('端口解析不受注释行干扰', () => {
      expect(resolvePort('# PORT=9999\nPORT=8080\n')).toBe('8080');
    });
  });

  /* 端口被占时 node 以 EADDRINUSE 退出，systemd 每 3 秒重试，就绪检查空等满 30 秒
     才报「未就绪」——用户去修一个不存在的面板问题。起服务前必须先把真因说出来。 */
  describe('起服务前预检端口', () => {
    const fnSource = script.match(/check_port_free\(\) \{[\s\S]*?\n\}/);
    if (!fnSource) throw new Error('未能在部署脚本中定位 check_port_free');

    /** 在真监听端口上跑一遍预检（不依赖 mock：判据就是 ss 的真实输出） */
    function runCheck(port) {
      return spawnSync(BASH_BIN, ['-c', 'eval "$FN_SRC"\ncheck_port_free "$PORT"'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PORT: String(port),
          PORT_FREE_WAIT: '2',
          FN_SRC: 'err() { echo "[ERR] $*" >&2; }\n' + fnSource[0],
        },
      });
    }

    it('端口空闲 → 放行', () => {
      const r = runCheck(59997);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });

    it('端口被占 → 拦下并报出占用进程与处置办法', async () => {
      const { createServer } = await import('node:net');
      const srv = createServer();
      await new Promise((res) => srv.listen(59996, '0.0.0.0', res));
      try {
        const r = runCheck(59996);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('已被占用');
        // 只说「被占」不够：用户要知道停谁、下一步做什么
        expect(r.stderr).toContain('PID');
        expect(r.stderr).toContain('systemctl stop mc-commander');
      } finally {
        await new Promise((res) => srv.close(res));
      }
    });

    it('预检发生在启动服务之前，且不早于「停旧面板」', () => {
      // 早于停旧面板：升级时面板本就占着端口，会把自己判成占用者，正常升级被拦
      const stopAt = script.indexOf(
        'systemctl stop mc-commander 2>/dev/null || true\n    # 升级中途失败',
      );
      const checkAt = script.indexOf('check_port_free "$SERVER_PORT"');
      const startAt = script.indexOf('systemctl enable mc-commander');
      expect(checkAt).toBeGreaterThan(stopAt);
      expect(checkAt).toBeLessThan(startAt);
    });
  });
  /* sudoers 的 command 参数禁止通配符：实测整份文件会因
     `wildcards are not allowed in command arguments` 被拒载，届时白名单里的
     停止/删除/更新/迁移一起失效——而症状是「点了没反应」，排查不到 sudoers 上。 */
  describe('sudoers 白名单', () => {
    it('不含通配符（否则整份文件被拒载，所有面板操作静默失灵）', () => {
      const at = script.indexOf('cat > /etc/sudoers.d/mc-commander <<EOF');
      expect(at).toBeGreaterThan(-1);
      const body = script.slice(at, script.indexOf('\nEOF', at));
      const rules = body.split('\n').filter((l) => l.includes('NOPASSWD'));
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule, `白名单行含通配符会被 sudo 拒载：${rule}`).not.toContain('*');
        expect(rule).not.toContain('?');
      }
    });

    it('每条授权都对应一个精确的单元名（不是模板实例）', () => {
      const at = script.indexOf('cat > /etc/sudoers.d/mc-commander <<EOF');
      const body = script.slice(at, script.indexOf('\nEOF', at));
      // 模板单元（@）只能靠通配符授权，与上一条互斥
      expect(body).not.toContain('@');
    });
  });

  /* 安装与卸载的健壮性：每条对应一个用户会真实走到、且失败后果不可逆的场景。 */
  describe('安装与卸载的健壮性', () => {
    it('非 root 直接判死并给出 sudo 出路（不降级继续跑）', () => {
      // 降级继续会在 apt-get / mkdir 处报一串 Permission denied，用户看不出该做什么
      // 锚安装侧那句独有的报错：卸载侧也有同名判断，按裸条件会定位到卸载那一段
      const at = script.lastIndexOf(
        'if [ "$(id -u)" -ne 0 ]',
        script.indexOf('需要 root 权限：安装要写'),
      );
      expect(at).toBeGreaterThan(-1);
      const body = script.slice(at, script.indexOf('\nfi\n', at) + 4);
      expect(body).toContain('exit 1');
      expect(body).toContain('sudo bash');
      // 降级开关已随判死一并移除
      expect(script).not.toContain('SKIP_SYSTEMD');
    });

    it('安装目录落点校验在入口处，且用 realpath 归一（挡 /opt/../etc）', () => {
      const at = script.indexOf('MC_COMMANDER_DIR_RESOLVED=$(realpath -m');
      expect(at).toBeGreaterThan(-1);
      // 校验必须早于任何 mkdir / rm
      const firstMkdir = script.indexOf('mkdir -p "$MC_COMMANDER_DIR"');
      if (firstMkdir > 0) expect(at).toBeLessThan(firstMkdir);
      expect(script.slice(at, at + 900)).toContain('拒绝在系统目录上安装');
    });

    it('npm 包走国内镜像，失败回退官方源', () => {
      expect(script).toContain('--registry="$registry"');
      expect(script).toContain('https://registry.npmmirror.com');
      expect(script).toContain('https://registry.npmjs.org');
      const fnAt = script.indexOf('install_deps()');
      const body = script.slice(fnAt, fnAt + 700);
      expect(body).toContain('npmmirror');
      // 回退分支必须真的再装一次，而不是只 warn
      expect(body).toContain('install_deps "https://registry.npmjs.org"');
    });

    it('更新前备份旧代码，就绪失败时回退', () => {
      expect(script).toContain('CODE_BACKUP="$MC_COMMANDER_DIR/.rollback"');
      // 备份必须发生在覆盖代码之前
      const backupAt = script.indexOf('CODE_BACKUP="$MC_COMMANDER_DIR/.rollback"');
      const copyAt = script.indexOf('cp -rf "$TMP_EXTRACT/." "$MC_COMMANDER_DIR/"');
      expect(backupAt).toBeGreaterThan(-1);
      expect(backupAt).toBeLessThan(copyAt);
      // 失败分支里要真的把旧代码放回去并重启
      const failAt = script.indexOf('正在回退到升级前的版本');
      expect(failAt).toBeGreaterThan(copyAt);
      expect(script.slice(failAt, failAt + 800)).toContain('systemctl restart mc-commander');
    });

    it('更新先清掉要重铺的条目，避免旧文件残留', () => {
      const rmAt = script.indexOf('for entry in src public mc-schemas; do');
      const copyAt = script.indexOf('cp -rf "$TMP_EXTRACT/." "$MC_COMMANDER_DIR/"');
      expect(rmAt).toBeGreaterThan(-1);
      expect(rmAt).toBeLessThan(copyAt);
      // 清理范围不得包含数据与配置
      const body = script.slice(rmAt, copyAt);
      expect(body).not.toContain('.env');
      expect(body).not.toContain('var');
      expect(body).not.toContain('node_modules');
    });

    it('卸载清理 /tmp 下运行期目录，且路径跟着 TMPDIR', () => {
      const at = script.indexOf('tmp_root="${TMPDIR:-/tmp}"');
      expect(at).toBeGreaterThan(-1);
      const body = script.slice(at, at + 700);
      expect(body).toContain('mc-commander-logs');
      expect(body).toContain('mc-commander-uploads');
    });

    it('卸载处理 pm2 与 nohup 两种托管方式', () => {
      expect(script).toContain('pm2 describe mc-commander');
      expect(script).toContain('pm2 delete mc-commander');
      expect(script).toContain('$MC_COMMANDER_DIR/src/index.js');
    });
  });

  /* npm ci 的语义是先 rm -rf node_modules 再重建。期间旧进程还在服务，任何一次运行期
     懒加载都会撞上不存在的模块。升级必须有一个「没有读者」的窗口，且窗口开着时脚本
     中途死掉要把面板拉回来——否则升级失败等于面板消失，用户只看到一条报错。 */
  describe('升级期给 npm ci 一个没有读者的窗口', () => {
    /** 取「安装 npm 依赖」那一段的脚本文本 */
    function npmCiSection() {
      const start = script.indexOf('# 8. 安装 npm 依赖');
      if (start < 0) throw new Error('未能定位安装依赖段');
      const end = script.indexOf('# 9.', start);
      return script.slice(start, end < 0 ? start + 3000 : end);
    }

    it('npm ci 之前停面板，之后才装依赖', () => {
      const sec = npmCiSection();
      const stopAt = sec.indexOf('systemctl stop mc-commander');
      // 锚真实命令行：注释里也写着「npm ci」，按裸串定位会匹配到说明文字
      const ciAt = sec.indexOf('npm ci --omit=dev');
      expect(stopAt).toBeGreaterThan(-1);
      expect(ciAt).toBeGreaterThan(stopAt);
    });

    it('停之前先判 is-active，首次安装不白跑一次 stop', () => {
      const sec = npmCiSection();
      expect(sec).toContain('systemctl is-active --quiet mc-commander');
    });

    it('停成功后置位 PANEL_STOPPED，供 EXIT trap 拉回', () => {
      const sec = npmCiSection();
      const stopAt = sec.indexOf('systemctl stop mc-commander');
      const flagAt = sec.indexOf('PANEL_STOPPED=1', stopAt);
      expect(flagAt).toBeGreaterThan(stopAt);
    });

    it('EXIT trap 在 PANEL_STOPPED=1 时把面板拉回来，且失败给出可执行的手动命令', () => {
      const trapStart = script.indexOf('on_exit() {');
      const trapBody = script.slice(trapStart, script.indexOf('trap on_exit EXIT'));
      expect(trapBody).toContain('PANEL_STOPPED');
      expect(trapBody).toContain('systemctl start mc-commander');
      // 自动恢复失败时必须给手动出路，否则用户只知道「升级失败了」
      expect(trapBody).toContain('自动恢复失败，请手动执行：systemctl start mc-commander');
    });

    it('面板最终起来后清掉 PANEL_STOPPED，避免正常结束时多拉一次', () => {
      expect(script).toContain('PANEL_STOPPED=0');
      const clearAt = script.lastIndexOf('PANEL_STOPPED=0');
      const trapAt = script.indexOf('trap on_exit EXIT');
      // 置 0 的那处必须在 trap 定义之后（否则是初始化那行）
      expect(clearAt).toBeGreaterThan(trapAt);
    });
  });

  // 服务起不来时不能无限重试：3 秒间隔配 systemd 默认的「10 秒内 5 次」永远够不着额度，
  // 于是每 3 秒重试一次、永不进入 failed——用户既看不到「它坏了」，也等不到它自己好。
  describe('systemd 单元的重试上限', () => {
    /** 取出面板服务单元模板的正文（heredoc 之间那段） */
    function serviceUnitBody() {
      const start = script.indexOf('cat > /etc/systemd/system/mc-commander.service <<EOF');
      if (start < 0) throw new Error('未能定位面板服务单元模板');
      const bodyStart = script.indexOf('\n', start) + 1;
      const bodyEnd = script.indexOf('\nEOF', bodyStart);
      if (bodyEnd < 0) throw new Error('未能定位单元模板的结束标记');
      return script.slice(bodyStart, bodyEnd);
    }

    /** 单元文件里某个键落在哪个段（systemd 只认各段自己声明的键） */
    function sectionOf(body, key) {
      let section = '';
      for (const line of body.split('\n')) {
        const head = line.match(/^\[(.+)\]$/);
        if (head) section = head[1];
        if (line.startsWith(`${key}=`)) return section;
      }
      return null;
    }

    it('单元模板带 StartLimit，且间隔与次数能让失败态真的出现', () => {
      const body = serviceUnitBody();
      const interval = Number((body.match(/StartLimitIntervalSec=(\d+)/) || [])[1]);
      const burst = Number((body.match(/StartLimitBurst=(\d+)/) || [])[1]);
      const restartSec = Number((body.match(/RestartSec=(\d+)/) || [])[1]);
      expect(interval).toBeGreaterThan(0);
      expect(burst).toBeGreaterThan(0);
      // 窗口内能容纳的重试次数必须真的耗尽额度，否则限制形同虚设
      expect(Math.floor(interval / restartSec)).toBeGreaterThanOrEqual(burst);
    });

    it('StartLimit 必须写在 [Unit] 段：写进 [Service] 会被 systemd 当作未知键静默忽略', () => {
      // 实测 systemd 255：写在 [Service] 段时 `systemctl show` 回的是默认值
      // StartLimitIntervalUSec=10s，同时 journal 只有一行 Unknown key name——限流等于没设。
      // 故判据是「落在哪个段」，不是「脚本里有没有这两行」。
      const body = serviceUnitBody();
      expect(sectionOf(body, 'StartLimitIntervalSec')).toBe('Unit');
      expect(sectionOf(body, 'StartLimitBurst')).toBe('Unit');
    });
  });
  // 反代/域名部署下，脚本探测到的 IP 与用户实际访问的入口不是一回事：
  // 硬拼出来的链接必然打不开。PUBLIC_URL 让部署方给出真实入口。
  describe('横幅地址：PUBLIC_URL 优先于探测结果', () => {
    /** 取脚本里决定 PANEL_URL 的那段，喂不同环境变量看结果 */
    function resolvePanelUrl(env) {
      const lines = script.split('\n');
      const start = lines.findIndex((l) => l.startsWith('PANEL_URL=""'));
      if (start < 0) throw new Error('未能在部署脚本中定位 PANEL_URL 计算');
      const end = lines.findIndex((l, i) => i > start && l === 'fi');
      const snippet = lines.slice(start, end + 1).join('\n');
      // 私网判定是这段逻辑的依赖，必须一并注入——缺了它，私网地址会被当成公网拼进链接
      const privateFn = script.match(
        /PRIVATE_IPV4_RE='[^']+'\n[\s\S]*?is_private_ip\(\) \{[\s\S]*?\n\}/,
      );
      if (!privateFn) throw new Error('未能在部署脚本中定位 is_private_ip');
      const r = spawnSync(BASH_BIN, ['-c', 'eval "$SNIPPET"\necho "URL=$PANEL_URL"'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SNIPPET: privateFn[0] + '\n' + snippet,
          SERVER_PORT: '25566',
          ...env,
        },
      });
      return (r.stdout.match(/URL=(.*)/) || [])[1] ?? '';
    }

    it('给了 PUBLIC_URL 就用它（反代/域名部署的唯一出路）', () => {
      expect(
        resolvePanelUrl({
          PUBLIC_URL: 'https://mc.example.com',
          PUBLIC_IP_DETECTED: '203.0.113.9',
        }),
      ).toBe('https://mc.example.com/');
    });

    it('PUBLIC_URL 末尾多写斜杠不产生双斜杠', () => {
      expect(resolvePanelUrl({ PUBLIC_URL: 'https://mc.example.com/' })).toBe(
        'https://mc.example.com/',
      );
    });

    it('没给 PUBLIC_URL 时退回探测到的公网 IP', () => {
      // 必须用真公网地址：TEST-NET 段（203.0.113.0/24）本身就在私网/保留表里，会被拦下
      expect(resolvePanelUrl({ PUBLIC_IP_DETECTED: '1.2.3.4' })).toBe('http://1.2.3.4:25566/');
    });

    it('探测到的是私网地址时不拼链接（用户必然打不开）', () => {
      expect(resolvePanelUrl({ PUBLIC_IP_DETECTED: '192.168.1.10' })).toBe('');
    });
  });
  // TLS 起不来时服务端会退回纯明文（缺 openssl、证书生成失败等）。此时横幅若仍说
  // 「面板已支持加密访问」，用户会照它去装根证书，装完发现还是 http。
  // 判据必须是实测：能连上 https 才说支持。
  describe('加密访问的承诺以实测为准', () => {
    // 横幅本体（第一条边框到常用命令之间）
    const tlsBanner = script.split('本机加密访问未能启动')[0].split('# 12. 输出部署信息')[1] ?? '';

    it('横幅先探测 https 再决定说什么', () => {
      expect(script).toContain(
        'curl -skf -o /dev/null --connect-timeout 3 --max-time 6 "https://localhost:$SERVER_PORT/health"',
      );
      expect(tlsBanner).toContain('面板已支持加密访问');
      // 降级分支必须存在且说清后果与原因
      const fallback = script.split('本机加密访问未能启动')[1] ?? '';
      expect(fallback).toContain('面板其余功能不受影响');
      expect(fallback).toContain('常见原因：系统缺少 openssl 命令');
    });

    it('探测用的是本机 https，不是面板公网地址（安全组未放行时也要判得准）', () => {
      // 用 $PANEL_URL 探 https 会在安全组未放行时恒失败，把「TLS 正常」误报成「未启动」
      const httpsProbe = script.split('加密访问未能启动')[0].split('if curl -skf')[1] ?? '';
      expect(httpsProbe).toContain('localhost');
      expect(httpsProbe).not.toContain('$PANEL_URL');
    });
  });
  /* 实例是 detached 进程，不随面板服务停止：只停面板时它们继续跑、继续写存档、
     继续对外服务，且会让 userdel 必然失败。停实例必须排在停服务之前 */
  describe('卸载先停实例并如实清点数据', () => {
    it('停实例发生在停服务之前', () => {
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      const stopInstancesAt = body.indexOf('stop_running_instances');
      const stopServiceAt = body.indexOf('systemctl stop mc-commander');
      expect(stopInstancesAt).toBeGreaterThan(0);
      expect(stopInstancesAt).toBeLessThan(stopServiceAt);
    });

    it('数据清单逐项数文件，不按目录存在就说「仍然保留」', () => {
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      // 空目录上说「数据仍然保留」等于告诉用户存档还在，他可能因此不去备份
      expect(body).toMatch(/find[^\n]*wc -l/);
      expect(body).toContain('已没有实例或备份数据');
    });

    it('删用户失败给出手动处置步骤', () => {
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      expect(body).toContain('ps -u mc-commander');
      expect(body).toContain('pkill -u mc-commander');
    });

    it('删用户不以「本次见到单元」为前提：上次失败后重跑必须还会尝试', () => {
      // 上一次 userdel 因实例占着该用户而失败，同时单元已被删掉。重跑时单元不存在，
      // 若删用户仍以「见到单元」为前提就永远不会再尝试，机器上留下一个删不掉的系统用户。
      // 判据：门控只能由「别的部署认领了这个用户」挡住，不能由 unit_matches 挡住。
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      // 定位真正执行 userdel 的那一行往上最近的条件行（if 开头）
      const userdelAt = body.indexOf('userdel mc-commander');
      const guardLine = body
        .slice(0, userdelAt)
        .split('\n')
        .filter((l) => l.trim().startsWith('if '))
        .pop();
      expect(guardLine).toContain('unit_owned_by_other');
      expect(guardLine).not.toContain('unit_matches');
    });

    it('安装目录归一化：尾斜杠不得让单元归属判定失效（否则静默跳过停服务/删单元/删用户）', () => {
      // unit 里的 WorkingDirectory 是当次调用写入的字面量，而卸载要与它逐字比对。
      // 不归一化时 /opt/x/ 会被判成「另一个目录」：停服务、删单元、删用户全跳过，
      // 代码却照删——服务仍 enabled 且 Restart=always，每 3 秒拉起一个没有 node_modules 的进程。
      const normAt = script.indexOf('while [ "${MC_COMMANDER_DIR}" != "/" ]');
      expect(normAt).toBeGreaterThan(-1);
      // 归一化必须发生在任何比对与路径拼接之前
      expect(normAt).toBeLessThan(script.indexOf('MANIFEST="$MC_COMMANDER_DIR/.install-manifest"'));
      expect(normAt).toBeLessThan(script.indexOf('do_uninstall() {'));

      const run = (value) =>
        spawnSync(
          BASH_BIN,
          [
            '-c',
            [
              'MC_COMMANDER_DIR="$V"',
              'MC_COMMANDER_DIR="${MC_COMMANDER_DIR:-/opt/mc-commander}"',
              'while [ "${MC_COMMANDER_DIR}" != "/" ] && [ "${MC_COMMANDER_DIR%/}" != "$MC_COMMANDER_DIR" ]; do MC_COMMANDER_DIR="${MC_COMMANDER_DIR%/}"; done',
              '[ -n "$MC_COMMANDER_DIR" ] || MC_COMMANDER_DIR="/"',
              'printf "%s" "$MC_COMMANDER_DIR"',
            ].join('\n'),
          ],
          { encoding: 'utf8', env: { ...process.env, V: value } },
        ).stdout;
      expect(run('/opt/mc-commander')).toBe('/opt/mc-commander');
      expect(run('/opt/mc-commander/')).toBe('/opt/mc-commander');
      expect(run('/opt/mc-commander///')).toBe('/opt/mc-commander');
      // 根目录不能被归一化成空串（那会让危险路径守卫的 "/" 分支失效）
      expect(run('/')).toBe('/');
      expect(run('//')).toBe('/');
    });

    it('单元指向别的安装目录时才保留用户（互不误伤）', () => {
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      expect(body).toContain('unit_owned_by_other=1');
      // 指向别的目录 ⇒ 那套部署仍认领这个全局唯一用户
      const branch = body.slice(body.indexOf('unit_dir" = "$MC_COMMANDER_DIR"'));
      expect(branch.slice(0, 400)).toContain('unit_owned_by_other=1');
    });
  });

  /* 注释里写着 systemd-run，实现却是 sudo 触发预置的一次性单元：
     照着注释排查会去找一个根本不存在的延迟单元 */
  it('删除链路三处注释与实际启动方式一致', () => {
    const files = [
      '../src/services/panel-removal.sh',
      '../src/routes/panel.js',
      '../src/routes/panel.ts',
      '../../web/src/api/panel.ts',
    ];
    for (const rel of files) {
      const abs = path.resolve(import.meta.dirname, rel);
      if (!existsSync(abs)) continue;
      expect(readFileSync(abs, 'utf8'), `${rel} 仍写着 systemd-run`).not.toContain('systemd-run');
    }
    expect(
      readFileSync(path.resolve(import.meta.dirname, '../src/routes/panel.js'), 'utf8'),
    ).toContain('--no-block');
  });

  /* 卸载在安装流程之前分派，那时 PKG_MANAGER 还没赋值：读它会让系统包一条都卸不掉，
     而脚本照常报「卸载完成」 */
  describe('卸载按命令探测包管理器', () => {
    it('系统包卸载不依赖安装阶段才赋值的 $PKG_MANAGER', () => {
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      expect(body).not.toContain('case "${PKG_MANAGER:-}"');
      expect(body).toMatch(/command -v apt-get/);
    });

    it('PKG_MANAGER 的赋值确实在 do_uninstall 之后（依赖它就是恒不执行）', () => {
      const uninstallAt = script.indexOf('do_uninstall() {');
      const assignAt = script.indexOf('PKG_MANAGER="apt"');
      expect(assignAt).toBeGreaterThan(uninstallAt);
    });
  });

  /* 安装时往 apt/yum 源目录里写 corretto 的密钥与源文件；卸载不撤，用户机器的包管理器
     会一直带着一个指向已删项目的源 */
  describe('卸载撤掉安装时写的软件源', () => {
    it('do_uninstall 里有 repo-file 分支', () => {
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      expect(body).toContain('repo-file');
      expect(body).toContain('repo_file_allowed');
    });

    it('只删软件源目录内的文件，清单被改写也删不到别处', () => {
      // 判定抽成函数后要连函数体一起看：白名单在函数里，分支里只剩调用
      expect(script).toMatch(
        /REPO_FILE_ROOTS="\$\{REPO_FILE_ROOTS:-\/etc\/apt\/sources\.list\.d \/etc\/yum\.repos\.d \/usr\/share\/keyrings\}"/,
      );
      const fnStart = script.indexOf('repo_file_allowed() {');
      const helper = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      // 上跳段必须显式拒绝：只做前缀匹配挡不住 <root>/../../etc/shadow
      expect(helper).toContain('*/../*');
    });

    it('清单在删目录之前读进内存，--purge 也能回滚', () => {
      // 清单是安装目录里的文件：--purge 的 rm -rf 会连它一起删掉。等删完再判清单存在，
      // 整段回滚就是死代码——脚本报「已无残留」，系统包与软件源却全在机器上
      const at = script.indexOf('do_uninstall() {');
      const body = script.slice(at, script.indexOf('\n}\n', at));
      const snapshot = body.indexOf('manifest_lines=$(cat "$MANIFEST")');
      const purgeRm = body.indexOf('rm -rf "$MC_COMMANDER_DIR"');
      const rollback = body.indexOf('if [ -n "$manifest_lines" ]; then');
      expect(snapshot).toBeGreaterThan(0);
      expect(snapshot).toBeLessThan(purgeRm);
      expect(rollback).toBeGreaterThan(purgeRm);
      expect(body).not.toContain('done < "$mf"');
    });

    it('防火墙值只接受端口号，清单里塞的非数字一律跳过', () => {
      const fnStart = script.indexOf('do_uninstall() {');
      const body = script.slice(fnStart, script.indexOf('\n}\n', fnStart));
      expect(body).toMatch(/\^\[0-9\]\{1,5\}\$/);
      expect(body).toMatch(/-gt 65535/);
      expect(body).toContain('忽略非法防火墙端口');
    });
  });
});
