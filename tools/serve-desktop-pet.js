#!/usr/bin/env node
/*
 * serve-desktop-pet.js — 桌面日程助手的本地服务器（零依赖，只用 Node 内置模块）
 *
 * 为什么需要它：
 *   直接双击 index.html 时页面是 file://，浏览器不能枚举/写入 data/ 下的图片目录，
 *   只能靠 File System Access API 让用户手动授权。用这个服务器打开页面时，图片的
 *   列目录和写文件都由服务端完成，导入图片会直接落到 data/backgrounds、data/wallpapers。
 *
 * 用法：
 *   node tools/serve-desktop-pet.js            # http://127.0.0.1:8123/
 *   node tools/serve-desktop-pet.js --open     # 启动后自动开浏览器
 *   node tools/serve-desktop-pet.js --port 9000
 *   node tools/serve-desktop-pet.js --host 0.0.0.0   # 局域网访问（注意：写接口无鉴权）
 *
 * 注意：HTTP 与 file:// 是两个独立的存储空间，日程/设置/形象包不会自动互通。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PORT = 8123;
const DEFAULT_HOST = '127.0.0.1';
const FOLDERS = ['backgrounds', 'wallpapers'];
const FOLDER_DIR = {
  backgrounds: path.join('data', 'backgrounds'),
  wallpapers: path.join('data', 'wallpapers')
};
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;
const UPLOAD_EXT_RE = /\.jpe?g$/i;
const FORBIDDEN_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME_LEN = 120;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const API_MARKER = 'desktop-pet-images';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.zip': 'application/zip'
};

/* ---------------- 通用小工具 ---------------- */

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function text(res, status, body) {
  const text2 = String(body);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text2),
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text2);
}

/* 把 URL path 拆成已解码的段；任何可疑段直接返回 null */
function decodeSegments(pathname) {
  const raw = String(pathname || '/').split('/').filter(Boolean);
  const out = [];
  for (const piece of raw) {
    let seg;
    try {
      seg = decodeURIComponent(piece);
    } catch (e) {
      return null;
    }
    if (!seg || seg === '.' || seg === '..') return null;
    if (seg.indexOf('\\') >= 0 || seg.indexOf('\u0000') >= 0) return null;
    // Windows 文件名不允许这些字符；其中 ':' 还能打开 NTFS 数据流（file:stream），必须挡掉
    if (/[<>:"|?*]/.test(seg)) return null;
    out.push(seg);
  }
  return out;
}

function isImageName(name) {
  if (typeof name !== 'string' || !name || name.length > MAX_NAME_LEN) return false;
  if (name.charAt(0) === '.') return false;
  if (FORBIDDEN_RE.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  if (!IMAGE_EXT_RE.test(name)) return false;

  try {
    const decoded = decodeURIComponent(name);
    if (decoded !== name &&
        (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0 ||
         decoded.charAt(0) === '.' || /[\u0000-\u001f]/.test(decoded))) {
      return false;
    }
  } catch (e) { /* 裸百分号，按普通字符处理 */ }
  return true;
}

function isUploadName(name) {
  return isImageName(name) && UPLOAD_EXT_RE.test(name);
}

function safeBaseName(name) {
  let base = String(name || 'image').replace(/\.[^.\\/]*$/, '');
  base = base.replace(FORBIDDEN_RE, '-').replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base) base = 'image';
  if (base.length > 60) base = base.slice(0, 60);
  if (RESERVED_RE.test(base)) base = '_' + base;
  return base;
}

/* 与客户端 filenameFor 同规则，但服务端只负责最终兜底。
   客户端传来的名字已经带时间戳，这里不再追加，避免出现两个时间戳。 */
function normalizeUploadName(name) {
  return safeBaseName(name) + '.jpg';
}

function isJpeg(buf) {
  return buf && buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

function ensureDirs(root) {
  for (const folder of FOLDERS) {
    fs.mkdirSync(path.join(root, FOLDER_DIR[folder]), { recursive: true });
  }
}

function resolveInside(root, segments) {
  const target = path.resolve(root, ...segments);
  if (target !== root && target.indexOf(root + path.sep) !== 0) return null;
  return target;
}

/* 只接受本机名或 IP 字面量作为 Host。
   挡掉 DNS rebinding：攻击者把域名解析到 127.0.0.1 时，Host 会带着域名，
   同源检查只看 Origin/Host 是否一致是挡不住的。局域网访问仍可用 IP。 */
function hostAllowed(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === '::1') return true;
  const host = raw.replace(/:\d+$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^[0-9a-f:]+$/i.test(host);              // 其余 IP 字面量
}

/* ---------------- 图片列表 / 上传 ---------------- */

function listFolder(root, folder) {
  const dir = path.join(root, FOLDER_DIR[folder]);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;                 // 目录、符号链接一律不列
    if (!isImageName(entry.name)) continue;
    let st;
    try {
      st = fs.statSync(path.join(dir, entry.name));
    } catch (e) {
      continue;
    }
    out.push({ name: entry.name, size: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
  return out;
}

function writeUnique(dir, name, buffer) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);

  for (let n = 1; n <= 999; n++) {
    const candidate = n === 1 ? name : stem + '-' + n + ext;
    const target = path.join(dir, candidate);
    let fd = null;
    try {
      fd = fs.openSync(target, 'wx');
      fs.writeFileSync(fd, buffer);
      fs.closeSync(fd);
      return candidate;
    } catch (e) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (e2) { /* 忽略 */ }
      }
      if (e && e.code === 'EEXIST') continue;
      // 写了一半的残余文件不要留在目录里
      try { fs.unlinkSync(target); } catch (e3) { /* 忽略 */ }
      throw e;
    }
  }
  throw new Error('同名文件过多');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) {
        const e = new Error('请求体过大');
        e.code = 'TOO_LARGE';
        reject(e);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/* ---------------- HTTP 入口 ---------------- */

function createAppServer(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || path.join(__dirname, '..', 'desktop-pet'));
  const port = opts.port == null ? DEFAULT_PORT : opts.port;

  ensureDirs(root);

  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) {
      text(res, 403, 'Forbidden host');
      return;
    }

    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch (e) {
      json(res, 400, { ok: false, error: 'BAD_URL' });
      return;
    }

    const segments = decodeSegments(parsed.pathname);
    if (!segments) {
      json(res, 400, { ok: false, error: 'BAD_PATH' });
      return;
    }

    /* ---- API ---- */
    if (segments[0] === 'api') {
      if (segments[1] !== 'images') {
        json(res, 404, { ok: false, error: 'NOT_FOUND' });
        return;
      }

      if (segments.length === 2 && req.method === 'GET') {
        const images = {};
        for (const folder of FOLDERS) images[folder] = listFolder(root, folder);
        json(res, 200, { ok: true, api: API_MARKER, version: 1, images });
        return;
      }

      if (segments.length === 4 && req.method === 'POST') {
        handleUpload(req, res, root, segments[2], segments[3]);
        return;
      }

      res.setHeader('Allow', 'GET, POST');
      json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
      return;
    }

    /* ---- 静态文件 ---- */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      text(res, 405, 'Method Not Allowed');
      return;
    }

    const rel = segments.length ? segments : ['index.html'];
    const target = resolveInside(root, rel);
    if (!target) {
      text(res, 400, 'Bad path');
      return;
    }

    let st;
    try {
      st = fs.statSync(target);
    } catch (e) {
      text(res, 404, 'Not found');
      return;
    }

    // 目录不列清单；/ 已在上面映射到 index.html
    if (!st.isFile()) {
      text(res, 404, 'Not found');
      return;
    }

    // 防符号链接逃逸
    let real;
    try {
      real = fs.realpathSync(target);
    } catch (e) {
      text(res, 404, 'Not found');
      return;
    }
    if (real !== root && real.indexOf(root + path.sep) !== 0) {
      text(res, 403, 'Forbidden');
      return;
    }
    try {
      st = fs.statSync(real);
    } catch (e) {
      text(res, 404, 'Not found');
      return;
    }

    serveFile(req, res, real, st);
  });

  server.port = port;
  return server;
}

function handleUpload(req, res, root, folder, rawName) {
  if (FOLDERS.indexOf(folder) < 0) {
    json(res, 400, { ok: false, error: 'BAD_FOLDER' });
    return;
  }

  // 跨站写保护：同源请求会带 Origin；带了就必须和 Host 对上
  const origin = req.headers.origin;
  if (origin) {
    const expected = 'http://' + (req.headers.host || '');
    if (origin !== expected) {
      json(res, 403, { ok: false, error: 'BAD_ORIGIN' });
      return;
    }
  }

  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.indexOf('image/jpeg') !== 0) {
    json(res, 415, { ok: false, error: 'ONLY_JPEG' });
    return;
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    json(res, 413, { ok: false, error: 'TOO_LARGE' });
    return;
  }

  const requested = rawName || 'image.jpg';
  if (!isUploadName(requested)) {
    json(res, 400, { ok: false, error: 'BAD_NAME' });
    return;
  }

  readBody(req, MAX_UPLOAD_BYTES).then((buffer) => {
    if (!isJpeg(buffer)) {
      json(res, 400, { ok: false, error: 'BAD_IMAGE' });
      return;
    }

    // 客户端传来的名字已经带时间戳；服务端仍做一次清洗，并在重名时加后缀
    const name = normalizeUploadName(requested);
    const dir = path.join(root, FOLDER_DIR[folder]);
    const saved = writeUnique(dir, name, buffer);
    json(res, 201, {
      ok: true,
      folder,
      name: saved,
      path: FOLDER_DIR[folder].split(path.sep).join('/') + '/' + saved,
      bytes: buffer.length
    });
  }).catch((e) => {
    if (e && e.code === 'TOO_LARGE') {
      json(res, 413, { ok: false, error: 'TOO_LARGE' });
    } else {
      json(res, 500, { ok: false, error: 'WRITE_FAILED' });
    }
  });
}

function serveFile(req, res, target, st) {
  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const size = st.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    let start = null;
    let end = null;

    if (m) {
      if (m[1] === '' && m[2] === '') {
        // bytes=- 无意义，按无 Range 处理
      } else if (m[1] === '') {
        // bytes=-500：最后 500 字节
        const suffix = Number(m[2]);
        if (suffix > 0) {
          start = Math.max(0, size - suffix);
          end = size - 1;
        }
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
    }

    if (start === null || !isFinite(start) || !isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + size });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': end - start + 1
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(target, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Length': size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(target);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, host: DEFAULT_HOST, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.indexOf('--port=') === 0) out.port = Number(a.slice(7));
    else if (a === '--host') out.host = argv[++i];
    else if (a.indexOf('--host=') === 0) out.host = a.slice(7);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function openBrowser(url) {
  let child = null;
  try {
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { stdio: 'ignore', detached: true });
    } else {
      child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    }
    // spawn 失败是异步的 'error' 事件；不监听会让整个服务器进程崩掉
    if (child) {
      child.on('error', function () {});
      child.unref();
    }
  } catch (e) {
    // 打不开浏览器不影响服务器本身
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node tools/serve-desktop-pet.js [--port 8123] [--host 127.0.0.1] [--open]');
    return;
  }

  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('端口不合法：' + args.port);
    process.exitCode = 1;
    return;
  }

  let server;
  try {
    server = createAppServer({ port });
  } catch (e) {
    console.error('无法初始化图片目录：' + (e && e.message ? e.message : e));
    console.error('请确认 desktop-pet/data 可写，或在仓库根目录运行。');
    process.exitCode = 1;
    return;
  }

  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('端口 ' + port + ' 已被占用。换一个端口：node tools/serve-desktop-pet.js --port 8124');
    } else {
      console.error('服务器启动失败：', e && e.message ? e.message : e);
    }
    process.exitCode = 1;
  });

  server.listen(port, args.host, () => {
    const shown = args.host === '0.0.0.0' || args.host === '::' ? '127.0.0.1' : args.host;
    const url = 'http://' + shown + ':' + port + '/';
    console.log('');
    console.log('桌面日程助手 · 本地服务器');
    console.log('  页面：' + url);
    console.log('  图片：desktop-pet/data/backgrounds、desktop-pet/data/wallpapers');
    console.log('  说明：导入的图片会直接写进上面两个文件夹。');
    if (args.host !== DEFAULT_HOST) {
      console.log('');
      console.log('  ⚠ 已允许局域网访问。图片写入接口没有鉴权，只在你信任的网络里使用。');
    }
    console.log('  按 Ctrl+C 停止。');
    console.log('');
    if (args.open) openBrowser(url);
  });
}

module.exports = {
  createAppServer,
  isImageName,
  normalizeUploadName,
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_UPLOAD_BYTES
};

if (require.main === module) main();
