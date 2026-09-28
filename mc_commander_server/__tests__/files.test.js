import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import iconv from 'iconv-lite';

import { createFileRoutes } from '../routes/files.js';
import { errorHandler } from '../middleware/error_handler.js';
import { ErrorCodes } from '../utils/response.js';

vi.mock('../db/index.js', () => ({
  BanModel: {
    deactivateByPlayer: vi.fn(),
    deactivateByIp: vi.fn(),
  },
}));

import { BanModel } from '../db/index.js';

describe('File Routes - Path Traversal Protection', () => {
  let app;
  let mockManager;
  let tmpDir;
  let secretFile;

  beforeEach(() => {
    // 临时目录作为实例目录，隔离真实 servers/ 目录
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-'));
    fs.writeFileSync(path.join(tmpDir, 'server.properties'), 'motd=hello\n');
    fs.mkdirSync(path.join(tmpDir, 'plugins'));
    fs.writeFileSync(path.join(tmpDir, 'plugins', 'plugin.yml'), 'name: test\n');
    // 二进制文件（PNG 文件头 + NUL 字节），用于验证二进制检测
    fs.writeFileSync(
      path.join(tmpDir, 'binary.dat'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
    );

    // 实例目录外的敏感文件，用于验证穿越攻击无法读取/删除
    secretFile = path.join(path.dirname(tmpDir), `mc-files-secret-${Date.now()}.txt`);
    fs.writeFileSync(secretFile, 'secret-content');

    app = express();
    app.use(express.json());
    mockManager = {
      getInstance: vi.fn().mockReturnValue({ serverPath: tmpDir }),
    };
    app.use('/api', createFileRoutes(mockManager));
    app.use(errorHandler);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(secretFile, { force: true });
  });

  describe('GET /api/instances/:id/files', () => {
    it('should list files for a legal path', async () => {
      const res = await request(app).get('/api/instances/s1/files').query({ path: '/' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data.isDirectory).toBe(true);
      const names = res.body.data.files.map((f) => f.name);
      expect(names).toContain('server.properties');
      expect(names).toContain('plugins');
      // 目录在前
      expect(res.body.data.files[0].name).toBe('plugins');
    });

    it('should list files in a legal sub-directory', async () => {
      const res = await request(app).get('/api/instances/s1/files').query({ path: 'plugins' });

      expect(res.status).toBe(200);
      expect(res.body.data.files.map((f) => f.name)).toContain('plugin.yml');
    });

    /**
     * 出参 path 一律 '/' 分隔（契约口径）。win32 上 `path.join` 产出 `\plugins\plugin.yml`，
     * 前端按 '/' 取父目录（parentDirOf）会一律回退到 '/'，于是重命名/移动把文件
     * 拼成 `/plugin.yml` 并真的搬过去——静默改目的地。故列表**子目录内**的
     * path 必须实测到 '/' 形态（根目录下的条目在两种实现下都是 `\name`，同样能暴露）。
     */
    it('出参 path 用 / 分隔（win32 的 path.join 会产出反斜杠，前端据此取父目录）', async () => {
      const res = await request(app).get('/api/instances/s1/files').query({ path: '/plugins' });

      expect(res.status).toBe(200);
      const entry = res.body.data.files.find((f) => f.name === 'plugin.yml');
      expect(entry).toBeDefined();
      expect(entry.path).toBe('/plugins/plugin.yml');
      expect(entry.path).not.toContain('\\');

      // 逐条都不得含反斜杠（含根目录列表的目录条目）
      const root = await request(app).get('/api/instances/s1/files').query({ path: '/' });
      for (const f of root.body.data.files) {
        expect(f.path, `${f.name} 的 path 含反斜杠`).not.toContain('\\');
        expect(f.path.startsWith('/')).toBe(true);
      }
    });

    it('未截断时不回报 truncated（缺省即未截断，兼容旧客户端）', async () => {
      const res = await request(app).get('/api/instances/s1/files').query({ path: '/' });

      expect(res.status).toBe(200);
      expect(res.body.data.truncated).toBeUndefined();
    });

    it('条目数超上限 → 截断并回报 truncated=true（少列了不能读成没有了）', async () => {
      /* 用 spy 造 2001 个条目而不是真写 2001 个文件：本项验证的是
         「排序 → 截断 → 只对留下的条目 stat」这段逻辑，它只吃 dirent 列表，
         与文件是否真实无关。真写盘实测约 5.5s（2001 次 writeFileSync + 2000 次
         statSync + 递归清理），全量并行跑时曾撞上 15s 用例超时。
         与下方 ENOENT 用例同一手法（都 spy readdirSync）。 */
      const MANY = 2001;
      const realReaddir = fs.readdirSync;
      const realStat = fs.statSync;
      const FAKE_NAME = /^f\d{5}\.txt$/;
      const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, opts) => {
        const out = realReaddir(p, opts);
        if (p !== tmpDir) return out;
        const entries = Array.from({ length: MANY }, (_, i) => {
          const name = `f${String(i).padStart(5, '0')}.txt`;
          return { name, isDirectory: () => false, isFile: () => true };
        });
        return opts?.withFileTypes ? entries : entries.map((e) => e.name);
      });
      // 合成条目在磁盘上不存在：stat 由 spy 补齐（否则逐项 ENOENT 全被跳过）
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((p, opts) => {
        if (typeof p === 'string' && FAKE_NAME.test(path.basename(p))) {
          return { size: 1, mtime: new Date('2026-01-01T00:00:00.000Z'), isDirectory: () => false };
        }
        return realStat(p, opts);
      });

      const res = await request(app).get('/api/instances/s1/files').query({ path: '/' });

      readdirSpy.mockRestore();
      statSpy.mockRestore();
      expect(res.status).toBe(200);
      expect(res.body.data.files).toHaveLength(2000);
      expect(res.body.data.truncated).toBe(true);
      // 截断按名称序取前 N（不因截断打乱顺序）；多出的那一项被丢掉
      expect(res.body.data.files[0].name).toBe('f00000.txt');
      expect(res.body.data.files[1999].name).toBe('f01999.txt');
      expect(res.body.data.files.map((f) => f.name)).not.toContain('f02000.txt');
    });

    it('并发删除的单条 ENOENT 跳过该项，不让整表 404', async () => {
      // 模拟「readdir 之后、stat 之前被删掉」：声明存在但磁盘上没有（statSync 抛 ENOENT）
      const realReaddir = fs.readdirSync;
      const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, opts) => {
        const out = realReaddir(p, opts);
        if (p !== tmpDir) return out;
        return opts?.withFileTypes
          ? [...out, { name: 'ghost.txt', isDirectory: () => false }]
          : [...out, 'ghost.txt'];
      });

      const res = await request(app).get('/api/instances/s1/files').query({ path: '/' });

      spy.mockRestore();
      expect(res.status).toBe(200);
      const names = res.body.data.files.map((f) => f.name);
      expect(names).not.toContain('ghost.txt');
      // 其余条目照常返回（不因一条坏项丢掉整表）
      expect(names).toContain('server.properties');
      // 目录在前、组内按名序（截断与跳过都不破坏既有排序口径）
      expect(res.body.data.files[0].name).toBe('plugins');
    });

    it('should reject path traversal with ../', async () => {
      const res = await request(app).get('/api/instances/s1/files').query({ path: '../' });

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('error');
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
    });

    it('should reject nested path traversal like a/../../b', async () => {
      const res = await request(app)
        .get('/api/instances/s1/files')
        .query({ path: 'plugins/../../outside' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
    });

    it('should reject URL-encoded traversal %2e%2e%2f', async () => {
      const res = await request(app).get('/api/instances/s1/files?path=%2e%2e%2fsecret');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
    });
  });

  describe('GET /api/instances/:id/files/content', () => {
    it('should read content of a legal file', async () => {
      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: 'server.properties' });

      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe('motd=hello\n');
      expect(res.body.data.name).toBe('server.properties');
    });

    it('should reject reading files outside instance dir via ../', async () => {
      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: `../${path.basename(secretFile)}` });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      expect(res.body.data?.content).toBeUndefined();
    });

    it('should reject deep traversal like ../../../../etc/passwd', async () => {
      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: '../../../../etc/passwd' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
    });
  });

  describe('PUT /api/instances/:id/files/content', () => {
    it('should write content to a legal path', async () => {
      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'config/new.yml', content: 'key: value\n' });

      expect(res.status).toBe(200);
      expect(fs.readFileSync(path.join(tmpDir, 'config', 'new.yml'), 'utf-8')).toBe('key: value\n');
    });

    it('保存采用原子写（.tmp + rename，不直接覆盖目标）', async () => {
      const renameSpy = vi.spyOn(fs, 'renameSync');

      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'server.properties', content: 'motd=atomic\n' });

      expect(res.status).toBe(200);
      expect(fs.readFileSync(path.join(tmpDir, 'server.properties'), 'utf-8')).toBe(
        'motd=atomic\n',
      );
      // 修复前：writeFileSync 直接覆盖目标文件（与设置页 saveProperties 双写入点竞争）
      expect(renameSpy).toHaveBeenCalled();
      // 不残留临时文件
      const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);
      renameSpy.mockRestore();
    });

    it('大写文件名列表文件同样触发 MC 内存同步（大小写不敏感）', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'BANNED-PLAYERS.JSON'),
        JSON.stringify([{ name: 'Steve', reason: 'test' }]),
      );
      const mockInstance = {
        id: 's1',
        serverPath: tmpDir,
        isRunning: true,
        sendCommand: vi.fn().mockResolvedValue(''),
      };
      mockManager.getInstance.mockReturnValue(mockInstance);

      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'BANNED-PLAYERS.JSON', content: JSON.stringify([]) });

      expect(res.status).toBe(200);
      // 修复前：LIST_FILE_SYNC 按小写 basename 精确匹配，大写文件名不同步
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('pardon Steve');
      expect(BanModel.deactivateByPlayer).toHaveBeenCalledWith('s1', 'Steve');
    });

    it('should reject writing outside instance dir via ../', async () => {
      const evilName = `mc-files-evil-${Date.now()}.txt`;
      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: `../${evilName}`, content: 'pwned' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      // 确认目录外未产生文件
      expect(fs.existsSync(path.join(path.dirname(tmpDir), evilName))).toBe(false);
    });
  });

  describe('DELETE /api/instances/:id/files', () => {
    it('should delete a legal file', async () => {
      const res = await request(app)
        .delete('/api/instances/s1/files')
        .query({ path: 'server.properties' });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(tmpDir, 'server.properties'))).toBe(false);
    });

    it('should reject deleting files outside instance dir via ../', async () => {
      const res = await request(app)
        .delete('/api/instances/s1/files')
        .query({ path: `../${path.basename(secretFile)}` });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      // 确认目录外文件未被删除
      expect(fs.existsSync(secretFile)).toBe(true);
    });

    it('should reject deleting the instance root via /', async () => {
      const res = await request(app).delete('/api/instances/s1/files').query({ path: '/' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      expect(fs.existsSync(tmpDir)).toBe(true);
    });

    // 修复：'.'/'./'/'.//'/'a/../' 经 path.resolve 归一化后等于实例根目录，
    // 原防护（字符串 includes('..') + 无边界 startsWith 前缀检查）全部可绕过——
    // 归一化后 startsWith 恒真，随后 rmSync recursive 会删除整个实例目录
    it('should reject deleting the instance root via . (归一化后等于根目录)', async () => {
      const res = await request(app).delete('/api/instances/s1/files').query({ path: '.' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      // 实例目录及内部文件均未被删除
      expect(fs.existsSync(tmpDir)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'server.properties'))).toBe(true);
    });

    it('should reject deleting the instance root via ./ 与 .// 与 a/../ 变体', async () => {
      for (const p of ['./', './/', 'a/../']) {
        const res = await request(app).delete('/api/instances/s1/files').query({ path: p });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
        expect(fs.existsSync(tmpDir)).toBe(true);
      }
    });

    it('should reject deleting sibling instance files across name boundary (sep 边界)', async () => {
      // 模拟父子目录实例：base = tmpDir，同级 tmpDir-sibling 命中原无边界
      // startsWith 前缀漏洞（'...mc-files-xxx' 前缀对 '...mc-files-xxx-sibling'
      // 恒真），旧代码可跨边界删除兄弟实例文件
      const siblingDir = `${tmpDir}-sibling`;
      fs.mkdirSync(siblingDir);
      fs.writeFileSync(path.join(siblingDir, 'evil.txt'), 'sibling-data');
      try {
        const res = await request(app)
          .delete('/api/instances/s1/files')
          .query({ path: `../${path.basename(tmpDir)}-sibling/evil.txt` });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
        expect(fs.existsSync(path.join(siblingDir, 'evil.txt'))).toBe(true);
      } finally {
        fs.rmSync(siblingDir, { recursive: true, force: true });
      }
    });

    it('删除 banned-players.json 后同步 MC 内存并清理 temp_bans', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'banned-players.json'),
        JSON.stringify([{ name: 'Alex', reason: 'spam' }]),
      );
      const mockInstance = {
        id: 's1',
        serverPath: tmpDir,
        isRunning: true,
        sendCommand: vi.fn().mockResolvedValue(''),
      };
      mockManager.getInstance.mockReturnValue(mockInstance);

      const res = await request(app)
        .delete('/api/instances/s1/files')
        .query({ path: 'banned-players.json' });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(tmpDir, 'banned-players.json'))).toBe(false);
      // 文件删除 = 全部条目移除：修复前 DELETE 不走 LIST_FILE_SYNC，
      // 不下发命令、不清理 temp_bans——MC 内存封禁仍生效，玩家无法进服
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('pardon Alex');
      expect(BanModel.deactivateByPlayer).toHaveBeenCalledWith('s1', 'Alex');
    });
  });

  describe('GET /api/instances/:id/files/content - binary detection', () => {
    it('should reject reading a binary file', async () => {
      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: 'binary.dat' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.code).toBe(ErrorCodes.BINARY_FILE_NOT_SUPPORTED.code);
    });
  });

  describe('PUT /api/instances/:id/files/content - binary detection', () => {
    it('should reject overwriting a binary file', async () => {
      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'binary.dat', content: 'tampered' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCodes.BINARY_FILE_NOT_SUPPORTED.code);
      // 原二进制内容未被修改（整字节比较，替代首字节 includes 的宽松断言）
      const buf = fs.readFileSync(path.join(tmpDir, 'binary.dat'));
      expect(buf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]))).toBe(true);
    });
  });

  describe('GET /api/instances/:id/files/content - encoding detection', () => {
    it('should decode a GBK file and return encoding field', async () => {
      // 中文 GBK 内容（UTF-8 严格解码必然失败）
      fs.writeFileSync(path.join(tmpDir, 'gbk.txt'), iconv.encode('服务器中文名', 'gbk'));

      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: 'gbk.txt' });

      expect(res.status).toBe(200);
      expect(res.body.data.encoding).toBe('gbk');
      expect(res.body.data.content).toBe('服务器中文名');
    });

    it('should mark UTF-8 file as utf-8', async () => {
      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: 'server.properties' });

      expect(res.status).toBe(200);
      expect(res.body.data.encoding).toBe('utf-8');
    });
  });

  describe('PUT /api/instances/:id/files/content - encoding preservation', () => {
    it('should write back a GBK file in GBK (not convert to UTF-8)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'gbk.txt'), iconv.encode('原名', 'gbk'));

      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'gbk.txt', content: '新名' });

      expect(res.status).toBe(200);
      // 文件仍是 GBK 编码，用 GBK 解码可还原
      const buf = fs.readFileSync(path.join(tmpDir, 'gbk.txt'));
      expect(iconv.decode(buf, 'gbk')).toBe('新名');
      // 若被转成 UTF-8，GBK 解码会得到乱码
      expect(buf.includes(0xe6)).toBe(false); // '新' 的 UTF-8 首字节
    });

    it('should create a new file as UTF-8 by default', async () => {
      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'new.txt', content: '中文默认 UTF-8' });

      expect(res.status).toBe(200);
      expect(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf-8')).toBe('中文默认 UTF-8');
    });
  });

  describe('PUT /api/instances/:id/files/content - BOM preservation', () => {
    it('should read BOM file without BOM chars and write back with BOM preserved', async () => {
      // 带 BOM 的 UTF-8 文件
      const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
      fs.writeFileSync(
        path.join(tmpDir, 'bom.txt'),
        Buffer.concat([BOM, Buffer.from('motd=hi\n')]),
      );

      // 读取：content 不含 BOM 字符
      const readRes = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: 'bom.txt' });

      expect(readRes.status).toBe(200);
      expect(readRes.body.data.encoding).toBe('utf-8');
      expect(readRes.body.data.content).toBe('motd=hi\n');

      // 写入：BOM 保留
      const writeRes = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'bom.txt', content: 'motd=changed\n' });

      expect(writeRes.status).toBe(200);
      const buf = fs.readFileSync(path.join(tmpDir, 'bom.txt'));
      expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
      expect(buf.subarray(3).toString('utf-8')).toBe('motd=changed\n');
    });
  });

  describe('PUT /api/instances/:id/files/content - GBK unrepresentable characters', () => {
    it('should reject content containing emoji not representable in GBK', async () => {
      fs.writeFileSync(path.join(tmpDir, 'gbk.txt'), iconv.encode('原名', 'gbk'));

      const res = await request(app)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'gbk.txt', content: '新名😀' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
      // 原文件未被修改
      expect(iconv.decode(fs.readFileSync(path.join(tmpDir, 'gbk.txt')), 'gbk')).toBe('原名');
    });
  });

  describe('PUT /api/instances/:id/files/content - ban list sync', () => {
    let banApp;
    let banManager;
    let banTmpDir;
    let sendCommand;

    // 运行中的实例（带 sendCommand mock）
    const runningInstance = () => ({
      id: 's1',
      serverPath: banTmpDir,
      isRunning: true,
      sendCommand,
    });

    beforeEach(() => {
      banTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-ban-'));
      sendCommand = vi.fn().mockResolvedValue('ok');
      banApp = express();
      banApp.use(express.json());
      banManager = {
        getInstance: vi.fn().mockReturnValue(runningInstance()),
      };
      banApp.use('/api', createFileRoutes(banManager));
      banApp.use(errorHandler);
    });

    afterEach(() => {
      fs.rmSync(banTmpDir, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('should pardon removed players and clean temp bans when banned-players.json saved', async () => {
      // 既有封禁：Saul233（临时封禁载体）+ Other（永久）
      fs.writeFileSync(
        path.join(banTmpDir, 'banned-players.json'),
        JSON.stringify([
          {
            name: 'Saul233',
            uuid: 'a1b2c3',
            reason: 'temp ban',
            created: new Date().toISOString(),
            source: 'command',
          },
          {
            name: 'Other',
            uuid: 'd4e5f6',
            reason: 'perm',
            created: new Date().toISOString(),
            source: 'command',
          },
        ]),
      );

      // 编辑移除 Saul233，保留 Other
      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({
          path: 'banned-players.json',
          content: JSON.stringify([
            {
              name: 'Other',
              uuid: 'd4e5f6',
              reason: 'perm',
              created: new Date().toISOString(),
              source: 'command',
            },
          ]),
        });

      expect(res.status).toBe(200);
      // 被移除的条目执行 pardon，同步 MC 内存封禁列表
      expect(sendCommand).toHaveBeenCalledWith('pardon Saul233');
      // 未移除的条目不触发
      expect(sendCommand).not.toHaveBeenCalledWith('pardon Other');
      // 同步清理 temp_bans 生效记录
      expect(BanModel.deactivateByPlayer).toHaveBeenCalledWith('s1', 'Saul233');
      // 文件已按新内容保存
      const saved = JSON.parse(
        fs.readFileSync(path.join(banTmpDir, 'banned-players.json'), 'utf-8'),
      );
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe('Other');
    });

    it('should ban newly added players when banned-players.json saved', async () => {
      fs.writeFileSync(
        path.join(banTmpDir, 'banned-players.json'),
        JSON.stringify([
          {
            name: 'Other',
            uuid: 'd4e5f6',
            reason: 'perm',
            created: new Date().toISOString(),
            source: 'command',
          },
        ]),
      );

      // 编辑新增 Newbie（带 reason）
      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({
          path: 'banned-players.json',
          content: JSON.stringify([
            {
              name: 'Other',
              uuid: 'd4e5f6',
              reason: 'perm',
              created: new Date().toISOString(),
              source: 'command',
            },
            {
              name: 'Newbie',
              uuid: 'g7h8i9',
              reason: 'spam',
              created: new Date().toISOString(),
              source: 'command',
            },
          ]),
        });

      expect(res.status).toBe(200);
      // 新增条目执行 ban，立即在内存中生效
      expect(sendCommand).toHaveBeenCalledWith('ban Newbie spam');
      // 未变化的条目不触发
      expect(sendCommand).not.toHaveBeenCalledWith('ban Other');
      // 新增不涉及 temp_bans 清理（永久封禁）
      expect(BanModel.deactivateByPlayer).not.toHaveBeenCalled();
    });

    it('should pardon-ip removed IPs and clean ip temp bans when banned-ips.json saved', async () => {
      fs.writeFileSync(
        path.join(banTmpDir, 'banned-ips.json'),
        JSON.stringify([
          { ip: '1.2.3.4', reason: 'temp', created: new Date().toISOString(), source: 'command' },
          { ip: '5.6.7.8', reason: 'perm', created: new Date().toISOString(), source: 'command' },
        ]),
      );

      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({
          path: 'banned-ips.json',
          content: JSON.stringify([
            { ip: '5.6.7.8', reason: 'perm', created: new Date().toISOString(), source: 'command' },
          ]),
        });

      expect(res.status).toBe(200);
      expect(sendCommand).toHaveBeenCalledWith('pardon-ip 1.2.3.4');
      expect(BanModel.deactivateByIp).toHaveBeenCalledWith('s1', '1.2.3.4');
    });

    it('should not run commands but still clean temp bans when instance is not running', async () => {
      banManager.getInstance.mockReturnValue({
        id: 's1',
        serverPath: banTmpDir,
        isRunning: false,
        sendCommand,
      });
      fs.writeFileSync(
        path.join(banTmpDir, 'banned-players.json'),
        JSON.stringify([
          {
            name: 'Saul233',
            uuid: 'a1b2c3',
            reason: 'temp',
            created: new Date().toISOString(),
            source: 'command',
          },
        ]),
      );

      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'banned-players.json', content: '[]' });

      expect(res.status).toBe(200);
      // 未运行实例不执行命令（启动时自动加载文件）
      expect(sendCommand).not.toHaveBeenCalled();
      // 但 temp_bans 生效记录仍应清理（文件是唯一事实源，记录跟随）
      expect(BanModel.deactivateByPlayer).toHaveBeenCalledWith('s1', 'Saul233');
    });

    it('should reject invalid JSON for ban files without saving', async () => {
      fs.writeFileSync(
        path.join(banTmpDir, 'banned-players.json'),
        JSON.stringify([
          {
            name: 'Saul233',
            uuid: 'a1b2c3',
            reason: 'temp',
            created: new Date().toISOString(),
            source: 'command',
          },
        ]),
      );

      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'banned-players.json', content: '{invalid json' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
      // 原文件未被修改
      const saved = JSON.parse(
        fs.readFileSync(path.join(banTmpDir, 'banned-players.json'), 'utf-8'),
      );
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe('Saul233');
      // 未触发任何命令或清理
      expect(sendCommand).not.toHaveBeenCalled();
      expect(BanModel.deactivateByPlayer).not.toHaveBeenCalled();
    });

    it('should reject non-array JSON for ban files', async () => {
      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'banned-players.json', content: JSON.stringify({ name: 'X' }) });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
    });

    it('sendCommand 抛同步异常时文件保存成功且无 unhandled rejection', async () => {
      // 构造意外错误路径：sendCommand 函数体同步 throw（而非返回 rejected promise）
      sendCommand.mockImplementation(() => {
        throw new Error('unexpected sync error');
      });
      fs.writeFileSync(
        path.join(banTmpDir, 'banned-players.json'),
        JSON.stringify([
          {
            name: 'Saul233',
            uuid: 'a1b2c3',
            reason: 'temp',
            created: new Date().toISOString(),
            source: 'command',
          },
        ]),
      );

      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'banned-players.json', content: '[]' });

      // 文件保存不受同步命令失败影响
      expect(res.status).toBe(200);
      const saved = JSON.parse(
        fs.readFileSync(path.join(banTmpDir, 'banned-players.json'), 'utf-8'),
      );
      expect(saved).toHaveLength(0);
      // temp_bans 清理仍执行（在命令之前，不依赖命令成功）
      expect(BanModel.deactivateByPlayer).toHaveBeenCalledWith('s1', 'Saul233');
    });

    it('should not sync anything for non-ban files', async () => {
      const res = await request(banApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'server.properties', content: 'motd=hello\n' });

      expect(res.status).toBe(200);
      expect(sendCommand).not.toHaveBeenCalled();
      expect(BanModel.deactivateByPlayer).not.toHaveBeenCalled();
      expect(BanModel.deactivateByIp).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/instances/:id/files/content - whitelist/ops sync', () => {
    let wlApp;
    let wlManager;
    let wlTmpDir;
    let sendCommand;

    const runningInstance = () => ({
      id: 's1',
      serverPath: wlTmpDir,
      isRunning: true,
      sendCommand,
    });

    beforeEach(() => {
      wlTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-wl-'));
      sendCommand = vi.fn().mockResolvedValue('ok');
      wlApp = express();
      wlApp.use(express.json());
      wlManager = {
        getInstance: vi.fn().mockReturnValue(runningInstance()),
      };
      wlApp.use('/api', createFileRoutes(wlManager));
      wlApp.use(errorHandler);
    });

    afterEach(() => {
      fs.rmSync(wlTmpDir, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('should whitelist remove/whitelist add on whitelist.json changes without touching temp bans', async () => {
      fs.writeFileSync(
        path.join(wlTmpDir, 'whitelist.json'),
        JSON.stringify([
          { name: 'Alex', uuid: 'aaa' },
          { name: 'Bob', uuid: 'bbb' },
        ]),
      );

      // 移除 Alex，新增 Carol
      const res = await request(wlApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({
          path: 'whitelist.json',
          content: JSON.stringify([
            { name: 'Bob', uuid: 'bbb' },
            { name: 'Carol', uuid: 'ccc' },
          ]),
        });

      expect(res.status).toBe(200);
      expect(sendCommand).toHaveBeenCalledWith('whitelist remove Alex');
      expect(sendCommand).toHaveBeenCalledWith('whitelist add Carol');
      // 白名单不涉及 temp_bans 清理
      expect(BanModel.deactivateByPlayer).not.toHaveBeenCalled();
      expect(BanModel.deactivateByIp).not.toHaveBeenCalled();
    });

    it('should deop/op on ops.json changes', async () => {
      fs.writeFileSync(
        path.join(wlTmpDir, 'ops.json'),
        JSON.stringify([{ name: 'Alex', uuid: 'aaa', level: 4, bypassesPlayerLimit: false }]),
      );

      // 移除 Alex，新增 Admin
      const res = await request(wlApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({
          path: 'ops.json',
          content: JSON.stringify([
            { name: 'Admin', uuid: 'ddd', level: 4, bypassesPlayerLimit: false },
          ]),
        });

      expect(res.status).toBe(200);
      expect(sendCommand).toHaveBeenCalledWith('deop Alex');
      expect(sendCommand).toHaveBeenCalledWith('op Admin');
      expect(BanModel.deactivateByPlayer).not.toHaveBeenCalled();
    });

    it('should reject invalid JSON for whitelist.json without saving', async () => {
      fs.writeFileSync(
        path.join(wlTmpDir, 'whitelist.json'),
        JSON.stringify([{ name: 'Alex', uuid: 'aaa' }]),
      );

      const res = await request(wlApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'whitelist.json', content: '[broken' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
      const saved = JSON.parse(fs.readFileSync(path.join(wlTmpDir, 'whitelist.json'), 'utf-8'));
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe('Alex');
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it('should not run commands when instance is not running (whitelist)', async () => {
      wlManager.getInstance.mockReturnValue({
        id: 's1',
        serverPath: wlTmpDir,
        isRunning: false,
        sendCommand,
      });
      fs.writeFileSync(
        path.join(wlTmpDir, 'whitelist.json'),
        JSON.stringify([{ name: 'Alex', uuid: 'aaa' }]),
      );

      const res = await request(wlApp)
        .put('/api/instances/s1/files/content')
        .set('Content-Type', 'application/json')
        .send({ path: 'whitelist.json', content: '[]' });

      expect(res.status).toBe(200);
      expect(sendCommand).not.toHaveBeenCalled();
    });
  });

  describe('File Routes - 符号链接越界防护', () => {
    // Windows 创建符号链接需要管理员权限或开发者模式：模块加载时探测一次，
    // 不可用则整组跳过（Linux/macOS 无条件可用）
    let symlinkSupported = false;
    try {
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-symlink-probe-'));
      try {
        fs.symlinkSync('probe-target', path.join(probe, 'probe-link'), 'file');
        symlinkSupported = true;
      } finally {
        fs.rmSync(probe, { recursive: true, force: true });
      }
    } catch {}

    let app;
    let mockManager;
    let tmpDir;
    let outsideDir;
    let secretFile;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-link-'));
      fs.writeFileSync(path.join(tmpDir, 'server.properties'), 'motd=hello\n');
      // 实例目录外的敏感文件，模拟符号链接越界目标
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-outside-'));
      secretFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(secretFile, 'top-secret');

      app = express();
      app.use(express.json());
      mockManager = {
        getInstance: vi.fn().mockReturnValue({ serverPath: tmpDir }),
      };
      app.use('/api', createFileRoutes(mockManager));
      app.use(errorHandler);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it.skipIf(!symlinkSupported)('GET content 通过实例内符号链接读外部文件 → 403', async () => {
      fs.symlinkSync(secretFile, path.join(tmpDir, 'leak.txt'), 'file');

      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: 'leak.txt' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      // 外部文件内容未泄露
      expect(res.body.data).toBeUndefined();
    });

    it.skipIf(!symlinkSupported)(
      'PUT content 通过符号链接覆盖外部文件 → 403 且外部文件未改',
      async () => {
        fs.symlinkSync(secretFile, path.join(tmpDir, 'overwrite.txt'), 'file');

        const res = await request(app)
          .put('/api/instances/s1/files/content')
          .set('Content-Type', 'application/json')
          .send({ path: 'overwrite.txt', content: 'pwned' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
        expect(fs.readFileSync(secretFile, 'utf-8')).toBe('top-secret');
      },
    );

    it.skipIf(!symlinkSupported)(
      'DELETE 通过符号链接删除外部文件 → 403 且外部文件仍在',
      async () => {
        fs.symlinkSync(secretFile, path.join(tmpDir, 'del-link.txt'), 'file');

        const res = await request(app)
          .delete('/api/instances/s1/files')
          .query({ path: 'del-link.txt' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
        expect(fs.existsSync(secretFile)).toBe(true);
      },
    );

    it.skipIf(!symlinkSupported)(
      '指向实例内文件的符号链接同样拒绝（最终目标 symlink 一律拒绝）',
      async () => {
        fs.symlinkSync(
          path.join(tmpDir, 'server.properties'),
          path.join(tmpDir, 'link-inside.txt'),
          'file',
        );

        const res = await request(app)
          .get('/api/instances/s1/files/content')
          .query({ path: 'link-inside.txt' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      },
    );

    it.skipIf(!symlinkSupported)(
      'list 通过符号链接目录越界 → 403（逐段 realpath 校验）',
      async () => {
        fs.symlinkSync(outsideDir, path.join(tmpDir, 'linkdir'), 'junction');

        const res = await request(app).get('/api/instances/s1/files').query({ path: 'linkdir' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
      },
    );

    it.skipIf(!symlinkSupported)('GET content 通过符号链接目录嵌套访问外部文件 → 403', async () => {
      fs.symlinkSync(outsideDir, path.join(tmpDir, 'linkdir'), 'junction');

      const res = await request(app)
        .get('/api/instances/s1/files/content')
        .query({ path: 'linkdir/secret.txt' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
    });
  });
});
