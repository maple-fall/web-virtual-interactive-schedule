/*
 * character/packZip.js — 形象包 zip 的解析与打包（纯逻辑，不碰 DOM / IndexedDB）
 *
 * 桌宠跑在 file:// 下，没有 fs 权限，所以形象包在浏览器里读：
 *   parseZip   读中央目录 -> 条目列表，按需解出 Blob（STORED 直接切，DEFLATE 用 DecompressionStream）
 *   packFromZip 识别 7 种状态文件、读 manifest、做大小上限校验 -> 可直接入库的 pack 对象
 *   buildZip   把 pack 重新打包成 zip（全 STORED，UTF-8 文件名），用于导出
 *
 * file:// 下没有 crypto.subtle，CRC32 用手动查表。
 * 状态名归一与 tools/video/make_pet_videos.py 的 state_name() 一致：
 *   basename -> 去扩展名 -> trim -> 小写 -> 空格/连字符归一 -> 比对
 */
(function () {
  'use strict';
  var App = window.App;

  var STATES = ['idle', 'studying', 'working', 'alert', 'done', 'refuse', 'talking'];
  var VIDEO_EXTS = ['.webm', '.mp4'];
  var MANIFEST = 'manifest.json';
  var DEFAULT_MAX_FILE = 10 * 1024 * 1024;
  var DEFAULT_MAX_TOTAL = 50 * 1024 * 1024;
  var DEFAULT_MAX_ZIP = 60 * 1024 * 1024;
  var UTF8_FLAG = 0x0800;

  /* ---------------- CRC32 ---------------- */

  var CRC_TABLE = (function () {
    var table = [], c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) {
      c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- 名称编解码 ---------------- */

  function utf8Encode(str) {
    str = String(str);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [], i, c, c2, cp;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length &&
               (c2 = str.charCodeAt(i + 1)) >= 0xDC00 && c2 <= 0xDFFF) {
        cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        i++;
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '', i = 0, b, cp;
    while (i < bytes.length) {
      b = bytes[i++];
      if (b < 0x80) cp = b;
      else if ((b & 0xE0) === 0xC0) cp = ((b & 0x1F) << 6) | (bytes[i++] & 0x3F);
      else if ((b & 0xF0) === 0xE0) {
        cp = ((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
      } else {
        cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) |
             ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
      }
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        s += String.fromCharCode(cp);
      }
    }
    return s;
  }

  function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return decodeUtf8(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function stateFromName(fileName) {
    var base = String(fileName || '').replace(/^.*[\\/]/, '');
    var dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);
    base = base.replace(/^\s+|\s+$/g, '').toLowerCase();
    var norm = base.replace(/[\s-]+/g, '_');
    var flat = base.replace(/[\s_-]+/g, '');
    for (var i = 0; i < STATES.length; i++) {
      if (STATES[i] === norm || STATES[i] === flat) return STATES[i];
    }
    return null;
  }

  function extOf(name) {
    var base = String(name || '').replace(/^.*[\\/]/, '').toLowerCase();
    var dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot) : '';
  }

  /* ---------------- zip 解析 ---------------- */

  function parseZip(arrayBuffer) {
    return new Promise(function (resolve) { resolve(parseZipSync(arrayBuffer)); });
  }

  function parseZipSync(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);
    var len = u8.length;

    if (len < 22) throw new Error('不是有效的 zip 文件（长度不足）');

    // EOCD 可能因为 zip 注释而不在最后 22 字节，从尾部向前扫（最长注释 64KB）
    var min = Math.max(0, len - 22 - 65535);
    var eocd = -1;
    for (var i = len - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50 &&
          i + 22 + dv.getUint16(i + 20, true) === len) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾）');

    var disk = dv.getUint16(eocd + 4, true);
    var cdDisk = dv.getUint16(eocd + 6, true);
    var countDisk = dv.getUint16(eocd + 8, true);
    var count = dv.getUint16(eocd + 10, true);
    var cdSize = dv.getUint32(eocd + 12, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw new Error('不支持分卷 zip');
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      throw new Error('不支持 Zip64 格式的形象包');
    }
    if (cdOffset + cdSize > len) throw new Error('zip 目录越界，文件可能已损坏');

    var entries = [];
    var off = cdOffset;
    for (var n = 0; n < count; n++) {
      if (off + 46 > cdOffset + cdSize) throw new Error('zip 目录不完整');
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('zip 目录项签名错误');

      var flags = dv.getUint16(off + 8, true);
      var method = dv.getUint16(off + 10, true);
      var crc = dv.getUint32(off + 16, true);
      var compSize = dv.getUint32(off + 20, true);
      var size = dv.getUint32(off + 24, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var commentLen = dv.getUint16(off + 32, true);
      var localOffset = dv.getUint32(off + 42, true);

      if (off + 46 + nameLen > cdOffset + cdSize) throw new Error('zip 目录项越界');
      var nameBytes = new Uint8Array(arrayBuffer, off + 46, nameLen);
      entries.push(makeEntry(
        decodeName(nameBytes, (flags & UTF8_FLAG) !== 0),
        flags, method, crc, compSize, size, localOffset, arrayBuffer, dv, len
      ));
      off += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries };
  }

  function makeEntry(name, flags, method, crc, compSize, size, localOffset,
                     arrayBuffer, dv, len) {
    return {
      name: name,
      flags: flags,
      method: method,
      crc32: crc,
      compSize: compSize,
      size: size,
      getBlob: function () {
        if (localOffset + 30 > len || dv.getUint32(localOffset, true) !== 0x04034b50) {
          return Promise.reject(new Error('zip 本地文件头损坏：' + name));
        }
        var lnLen = dv.getUint16(localOffset + 26, true);
        var leLen = dv.getUint16(localOffset + 28, true);
        var dataStart = localOffset + 30 + lnLen + leLen;
        if (dataStart + compSize > len) {
          return Promise.reject(new Error('zip 数据越界：' + name));
        }
        if (method === 0) {
          return Promise.resolve(new Blob([new Uint8Array(arrayBuffer, dataStart, compSize)]));
        }
        if (method === 8) {
          if (typeof DecompressionStream !== 'function') {
            return Promise.reject(new Error(
              '当前浏览器不支持解压 deflate 条目，请用 tools/video/char_pack.py 重新打包为 stored'));
          }
          var bytes = new Uint8Array(arrayBuffer, dataStart, compSize);
          var stream = new Blob([bytes]).stream()
            .pipeThrough(new DecompressionStream('deflate-raw'));
          return new Response(stream).arrayBuffer().then(function (buf) {
            return new Blob([buf]);
          });
        }
        return Promise.reject(new Error('不支持的压缩方式（method=' + method + '）：' + name));
      }
    };
  }

  /* ---------------- 形象包识别 ---------------- */

  function zipStem(zipName) {
    var base = String(zipName || '').replace(/^.*[\\/]/, '');
    return base.replace(/\.zip$/i, '').replace(/^\s+|\s+$/g, '');
  }

  function readManifest(entry, warnings) {
    if (!entry) return Promise.resolve(null);
    return entry.getBlob().then(function (blob) {
      return blob.text();
    }).then(function (text) {
      var obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bad manifest');
      return obj;
    }).catch(function () {
      warnings.push('manifest.json 解析失败，已回退用 zip 文件名作形象名');
      return null;
    });
  }

  function clip(value, max) {
    return String(value == null ? '' : value).replace(/^\s+|\s+$/g, '').slice(0, max);
  }

  function packFromZip(arrayBuffer, opts) {
    opts = opts || {};
    var maxFile = opts.maxFileBytes == null ? DEFAULT_MAX_FILE : opts.maxFileBytes;
    var maxTotal = opts.maxTotalBytes == null ? DEFAULT_MAX_TOTAL : opts.maxTotalBytes;
    var maxZip = opts.maxZipBytes == null ? DEFAULT_MAX_ZIP : opts.maxZipBytes;
    var warnings = [];

    if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number') {
      return Promise.resolve({ ok: false, message: '读不到 zip 内容', warnings: warnings });
    }
    if (arrayBuffer.byteLength > maxZip) {
      return Promise.resolve({
        ok: false,
        message: 'zip 文件过大（超过 ' + Math.round(maxZip / 1024 / 1024) + 'MB）',
        warnings: warnings
      });
    }

    return parseZip(arrayBuffer).then(function (parsed) {
      var entries = parsed.entries;
      var manifestEntry = null;
      var manifestDepth = Infinity;
      var candidates = [];
      var seen = {};
      var total = 0;

      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var name = entry.name;
        if (!name || /\/$/.test(name)) continue;                       // 目录
        if (name.indexOf('__MACOSX/') === 0 || name.indexOf('__MACOSX\\') === 0) continue;
        var base = name.replace(/^.*[\\/]/, '').toLowerCase();
        if (base === '.ds_store' || base === 'thumbs.db') continue;

        if (base === MANIFEST) {
          var depth = (name.match(/\//g) || []).length;
          if (depth < manifestDepth) { manifestEntry = entry; manifestDepth = depth; }
          continue;
        }

        var ext = extOf(name);
        if (VIDEO_EXTS.indexOf(ext) < 0) continue;                     // 非视频静默忽略
        var state = stateFromName(name);
        if (!state) {
          warnings.push('跳过无法识别的文件：' + name);
          continue;
        }
        if (entry.flags & 0x1) {
          warnings.push('跳过加密文件：' + name);
          continue;
        }
        if (seen[state]) {
          warnings.push('重复状态 ' + state + '：跳过 ' + name + '（保留先出现的）');
          continue;
        }
        seen[state] = true;
        if (entry.size > maxFile) {
          warnings.push('文件过大，已跳过：' + name + '（' + Math.round(entry.size / 1024 / 1024) + 'MB）');
          continue;
        }
        if (total + entry.size > maxTotal) {
          warnings.push('超出总大小上限，已跳过：' + name);
          continue;
        }
        total += entry.size;
        candidates.push({ entry: entry, state: state, ext: ext });
      }

      if (!candidates.length) {
        return {
          ok: false,
          message: '包里没有找到可用的状态视频（文件名需为 idle/studying/working/alert/done/refuse/talking）',
          warnings: warnings
        };
      }

      var files = {};
      var loaded = 0;
      return candidates.reduce(function (chain, item) {
        return chain.then(function () {
          return item.entry.getBlob().then(function (blob) {
            files[item.state] = { blob: blob, ext: item.ext, size: item.entry.size };
            loaded++;
          }, function (err) {
            warnings.push('读取失败，已跳过：' + item.entry.name + '（' +
              (err && err.message ? err.message : err) + '）');
          });
        });
      }, Promise.resolve()).then(function () {
        if (!loaded) {
          return {
            ok: false,
            message: '包里没有能读取的状态视频，请检查 zip 是否损坏',
            warnings: warnings
          };
        }
        return readManifest(manifestEntry, warnings).then(function (manifest) {
          var name = manifest ? clip(manifest.name, 60) : '';
          if (!name) name = zipStem(opts.zipName) || '未命名形象';
          if (!files.idle) warnings.push('缺少 idle 视频，空闲状态会退回磁盘默认素材');

          return {
            ok: true,
            warnings: warnings,
            pack: {
              id: App.util.uid('pack'),
              name: name,
              author: manifest ? clip(manifest.author, 60) : '',
              version: manifest && clip(manifest.version, 20) ? clip(manifest.version, 20) : '1.0',
              note: manifest ? clip(manifest.note, 200) : '',
              source: String(opts.zipName || ''),
              createdAt: Date.now(),
              totalBytes: total,
              files: files
            }
          };
        });
      });
    }).catch(function (err) {
      return {
        ok: false,
        message: (err && err.message) ? err.message : String(err),
        warnings: warnings
      };
    });
  }

  /* ---------------- zip 打包（导出） ---------------- */

  function u16(arr, off, val) {
    arr[off] = val & 255;
    arr[off + 1] = (val >>> 8) & 255;
  }

  function u32(arr, off, val) {
    arr[off] = val & 255;
    arr[off + 1] = (val >>> 8) & 255;
    arr[off + 2] = (val >>> 16) & 255;
    arr[off + 3] = (val >>> 24) & 255;
  }

  function dosDateTime(d) {
    var year = d.getFullYear();
    if (year < 1980) year = 1980;
    if (year > 2107) year = 2107;
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function buildZip(files, manifest) {
    var items = [];
    if (manifest) {
      items.push({
        name: MANIFEST,
        blob: new Blob([utf8Encode(JSON.stringify(manifest, null, 2))])
      });
    }
    for (var i = 0; i < STATES.length; i++) {
      var f = files && files[STATES[i]];
      if (f && f.blob) {
        items.push({ name: STATES[i] + (f.ext || '.webm'), blob: f.blob });
      }
    }

    var dos = dosDateTime(new Date());
    var parts = [];
    var central = [];
    var offset = 0;

    return items.reduce(function (chain, item) {
      return chain.then(function () {
        return item.blob.arrayBuffer().then(function (buf) {
          var u8 = new Uint8Array(buf);
          var nameBytes = utf8Encode(item.name);
          var crc = crc32(u8);

          var local = new Uint8Array(30 + nameBytes.length);
          u32(local, 0, 0x04034b50);
          u16(local, 4, 20);
          u16(local, 6, UTF8_FLAG);
          u16(local, 8, 0);              // stored
          u16(local, 10, dos.time);
          u16(local, 12, dos.date);
          u32(local, 14, crc);
          u32(local, 18, u8.length);
          u32(local, 22, u8.length);
          u16(local, 26, nameBytes.length);
          u16(local, 28, 0);
          local.set(nameBytes, 30);

          parts.push(local, u8);
          central.push({
            nameBytes: nameBytes, crc: crc, size: u8.length, offset: offset
          });
          offset += local.length + u8.length;
        });
      });
    }, Promise.resolve()).then(function () {
      var cdStart = offset;
      var cdSize = 0;
      var cdParts = central.map(function (c) {
        var ch = new Uint8Array(46 + c.nameBytes.length);
        u32(ch, 0, 0x02014b50);
        u16(ch, 4, 20);                  // version made by
        u16(ch, 6, 20);                  // version needed
        u16(ch, 8, UTF8_FLAG);
        u16(ch, 10, 0);                  // stored
        u16(ch, 12, dos.time);
        u16(ch, 14, dos.date);
        u32(ch, 16, c.crc);
        u32(ch, 20, c.size);
        u32(ch, 24, c.size);
        u16(ch, 28, c.nameBytes.length);
        u16(ch, 30, 0);                  // extra
        u16(ch, 32, 0);                  // comment
        u16(ch, 34, 0);                  // disk
        u16(ch, 36, 0);                  // internal attrs
        u32(ch, 38, 0);                  // external attrs
        u32(ch, 42, c.offset);
        ch.set(c.nameBytes, 46);
        cdSize += ch.length;
        return ch;
      });

      var eocd = new Uint8Array(22);
      u32(eocd, 0, 0x06054b50);
      u16(eocd, 4, 0);
      u16(eocd, 6, 0);
      u16(eocd, 8, central.length);
      u16(eocd, 10, central.length);
      u32(eocd, 12, cdSize);
      u32(eocd, 16, cdStart);
      u16(eocd, 20, 0);

      return new Blob(parts.concat(cdParts, [eocd]), { type: 'application/zip' });
    });
  }

  App.PackZip = {
    STATES: STATES,
    crc32: crc32,
    stateFromName: stateFromName,
    parseZip: parseZip,
    packFromZip: packFromZip,
    buildZip: buildZip
  };
})();
