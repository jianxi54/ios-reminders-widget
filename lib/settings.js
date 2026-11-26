'use strict';
/**
 * 本地设置（Bark 推送等）—— 存在 %LOCALAPPDATA%\RemindersWidget\settings.json，
 * 与 iCloud 会话分开，避免重新登录时把推送配置冲掉。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'RemindersWidget');
const FILE = path.join(DIR, 'settings.json');

const DEFAULTS = {
  ui: {
    theme: 'dark',        // dark | light
    pinned: false,        // 固定到桌面（固定 = 锁定位置），宿主退出前写回，下次启动自动恢复
  },
  bark: {
    enabled: false,
    server: 'https://api.day.app',
    key: '',
    group: '提醒事项',
    sound: '',
    level: 'active',      // active | timeSensitive | passive | critical
    icon: '',
    notifyOnDue: true,    // 没有单独设置提前提醒时，到期也推一条
  },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function deepMerge(base, patch) {
  const out = clone(base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function load() {
  let saved = {};
  try {
    // 有的编辑器/PowerShell 会写入 UTF-8 BOM，JSON.parse 会直接报错 → 先去掉
    const txt = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    saved = JSON.parse(txt);
  } catch { saved = {}; }
  return deepMerge(DEFAULTS, saved);
}

function save(patch) {
  const next = deepMerge(load(), patch || {});
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    throw new Error('保存设置失败：' + e.message);
  }
  return next;
}

module.exports = { load, save, DEFAULTS, FILE };
