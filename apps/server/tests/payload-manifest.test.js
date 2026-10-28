/**
 * 发布载荷契约：产物组成由 `tools/deploy/stage-payload.mjs` 的白名单单源声明。
 *
 * 锁的是结构，不是某个文件的内容：
 *   ① 白名单默认拒绝——未登记的文件必须被判违规（负向探针）；
 *   ② 开发与分发属性文件不进载荷（测试/lint 配置、仓库 README、启动脚本、安装脚本副本、
 *      契约包源码）：它们对运行时进程与安装过程都没有消费者；
 *   ③ 契约包清单只保留运行期字段（`exports.types` 指向不进产物的 `src/`，留着就是死指针）；
 *   ④ 打包入口唯一：发布流程必须调用组装器，不得再出现「拷整包 + 排除清单」的写法；
 *   ⑤ 安装脚本在解包阶段拦住缺契约包产物的包（缺了它安装照样成功，启动才崩）；
 *   ⑥ lock 里的依赖地址必须是公共 registry——`npm ci` 严格按 `resolved` 取包，
 *      内网镜像域名在用户机上解析不到，安装会停在「装 npm 依赖」一步。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findForeignResolved,
  findViolations,
  PAYLOAD,
  runtimePackageJson,
} from '../../../tools/deploy/stage-payload.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
const INSTALLER = readFileSync(join(REPO, 'apps/server/scripts/deploy-mc-commander.sh'), 'utf8');
const RELEASE_YML = readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8');

describe('发布载荷白名单', () => {
  it('合规载荷通过（正向）', () => {
    const ok = [
      '.env.example',
      'package.json',
      'package-lock.json',
      'src/index.js',
      'src/services/mc_server.js',
      'public/index.html',
      'mc-schemas/package.json',
      'mc-schemas/dist/index.js',
    ];
    expect(findViolations(ok)).toEqual([]);
  });

  it('未登记文件被判违规（负向探针：白名单是默认拒绝）', () => {
    const bad = [
      'vitest.config.js',
      '.oxlintrc.json',
      'README.md',
      'start.sh',
      'start.bat',
      'scripts/deploy-mc-commander.sh',
      'tests/config.test.js',
      'node_modules/express/index.js',
      'var/data/mc_commander.db',
      'mc-schemas/src/index.ts',
      'mc-schemas/tsconfig.json',
      'mc-schemas/vitest.config.js',
    ];
    expect(findViolations(bad).sort()).toEqual([...bad].sort());
  });

  it('白名单本身不含开发/分发属性条目', () => {
    const declared = [...PAYLOAD.serverFiles, ...PAYLOAD.serverDirs, ...PAYLOAD.schemasFiles];
    for (const devOnly of [
      'tests',
      'scripts',
      'vitest.config.js',
      '.oxlintrc.json',
      'README.md',
      'start.sh',
      'start.bat',
    ]) {
      expect(declared).not.toContain(devOnly);
    }
    // 契约包只送运行期产物：源码与 TS/测试配置都不进包
    expect(PAYLOAD.schemasFiles).not.toContain('src');
    expect(PAYLOAD.schemasFiles).not.toContain('tsconfig.json');
  });

  it('契约包清单收敛为运行期字段', () => {
    const runtime = runtimePackageJson({
      name: '@mc-commander/schemas',
      version: '9.9.9',
      main: './dist/index.js',
      exports: { '.': { types: './src/index.ts', default: './dist/index.js' } },
      devDependencies: { vitest: '5.0.4' },
      scripts: { build: 'rolldown' },
      files: ['dist'],
    });
    expect(runtime.devDependencies).toBeUndefined();
    expect(runtime.scripts).toBeUndefined();
    expect(runtime.files).toBeUndefined();
    expect(runtime.exports['.'].types).toBeUndefined();
    expect(runtime.exports['.'].default).toBe('./dist/index.js');
  });
});

describe('打包入口唯一', () => {
  it('发布流程调用组装器，而不是自带搬运逻辑', () => {
    expect(RELEASE_YML).toContain('node tools/deploy/stage-payload.mjs');
    expect(RELEASE_YML).not.toMatch(/tar -cf - -C apps\/server/);
  });
});

describe('安装期 fail-closed', () => {
  it('解包后校验契约包产物存在', () => {
    expect(INSTALLER).toMatch(/if \[ ! -f "\$TMP_EXTRACT\/mc-schemas\/dist\/index\.js" \]/);
  });

  it('依赖按 lock 精确重建（npm ci 而非 npm install）', () => {
    expect(INSTALLER).toContain('npm ci --omit=dev');
    expect(INSTALLER).not.toMatch(/^npm install --omit=dev$/m);
  });
});

describe('载荷 lock 的依赖地址必须用户机可达', () => {
  const STAGER = readFileSync(join(REPO, 'tools/deploy/stage-payload.mjs'), 'utf8');

  it('内网镜像域被判违规（打包机的 registry 会被 lock 照抄）', () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/x': {
          resolved: 'http://mirrors.tencentyun.com/npm/x/-/x-1.0.0.tgz',
        },
      },
    });
    expect(findForeignResolved(lock)).toHaveLength(1);
  });

  it('公共 registry 放行（正向）', () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/x': {
          resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
        },
      },
    });
    expect(findForeignResolved(lock)).toEqual([]);
  });

  it('生成 lock 时显式钉住公共 registry，不继承打包机的 npm 配置', () => {
    // 只钉住「传入 --registry」这一件事：若改成信任环境（去掉该参数），
    // 打包机换一台（CI 与维护者机器 registry 不同）就会静默产出装不上的包
    expect(STAGER).toMatch(/'--registry=https:\/\/registry\.npmjs\.org'/);
  });

  it('生成后仍要自检一遍：参数被 npm 忽略时也要在打包期拦下', () => {
    // 变异：删掉 assertPublicLock 调用 ⇒ 转红
    expect(STAGER).toMatch(/assertPublicLock\(staging\)/);
  });
});
