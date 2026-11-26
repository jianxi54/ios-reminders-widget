/* 用无头浏览器测量真实渲染布局，替代截图 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9444;
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

async function waitEndpoint() {
  for (let i = 0; i < 60; i++) {
    try { return await getJSON(`http://127.0.0.1:${PORT}/json/list`); } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  throw new Error('调试端口未就绪');
}

(async () => {
  const browser = CANDIDATES.find(p => fs.existsSync(p));
  if (!browser) throw new Error('找不到 Chrome / Edge');

  const profile = path.join(os.tmpdir(), 'wk-layout-check-' + Date.now());
  const child = spawn(browser, [
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--headless=new',
    '--window-size=420,400',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    'http://127.0.0.1:8642/',
  ], { stdio: 'ignore' });

  let ws;
  try {
    const list = await waitEndpoint();
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('没有页面目标');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

    const cmd = (method, params = {}) => new Promise(res => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

    const evalJS = async (expr) => {
      const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result.result.value;
    };

    for (let i = 0; i < 40; i++) {
      const n = await evalJS("document.querySelectorAll('.row').length");
      if (n > 0) break;
      await new Promise(r => setTimeout(r, 400));
    }

    const layout = await evalJS(`(() => {
      const px = s => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().height) : null; };
      const rows = [...document.querySelectorAll('.row:not(.add)')];
      const add = document.querySelector('.row.add');
      const cnt = getComputedStyle(document.getElementById('count'));
      const nam = getComputedStyle(document.getElementById('viewTitle'));
      const fab = document.querySelector('.fab:not(.hidden)');
      return {
        viewport: [innerWidth, innerHeight],
        heroH: px('#hero'),
        listH: px('#list'),
        listRatio: Math.round((document.getElementById('list').getBoundingClientRect().height / innerHeight) * 100),
        countFont: cnt.fontSize, countWeight: cnt.fontWeight, countColor: cnt.color,
        nameFont: nam.fontSize, nameColor: nam.color,
        ratio: (parseFloat(cnt.fontSize) / parseFloat(nam.fontSize)).toFixed(2),
        fabSize: fab ? Math.round(fab.getBoundingClientRect().width) : null,
        rowCount: rows.length,
        rowH: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : null,
        rowTexts: rows.map(r => r.querySelector('.t1').textContent),
        flaggedRows: rows.filter(r => r.classList.contains('flagged')).map(r => r.querySelector('.t1').textContent),
        prios: rows.map(r => ({ t: r.querySelector('.t1').textContent, mark: r.querySelector('.prio').textContent })),
        flagVisible: rows.filter(r => r.classList.contains('flagged')).map(r => getComputedStyle(r.querySelector('.flag')).display),
        hasAddRow: !!add,
        addRowIsLast: add === document.getElementById('list').lastElementChild,
        addBtnGone: !document.getElementById('btnAdd'),
        footerEls: [...document.querySelectorAll('footer, .footer, .hint, .statusbar')].length,
        bodyText: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 200),
      };
    })()`);

    console.log('=== 布局 ===');
    console.log(JSON.stringify(layout, null, 1));

    // 刷新是否重画
    const scrollTest = await evalJS(`(async () => {
      const el = document.getElementById('list');
      el.scrollTop = el.scrollHeight;
      const before = el.scrollTop;
      const prevRows = [...document.querySelectorAll('.row')].map(r => r.dataset.uid || 'add');
      await load(false);
      const after = el.scrollTop;
      const nextRows = [...document.querySelectorAll('.row')].map(r => r.dataset.uid || 'add');
      return { scrollBefore: before, scrollAfter: after,
               keptScroll: Math.abs(before - after) < 2,
               sameRows: JSON.stringify(prevRows) === JSON.stringify(nextRows) };
    })()`);
    console.log('\n=== 刷新无抖动 ===');
    console.log(JSON.stringify(scrollTest, null, 1));

    // 行内编辑 + 新建入口存在性（只验证 DOM 行为，不改数据）
    const editTest = await evalJS(`(async () => {
      const row = document.querySelector('.row:not(.add)');
      row.querySelector('.t1').click();
      await new Promise(r => setTimeout(r, 200));
      const input = row.querySelector('input.edit');
      const focused = document.activeElement === input;
      const val = input ? input.value : null;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      return { inputOpened: !!input, focused, val, closedAfterEsc: !row.querySelector('input.edit') };
    })()`);
    console.log('\n=== 行内编辑 ===');
    console.log(JSON.stringify(editTest, null, 1));

    const addTest = await evalJS(`(async () => {
      document.querySelector('.row.add').click();
      await new Promise(r => setTimeout(r, 200));
      const input = document.querySelector('.row.add input');
      const focused = document.activeElement === input;
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      return { opened: !!input, focused, closed: !document.querySelector('.row.add input') };
    })()`);
    console.log('\n=== 空白行新建 ===');
    console.log(JSON.stringify(addTest, null, 1));

    const doneView = await evalJS(`(async () => {
      document.getElementById('btnDone').click();
      await new Promise(r => setTimeout(r, 500));
      const rows = document.querySelectorAll('.row:not(.add)');
      const r = { title: document.getElementById('viewTitle').textContent,
                  count: document.getElementById('count').textContent,
                  rows: rows.length,
                  addRowHidden: document.querySelector('.row.add').classList.contains('hidden'),
                  backVisible: !document.getElementById('btnBack').classList.contains('hidden') };
      document.getElementById('btnBack').click();
      await new Promise(r2 => setTimeout(r2, 400));
      return r;
    })()`);
    console.log('\n=== 已完成视图 ===');
    console.log(JSON.stringify(doneView, null, 1));
  } finally {
    try { ws && ws.close(); } catch { }
    try { child.kill(); } catch { }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }, 1500);
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
