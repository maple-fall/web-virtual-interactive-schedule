/*
 * gen-schedule-pdf/gen-cmaps.js — 一次性生成「内置 CMap 表」desktop-pet/lib/pdfjs/cmaps.js
 *
 * 干什么用的：不少教务系统 / WPS 导出的中文 PDF 用的是「未内嵌字体 + 标准 CJK 字体」，
 * 字形 → Unicode 的映射放在外部 CMap 文件里。pdf.js 默认不去取这些文件（file:// 下也取不到），
 * 结果是 getTextContent() 返回空数组、PDF 看着正常却一个字都提不出来。
 * 这份生成器把 pdfjs-dist 自带的 CMap 打包成一段 JS（base64），随应用一起分发，
 * 由 App.PdfCMaps.factory() 交给 pdf.js，file:// 双击运行也能解析这类 PDF。
 *
 * 只打包 GB 系（简体中文）：GB/GBK/GBT/EUC/UniGB/Adobe-GB1 共 33 个文件，base64 后约 390KB。
 * 繁体（CNS）、日文（JIS）、韩文（KOR）系没有打包 —— 用到了会报「缺少内置 CMap」。
 *
 * 用法：在仓库根目录执行 npm run gen:cmaps
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var SRC_DIR = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps');
var OUT = path.join(ROOT, 'desktop-pet', 'lib', 'pdfjs', 'cmaps.js');

// 简体中文相关：GB2312/GBK/GB18030 编码族 + Adobe-GB1 字符集 + UTF 映射变体
var WANTED = /^(GB|GBT|GBK|UniGB|Adobe-GB1)/;

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('未找到 CMap 源目录：' + SRC_DIR);
    console.error('请先在仓库根目录执行 npm install');
    process.exit(1);
  }

  var names = fs.readdirSync(SRC_DIR)
    .filter(function (f) { return /\.bcmap$/.test(f) && WANTED.test(f.replace(/\.bcmap$/, '')); })
    .map(function (f) { return f.replace(/\.bcmap$/, ''); })
    .sort();
  if (!names.length) {
    console.error('没有筛出任何 CMap 文件，检查 WANTED 规则');
    process.exit(1);
  }

  var lines = [];
  var rawBytes = 0;
  names.forEach(function (name) {
    var buf = fs.readFileSync(path.join(SRC_DIR, name + '.bcmap'));
    rawBytes += buf.length;
    lines.push('    ' + JSON.stringify(name) + ': ' + JSON.stringify(buf.toString('base64')));
  });

  var js = [
    '/*',
    ' * lib/pdfjs/cmaps.js — 内置 CJK CMap 表（生成产物，勿手改）',
    ' * 生成器：tools/gen-schedule-pdf/gen-cmaps.js（npm run gen:cmaps）',
    ' * 源：pdfjs-dist ' + require(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'package.json')).version +
      ' 的 cmaps/ 目录，筛出 GB 系 ' + names.length + ' 个文件',
    ' *',
    ' * 为什么需要：用标准 CJK 字体（STSong-Light 等）且未内嵌字体的 PDF，字形到 Unicode 的映射',
    ' * 不在文件里，pdf.js 必须另外加载 CMap 才能提取文字 —— file:// 下取不到，于是返回空文本层。',
    ' * 这里把 CMap 内联成 base64，由 App.PdfCMaps.factory() 提供给 pdf.js，离线双击也能解析。',
    ' */',
    '(function () {',
    '  \'use strict\';',
    '  var App = window.App = window.App || {};',
    '',
    '  var DATA = {',
    lines.join(',\n'),
    '  };',
    '',
    '  var cache = {};',
    '',
    '  function decode(b64) {',
    '    var bin = atob(b64);',
    '    var u8 = new Uint8Array(bin.length);',
    '    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);',
    '    return u8;',
    '  }',
    '',
    '  /* pdf.js 约定的读取器：fetch({name}) -> Promise<{cMapData, compressionType}>',
    '     compressionType 1 = CMapCompressionType.BINARY（bcmap 是二进制格式） */',
    '  function CMapReaderFactory(params) {',
    '    params = params || {};',
    '    this.baseUrl = params.baseUrl || null;',
    '    this.isCompressed = params.isCompressed !== false;',
    '  }',
    '',
    '  CMapReaderFactory.prototype.fetch = function (params) {',
    '    var name = params && params.name;',
    '    var b64 = name ? DATA[name] : null;',
    '    if (!b64) {',
    '      return Promise.reject(new Error(\'缺少内置 CMap：\' + name +',
    '        \'（该 PDF 用了未打包的编码，目前只内置简体中文 GB 系）\'));',
    '    }',
    '    if (!cache[name]) cache[name] = decode(b64);',
    '    return Promise.resolve({ cMapData: cache[name], compressionType: 1 });',
    '  };',
    '',
    '  /* 交给 pdf.js 的是「构造函数」而不是实例：getDocument 内部自己 new',
    '     （CMapReaderFactory: new CMapReaderFactory({baseUrl, isCompressed})） */',
    '  App.PdfCMaps = {',
    '    names: Object.keys(DATA),',
    '    CMapReaderFactory: CMapReaderFactory',
    '  };',
    '})();',
    ''
  ].join('\n');

  fs.writeFileSync(OUT, js, 'utf8');
  console.log('CMap 文件数: ' + names.length + '（原始 ' + (rawBytes / 1024).toFixed(0) + 'KB）');
  console.log('已写出    : ' + OUT + '（' + (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB）');
}

main();
