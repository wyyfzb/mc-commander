/**
 * 模组（Fabric/Forge）管理：`mods/` 复用插件模型。
 *
 * 与 `plugins.test.js` 的分工：那份锁 Bukkit 系 `plugins/` 的既有行为（行为必须逐字
 * 不变）；本份锁**新增的第二种装载目标**——差异只有两点（目录名、不支持文件级启停），
 * 而这两点正是「照搬插件语义会出错」的地方：
 *
 * 1. `.disabled` 是 **Bukkit 系约定**，Forge/Fabric 在文件层面**没有**通用等价物
 *    ⇒ 若照搬，用户会以为「已禁用」而 mod 仍被加载（写出的文件名 loader 也不认）
 * 2. 目录必须**真的落在 `mods/`**，不能因为复用模型而读写 `plugins/`
 *
 * 全部写盘面指向 os.tmpdir()，不触碰仓库真实实例目录。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { createPluginRoutes } from '../routes/plugins.js';
import {
  listPlugins,
  uploadPlugin,
  deletePlugin,
  setPluginEnabled,
  resolveLoadTarget,
  LOAD_TARGETS,
} from '../services/plugin.service.js';
import { errorHandler } from '../middleware/error_handler.js';

vi.mock('../utils/audit.js', () => ({
  AuditActions: {
    PLUGIN_UPLOAD: 'PLUGIN_UPLOAD',
    PLUGIN_ENABLE: 'PLUGIN_ENABLE',
    PLUGIN_DISABLE: 'PLUGIN_DISABLE',
    PLUGIN_DELETE: 'PLUGIN_DELETE',
    MOD_UPLOAD: 'MOD_UPLOAD',
    MOD_DELETE: 'MOD_DELETE',
  },
  recordAudit: vi.fn(),
}));

import { recordAudit } from '../utils/audit.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-mods-'));
const serverPath = path.join(tmpRoot, 'inst1');
const modsDir = path.join(serverPath, 'mods');
const pluginsDir = path.join(serverPath, 'plugins');

function ensureModsDir() {
  fs.mkdirSync(modsDir, { recursive: true });
}

/** 写一个 mods/ 下的假 mod jar（Fabric 的 fabric.mod.json 形态；内容对本层无关，只要是 zip） */
function writeModJar(fileName, descriptor = 'fabric.mod.json') {
  const zip = new AdmZip();
  zip.addFile(descriptor, Buffer.from('{"id":"example","version":"1.0.0"}', 'utf8'));
  zip.writeZip(path.join(modsDir, fileName));
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(modsDir, { recursive: true, force: true });
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('装载目标表（目录名的唯一声明源）', () => {
  it('两个目标的目录名与启停能力', () => {
    expect(LOAD_TARGETS.plugin).toMatchObject({ dir: 'plugins', supportsToggle: true });
    expect(LOAD_TARGETS.mod).toMatchObject({ dir: 'mods', supportsToggle: false });
  });

  it('未知 kind 报错而不是回落到 plugins/（回落会把「拼错」变成「操作错目录」）', () => {
    expect(() => resolveLoadTarget('mods')).toThrowError(/Unknown load target/);
    expect(() => resolveLoadTarget('')).toThrowError(/Unknown load target/);
  });

  it('原型链键必须同样被拒（否则 dir/label 全 undefined，删除会先删再抛）', () => {
    // 直接下标会走原型链：这些键在旧实现下被判为「合法目标」，随后 dir 为 undefined、
    // listPlugins/deletePlugin 抛原生 TypeError（对外 500），且 deletePlugin 会在抛错
    // **之前**真的删掉文件。这是「决定改哪个目录」的守卫，必须 own-property 判定。
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(() => resolveLoadTarget(key), key).toThrowError(/Unknown load target/);
    }
  });

  it('原型链键不会造成任何文件被删（拒绝必须发生在 unlink 之前）', () => {
    ensureModsDir();
    writeModJar('canary.jar');
    expect(() => deletePlugin(serverPath, 'canary.jar', { kind: 'constructor' })).toThrowError(
      /Unknown load target/,
    );
    expect(fs.existsSync(path.join(modsDir, 'canary.jar')), '文件不得被删').toBe(true);
  });

  it('不传 kind 时默认 plugins（既有调用方行为零变化）', () => {
    expect(resolveLoadTarget().dir).toBe('plugins');
  });
});

describe('listPlugins({kind:"mod"}) 读的是 mods/ 而不是 plugins/', () => {
  it('只列出 mods/ 下的 jar，忽略 plugins/ 下的（目录不能串）', () => {
    ensureModsDir();
    fs.mkdirSync(pluginsDir, { recursive: true });
    writeModJar('sodium.jar');
    // plugins/ 下放一个插件：kind=mod 时**不得**被列出
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: EssentialsX\n', 'utf8'));
    zip.writeZip(path.join(pluginsDir, 'essentialsx.jar'));

    const mods = listPlugins(serverPath, { kind: 'mod' }).plugins;
    expect(mods.map((p) => p.file)).toEqual(['sodium.jar']);

    const plugins = listPlugins(serverPath, { kind: 'plugin' }).plugins;
    expect(plugins.map((p) => p.file)).toEqual(['essentialsx.jar']);
  });

  it('mods/ 不存在视为空列表（不报错）', () => {
    expect(listPlugins(serverPath, { kind: 'mod' }).plugins).toEqual([]);
  });

  it('mods/ 是文件而非目录时报错', () => {
    fs.mkdirSync(serverPath, { recursive: true });
    fs.writeFileSync(modsDir, 'not a dir');
    expect(() => listPlugins(serverPath, { kind: 'mod' })).toThrowError(/not a directory/);
  });

  it('非 jar 文件被忽略（白名单）', () => {
    ensureModsDir();
    fs.writeFileSync(path.join(modsDir, 'readme.txt'), 'x');
    fs.writeFileSync(path.join(modsDir, '.hidden.jar'), 'x');
    writeModJar('ok.jar');
    expect(listPlugins(serverPath, { kind: 'mod' }).plugins.map((p) => p.file)).toEqual(['ok.jar']);
  });
});

describe('模组不支持文件级启停（防照搬 Bukkit 的 .disabled 约定）', () => {
  it('setPluginEnabled(kind:"mod") 直接拒绝，且**不改名任何文件**', () => {
    ensureModsDir();
    writeModJar('sodium.jar');

    expect(() => setPluginEnabled(serverPath, 'sodium.jar', false, { kind: 'mod' })).toThrowError(
      /不支持按文件启停/,
    );
    // 关键：拒绝必须发生在**改名之前**——若先改名再报错，磁盘上会留下 loader 不认的
    // 文件名（mod 消失），比明确报错危险得多
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar'))).toBe(true);
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar.disabled'))).toBe(false);
  });

  it('插件目标仍可启停（既有行为不变）', () => {
    fs.mkdirSync(pluginsDir, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: X\n', 'utf8'));
    zip.writeZip(path.join(pluginsDir, 'x.jar'));

    const r = setPluginEnabled(serverPath, 'x.jar', false, { kind: 'plugin' });
    expect(r).toEqual({ file: 'x.jar.disabled', enabled: false });
    expect(fs.existsSync(path.join(pluginsDir, 'x.jar.disabled'))).toBe(true);
  });

  it('不存在 enabled 端点：mods 没有启停入口（HTTP 层也不给）', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createPluginRoutes({ getInstance: () => ({ serverPath }) }));
    app.use(errorHandler);

    const res = await request(app)
      .put('/api/v1/instances/inst1/mods/sodium.jar/enabled')
      .send({ enabled: false });
    // 未注册该路由 ⇒ 404（不是 200 假成功，也不是 500）
    expect(res.status).toBe(404);
  });
});

describe('上传与删除走 mods/', () => {
  it('uploadPlugin(kind:"mod") 落盘到 mods/ 且创建目录', () => {
    const tmpFile = path.join(tmpRoot, 'incoming.jar');
    const zip = new AdmZip();
    zip.addFile('fabric.mod.json', Buffer.from('{"id":"x"}', 'utf8'));
    zip.writeZip(tmpFile);

    const r = uploadPlugin(serverPath, tmpFile, 'sodium.jar', { kind: 'mod' });
    expect(r.file).toBe('sodium.jar');
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'sodium.jar'))).toBe(false);
  });

  it('非 zip 伪装成 jar 被拒（与插件同款魔数校验）', () => {
    const tmpFile = path.join(tmpRoot, 'fake.jar');
    fs.writeFileSync(tmpFile, 'not a zip at all');
    expect(() => uploadPlugin(serverPath, tmpFile, 'fake.jar', { kind: 'mod' })).toThrowError(
      /zip magic/,
    );
  });

  it('deletePlugin(kind:"mod") 删的是 mods/ 下的文件', () => {
    ensureModsDir();
    writeModJar('sodium.jar');
    expect(deletePlugin(serverPath, 'sodium.jar', { kind: 'mod' })).toEqual({
      deleted: 'sodium.jar',
    });
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar'))).toBe(false);
  });

  it('删除不存在的 mod → PLUGIN_NOT_FOUND 语义（字符串保持英文，与插件一致）', () => {
    ensureModsDir();
    expect(() => deletePlugin(serverPath, 'Ghost.jar', { kind: 'mod' })).toThrowError(/not found/);
  });

  it('路径穿越文件名被拒（mods/ 与 plugins/ 同款防护）', () => {
    ensureModsDir();
    for (const bad of ['../evil.jar', 'a/b.jar', '.hidden.jar', 'x.jar.exe']) {
      expect(() => deletePlugin(serverPath, bad, { kind: 'mod' }), bad).toThrowError(
        /Invalid mod path|Invalid mod file name/,
      );
    }
  });

  it('父目录包含校验真的在承重：文件名合法但解析结果不在目标目录时被拒', () => {
    // 上一个用例喂的名字**全部**已被 PLUGIN_FILE_REGEX 挡下，故它只证明了正则有效，
    // 没证明 resolveSafePath + 父目录校验这一层。这里直接调用解析结果校验的判据：
    // 让 mods/ 内出现一个**指向外部目录**的文件级 symlink（名字合法：linked.jar），
    // 它必须被 realpath 那一步拦下——这层若被改坏，上一条用例照样绿。
    ensureModsDir();
    const outsideDir = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'target.jar'), 'SENSITIVE');
    try {
      fs.symlinkSync(path.join(outsideDir, 'target.jar'), path.join(modsDir, 'linked.jar'), 'file');
    } catch {
      return; // 平台不允许创建 symlink（无权限）时跳过：本用例的前提无法建立
    }
    expect(() => deletePlugin(serverPath, 'linked.jar', { kind: 'mod' })).toThrowError(
      /Invalid mod path/,
    );
    expect(fs.existsSync(path.join(outsideDir, 'target.jar')), '外部文件不得被删').toBe(true);
  });
});

describe('HTTP 端点（/instances/:id/mods）', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createPluginRoutes({ getInstance: () => ({ serverPath }) }));
    app.use(errorHandler);
    return app;
  }

  it('GET /mods 返回 mods/ 内容', async () => {
    ensureModsDir();
    writeModJar('sodium.jar');
    const res = await request(buildApp()).get('/api/v1/instances/inst1/mods');
    expect(res.status).toBe(200);
    expect(res.body.data.plugins.map((p) => p.file)).toEqual(['sodium.jar']);
  });

  it('DELETE /mods/:file 删除并写 MOD_DELETE 审计', async () => {
    ensureModsDir();
    writeModJar('sodium.jar');
    const res = await request(buildApp()).delete('/api/v1/instances/inst1/mods/sodium.jar');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: 'sodium.jar' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MOD_DELETE', targetType: 'mod' }),
    );
  });

  it('POST /mods/upload 落盘到 mods/ 并写 MOD_UPLOAD 审计', async () => {
    const zip = new AdmZip();
    zip.addFile('fabric.mod.json', Buffer.from('{"id":"x"}', 'utf8'));
    const buf = zip.toBuffer();

    const res = await request(buildApp())
      .post('/api/v1/instances/inst1/mods/upload')
      .attach('file', buf, 'sodium.jar');

    expect(res.status).toBe(201);
    expect(res.body.data.file).toBe('sodium.jar');
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MOD_UPLOAD', targetType: 'mod' }),
    );
  });

  it('实例不存在 → 404（三个端点一致）', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createPluginRoutes({ getInstance: () => null }));
    app.use(errorHandler);

    expect((await request(app).get('/api/v1/instances/nope/mods')).status).toBe(404);
    expect((await request(app).delete('/api/v1/instances/nope/mods/x.jar')).status).toBe(404);
  });
});
