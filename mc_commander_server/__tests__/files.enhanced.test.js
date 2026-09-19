import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';
import express from 'express';
import { setupRoutes } from '../routes/index.js';
import { ErrorCodes } from '../utils/response.js';
import { errorHandler } from '../middleware/error_handler.js';

// 简易 mock serverManager
function createMockServerManager(serversDir) {
  const instances = new Map();
  return {
    getInstance(id) {
      if (!instances.has(id)) return undefined;
      return instances.get(id);
    },
    instances,
    createInstance(id) {
      const serverPath = path.join(serversDir, id);
      fs.mkdirSync(serverPath, { recursive: true });
      instances.set(id, { id, serverPath, isRunning: false });
      return instances.get(id);
    },
  };
}

let app, serverManager, tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-test-'));
  serverManager = createMockServerManager(tmpDir);
  serverManager.createInstance('test-inst');

  app = express();
  app.use(express.json());

  // 简易认证中间件（绕过 X-API-Key 检查）；v1 角色门要求显式角色，故直接落 admin
  app.use('/api/v1', (req, res, next) => {
    req.auth = { source: 'test', role: 'admin' };
    next();
  });

  setupRoutes(app, serverManager, null);
  app.use(errorHandler);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const API_KEY = 'test-key';

function authHeaders() {
  return { 'X-API-Key': API_KEY };
}

describe('POST /instances/:id/files/mkdir', () => {
  it('creates a directory successfully', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/mkdir')
      .set(authHeaders())
      .send({ path: '/new-dir' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.path).toBe('/new-dir');
    expect(res.body.data.name).toBe('new-dir');
    expect(fs.existsSync(path.join(tmpDir, 'test-inst', 'new-dir'))).toBe(true);
  });

  it('creates nested directories', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/mkdir')
      .set(authHeaders())
      .send({ path: '/a/b/c' });

    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, 'test-inst', 'a/b/c'))).toBe(true);
  });

  it('returns 400 when path is missing', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/mkdir')
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('returns 409 when directory already exists', async () => {
    fs.mkdirSync(path.join(tmpDir, 'test-inst', 'existing'));
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/mkdir')
      .set(authHeaders())
      .send({ path: '/existing' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCodes.FILE_ALREADY_EXISTS.code);
  });

  it('returns 404 when instance not found', async () => {
    const res = await request(app)
      .post('/api/v1/instances/nonexistent/files/mkdir')
      .set(authHeaders())
      .send({ path: '/test' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCodes.INSTANCE_NOT_FOUND.code);
  });

  it('rejects path traversal in mkdir', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/mkdir')
      .set(authHeaders())
      .send({ path: '/../../../etc' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
  });
});

describe('POST /instances/:id/files/rename', () => {
  it('renames a file successfully', async () => {
    const filePath = path.join(tmpDir, 'test-inst', 'original.txt');
    fs.writeFileSync(filePath, 'hello');

    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/rename')
      .set(authHeaders())
      .send({ path: '/original.txt', newPath: '/renamed.txt' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.name).toBe('renamed.txt');
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'test-inst', 'renamed.txt'))).toBe(true);
  });

  it('returns 404 when source does not exist', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/rename')
      .set(authHeaders())
      .send({ path: '/nonexistent.txt', newPath: '/new.txt' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCodes.FILE_NOT_FOUND.code);
  });

  it('returns 409 when target already exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test-inst', 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'test-inst', 'b.txt'), 'b');

    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/rename')
      .set(authHeaders())
      .send({ path: '/a.txt', newPath: '/b.txt' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCodes.FILE_ALREADY_EXISTS.code);
  });

  it('returns 400 when path is missing', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/rename')
      .set(authHeaders())
      .send({ path: '/old.txt' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('rejects path traversal in rename target', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test-inst', 'secret.txt'), 'data');

    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/rename')
      .set(authHeaders())
      .send({ path: '/secret.txt', newPath: '/../../../etc/passwd' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
  });
});

describe('POST /instances/:id/files/upload', () => {
  it('uploads a file successfully', async () => {
    const buf = Buffer.from('hello world');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload')
      .set(authHeaders())
      .attach('file', buf, { filename: 'test.txt', contentType: 'text/plain' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.name).toBe('test.txt');
    expect(res.body.data.size).toBe(11);
    expect(fs.existsSync(path.join(tmpDir, 'test-inst', 'test.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'test-inst', 'test.txt'), 'utf-8')).toBe(
      'hello world',
    );
  });

  it('rejects .jar extension', async () => {
    const buf = Buffer.from('fake jar');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload')
      .set(authHeaders())
      .attach('file', buf, { filename: 'bad.jar', contentType: 'application/java-archive' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED.code);
  });

  it('rejects .exe extension', async () => {
    const buf = Buffer.from('fake exe');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload')
      .set(authHeaders())
      .attach('file', buf, { filename: 'virus.exe', contentType: 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED.code);
  });

  it('returns 404 when instance not found', async () => {
    const buf = Buffer.from('data');
    const res = await request(app)
      .post('/api/v1/instances/nonexistent/files/upload')
      .set(authHeaders())
      .attach('file', buf, { filename: 'test.txt', contentType: 'text/plain' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCodes.INSTANCE_NOT_FOUND.code);
  });

  it('rejects .. filename (directory escape)', async () => {
    const buf = Buffer.from('hack');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload')
      .set(authHeaders())
      .attach('file', buf, { filename: '..', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('returns 400 when multipart has no file field', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload')
      .set(authHeaders())
      .set('Content-Type', 'multipart/form-data; boundary=----test')
      .send(
        '------test--\r\nContent-Disposition: form-data; name="something"\r\n\r\nvalue\r\n------test--',
      );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('allows .properties file (dot-prefixed)', async () => {
    const buf = Buffer.from('level-name=Test');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload')
      .set(authHeaders())
      .attach('file', buf, { filename: 'server.properties', contentType: 'text/plain' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('server.properties');
  });

  it('uploads to target directory via query parameter', async () => {
    // 先创建目标目录
    fs.mkdirSync(path.join(tmpDir, 'test-inst', 'plugins', 'Essentials'), { recursive: true });
    const buf = Buffer.from('config data');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload?targetDir=/plugins/Essentials')
      .set(authHeaders())
      .attach('file', buf, { filename: 'config.yml', contentType: 'text/plain' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('config.yml');
    expect(res.body.data.path).toBe('/plugins/Essentials/config.yml');
    expect(
      fs.existsSync(path.join(tmpDir, 'test-inst', 'plugins', 'Essentials', 'config.yml')),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(tmpDir, 'test-inst', 'plugins', 'Essentials', 'config.yml'),
        'utf-8',
      ),
    ).toBe('config data');
  });

  it('rejects path traversal in targetDir', async () => {
    const buf = Buffer.from('hack');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload?targetDir=/../../../etc')
      .set(authHeaders())
      .attach('file', buf, { filename: 'evil.txt', contentType: 'text/plain' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when targetDir is not a directory', async () => {
    // 在根目录创建一个文件（不是目录）
    fs.writeFileSync(path.join(tmpDir, 'test-inst', 'server.properties'), 'test');
    const buf = Buffer.from('data');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload?targetDir=/server.properties')
      .set(authHeaders())
      .attach('file', buf, { filename: 'file.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('returns 400 when targetDir does not exist', async () => {
    const buf = Buffer.from('data');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload?targetDir=/nonexistent-dir')
      .set(authHeaders())
      .attach('file', buf, { filename: 'file.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
  });

  it('backward compatible: no targetDir uploads to root', async () => {
    const buf = Buffer.from('root file');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload')
      .set(authHeaders())
      .attach('file', buf, { filename: 'root.txt', contentType: 'text/plain' });

    expect(res.status).toBe(200);
    expect(res.body.data.path).toBe('/root.txt');
    expect(fs.existsSync(path.join(tmpDir, 'test-inst', 'root.txt'))).toBe(true);
  });
});
describe('files zod 请求契约（issue 391）', () => {
  it('PUT /files/content：content 非字符串 → 400 + 结构化 details（契约拦截在 handler 前）', async () => {
    const res = await request(app)
      .put('/api/v1/instances/test-inst/files/content')
      .set(authHeaders())
      .send({ path: '/a.txt', content: 123 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0]).toMatchObject({ path: 'content' });
  });

  it('GET /files/download：缺 path 查询 → 400 + 结构化 details（原手写校验收敛到 schema）', async () => {
    const res = await request(app)
      .get('/api/v1/instances/test-inst/files/download')
      .set(authHeaders());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
    expect(res.body.details[0]).toMatchObject({ path: 'path', message: 'File path is required' });
  });

  it('GET /files 列表：未知查询字段被剥离（下游只见契约字段），path 缺省归一 /', async () => {
    const res = await request(app)
      .get('/api/v1/instances/test-inst/files?junk=injected')
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data.path).toBe('/');
  });

  it('POST /files/upload：?targetDir= 空串 → 400（schema 拒绝，控制字符/前导斜杠归一同源）', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload?targetDir=')
      .set(authHeaders())
      .attach('file', Buffer.from('data'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('POST /files/upload：?targetDir= 控制字符 → 400 且 multer 临时文件被清理（diskStorage 无残留）', async () => {
    // multer diskStorage 缓冲目录（routes/files.js uploadStorage.destination）
    const tmpUploadDir = path.join(os.tmpdir(), 'mc-commander-uploads');
    const snapshotBefore = new Set(fs.existsSync(tmpUploadDir) ? fs.readdirSync(tmpUploadDir) : []);

    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/upload?targetDir=%01bad')
      .set(authHeaders())
      .attach('file', Buffer.from('data'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);

    // validateQuery onError 钩子在 400 前清理落盘临时文件：
    // 本次请求新增的 .upload.tmp-* 不应残留在磁盘上
    const leftovers = fs.existsSync(tmpUploadDir)
      ? fs
          .readdirSync(tmpUploadDir)
          .filter((f) => f.startsWith('.upload.tmp-') && !snapshotBefore.has(f))
      : [];
    expect(leftovers).toEqual([]);
  });
});
