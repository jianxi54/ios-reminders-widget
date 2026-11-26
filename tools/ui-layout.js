/* 版式体检：按真实的 420×400 小组件尺寸量所有关键元素 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9472;
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const browser = CANDIDATES.find(p => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'wk-lay-' + Date.now());
  const child = spawn(browser, [
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    'http://127.0.0.1:8642/',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let list;
    for (let i = 0; i < 60; i++) { try { list = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
    ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cmd = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
    const js = async expr => {
      const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error('JS: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
      return r.result.result.value;
    };

    await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 400, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 50; i++) { if ((await js('document.querySelectorAll(".row").length')) > 2) break; await new Promise(r => setTimeout(r, 400)); }

    const probe = `
      (() => {
        const R = document.querySelectorAll('.row:not(.add)');
        const dueRows = [];
        R.forEach(r => {
          const d = r.querySelector('.due');
          if (!d.textContent) return;
          const b = d.getBoundingClientRect();
          dueRows.push(r.querySelector('.t1').textContent.slice(0, 10) + ' = ' + d.textContent + ' @x' + Math.round(b.right) + '/' + innerWidth);
        });
        const bad = [];
        document.querySelectorAll('.row, #hero, #list, .line1, .body').forEach(e => {
          if (e.scrollWidth > e.clientWidth + 1) bad.push((e.className || e.id) + ' ' + e.scrollWidth + '>' + e.clientWidth);
        });
        return JSON.stringify({
          vw: innerWidth, vh: innerHeight,
          heroH: Math.round(document.getElementById('hero').getBoundingClientRect().height),
          rows: R.length,
          heights: [...R].slice(0, 5).map(r => Math.round(r.getBoundingClientRect().height)),
          notesRows: document.querySelectorAll('.row.has-notes').length,
          dueRows, bad,
          listScroll: document.getElementById('list').scrollHeight
        }, null, 1);
      })()
    `;
    console.log('=== 主列表 ===');
    console.log(await js(probe));

    console.log('\n=== 详情面板 ===');
    await js("document.querySelector('.row:not(.add) .body').click()");
    await new Promise(r => setTimeout(r, 350));
    const sheetProbe = `
      (() => {
        const sh = document.getElementById('sheet');
        const body = sh.querySelector('.sheet-body');
        const out = {};
        ['fTitle','fNotes','fDate','fTime','fAlarm','fPriority','fFlagged','btnSheetSave'].forEach(k => {
          const e = document.getElementById(k);
          const b = e.getBoundingClientRect();
          out[k] = Math.round(b.width) + 'x' + Math.round(b.height) + '@y' + Math.round(b.top);
        });
        out.sheetH = Math.round(sh.getBoundingClientRect().height);
        out.bodyScroll = body.scrollHeight;
        out.bodyClient = body.clientHeight;
        return JSON.stringify(out, null, 1);
      })()
    `;
    console.log(await js(sheetProbe));

    console.log('\n=== 滚到底 ===');
    console.log(await js("(() => { const b = document.querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; const d = document.getElementById('btnDelete').getBoundingClientRect(); return JSON.stringify({ delBottom: Math.round(d.bottom), vh: innerHeight, ok: d.bottom <= innerHeight }); })()"));
    await js("document.getElementById('btnSheetCancel').click()");

    console.log('\n=== 设置抽屉 ===');
    await js("document.getElementById('btnSettings').click()");
    await new Promise(r => setTimeout(r, 400));
    console.log(await js("(() => { const d = document.getElementById('drawer'); const b = document.getElementById('btnBarkSave').getBoundingClientRect(); return JSON.stringify({ drawerH: Math.round(d.getBoundingClientRect().height), scrollH: d.scrollHeight, clientH: d.clientHeight, barkSaveTop: Math.round(b.top), hasBark: !!document.getElementById('barkKey') }); })()"));
  } finally {
    try { ws && ws.close(); } catch { }
    try { child.kill(); } catch { }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }, 1200);
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
