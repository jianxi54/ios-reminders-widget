'use strict';
/**
 * iOS 提醒事项 · Windows 11 小组件 — 本地服务
 *
 * 数据源：iCloud CloudKit 私有库（com.apple.reminders）
 *   iOS 13 起「提醒事项」已迁出 CalDAV，只有 CloudKit 能真正读写到 iPhone 上的数据。
 *   会话由 login-icloud.bat 通过真实浏览器换取，存于 %LOCALAPPDATA%\RemindersWidget\icloud-session.json
 *
 * 能力：
 *   - 读：标题 / 备注（富文本正文）/ 到期时间 / 提前提醒 / 优先级 / 旗标 / 列表颜色
 *   - 写：新建、改名、备注、日期、提前提醒、优先级、旗标、完成、删除
 *   - 推送：Bark（iOS），到期或到达「提前提醒」时刻时推送
 *
 * 仅监听 127.0.0.1。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { CloudKitClient, ALARM_PRESETS, describeAlarm } = require('./lib/cloudkit');
const settingsStore = require('./lib/settings');
const bark = require('./lib/bark');
const { NAME: APP_NAME, VERSION: APP_VERSION, TAG: APP_TAG } = require('./lib/version');

const PORT = Number(process.env.WIDGET_PORT || 8642);
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'RemindersWidget');
const SESSION_FILE = path.join(SESSION_DIR, 'icloud-session.json');
const PUSHED_FILE = path.join(SESSION_DIR, 'pushed.json');

/* ---------------- 会话 ---------------- */
function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/* ---------------- 演示数据 ---------------- */
function at(dayOffset, h, m = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const demoLists = [
  { id: 'list-buy', name: '购物', color: '#FF9F0A' },
  { id: 'list-work', name: '工作', color: '#0A84FF' },
  { id: 'list-me', name: '个人', color: '#30D158' },
  { id: 'list-home', name: '家庭', color: '#FF375F' },
];

let demoItems = [
  { uid: 'demo-1', listId: 'list-buy', summary: '牛奶两盒、鸡蛋一打', notes: '', due: at(0, 19, 0), status: 'NEEDS-ACTION', completed: null, priority: 0, alarmOffset: 30 },
  { uid: 'demo-2', listId: 'list-buy', summary: '给妈妈订生日蛋糕', notes: '要草莓味的\n提前一天和店里确认', due: at(1, 18, 0), status: 'NEEDS-ACTION', completed: null, priority: 1, alarmOffset: 60 },
  { uid: 'demo-3', listId: 'list-work', summary: '回复客户邮件', notes: '', due: at(0, 10, 0), status: 'NEEDS-ACTION', completed: null, priority: 0 },
  { uid: 'demo-4', listId: 'list-work', summary: '准备周报', notes: '把上周的同步数据和本周计划都放进去', due: at(3, 17, 0), status: 'NEEDS-ACTION', completed: null, priority: 5 },
  { uid: 'demo-5', listId: 'list-work', summary: '审核设计稿 v2', notes: '', due: null, status: 'NEEDS-ACTION', completed: null, priority: 9 },
  { uid: 'demo-6', listId: 'list-me', summary: '给手机充值', notes: '', due: at(-1, 21, 0), status: 'NEEDS-ACTION', completed: null, priority: 0 },
  { uid: 'demo-7', listId: 'list-me', summary: '健身 40 分钟', notes: '', due: at(0, 19, 30), status: 'NEEDS-ACTION', completed: null, priority: 0 },
  { uid: 'demo-8', listId: 'list-me', summary: '读书 30 页', notes: '《置身事内》', due: null, status: 'NEEDS-ACTION', completed: null, priority: 0 },
  { uid: 'demo-9', listId: 'list-home', summary: '缴水电费', notes: '', due: at(0, 12, 0), status: 'NEEDS-ACTION', completed: null, priority: 0 },
  { uid: 'demo-10', listId: 'list-home', summary: '预约牙医复诊', notes: '', due: at(5, 9, 30), status: 'NEEDS-ACTION', completed: null, priority: 1 },
  { uid: 'demo-11', listId: 'list-buy', summary: '取快递', notes: '', due: at(0, 14, 0), status: 'COMPLETED', completed: at(0, 15, 10), priority: 0 },
  { uid: 'demo-12', listId: 'list-work', summary: '发送合同扫描件', notes: '', due: at(-1, 16, 0), status: 'COMPLETED', completed: at(-1, 15, 42), priority: 0 },
];

/* ---------------- 运行状态 ---------------- */
let session = loadSession();
let ck = session ? new CloudKitClient(session) : null;
let mode = ck ? 'live' : 'demo';
let lastSync = null;
let lastError = null;
let cache = new Map();   // uid -> 规范化后的条目（含原始 record，供写操作使用）
let listCache = [];      // 列表对象（含 record，供新建使用）
let lastSnapshot = null; // 上一次成功的完整响应（限流兜底 + 10 秒内复用）
let lastFetchAt = 0;
let inflight = null;     // 正在进行的刷新（多端同时刷新时只打一次 CloudKit）
let fetchSeq = 0;        // 防止慢请求晚到，用旧结果覆盖新快照
let forceFresh = false;  // 刚写完，下一次读取必须等真实数据

function maskId(id) {
  if (!id) return '';
  const [name, dom] = String(id).split('@');
  const n = String(name);
  return n.slice(0, Math.min(2, n.length)) + '***' + (dom ? '@' + dom : '');
}

/** 兼容旧版：苹果曾用一条系统提醒提示「此列表的创建者已升级……」 */
function isSystemNotice(it) {
  const s = String(it.summary || '');
  return /已升级(这些)?提醒事项/.test(s);
}

function publicItem(it) {
  return {
    uid: it.uid,
    listId: it.listId,
    listName: it.listName || '',
    listColor: it.listColor || '',
    summary: it.summary,
    notes: it.notes || '',
    due: it.due || null,
    created: it.created || null,
    status: it.status || 'NEEDS-ACTION',
    completed: it.completed || null,
    allDay: !!it.allDay,
    flagged: !!it.flagged,
    priority: it.priority || 0,
    alarmOffset: it.alarmOffset === undefined ? null : it.alarmOffset,
    alarmText: describeAlarm(it.alarmOffset),
    system: isSystemNotice(it),
  };
}

/**
 * 会话失效判定。
 * 421 Invalid global session = iCloud 作废了这次登录（在别处重新登录、令牌轮换、pod 迁移都会这样），
 * 等价于「要重新登录」，不能当成普通网络错误。
 */
function isAuthError(e) {
  const m = String(e && e.message || '');
  return /HTTP 401|HTTP 403|HTTP 421|AUTHENTICATION|NOT_AUTHORIZED|Unauthorized|Invalid global session/i.test(m);
}

function sessionExpired(e) {
  return isAuthError(e);
}

/* ---------------- 会话自愈 ----------------
 * login-icloud.bat 重新登录时只会覆盖磁盘上的会话文件，正在跑的服务不会自动知道。
 * 盯着文件修改时间：一变就重建客户端，这样"登录完就能用"，不用重启小组件、也不用点刷新会话。
 */
let sessionMtime = 0;
function statSessionMtime() {
  try { return fs.statSync(SESSION_FILE).mtimeMs; } catch { return 0; }
}
sessionMtime = statSessionMtime();

function reloadSessionIfChanged(force) {
  const m = statSessionMtime();
  if (!force && (!m || m === sessionMtime)) return false;
  const s = loadSession();
  if (!s || !s.cookies || !s.webservices) return false;
  // 同一个账号只是换了令牌：缓存里的记录/changeTag 仍然有效，保留；
  // 换了账号就必须清干净，别把上一个账号的条目写到新账号里。
  const sameAccount = !!(session && s.dsid && session.dsid === s.dsid);
  session = s;
  ck = new CloudKitClient(s);
  sessionMtime = m;
  mode = 'live';
  if (!sameAccount) {
    cache = new Map();
    listCache = [];
    lastSnapshot = null;
  }
  lastFetchAt = 0;
  lastError = null;
  console.log('[session] 会话文件已更新，重新载入（dsid ' + s.dsid + '，pod ' + (s.webservices.ckdatabasews || {}).url + '）');
  return true;
}


/* ---------------- 核心：读取 ---------------- */
/** 真正去 CloudKit 拉一遍（限流时可能十几秒），结果落地成快照 */
async function fetchLive(allowRetry = true) {
  const seq = ++fetchSeq;
  try {
    const byList = await ck.fetchAll();
    const lists = [];
    const items = [];
    const nextCache = new Map();
    const nextLists = [];

    for (const [, { list, items: raw }] of byList) {
      lists.push({ id: list.recordName, name: list.name, color: list.color || '#8E8E93' });
      nextLists.push(list);
      for (const it of raw) {
        const norm = {
          uid: it.uid,
          listId: list.recordName,
          listName: list.name,
          listColor: list.color || '',
          summary: it.title,
          notes: it.notes || '',
          due: it.due,
          created: it.created,
          status: it.completed ? 'COMPLETED' : 'NEEDS-ACTION',
          completed: it.completedAt,
          allDay: it.allDay,
          flagged: it.flagged,
          priority: it.priority,
          alarmOffset: it.alarmOffset,
          record: it.record,
        };
        nextCache.set(it.uid, norm);
        items.push(publicItem(norm));
      }
    }

    const snap = {
      mode: 'live',
      lists,
      items,
      lastSync: Date.now(),
      lastError: null,
      appleId: maskId(session.appleId || ''),
      serverTime: Date.now(),
      alarmPresets: ALARM_PRESETS,
    };

    lastSync = snap.lastSync;
    lastError = null;
    // 慢请求可能晚到，别用旧结果覆盖更新的快照
    if (seq === fetchSeq) {
      cache = nextCache;
      listCache = nextLists;
      lastSnapshot = snap;
      lastFetchAt = Date.now();
    }
    return snap;
  } catch (e) {
    // 会话被作废：磁盘上的会话可能已经被重新登录覆盖过，重载再试一次
    if (allowRetry && isAuthError(e) && reloadSessionIfChanged(true)) {
      console.log('[session] 认证失败（' + e.message + '），已用新会话重试');
      return fetchLive(false);
    }
    lastError = e.message;
    // 读失败但有旧数据时，宁可显示稍旧的内容，也不要把列表清空
    if (lastSnapshot && /THROTTLED|ETIMEDOUT|ENOTFOUND|ECONNRESET|fetch failed/i.test(e.message)) {
      return { ...lastSnapshot, lastError: '网络/限流，显示的是稍早的数据', stale: true, serverTime: Date.now() };
    }
    const err = new Error(sessionExpired(e)
      ? 'iCloud 判定这次登录已失效（Invalid global session），请重新双击 login-icloud.bat 登录；登录完成后会自动接上，不用重启小组件'
      : e.message);
    err.expose = true;
    throw err;
  }
}

async function getRemindersData() {
  // 先看一眼会话文件是不是被重新登录覆盖过（几百字节的 stat，代价可忽略）
  reloadSessionIfChanged(false);
  if (mode === 'demo' || !ck) {
    const items = demoItems.map(it => {
      const list = demoLists.find(l => l.id === it.listId);
      return publicItem({ ...it, listName: list ? list.name : '', listColor: list ? list.color : '' });
    });
    return {
      mode: 'demo', lists: demoLists, items, lastSync: Date.now(), lastError: null,
      appleId: '', serverTime: Date.now(),
      hint: '尚未登录 iCloud。双击项目目录下的 login-icloud.bat 完成登录后即可同步。',
    };
  }

  // 10 秒内重复刷新直接复用，CloudKit 对频繁 lookup 会限流
  if (lastSnapshot && Date.now() - lastFetchAt < 10000 && !forceFresh) return lastSnapshot;

  if (!inflight) {
    const p = fetchLive();
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
  }

  // 刚写完必须等新数据，不能拿写之前的快照糊弄
  if (forceFresh) {
    forceFresh = false;
    return inflight;
  }
  // 有旧数据就先给界面，后台慢慢刷（限流时可能要十几秒，界面不该干等）
  if (lastSnapshot) {
    inflight.catch(() => { /* 失败时旧数据继续用 */ });
    return { ...lastSnapshot, stale: true, refreshing: true, serverTime: Date.now() };
  }
  return inflight;
}

/* ---------------- 核心：写入 ---------------- */
function normPriority(p) {
  const n = Number(p);
  return [0, 1, 5, 9].includes(n) ? n : 0;
}

function normOffset(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

async function handleOp(body) {
  const op = body.op;

  if (mode === 'demo' || !ck) {
    if (op === 'add') {
      if (!body.summary || !body.summary.trim()) throw new Error('提醒内容不能为空');
      demoItems.push({
        uid: 'demo-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
        listId: body.listId || demoLists[0].id,
        summary: body.summary.trim(),
        notes: body.notes || '',
        due: body.due || null,
        allDay: !!body.allDay,
        priority: normPriority(body.priority),
        flagged: !!body.flagged,
        alarmOffset: normOffset(body.offsetMinutes),
        status: 'NEEDS-ACTION', completed: null,
      });
      return { ok: true };
    }
    const it = demoItems.find(x => x.uid === body.uid);
    if (!it) throw new Error('未找到该提醒');
    if (op === 'complete') { it.status = 'COMPLETED'; it.completed = Date.now(); }
    else if (op === 'uncomplete') { it.status = 'NEEDS-ACTION'; it.completed = null; }
    else if (op === 'rename') {
      if (!body.summary || !body.summary.trim()) throw new Error('提醒内容不能为空');
      it.summary = body.summary.trim();
    }
    else if (op === 'update') {
      if (body.summary !== undefined) {
        const t = String(body.summary).trim();
        if (!t) throw new Error('提醒内容不能为空');
        it.summary = t;
      }
      if (body.notes !== undefined) it.notes = String(body.notes);
      if (body.due !== undefined) it.due = body.due || null;
      if (body.allDay !== undefined) it.allDay = !!body.allDay;
      if (body.offsetMinutes !== undefined) it.alarmOffset = normOffset(body.offsetMinutes);
      if (body.priority !== undefined) it.priority = normPriority(body.priority);
      if (body.flagged !== undefined) it.flagged = !!body.flagged;
    }
    else if (op === 'delete') { demoItems = demoItems.filter(x => x.uid !== body.uid); }
    else throw new Error('未知操作');
    return { ok: true };
  }

  if (op === 'add') {
    if (!body.summary || !body.summary.trim()) throw new Error('提醒内容不能为空');
    const list = listCache.find(l => l.recordName === body.listId) || listCache[0];
    if (!list) throw new Error('没有可用的提醒列表');
    await ck.createReminder(list, body.summary.trim(), {
      dueMs: body.due || null,
      allDay: !!body.allDay,
      priority: normPriority(body.priority),
      flagged: !!body.flagged,
      notes: body.notes || '',
      offsetMinutes: body.due ? normOffset(body.offsetMinutes) : null,
    });
  } else {
    const it = cache.get(body.uid);
    if (!it) throw new Error('本地缓存中没有该提醒，请刷新后重试');
    const rec = it.record;

    if (op === 'complete') await ck.setCompleted(rec, true);
    else if (op === 'uncomplete') await ck.setCompleted(rec, false);
    else if (op === 'rename') {
      const title = String(body.summary || '').trim();
      if (!title) throw new Error('提醒内容不能为空');
      await ck.setTitle(rec, title);
      it.summary = title;
    }
    else if (op === 'delete') await ck.removeReminder(it);
    else if (op === 'update') {
      // 顺序很重要：先写标题/备注，再写日期，最后写提醒（提醒依赖日期）
      if (body.summary !== undefined) {
        const title = String(body.summary).trim();
        if (!title) throw new Error('提醒内容不能为空');
        await ck.setTitle(rec, title);
        it.summary = title;
      }
      if (body.notes !== undefined) {
        await ck.setNotes(rec, body.notes);
        it.notes = String(body.notes);
      }
      if (body.priority !== undefined) {
        await ck.setPriority(rec, normPriority(body.priority));
        it.priority = normPriority(body.priority);
      }
      if (body.flagged !== undefined) {
        await ck.setFlagged(rec, !!body.flagged);
        it.flagged = !!body.flagged;
      }

      const dueChanged = body.due !== undefined;
      const offsetChanged = body.offsetMinutes !== undefined;
      const dueMs = dueChanged ? (body.due || null) : it.due;
      if (dueChanged || offsetChanged) {
        const allDayVal = body.allDay !== undefined ? !!body.allDay : !!it.allDay;
        const offset = offsetChanged ? normOffset(body.offsetMinutes) : normOffset(it.alarmOffset);
        // 日期与提醒必须一起提交，否则 iOS 会在改日期时把提醒清掉
        await ck.setDueAndAlarm(rec, dueMs, allDayVal, dueMs ? offset : null);
        it.due = dueMs;
        it.allDay = allDayVal;
        it.alarmOffset = dueMs ? offset : null;
      }
    }
    else throw new Error('未知操作');
  }

  lastSync = Date.now();
  return { ok: true };
}

/* ---------------- Bark 推送 ---------------- */
let pushedKeys = loadPushed();

function loadPushed() {
  try {
    const j = JSON.parse(fs.readFileSync(PUSHED_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function savePushed() {
  pushedKeys = pushedKeys.slice(-400);
  try { fs.writeFileSync(PUSHED_FILE, JSON.stringify(pushedKeys), 'utf8'); } catch { /* ignore */ }
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 一条提醒应该在什么时刻推送：优先用「提前提醒」，否则到期时推 */
function remindAtOf(it) {
  if (!it.due) return null;
  if (it.alarmOffset !== null && it.alarmOffset !== undefined) return it.due - it.alarmOffset * 60000;
  return it.due;
}

async function checkAndPush() {
  const cfg = settingsStore.load();
  const b = cfg.bark;
  if (!b.enabled || !b.key) return;
  if (mode === 'demo') return;

  const now = Date.now();
  let data;
  try { data = await getRemindersData(); } catch { return; }

  for (const it of data.items) {
    if (it.completed || it.system || !it.due) continue;
    const at = remindAtOf(it);
    if (!at) continue;
    // 只在「刚刚到点」的 10 分钟窗口内推送，避免重启后把历史提醒全推一遍
    if (now < at || now - at > 10 * 60000) continue;
    // 没有单独提醒时间、且用户关闭了「到期也推」
    if ((it.alarmOffset === null || it.alarmOffset === undefined) && !b.notifyOnDue) continue;

    const key = it.uid + '|' + at;
    if (pushedKeys.includes(key)) continue;

    const when = it.alarmOffset ? `${fmtTime(it.due)} 到期` : fmtTime(it.due);
    const bodyText = it.notes ? String(it.notes).split('\n')[0].slice(0, 80) : when;
    try {
      await bark.send(b, it.listName || '提醒事项', `${it.summary}\n${bodyText}`);
      pushedKeys.push(key);
      savePushed();
      console.log(`[bark] 已推送：${it.summary}（${when}）`);
    } catch (e) {
      console.error('[bark] 推送失败：' + e.message);
    }
  }
}

/* ---------------- HTTP ---------------- */
function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'GET' && p === '/api/reminders') {
        const data = await getRemindersData();
        return sendJSON(res, 200, data);
      }
      if (req.method === 'POST' && p === '/api/ops') {
        const body = await readBody(req);
        reloadSessionIfChanged(false);   // 写之前也对齐一次会话，避免拿着已作废的令牌去写
        const r = await handleOp(body);
        // 写完立刻让下一次读取去拿真实数据（不要写之前的快照）
        lastFetchAt = 0;
        inflight = null;
        forceFresh = true;
        return sendJSON(res, 200, { ok: true, ...r });
      }
      if (req.method === 'GET' && p === '/api/settings') {
        const s = settingsStore.load();
        return sendJSON(res, 200, { ...s, version: APP_VERSION, versionTag: APP_TAG, name: APP_NAME, file: settingsStore.FILE });
      }
      if (req.method === 'POST' && p === '/api/settings') {
        const patch = await readBody(req);
        const next = settingsStore.save(patch);
        return sendJSON(res, 200, { ok: true, ...next });
      }
      if (req.method === 'POST' && p === '/api/bark/test') {
        const cfg = settingsStore.load();
        const r = await bark.send(cfg.bark, '提醒事项 · 连接测试', '如果你收到这条，说明 Bark 推送已经配置好了。');
        return sendJSON(res, 200, { ok: true, url: r.url });
      }
      // 启动浏览器登录，由用户在弹出的窗口里完成
      if (req.method === 'POST' && p === '/api/login') {
        spawn(process.execPath, [path.join(ROOT, 'tools', 'browser-login.js')], {
          detached: true, stdio: 'ignore', cwd: ROOT,
        }).unref();
        return sendJSON(res, 200, { ok: true, message: '已打开浏览器，请完成登录后本窗口会自动同步' });
      }
      // 重新读取会话文件（登录完成后由前端触发）
      if (req.method === 'POST' && p === '/api/reload-session') {
        const s = loadSession();
        if (!s || !s.dsid) throw new Error('尚未找到会话文件，请先完成登录');
        session = s;
        ck = new CloudKitClient(s);
        sessionMtime = statSessionMtime();   // 记住这一版，免得下一轮又白重载一次
        mode = 'live';
        cache = new Map();
        listCache = [];
        lastSnapshot = null;
        lastFetchAt = 0;
        lastError = null;
        return sendJSON(res, 200, { ok: true, appleId: maskId(s.appleId || ''), host: s.host });
      }
      if (req.method === 'GET' && p === '/api/session') {
        const s = loadSession();
        return sendJSON(res, 200, {
          loggedIn: !!s,
          appleId: s ? maskId(s.appleId || '') : '',
          host: s ? s.host : '',
          createdAt: s ? s.createdAt : null,
          sessionFile: SESSION_FILE,
        });
      }
      if (req.method === 'POST' && p === '/api/disconnect') {
        try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
        session = null; ck = null; mode = 'demo';
        cache = new Map(); listCache = []; lastSync = null; lastError = null;
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/diagnose') {
        const report = { ok: false, sessionFile: SESSION_FILE, exists: fs.existsSync(SESSION_FILE) };
        try {
          const s = loadSession();
          if (!s) throw new Error('没有会话文件，请先登录');
          const c = new CloudKitClient(s);
          const lists = await c.queryLists();
          report.ok = true;
          report.dsid = s.dsid;
          report.host = s.host;
          report.cloudkit = c.ckBase;
          report.lists = lists.map(l => ({ name: l.name, count: l.count, ids: l.reminderIds.length, color: l.color }));
        } catch (e) {
          report.error = isAuthError(e)
            ? e.message + '｜这表示 iCloud 已作废这次登录，不是网络问题；重新登录后会自动接上'
            : e.message;
        }
        return sendJSON(res, 200, report);
      }
      return sendJSON(res, 404, { error: '接口不存在' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return serveStatic(req, res, p);
  } catch (e) {
    const payload = { error: e.message || '服务器内部错误' };
    return sendJSON(res, 400, payload);
  }
});

server.listen(PORT, HOST, () => {
  console.log('[ios-reminders-widget] http://' + HOST + ':' + PORT + '  模式: ' + (mode === 'live' ? 'iCloud CloudKit 同步' : '演示模式'));
});

/* 每 60 秒检查一次是否该推送 */
setInterval(() => { checkAndPush().catch(() => { /* 静默 */ }); }, 60000);
setTimeout(() => { checkAndPush().catch(() => { /* 静默 */ }); }, 8000);
