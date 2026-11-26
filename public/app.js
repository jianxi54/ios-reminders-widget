'use strict';
/* iOS 提醒事项 · 桌面小组件 — 前端
 *
 * 渲染策略（解决刷新闪动）：
 *   1. 只为「新增/消失/改写」的行做 DOM 变更，已有行原地更新文本，从不整体重画
 *   2. 数据签名不变时直接跳过重绘（20 秒轮询多数情况下什么都不会发生）
 *   3. 勾选完成时先按 iOS 的方式把行"收起"，再请求服务端
 *
 * 交互：
 *   点条目标题 = 行内改名
 *   点条目其余位置 = 打开详情（备注 / 日期 / 提前提醒 / 优先级 / 旗标 / 删除）
 *   点列表末尾的空白行 = 新建
 */

const $ = s => document.querySelector(s);
const listEl = $('#list');

const HOSTED = !!(window.chrome && window.chrome.webview);
const THEME_KEY = 'rw.theme';
const themeOf = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

let state = { mode: 'demo', lists: [], items: [], appleId: '', lastSync: null };

let view = 'open';       // open | done
let sig = '';            // 当前渲染的数据签名
const rows = new Map();  // uid -> 行元素
let loading = false;
let busy = 0;            // 正在执行写操作，期间暂停自动刷新
let editingUid = null;   // 正在行内编辑的条目
let adding = false;      // 正在新建
let addRow = null;       // 列表末尾的空白行
let sheetUid = null;     // 详情面板中的条目
let alarmPresets = [0, 5, 15, 30, 60, 120, 1440, 2880, 10080];

/* ---------------- 宿主通信 ---------------- */
function postToHost(msg) {
  if (HOSTED) {
    try { window.chrome.webview.postMessage(msg); } catch { /* ignore */ }
  }
}

window.setPinned = (v) => {
  const btn = $('#btnPin');
  btn.classList.toggle('pinned', !!v);
  btn.title = v ? '取消固定（可再次拖动）' : '固定到桌面（固定后窗口拖不动）';
  // 固定 = 锁定位置，头部不再显示可拖动光标，也不发拖动消息
  $('#hero').classList.toggle('dragable', !v);
};

/* ---------------- 工具 ---------------- */
const p2 = n => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function api(path, opts = {}) {
  return fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts })
    .then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

function dayStart(offset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}

const isDone = it => it.status === 'COMPLETED' || !!it.completed;

/** 到期时间 → { text, cls }，和 iOS 一样：今天 / 明天 / 周三 / 10/28 + 时间 */
function fmtDue(it) {
  if (!it.due) return null;
  const d = new Date(it.due);
  const t = it.allDay ? '' : ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  const md = (d.getMonth() + 1) + '/' + d.getDate();
  const today = dayStart(0);

  if (it.due < today) return { text: (it.allDay ? md : md + t) + '', cls: ' overdue' };
  if (it.due < dayStart(1)) return { text: '今天' + t, cls: ' today' };
  if (it.due < dayStart(2)) return { text: '明天' + t, cls: ' soon' };
  if (it.due < dayStart(7)) return { text: WEEK[d.getDay()] + t, cls: '' };
  return { text: md + t, cls: '' };
}

function hexA(hex, a) {
  const h = String(hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h.padEnd(6, '0');
  const r = parseInt(n.slice(0, 2), 16) || 0;
  const g = parseInt(n.slice(2, 4), 16) || 0;
  const b = parseInt(n.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

function currentItems() {
  const items = state.items.filter(i => !i.system);
  if (view === 'done') {
    return items.filter(isDone).sort((a, b) => (b.completed || 0) - (a.completed || 0));
  }
  return items.filter(i => !isDone(i)).sort((a, b) => {
    const ad = a.due ?? Infinity, bd = b.due ?? Infinity;
    if (ad !== bd) return ad - bd;
    return (a.created || 0) - (b.created || 0);
  });
}

/* ---------------- 绘制 ---------------- */
function setCount(n, animate) {
  const el = $('#count');
  if (el.textContent !== String(n)) {
    el.textContent = String(n);
    if (animate) {
      el.classList.add('pop');
      setTimeout(() => el.classList.remove('pop'), 190);
    }
  }
}

/** 颜色混合：k<0 变深、k>0 变浅（0~1） */
function shade(hex, k) {
  const h = String(hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h.padEnd(6, '0');
  const t = k < 0 ? 0 : 255;
  const p = Math.abs(k);
  return '#' + [0, 2, 4].map(i => {
    const v = parseInt(n.slice(i, i + 2), 16) || 0;
    return p2(Math.round(v * (1 - p) + t * p).toString(16));
  }).join('');
}

function applyAccent() {
  const c = (state.lists[0] && state.lists[0].color) || '#cc73e1';
  const light = themeOf() === 'light';
  document.documentElement.style.setProperty('--accent', c);
  // 亮色底上把列表色压深一点，否则浅紫/浅黄看不清
  document.documentElement.style.setProperty('--accent-ink', light ? shade(c, -0.3) : c);
  document.documentElement.style.setProperty('--accent-soft', hexA(c, light ? .12 : .16));
}

/** 切换明暗：改 html[data-theme] + 记住选择 + 通知宿主换窗口底色 */
function applyTheme(t, persist, notify) {
  const v = t === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', v);
  try { localStorage.setItem(THEME_KEY, v); } catch { /* ignore */ }
  const seg = $('#fTheme');
  if (seg) for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.t === v);
  applyAccent();
  // 启动时不必通知：宿主本来就知道主题（它会先按设置定好窗口底色）
  if (notify) postToHost({ type: 'theme', value: v });
  if (persist) {
    api('/settings', { method: 'POST', body: JSON.stringify({ ui: { theme: v } }) }).catch(() => { /* 本地已记住 */ });
  }
}

/** 服务端记录的才是「跨重新登录」的真相，启动时对齐一次 */
async function syncThemeFromServer() {
  try {
    const s = await api('/settings');
    const t = (s.ui && s.ui.theme) || 'dark';
    if (t !== themeOf()) applyTheme(t, false, true);
    // 版本号（服务端 lib/version.js 是唯一来源）
    const ver = $('#appVer');
    if (ver && s.versionTag) ver.textContent = s.versionTag;
  } catch { /* 用本地缓存 */ }
}

function paint(force) {
  const items = currentItems();

  $('#viewTitle').textContent = view === 'open' ? (state.lists[0] && state.lists[0].name) || '提醒事项' : '已完成';
  $('#btnDone').classList.toggle('hidden', view !== 'open');
  $('#btnBack').classList.toggle('hidden', view === 'open');
  setCount(items.length, true);

  const s = view + '|' + items.map(i => [
    i.uid, i.summary, i.due || 0, i.status, i.flagged ? 1 : 0, i.priority || 0,
    i.listColor, i.allDay ? 1 : 0, i.alarmOffset ?? '', (i.notes || '').length,
  ].join('~')).join('|');
  if (!force && s === sig) return;
  sig = s;

  reconcile(items);
}

/** 关键：增量对账，只动变化的行 */
function reconcile(items) {
  const wanted = new Set(items.map(i => i.uid));

  for (const [uid, el] of [...rows]) {
    if (!wanted.has(uid)) leave(uid, el);
  }

  let cursor = listEl.firstElementChild;
  const nextLive = () => {
    while (cursor && (cursor.classList.contains('leaving') || cursor === addRow)) cursor = cursor.nextElementSibling;
    const n = cursor;
    if (cursor) cursor = cursor.nextElementSibling;
    return n;
  };

  for (const it of items) {
    let el = rows.get(it.uid);
    if (!el) {
      el = createRow(it);
      rows.set(it.uid, el);
      el.classList.add('enter');
      setTimeout(() => el.classList.remove('enter'), 260);
    } else {
      updateRow(el, it);
    }
    const ref = nextLive();
    if (ref !== el) listEl.insertBefore(el, ref || null);
  }

  // 末尾始终留一行空白行（点它新建）；已完成视图不需要
  if (!addRow) buildAddRow();
  addRow.classList.toggle('hidden', view !== 'open');
  if (view === 'open' && (addRow.parentNode !== listEl || listEl.lastElementChild !== addRow)) {
    listEl.appendChild(addRow);
  }
}

function leave(uid, el) {
  rows.delete(uid);
  if (editingUid === uid) editingUid = null;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 210);
}

function createRow(it) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.uid = it.uid;
  el.innerHTML =
    '<button class="check" tabindex="-1" aria-label="切换完成状态">' +
      '<svg viewBox="0 0 16 16"><path d="M3.2 8.7l3 3L12.8 5"/></svg>' +
    '</button>' +
    '<div class="body">' +
      '<div class="line1">' +
        '<span class="prio" aria-hidden="true"></span>' +
        '<span class="t1"></span>' +
        '<span class="flag" title="已加旗标">' +
          '<svg viewBox="0 0 24 24"><path d="M6 2.6c0-.5.4-.9.9-.9s.9.4.9.9v18.8a.9.9 0 0 1-1.8 0V2.6zm2.4 1h9.9c.6 0 .9.7.6 1.1l-1.9 3.4 1.9 3.4c.3.5-.1 1.1-.6 1.1H8.4V3.6z"/></svg>' +
        '</span>' +
      '</div>' +
      '<div class="notes-line"></div>' +
    '</div>' +
    '<span class="due"></span>';
  updateRow(el, it);
  return el;
}

function updateRow(el, it) {
  const done = isDone(it);
  el.classList.toggle('done', done);
  el.classList.toggle('flagged', !!it.flagged);
  el.style.setProperty('--row-accent', it.listColor || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());

  const t = el.querySelector('.t1');
  if (t.textContent !== it.summary) t.textContent = it.summary;

  // 备注（富文本正文）：行内最多两行，点开可看全文
  const notes = (it.notes || '').trim();
  const nl = el.querySelector('.notes-line');
  const firstLine = notes ? notes.split('\n').filter(x => x.trim())[0] || '' : '';
  if (nl.textContent !== firstLine) nl.textContent = firstLine;
  nl.classList.toggle('hidden', !firstLine);
  el.classList.toggle('has-notes', !!firstLine);
  el.title = notes || it.summary;

  // 优先级：与 iOS 一致，1=高(!!!) 5=中(!!) 9=低(!)，显示在标题文字之前
  const p = it.priority || 0;
  const prioEl = el.querySelector('.prio');
  const marks = p === 1 ? '!!!' : p === 5 ? '!!' : p === 9 ? '!' : '';
  if (prioEl.textContent !== marks) prioEl.textContent = marks;
  prioEl.classList.toggle('on', !!marks);
  prioEl.style.color = p === 1 ? 'var(--danger)' : p === 5 ? 'var(--flag)' : 'var(--text-2)';

  // 日期：已完成也显示（灰色），这样"哪天做完的/原本哪天到期"一眼能看到
  const dueEl = el.querySelector('.due');
  const info = fmtDue(it);
  const text = info ? info.text : '';
  const cls = 'due' + (info ? info.cls : '') + (done ? ' dim' : '');
  if (dueEl.textContent !== text) dueEl.textContent = text;
  if (dueEl.className !== cls) dueEl.className = cls;
}

/* ---------------- 行内编辑（改名） ---------------- */
function startEdit(uid) {
  const it = state.items.find(i => i.uid === uid);
  const el = rows.get(uid);
  if (!it || !el || editingUid || el.classList.contains('editing')) return;

  editingUid = uid;
  const t = el.querySelector('.t1');
  const input = document.createElement('input');
  input.className = 'edit';
  input.type = 'text';
  input.maxLength = 200;
  input.value = it.summary;
  el.classList.add('editing');
  t.parentNode.insertBefore(input, t.nextSibling);
  t.style.display = 'none';
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const val = input.value.trim();
    input.remove();
    t.style.display = '';
    el.classList.remove('editing');
    editingUid = null;

    if (!save) return;
    if (!val) { toast('内容不能为空'); return; }
    if (val === it.summary) return;

    const old = it.summary;
    it.summary = val;
    t.textContent = val;
    sig = '';
    busy++;
    try {
      await api('/ops', { method: 'POST', body: JSON.stringify({ op: 'rename', uid, summary: val }) });
    } catch (e) {
      it.summary = old;
      t.textContent = old;
      sig = '';
      toast('修改失败：' + e.message);
    } finally {
      busy--;
      await load(false);
    }
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------------- 新建（点末尾空白行） ---------------- */
function buildAddRow() {
  addRow = document.createElement('div');
  addRow.className = 'row add';
  addRow.title = '点击新建提醒事项';
  addRow.innerHTML = '<span class="check ghost" aria-hidden="true"></span>';
  addRow.addEventListener('click', startAdd);
}

function startAdd(e) {
  if (e) e.stopPropagation();
  if (adding || view !== 'open') return;
  adding = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '新建提醒事项';
  input.maxLength = 200;
  addRow.appendChild(input);
  addRow.classList.add('editing');   // 进入编辑才显示圆圈
  input.focus();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const val = input.value.trim();
    input.remove();
    adding = false;
    addRow.classList.remove('editing');
    if (!save || !val) return;
    busy++;
    try {
      const listId = (state.lists[0] && state.lists[0].id) || '';
      await api('/ops', { method: 'POST', body: JSON.stringify({ op: 'add', summary: val, listId }) });
    } catch (err) {
      toast('添加失败：' + err.message);
    } finally {
      busy--;
      await load(false);
    }
  };

  input.addEventListener('keydown', e2 => {
    if (e2.key === 'Enter') { e2.preventDefault(); finish(true); }
    else if (e2.key === 'Escape') { e2.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------------- 自定义下拉 ----------------
 * 原生 <select> 的弹出层由系统绘制，深色主题下会出现白底白字（看不清）。
 * 这里保留原生 select 负责取值/disabled，只把它藏起来，用一个自绘菜单代替。
 */
const selCtl = new WeakMap();
let openSel = null;

function closeSel() {
  if (!openSel) return;
  openSel.menu.classList.add('hidden');
  openSel.wrap.classList.remove('open');
  openSel = null;
}

function enhanceSelect(native) {
  const wrap = document.createElement('div');
  wrap.className = 'sel';
  native.parentNode.insertBefore(wrap, native);
  wrap.appendChild(native);
  native.classList.add('sel-native');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'field sel-btn';
  btn.innerHTML =
    '<span class="sel-label"></span>' +
    '<svg class="caret" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';
  const menu = document.createElement('div');
  menu.className = 'sel-menu hidden';
  wrap.appendChild(btn);
  document.body.appendChild(menu);

  const ctl = {
    wrap, btn, menu, native,
    sync() {
      const opt = native.options[native.selectedIndex];
      btn.querySelector('.sel-label').textContent = opt ? opt.textContent : '';
      btn.disabled = native.disabled || native.options.length === 0;
      for (const el of menu.querySelectorAll('.sel-opt')) el.classList.toggle('on', el.dataset.v === native.value);
    },
    build() {
      menu.innerHTML = '';
      for (const o of native.options) {
        const d = document.createElement('div');
        d.className = 'sel-opt';
        d.dataset.v = o.value;
        d.innerHTML =
          '<svg class="tick" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.4l2.6 2.6L10 3.4"/></svg>' +
          '<span></span>';
        d.querySelector('span').textContent = o.textContent;
        d.addEventListener('click', () => {
          if (native.value !== o.value) {
            native.value = o.value;
            native.dispatchEvent(new Event('change', { bubbles: true }));
          }
          ctl.sync();
          closeSel();
        });
        menu.appendChild(d);
      }
      ctl.sync();
    },
    open() {
      if (native.disabled || !native.options.length) return;
      ctl.build();
      menu.classList.remove('hidden');
      wrap.classList.add('open');
      const r = btn.getBoundingClientRect();
      const vh = window.innerHeight;
      menu.style.minWidth = Math.round(r.width) + 'px';
      menu.style.left = Math.max(6, Math.min(Math.round(r.left), window.innerWidth - Math.round(r.width) - 6)) + 'px';
      const need = menu.scrollHeight;
      let top = r.bottom + 3;
      if (top + need > vh - 6) top = Math.max(6, Math.round(r.top) - Math.min(need, 216) - 3);
      menu.style.top = Math.round(top) + 'px';
      menu.style.maxHeight = Math.min(216, vh - top - 8) + 'px';
      openSel = ctl;
      const on = menu.querySelector('.sel-opt.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (openSel === ctl) closeSel();
    else { closeSel(); ctl.open(); }
  });
  // 原生 select 被系统/键盘改动时同步显示
  native.addEventListener('change', () => ctl.sync());

  selCtl.set(native, ctl);
  ctl.sync();
  return ctl;
}

/** 值或 disabled 发生变化后刷新显示（原生控件本身已是最新值） */
function syncSel(el) {
  const c = selCtl.get(el);
  if (c) c.sync();
}

document.addEventListener('mousedown', e => {
  if (openSel && !openSel.wrap.contains(e.target) && !openSel.menu.contains(e.target)) closeSel();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !openSel) return;
  e.stopPropagation(); // 只收起下拉，不要顺手把详情面板也关了
  closeSel();
}, true);
window.addEventListener('resize', closeSel);
document.addEventListener('scroll', e => {
  if (openSel && !openSel.menu.contains(e.target)) closeSel();
}, true);

/* ---------------- 详情面板 ---------------- */
const ALARM_LABEL = m => {
  if (m === 0) return '准时提醒';
  if (m < 60) return `提前 ${m} 分钟`;
  if (m === 60) return '提前 1 小时';
  if (m < 1440) return `提前 ${Number((m / 60).toFixed(1))} 小时`;
  if (m === 1440) return '提前 1 天';
  if (m === 2880) return '提前 2 天';
  if (m === 10080) return '提前 1 周';
  return `提前 ${Number((m / 1440).toFixed(1))} 天`;
};

function buildAlarmOptions() {
  const sel = $('#fAlarm');
  const opts = [['', '无']];
  for (const m of alarmPresets) opts.push([String(m), ALARM_LABEL(m)]);
  opts.push(['custom', '自定义…']);
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  syncSel(sel);
}

function toDateInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function toTimeInput(ms) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function syncAlarmUi() {
  const hasDue = !!$('#fDate').value;
  const sel = $('#fAlarm');
  sel.disabled = !hasDue;
  $('#fTime').disabled = $('#fAllDay').checked;
  $('#alarmCustomWrap').classList.toggle('hidden', sel.value !== 'custom');
  const hint = $('#alarmHint');
  if (!hasDue) hint.textContent = '先选一个日期，才能设置提前提醒';
  else if (sel.value === '') hint.textContent = '不提醒（手机上也不会响）';
  else if (sel.value === 'custom') hint.textContent = '';
  else hint.textContent = ALARM_LABEL(Number(sel.value)) + ' · 手机上同一时刻弹出通知';
  syncSel(sel);
}

function openSheet(uid) {
  const it = state.items.find(i => i.uid === uid);
  if (!it) return;
  sheetUid = uid;

  $('#fTitle').value = it.summary === '(无标题)' ? '' : it.summary;
  $('#fNotes').value = it.notes || '';
  $('#fDate').value = it.due ? toDateInput(it.due) : '';
  $('#fTime').value = it.due && !it.allDay ? toTimeInput(it.due) : '';
  $('#fAllDay').checked = !!it.allDay;
  const off = it.alarmOffset;
  if (off === null || off === undefined) {
    $('#fAlarm').value = '';
    $('#fAlarmCustom').value = '';
  } else if (alarmPresets.includes(off)) {
    $('#fAlarm').value = String(off);
  } else {
    $('#fAlarm').value = 'custom';
    $('#fAlarmCustom').value = String(off);
  }
  setSheetPriority(it.priority || 0);
  $('#fFlagged').checked = !!it.flagged;
  syncAlarmUi();

  $('#sheetMask').classList.remove('hidden');
  $('#sheet').classList.remove('hidden');
  $('#sheet').classList.remove('pageIn');
  void $('#sheet').offsetWidth;
  $('#sheet').classList.add('pageIn');
}

function closeSheet() {
  sheetUid = null;
  $('#sheetMask').classList.add('hidden');
  $('#sheet').classList.add('hidden');
}

function setSheetPriority(p) {
  for (const b of $('#fPriority').querySelectorAll('button')) {
    b.classList.toggle('on', Number(b.dataset.p) === Number(p));
  }
}

function readSheetDue() {
  const v = $('#fDate').value;
  if (!v) return null;
  const [y, m, d] = v.split('-').map(Number);
  if ($('#fAllDay').checked || !$('#fTime').value) return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const [hh, mm] = $('#fTime').value.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

function readSheetOffset() {
  const sel = $('#fAlarm');
  if (sel.disabled || sel.value === '') return null;
  if (sel.value === 'custom') {
    const n = Number($('#fAlarmCustom').value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }
  return Number(sel.value);
}

async function saveSheet() {
  if (!sheetUid) return;
  const it = state.items.find(i => i.uid === sheetUid);
  if (!it) { closeSheet(); return; }

  const title = $('#fTitle').value.trim();
  if (!title) { toast('内容不能为空'); return; }

  const due = readSheetDue();
  const allDay = $('#fAllDay').checked;
  const offset = due ? readSheetOffset() : null;
  const priority = Number(($('#fPriority .on') || { dataset: { p: 0 } }).dataset.p || 0);
  const flagged = $('#fFlagged').checked;
  const notes = $('#fNotes').value.replace(/\r\n?/g, '\n');

  const patch = {};
  if (title !== it.summary) patch.summary = title;
  if (notes !== (it.notes || '')) patch.notes = notes;
  if (Math.abs((due || 0) - (it.due || 0)) > 1000 || (due && allDay !== !!it.allDay)) {
    patch.due = due;
    patch.allDay = allDay;
  }
  if ((offset ?? null) !== (it.alarmOffset ?? null)) patch.offsetMinutes = offset;
  if (priority !== (it.priority || 0)) patch.priority = priority;
  if (flagged !== !!it.flagged) patch.flagged = flagged;

  if (!Object.keys(patch).length) { closeSheet(); return; }

  const btn = $('#btnSheetSave');
  btn.disabled = true;
  busy++;
  try {
    await api('/ops', { method: 'POST', body: JSON.stringify({ op: 'update', uid: it.uid, ...patch }) });
    toast('已保存');
    closeSheet();
    await load(false);
  } catch (e) {
    toast('保存失败：' + e.message);
  } finally {
    btn.disabled = false;
    busy--;
  }
}

async function deleteFromSheet() {
  const it = state.items.find(i => i.uid === sheetUid);
  if (!it) return;
  const btn = $('#btnDelete');
  if (btn.dataset.arm !== '1') {
    btn.dataset.arm = '1';
    btn.textContent = '再点一次确认删除';
    setTimeout(() => { btn.dataset.arm = ''; btn.textContent = '删除提醒'; }, 3000);
    return;
  }
  btn.dataset.arm = '';
  btn.textContent = '删除提醒';
  busy++;
  try {
    await api('/ops', { method: 'POST', body: JSON.stringify({ op: 'delete', uid: it.uid }) });
    closeSheet();
    await load(false);
    toast('已删除');
  } catch (e) {
    toast('删除失败：' + e.message);
  } finally {
    busy--;
  }
}

/* ---------------- 加载 ---------------- */
async function load(spin) {
  if (loading) return;
  loading = true;
  if (spin) $('#btnRefresh').classList.add('spin');
  try {
    state = await api('/reminders');
    if (Array.isArray(state.alarmPresets) && state.alarmPresets.length) {
      alarmPresets = state.alarmPresets;
      buildAlarmOptions();
    }
    applyAccent();
    paint(false);
  } catch (e) {
    toast('同步失败：' + e.message);
  } finally {
    loading = false;
    if (spin) $('#btnRefresh').classList.remove('spin');
  }
}

function switchView(v) {
  if (view === v) return;
  view = v;
  sig = '';
  for (const [, el] of rows) el.remove();
  rows.clear();
  editingUid = null;
  paint(true);
  listEl.classList.remove('pageIn');
  void listEl.offsetWidth;
  listEl.classList.add('pageIn');
}

/* ---------------- 交互 ---------------- */
async function toggleDone(uid) {
  const item = state.items.find(i => i.uid === uid);
  if (!item) return;
  const toDone = !isDone(item);
  const el = rows.get(uid);
  if (el) leave(uid, el);

  item.status = toDone ? 'COMPLETED' : 'NEEDS-ACTION';
  item.completed = toDone ? Date.now() : null;
  sig = '';
  setCount(Math.max(0, currentItems().length), true);

  busy++;
  try {
    await api('/ops', { method: 'POST', body: JSON.stringify({ op: toDone ? 'complete' : 'uncomplete', uid }) });
    await load(false);
  } catch (e) {
    toast('操作失败：' + e.message);
    await load(false);
  } finally {
    busy--;
  }
}

listEl.addEventListener('click', e => {
  const row = e.target.closest('.row');
  if (!row || row.classList.contains('add')) return;
  const uid = row.dataset.uid;
  if (e.target.closest('.check')) toggleDone(uid);
  else if (e.target.closest('.t1')) startEdit(uid);
  else openSheet(uid);
});

$('#btnDone').onclick = () => switchView('done');
$('#btnBack').onclick = () => switchView('open');
$('#btnRefresh').onclick = () => load(true);

/* 详情面板事件 */
$('#btnSheetCancel').onclick = closeSheet;
$('#sheetMask').onclick = closeSheet;
$('#btnSheetSave').onclick = saveSheet;
$('#btnDelete').onclick = deleteFromSheet;
$('#fDate').addEventListener('change', syncAlarmUi);
$('#fAllDay').addEventListener('change', syncAlarmUi);
$('#fAlarm').addEventListener('change', syncAlarmUi);
$('#btnClearDue').addEventListener('click', () => {
  $('#fDate').value = '';
  $('#fTime').value = '';
  $('#fAlarm').value = '';
  syncAlarmUi();
});
$('#fPriority').addEventListener('click', e => {
  const b = e.target.closest('button[data-p]');
  if (b) setSheetPriority(Number(b.dataset.p));
});
$('#sheet').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveSheet(); }
});

/* 宿主按钮 */
if (HOSTED) {
  $('#btnPin').classList.remove('hidden');
  $('#btnHide').classList.remove('hidden');
  $('#btnPin').onclick = () => postToHost({ type: $('#btnPin').classList.contains('pinned') ? 'unpin' : 'pin' });
  $('#btnHide').onclick = () => postToHost({ type: 'hide' });
  $('#hero').classList.add('dragable');
  $('#hero').addEventListener('mousedown', e => {
    // 固定 = 锁定位置，此时拖不动
    if ($('#btnPin').classList.contains('pinned')) return;
    if (!e.target.closest('button, select, input, a')) postToHost({ type: 'drag' });
  });
}

/* ---------------- 设置抽屉 ---------------- */
async function refreshSessionInfo() {
  try {
    const s = await api('/session');
    $('#sessionState').textContent = s.loggedIn ? '已登录' : '未登录';
    $('#sessionState').className = s.loggedIn ? 'ok' : 'bad';
    $('#sessionAccount').textContent = s.appleId || '—';
    $('#sessionHost').textContent = s.host || '—';
  } catch {
    $('#sessionState').textContent = '无法读取';
    $('#sessionState').className = 'bad';
  }
}

async function loadBarkSettings() {
  try {
    const s = await api('/settings');
    const b = s.bark || {};
    $('#barkEnabled').checked = !!b.enabled;
    $('#barkServer').value = b.server || '';
    $('#barkKey').value = b.key || '';
    $('#barkGroup').value = b.group || '';
    $('#barkSound').value = b.sound || '';
    $('#barkLevel').value = b.level || 'active';
    $('#barkOnDue').checked = b.notifyOnDue !== false;
    syncSel($('#barkLevel'));
  } catch { /* 设置文件还不存在时忽略 */ }
}

function openDrawer() {
  $('#drawerMask').classList.remove('hidden');
  $('#drawer').classList.remove('hidden');
  $('#cfgError').classList.add('hidden');
  $('#btnDisconnect').classList.toggle('hidden', state.mode !== 'live');
  refreshSessionInfo();
  loadBarkSettings();
}
function closeDrawer() {
  $('#drawerMask').classList.add('hidden');
  $('#drawer').classList.add('hidden');
}
$('#btnSettings').onclick = openDrawer;
$('#btnCloseDrawer').onclick = closeDrawer;
$('#drawerMask').onclick = closeDrawer;

$('#fTheme').addEventListener('click', e => {
  const b = e.target.closest('button[data-t]');
  if (b) applyTheme(b.dataset.t, true, true);
});

function showCfgError(msg) {
  const box = $('#cfgError');
  box.textContent = msg;
  box.classList.remove('hidden');
}

$('#btnLogin').onclick = async () => {
  const btn = $('#btnLogin');
  btn.disabled = true;
  btn.textContent = '正在打开…';
  $('#cfgError').classList.add('hidden');
  try {
    await api('/login', { method: 'POST', body: '{}' });
    toast('已打开浏览器，请完成登录');
  } catch (e) {
    showCfgError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '打开浏览器登录';
  }
};

$('#btnReload').onclick = async () => {
  const btn = $('#btnReload');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const r = await api('/reload-session', { method: 'POST', body: '{}' });
    await refreshSessionInfo();
    await load(true);
    closeDrawer();
    toast('已连接 ' + (r.appleId || 'iCloud'));
  } catch (e) {
    showCfgError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

$('#btnDiagnose').onclick = async () => {
  const el = $('#diagOut');
  el.textContent = '正在检查…';
  el.classList.remove('hidden');
  try {
    const r = await api('/diagnose', { method: 'POST', body: '{}' });
    const lines = [r.ok ? '✅ CloudKit 连接正常' : '❌ ' + (r.error || '未知错误')];
    if (r.dsid) lines.push('dsid: ' + r.dsid);
    if (r.host) lines.push('区域: ' + r.host);
    if (r.cloudkit) lines.push('cloudkit: ' + r.cloudkit);
    if (r.lists) {
      lines.push('', '列表：');
      for (const l of r.lists) lines.push('  ' + l.name + '  ' + l.ids + ' 条  ' + (l.color || ''));
    }
    el.textContent = lines.join('\n');
  } catch (e) {
    el.textContent = '诊断失败：' + e.message;
  }
};

$('#btnDisconnect').onclick = async () => {
  try {
    await api('/disconnect', { method: 'POST', body: '{}' });
    await load(true);
    closeDrawer();
    toast('已断开连接');
  } catch (e) {
    toast(e.message);
  }
};

$('#btnBarkSave').onclick = async () => {
  const btn = $('#btnBarkSave');
  btn.disabled = true;
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        bark: {
          enabled: $('#barkEnabled').checked,
          server: $('#barkServer').value.trim() || 'https://api.day.app',
          key: $('#barkKey').value.trim(),
          group: $('#barkGroup').value.trim(),
          sound: $('#barkSound').value.trim(),
          level: $('#barkLevel').value,
          notifyOnDue: $('#barkOnDue').checked,
        },
      }),
    });
    toast('推送设置已保存');
  } catch (e) {
    showCfgError(e.message);
  } finally {
    btn.disabled = false;
  }
};

$('#btnBarkTest').onclick = async () => {
  const btn = $('#btnBarkTest');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    await $('#btnBarkSave').onclick();
    await api('/bark/test', { method: 'POST', body: '{}' });
    toast('测试推送已发出，看看手机');
  } catch (e) {
    showCfgError('推送失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

/* ---------------- 自动同步 ---------------- */
function canAutoRefresh() {
  return !document.hidden && !busy && !loading && !editingUid && !adding && !sheetUid;
}

setInterval(() => { if (canAutoRefresh()) load(false); }, 20000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && canAutoRefresh()) load(false);
});

window.addEventListener('focus', () => {
  if (canAutoRefresh()) load(false);
});

/* ---------------- 启动 ---------------- */
enhanceSelect($('#fAlarm'));
enhanceSelect($('#barkLevel'));
buildAlarmOptions();
applyTheme(themeOf(), false, false);  // 同步分段控件与强调色（宿主启动时已按设置定好底色）
load(true);
syncThemeFromServer();          // 服务端记录的主题优先
