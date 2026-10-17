/*
 * character/builtin.js — 内置形象登记表
 *
 * file:// 下浏览器读不了 zip，所以内置形象直接引用 videos/ 下的目录：
 * 目录里按 <状态>.webm（或 .mp4）放七个文件即可，不需要导入。
 *
 * 增加内置形象：复制一个视频目录，然后在 BUILTINS 里加一项。
 * 第一项带 isDefault: true 的会作为首次打开时的默认形象。
 */
(function () {
  'use strict';
  var App = window.App;

  var STATES = ['idle', 'studying', 'working', 'alert', 'done', 'refuse', 'talking'];

  var BUILTINS = [
    { id: 'zhenzhu', name: 'zhenzhu', dir: 'videos/zhenzhu/', ext: '.webm', isDefault: true }
  ];

  function byId(id) {
    for (var i = 0; i < BUILTINS.length; i++) {
      if (BUILTINS[i].id === id) return BUILTINS[i];
    }
    return null;
  }

  function defaultEntry() {
    for (var i = 0; i < BUILTINS.length; i++) {
      if (BUILTINS[i].isDefault) return BUILTINS[i];
    }
    return BUILTINS.length ? BUILTINS[0] : null;
  }

  /* 目录 -> animation.setCharacter 认识的 pack 结构（url 而非 blob） */
  function toPack(entry) {
    var files = {};
    for (var i = 0; i < STATES.length; i++) {
      var state = STATES[i];
      files[state] = { url: entry.dir + state + entry.ext, ext: entry.ext, size: 0 };
    }
    return {
      id: 'builtin_' + entry.id,
      name: entry.name,
      builtin: true,
      source: 'builtin',
      createdAt: 0,
      totalBytes: 0,
      files: files
    };
  }

  App.Builtin = {
    list: BUILTINS,
    STATES: STATES,
    byId: byId,
    defaultEntry: defaultEntry,
    toPack: toPack
  };
})();
