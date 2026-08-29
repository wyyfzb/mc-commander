import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { createPluginRoutes } from '../routes/plugins.js';
import { listPlugins, setPluginEnabled, deletePlugin, readPluginMeta } from '../services/plugin.service.js';
import { errorHandler } from '../middleware/error_handler.js';

// mock 审计（recordAudit 内部吞错，直接 spy 断言调用参数）
vi.mock('../utils/audit.js', () => ({
  AuditActions: {
    PLUGIN_UPLOAD: 'PLUGIN_UPLOAD',
    PLUGIN_ENABLE: 'PLUGIN_ENABLE',
    PLUGIN_DISABLE: 'PLUGIN_DISABLE',
    PLUGIN_DELETE: 'PLUGIN_DELETE',
  },
  recordAudit: vi.fn(),
}));

import { recordAudit } from '../utils/audit.js';
import { uploadPlugin } from '../services/plugin.service.js';

// 临时实例目录：每个用例独立，测试后整体清理
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-plugins-'));
const serverPath = path.join(tmpRoot, 'inst1');
const pluginsDir = path.join(serverPath, 'plugins');

function ensurePluginsDir() {
  fs.mkdirSync(pluginsDir, { recursive: true });
}

/// 创建带 plugin.yml 的真实 jar（adm-zip 产物与 Bukkit 插件同为 zip 容器）
function writePluginJar(fileName, yml = 'name: EssentialsX\nversion: 2.20.1\nmain: net.essentialsx.Essentials\napi-version: "1.20"\nauthors: [EssentialsX Team]\ndepend: [Vault]\n') {
  const zip = new AdmZip();
  zip.addFile('plugin.yml', Buffer.from(yml, 'utf8'));
  zip.writeZip(path.join(pluginsDir, fileName));
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('plugin.service - listPlugins', () => {
  beforeEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('plugins 目录不存在返回空列表（首启前无该目录，不应报错）', () => {
    expect(listPlugins(serverPath)).toEqual({ plugins: [] });
  });

  it('列出启用/禁用插件，启用优先排序，读取 jar 内 plugin.yml 元数据', () => {
    ensurePluginsDir();
    writePluginJar('EssentialsX-2.20.1.jar');
    writePluginJar('Vault.jar',
      'name: Vault\nversion: 1.7.3\nmain: net.milkbowl.vault.Vault\n');
    // 禁用插件：.disabled 后缀
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: WorldEdit\nversion: 7.3.0\nmain: com.sk89q.worldedit.WorldEdit\n', 'utf8'));
    zip.writeZip(path.join(pluginsDir, 'WorldEdit.jar.disabled'));
    // 非 jar 文件与子目录应被忽略
    fs.writeFileSync(path.join(pluginsDir, 'README.txt'), 'not a plugin');
    fs.mkdirSync(path.join(pluginsDir, 'EssentialsX'), { recursive: true });

    const { plugins } = listPlugins(serverPath);
    expect(plugins).toHaveLength(3);
    // 启用优先，再按文件名字典序
    expect(plugins.map((p) => p.file)).toEqual(['EssentialsX-2.20.1.jar', 'Vault.jar', 'WorldEdit.jar.disabled']);
    expect(plugins[0].enabled).toBe(true);
    expect(plugins[2].enabled).toBe(false);
    // 元数据：来自 jar 内 plugin.yml
    expect(plugins[0].meta).toMatchObject({
      name: 'EssentialsX',
      version: '2.20.1',
      main: 'net.essentialsx.Essentials',
      apiVersion: '1.20',
      authors: ['EssentialsX Team'],
      depend: ['Vault'],
    });
    expect(plugins[2].meta.name).toBe('WorldEdit');
  });

  it('损坏的 jar（非 zip 内容）元数据降级为 null，不影响列表', () => {
    ensurePluginsDir();
    fs.writeFileSync(path.join(pluginsDir, 'broken.jar'), 'definitely not a zip');
    const { plugins } = listPlugins(serverPath);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].file).toBe('broken.jar');
    expect(plugins[0].meta).toBeNull();
  });

  it('paper-plugin.yml 作为退回 descriptor 被读取', () => {
    ensurePluginsDir();
    const zip = new AdmZip();
    zip.addFile('paper-plugin.yml', Buffer.from('name: PaperPlug\nversion: 1.0.0\nmain: com.example.PaperPlug\napiVersion: "1.21"\n', 'utf8'));
    zip.writeZip(path.join(pluginsDir, 'paperplug.jar'));
    const meta = readPluginMeta(path.join(pluginsDir, 'paperplug.jar'));
    expect(meta).toMatchObject({ name: 'PaperPlug', apiVersion: '1.21' });
  });
});

describe('plugin.service - setPluginEnabled', () => {
  beforeEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('禁用：jar → jar.disabled 重命名生效', () => {
    ensurePluginsDir();
    writePluginJar('Vault.jar');
    const result = setPluginEnabled(serverPath, 'Vault.jar', false);
    expect(result).toEqual({ file: 'Vault.jar.disabled', enabled: false });
    expect(fs.existsSync(path.join(pluginsDir, 'Vault.jar'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, 'Vault.jar.disabled'))).toBe(true);
  });

  it('启用：jar.disabled → jar 重命名生效', () => {
    ensurePluginsDir();
    writePluginJar('Vault.jar');
    fs.renameSync(path.join(pluginsDir, 'Vault.jar'), path.join(pluginsDir, 'Vault.jar.disabled'));
    const result = setPluginEnabled(serverPath, 'Vault.jar.disabled', true);
    expect(result).toEqual({ file: 'Vault.jar', enabled: true });
    expect(fs.existsSync(path.join(pluginsDir, 'Vault.jar'))).toBe(true);
  });

  it('重复启停返回 409 语义冲突（PLUGIN_STATE_CONFLICT）', () => {
    ensurePluginsDir();
    writePluginJar('Vault.jar');
    expect(() => setPluginEnabled(serverPath, 'Vault.jar', true)).toThrowError(/already enabled/);
  });

  it('目标名已存在时拒绝并保留两个文件（不覆盖）', () => {
    ensurePluginsDir();
    writePluginJar('Vault.jar');
    writePluginJar('Vault.jar.disabled');
    expect(() => setPluginEnabled(serverPath, 'Vault.jar', false)).toThrowError(/Target file already exists/);
    expect(fs.existsSync(path.join(pluginsDir, 'Vault.jar'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'Vault.jar.disabled'))).toBe(true);
  });

  it('非法文件名（路径逃逸/非 jar）返回 400', () => {
    ensurePluginsDir();
    for (const bad of ['../evil.jar', 'a/b.jar', '.hidden.jar', 'x.txt', '', 'x.jar.zip']) {
      expect(() => setPluginEnabled(serverPath, bad, false)).toThrowError(/Invalid plugin/);
    }
  });

  it('文件不存在返回 404 语义（PLUGIN_NOT_FOUND）', () => {
    ensurePluginsDir();
    expect(() => setPluginEnabled(serverPath, 'Ghost.jar', false)).toThrowError(/not found/);
  });
});

describe('plugin.service - deletePlugin', () => {
  beforeEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    ensurePluginsDir();
    vi.clearAllMocks();
  });

  it('删除启用的插件 jar', () => {
    writePluginJar('Vault.jar');
    expect(deletePlugin(serverPath, 'Vault.jar')).toEqual({ deleted: 'Vault.jar' });
    expect(fs.existsSync(path.join(pluginsDir, 'Vault.jar'))).toBe(false);
  });

  it('删除禁用状态（.disabled）的插件 jar', () => {
    writePluginJar('Vault.jar');
    fs.renameSync(path.join(pluginsDir, 'Vault.jar'), path.join(pluginsDir, 'Vault.jar.disabled'));
    deletePlugin(serverPath, 'Vault.jar.disabled');
    expect(fs.readdirSync(pluginsDir)).toHaveLength(0);
  });

  it('文件不存在报错', () => {
    expect(() => deletePlugin(serverPath, 'Ghost.jar')).toThrowError(/not found/);
  });
});

describe('Plugin Routes', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    ensurePluginsDir();
    app = express();
    app.use(express.json());
    mockManager = { getInstance: vi.fn() };
    app.use('/api/v1', createPluginRoutes(mockManager));
    app.use(errorHandler);
    vi.clearAllMocks();
  });

  it('GET 列表：实例存在返回 200 与插件数组', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    writePluginJar('Vault.jar');
    const res = await request(app).get('/api/v1/instances/inst1/plugins');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.plugins).toHaveLength(1);
    expect(res.body.data.plugins[0].file).toBe('Vault.jar');
  });

  it('GET 列表：实例不存在返回 404 INSTANCE_NOT_FOUND', async () => {
    mockManager.getInstance.mockReturnValue(null);
    const res = await request(app).get('/api/v1/instances/nope/plugins');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40401);
  });

  it('PUT 启停：200 + 审计记录 PLUGIN_DISABLE', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    writePluginJar('Vault.jar');
    const res = await request(app)
      .put('/api/v1/instances/inst1/plugins/Vault.jar/enabled')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ file: 'Vault.jar.disabled', enabled: false });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst1',
      action: 'PLUGIN_DISABLE',
      targetType: 'plugin',
      targetId: 'Vault.jar',
    }));
  });

  it('PUT 启停：enabled 非布尔返回 400', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    const res = await request(app)
      .put('/api/v1/instances/inst1/plugins/Vault.jar/enabled')
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('PUT 启停：重复状态返回 409 PLUGIN_STATE_CONFLICT', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    writePluginJar('Vault.jar');
    const res = await request(app)
      .put('/api/v1/instances/inst1/plugins/Vault.jar/enabled')
      .send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40910);
  });

  it('DELETE：200 + 审计记录 PLUGIN_DELETE', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    writePluginJar('Vault.jar');
    const res = await request(app).delete('/api/v1/instances/inst1/plugins/Vault.jar');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: 'Vault.jar' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PLUGIN_DELETE',
      targetId: 'Vault.jar',
    }));
  });

  it('DELETE：非法文件名返回 400（路径逃逸防护穿透到路由层）', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    const res = await request(app).delete('/api/v1/instances/inst1/plugins/..%2Fevil.jar');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('DELETE：实例不存在返回 404', async () => {
    mockManager.getInstance.mockReturnValue(null);
    const res = await request(app).delete('/api/v1/instances/nope/plugins/Vault.jar');
    expect(res.status).toBe(404);
  });
});

describe('plugin.service - uploadPlugin（feat-8 上传延伸）', () => {
  beforeEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** 在 tmpRoot 下生成待上传文件，返回其绝对路径 */
  function stageUpload(fileName, content) {
    const p = path.join(tmpRoot, fileName);
    fs.writeFileSync(p, content);
    return p;
  }

  it('合法 jar 上传成功：落盘 + 元数据解析 + 自动创建 plugins 目录', () => {
    // 故意不预建 plugins 目录（首启前装插件是主流流程）
    const tmp = stageUpload('essx.jar', Buffer.alloc(0));
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: EssentialsX\nversion: 2.20.1\nmain: net.essentialsx.Essentials\nwebsite: https://essentialsx.net\nsoftdepend: [Vault]\nload: POSTWORLD\n', 'utf8'));
    zip.writeZip(tmp);

    const result = uploadPlugin(serverPath, tmp, 'EssentialsX-2.20.1.jar');
    expect(result.file).toBe('EssentialsX-2.20.1.jar');
    expect(result.overwritten).toBe(false);
    expect(result.sizeBytes).toBe(fs.statSync(path.join(pluginsDir, 'EssentialsX-2.20.1.jar')).size);
    expect(result.meta).toMatchObject({
      name: 'EssentialsX',
      website: 'https://essentialsx.net',
      softdepend: ['Vault'],
      load: 'POSTWORLD',
    });
    expect(fs.existsSync(path.join(pluginsDir, 'EssentialsX-2.20.1.jar'))).toBe(true);
  });

  it('非 jar 扩展名返回 400', () => {
    const tmp = stageUpload('notes.txt', 'hello');
    expect(() => uploadPlugin(serverPath, tmp, 'notes.txt')).toThrowError(/Invalid plugin file name/);
  });

  it('路径逃逸文件名返回 400', () => {
    const tmp = stageUpload('evil.jar', Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(() => uploadPlugin(serverPath, tmp, '../evil.jar')).toThrowError(/Invalid plugin file name/);
    expect(() => uploadPlugin(serverPath, tmp, 'a/b.jar')).toThrowError(/Invalid plugin file name/);
    // .disabled 状态不允许直接上传（启停走接口）
    expect(() => uploadPlugin(serverPath, tmp, 'Vault.jar.disabled')).toThrowError(/Invalid plugin file name/);
  });

  it('非 zip 内容（伪装 .jar）返回 400（魔数校验）', () => {
    const tmp = stageUpload('fake.jar', 'this is not a zip file');
    expect(() => uploadPlugin(serverPath, tmp, 'Fake.jar'))
      .toThrowError(/not a valid jar \(zip magic check failed\)/);
    expect(fs.existsSync(path.join(pluginsDir, 'Fake.jar'))).toBe(false);
  });

  it('同名冲突默认拒绝（40912），源文件保留', () => {
    writePluginJar('Vault.jar', 'name: Vault\nversion: 1.7.3\nmain: net.milkbowl.vault.Vault\n');
    const tmp = stageUpload('new.jar', Buffer.alloc(0));
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: Vault\nversion: 9.9.9\nmain: net.milkbowl.vault.Vault\n', 'utf8'));
    zip.writeZip(tmp);

    expect(() => uploadPlugin(serverPath, tmp, 'Vault.jar')).toThrowError(/already exists/);
    // 旧文件未被破坏
    const meta = readPluginMeta(path.join(pluginsDir, 'Vault.jar'));
    expect(meta.version).toBe('1.7.3');
  });

  it('overwrite=true 替换旧文件并标记 overwritten', () => {
    writePluginJar('Vault.jar', 'name: Vault\nversion: 1.7.3\nmain: net.milkbowl.vault.Vault\n');
    const tmp = stageUpload('new.jar', Buffer.alloc(0));
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: Vault\nversion: 9.9.9\nmain: net.milkbowl.vault.Vault\n', 'utf8'));
    zip.writeZip(tmp);

    const result = uploadPlugin(serverPath, tmp, 'Vault.jar', { overwrite: true });
    expect(result.overwritten).toBe(true);
    expect(readPluginMeta(path.join(pluginsDir, 'Vault.jar')).version).toBe('9.9.9');
  });
});

describe('Plugin Routes - POST upload', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    ensurePluginsDir();
    app = express();
    app.use(express.json());
    mockManager = { getInstance: vi.fn() };
    app.use('/api/v1', createPluginRoutes(mockManager));
    app.use(errorHandler);
    vi.clearAllMocks();
  });

  it('上传合法 jar：201 + 元数据返回 + 审计 PLUGIN_UPLOAD + 临时文件清理', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: LuckPerms\nversion: 5.4.140\nmain: me.lucko.luckperms.bukkit.LP Bukkit\n'.replace('LP Bukkit', 'LPBukkit'), 'utf8'));
    const jarBuffer = zip.toBuffer();

    const res = await request(app)
      .post('/api/v1/instances/inst1/plugins/upload')
      .attach('file', jarBuffer, { filename: 'LuckPerms.jar', contentType: 'application/java-archive' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.file).toBe('LuckPerms.jar');
    expect(res.body.data.overwritten).toBe(false);
    expect(res.body.data.meta.name).toBe('LuckPerms');
    expect(fs.existsSync(path.join(pluginsDir, 'LuckPerms.jar'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst1',
      action: 'PLUGIN_UPLOAD',
      targetId: 'LuckPerms.jar',
      detail: expect.objectContaining({ overwritten: false }),
    }));
    // multer 临时文件应被清理（tmpdir 下无 .plugin-upload.tmp 残留）
    const tmpDir = path.join(os.tmpdir(), 'mc-commander-uploads');
    const leftovers = fs.existsSync(tmpDir)
      ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('.plugin-upload.tmp'))
      : [];
    expect(leftovers).toHaveLength(0);
  });

  it('同名冲突返回 409 code 40912', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    writePluginJar('Vault.jar');
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: Vault\nversion: 2.0\nmain: net.milkbowl.vault.Vault\n', 'utf8'));
    const res = await request(app)
      .post('/api/v1/instances/inst1/plugins/upload')
      .attach('file', zip.toBuffer(), { filename: 'Vault.jar' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40912);
  });

  it('?overwrite=true 返回 200 且内容被替换', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    writePluginJar('Vault.jar', 'name: Vault\nversion: 1.7.3\nmain: net.milkbowl.vault.Vault\n');
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: Vault\nversion: 2.0\nmain: net.milkbowl.vault.Vault\n', 'utf8'));
    const res = await request(app)
      .post('/api/v1/instances/inst1/plugins/upload?overwrite=true')
      .attach('file', zip.toBuffer(), { filename: 'Vault.jar' });
    expect(res.status).toBe(200);
    expect(res.body.data.overwritten).toBe(true);
    expect(readPluginMeta(path.join(pluginsDir, 'Vault.jar')).version).toBe('2.0');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ overwritten: true }),
    }));
  });

  it('非 .jar 扩展名返回 400', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    const res = await request(app)
      .post('/api/v1/instances/inst1/plugins/upload')
      .attach('file', Buffer.from('hello'), { filename: 'readme.txt' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('实例不存在返回 404 且不留临时文件', async () => {
    mockManager.getInstance.mockReturnValue(null);
    const zip = new AdmZip();
    zip.addFile('plugin.yml', Buffer.from('name: Vault\nmain: v\n', 'utf8'));
    const res = await request(app)
      .post('/api/v1/instances/nope/plugins/upload')
      .attach('file', zip.toBuffer(), { filename: 'Vault.jar' });
    expect(res.status).toBe(404);
    const tmpDir = path.join(os.tmpdir(), 'mc-commander-uploads');
    const leftovers = fs.existsSync(tmpDir)
      ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('.plugin-upload.tmp'))
      : [];
    expect(leftovers).toHaveLength(0);
  });
});
