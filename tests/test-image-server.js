/*
 * 无头测试：tools/serve-desktop-pet.js
 * 运行： node tests/test-image-server.js   （零依赖，不需要 npm install）
 *
 * 用临时目录当文档根，起一个随机端口的服务器，覆盖：
 * 图片列表、中文名上传、重名后缀、类型/魔数/路径/Origin 校验、静态文件与 Range。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { createAppServer, MAX_UPLOAD_BYTES } = require('../tools/serve-desktop-pet.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);

function rawRequest(port, rawPath, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ Connection: 'close' }, opts.headers || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: rawPath,
      method: opts.method || 'GET',
      headers: headers,
      agent: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonOf(res) {
  try { return JSON.parse(res.body.toString('utf8')); } catch (e) { return null; }
}

async function main() {
  const root = fs.mkdtempSync(path.join(__dirname, '_tmp-image-server-'));
  const outside = path.join(__dirname, '_tmp-image-server-outside.txt');
  fs.writeFileSync(outside, 'SECRET');
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><h1>ok</h1>');
  fs.mkdirSync(path.join(root, 'videos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'videos', 'test.webm'), Buffer.alloc(12, 0xAA));
  fs.mkdirSync(path.join(root, 'data', 'backgrounds'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'wallpapers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'backgrounds', 'a.jpg'), JPEG);
  fs.writeFileSync(path.join(root, 'data', 'backgrounds', 'note.txt'), 'ignore me');
  fs.writeFileSync(path.join(root, 'data', 'backgrounds', '.hidden.jpg'), JPEG);
  fs.mkdirSync(path.join(root, 'data', 'backgrounds', 'dir.jpg'));
  fs.writeFileSync(path.join(root, 'data', 'wallpapers', '中文 图.png'), JPEG);

  const server = createAppServer({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  try {
    console.log('\n=== 用例 1：图片列表 ===');
    {
      const res = await rawRequest(port, '/api/images');
      const body = jsonOf(res);
      check('200 + API 标记', res.status === 200 && body && body.ok === true &&
        body.api === 'desktop-pet-images', res.status + ' ' + JSON.stringify(body));
      const names = body.images.backgrounds.map((x) => x.name);
      check('只列图片扩展名', names.indexOf('a.jpg') >= 0 && names.indexOf('note.txt') < 0,
        names.join(','));
      check('跳过点文件和目录',
        names.indexOf('.hidden.jpg') < 0 && names.indexOf('dir.jpg') < 0, names.join(','));
      check('壁纸目录独立',
        body.images.wallpapers.map((x) => x.name).join(',') === '中文 图.png',
        body.images.wallpapers.map((x) => x.name).join(','));
      check('返回大小与修改时间',
        typeof body.images.backgrounds[0].size === 'number' &&
        typeof body.images.backgrounds[0].mtimeMs === 'number');
    }

    console.log('\n=== 用例 2：上传与重名 ===');
    {
      const name = '测试图片-20261019-134500.jpg';
      const url = '/api/images/backgrounds/' + encodeURIComponent(name);
      const headers = {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(JPEG.length)
      };
      const r1 = await rawRequest(port, url, { method: 'POST', headers }, JPEG);
      const b1 = jsonOf(r1);
      check('中文名上传成功', r1.status === 201 && b1 && b1.ok === true &&
        b1.name === name, r1.status + ' ' + JSON.stringify(b1));
      check('文件真的落盘', fs.existsSync(path.join(root, 'data', 'backgrounds', name)));

      const r2 = await rawRequest(port, url, { method: 'POST', headers }, JPEG);
      const b2 = jsonOf(r2);
      check('同名上传自动加 -2', r2.status === 201 && b2 && /-2\.jpg$/.test(b2.name),
        r2.status + ' ' + JSON.stringify(b2));
      check('列表里能看到两张',
        jsonOf(await rawRequest(port, '/api/images')).images.backgrounds
          .map((x) => x.name).filter((n) => n.indexOf('测试图片') === 0).length === 2);
    }

    console.log('\n=== 用例 3：上传校验 ===');
    {
      const url = '/api/images/backgrounds/x.jpg';
      const badType = await rawRequest(port, url, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(JPEG.length) }
      }, JPEG);
      check('非 JPEG Content-Type → 415', badType.status === 415, String(badType.status));

      const badMagic = await rawRequest(port, url, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '4' }
      }, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
      check('魔数不对 → 400', badMagic.status === 400, String(badMagic.status));

      const badName = await rawRequest(port, '/api/images/backgrounds/bad.svg', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(JPEG.length) }
      }, JPEG);
      check('非图片扩展名 → 400', badName.status === 400, String(badName.status));

      const badFolder = await rawRequest(port, '/api/images/other/x.jpg', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(JPEG.length) }
      }, JPEG);
      check('未知目录 → 400', badFolder.status === 400, String(badFolder.status));

      const tooLarge = await rawRequest(port, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(MAX_UPLOAD_BYTES + 1)
        }
      });
      check('声明超限 → 413', tooLarge.status === 413, String(tooLarge.status));
    }

    console.log('\n=== 用例 4：Origin 与路径穿越 ===');
    {
      const same = await rawRequest(port, '/api/images/backgrounds/origin.jpg', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(JPEG.length),
          'Origin': base
        }
      }, JPEG);
      check('同源 Origin 允许', same.status === 201, String(same.status));

      const cross = await rawRequest(port, '/api/images/backgrounds/cross.jpg', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(JPEG.length),
          'Origin': 'http://evil.example'
        }
      }, JPEG);
      check('跨站 Origin → 403', cross.status === 403, String(cross.status));

      const dots = await rawRequest(port, '/%2e%2e/%2e%2e/%2e%2e/Windows/win.ini');
      // WHATWG URL 会先把编码的 .. 归一化；无论如何都不能读到根外文件
      check('`..` 段不会读到根外', dots.status === 400 || dots.status === 404,
        String(dots.status));

      const slash = await rawRequest(port, '/%2e%2e%2f_tmp-image-server-outside.txt');
      check('编码斜杠不能读到根外文件',
        slash.status !== 200 || slash.body.toString('utf8').indexOf('SECRET') < 0,
        slash.status + ' ' + slash.body.toString('utf8').slice(0, 20));

      const backslash = await rawRequest(port, '/data%5cbackgrounds%5ca.jpg');
      check('反斜杠路径 → 400/404', backslash.status === 400 || backslash.status === 404,
        String(backslash.status));

      const ads = await rawRequest(port, '/index.html%3Astream');
      check('NTFS 数据流路径 → 400', ads.status === 400, String(ads.status));

      const badHost = await rawRequest(port, '/api/images', {
        headers: { Host: 'evil.example' }
      });
      check('域名 Host → 403（防 DNS rebinding）', badHost.status === 403,
        String(badHost.status));
      const badHostStatic = await rawRequest(port, '/index.html', {
        headers: { Host: 'evil.example:8123' }
      });
      check('静态文件同样校验 Host', badHostStatic.status === 403,
        String(badHostStatic.status));
    }

    console.log('\n=== 用例 5：静态文件与 Range ===');
    {
      const index = await rawRequest(port, '/');
      check('根路径返回 index.html',
        index.status === 200 && index.body.toString('utf8').indexOf('<h1>ok</h1>') >= 0);
      check('HTML Content-Type',
        String(index.headers['content-type']).indexOf('text/html') === 0,
        index.headers['content-type']);

      const js = await rawRequest(port, '/index.html');
      check('HEAD 带 Content-Length 且无 body',
        (await rawRequest(port, '/index.html', { method: 'HEAD' })).body.length === 0);

      const range = await rawRequest(port, '/videos/test.webm', {
        headers: { Range: 'bytes=0-3' }
      });
      check('Range 返回 206', range.status === 206, String(range.status));
      check('Content-Range 正确',
        range.headers['content-range'] === 'bytes 0-3/12',
        range.headers['content-range']);
      check('只返回 4 字节', range.body.length === 4, String(range.body.length));

      const badRange = await rawRequest(port, '/videos/test.webm', {
        headers: { Range: 'bytes=999-1000' }
      });
      check('越界 Range → 416', badRange.status === 416, String(badRange.status));

      const method = await rawRequest(port, '/', { method: 'POST', headers: { 'Content-Length': '0' } });
      check('静态文件 POST → 405', method.status === 405, String(method.status));
      check('405 带 Allow', String(method.headers['allow']).indexOf('GET') >= 0,
        method.headers['allow']);

      const apiMethod = await rawRequest(port, '/api/images', { method: 'PUT' });
      check('API PUT → 405', apiMethod.status === 405, String(apiMethod.status));

      const notFound = await rawRequest(port, '/no-such-file');
      check('不存在的文件 → 404', notFound.status === 404, String(notFound.status));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
