/* 界面端到端：新建 → 打开详情 → 填日期/提前提醒/备注/优先级/旗标 → 保存 → 回读 → 删除
 * 全程用真实 CloudKit，跑完把自检条目删掉，不留脏数据。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9461;
const TITLE = 'ZZ界面自检-' + Date.now().toString().slice(-4);
const NOTES = '第一行：客户地址在万科新都汇\n第二行：带上维保报告\n第三行：提前半小时出发';
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const browser = CANDIDATES.find(p => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'wk-ui-' + Date.now());
  const child = spawn(browser, [
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=420,420',
    'http://127.0.0.1:8642/',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let list;
    for (let i = 0; i < 60; i++) { try { list = await getJSON(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
    ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const logs = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value).join(' '));
      if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails.text));
    });
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cmd = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
    await cmd('Runtime.enable');
    const js = async expr => {
      const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      const ex = r.result.exceptionDetails;
      if (ex) {
        const d = ex.exception && (ex.exception.description || ex.exception.value);
        throw new Error('JS: ' + (d || ex.text) + '  ←  ' + expr.slice(0, 80));
      }
      return r.result.result.value;
    };

    for (let i = 0; i < 50; i++) { if ((await js('document.querySelectorAll(".row").length')) > 2) break; await new Promise(r => setTimeout(r, 400)); }

    console.log('[1] 首屏行数:', await js('document.querySelectorAll(".row").length'));
    console.log('    带日期的行:', await js(`JSON.stringify([...document.querySelectorAll('.row:not(.add)')].filter(r => r.querySelector('.due').textContent).map(r => r.querySelector('.t1').textContent + ' → ' + r.querySelector('.due').textContent))`));

    console.log('\n[2] 点空白行新建…');
    await js(`document.querySelector('.row.add').click()`);
    await new Promise(r => setTimeout(r, 250));
    const hasInput = await js(`!!document.querySelector('.row.add input')`);
    console.log('    输入框出现:', hasInput);
    if (!hasInput) throw new Error('点空白行没有出现输入框');
    await js(`(() => {
      const i = document.querySelector('.row.add input');
      i.value = ${JSON.stringify(TITLE)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await new Promise(r => setTimeout(r, 10000));
    const uid = await js(`(() => {
      const row = [...document.querySelectorAll('.row')].find(r => r.querySelector('.t1') && r.querySelector('.t1').textContent === ${JSON.stringify(TITLE)});
      return row ? row.dataset.uid : null;
    })()`);
    console.log('    新行 uid:', uid);
    if (!uid) throw new Error('新建失败');

    console.log('\n[3] 打开详情并填写…');
    await js(`(() => {
      const row = document.querySelector('.row[data-uid="${uid}"]');
      row.querySelector('.body').click();
    })()`);
    await new Promise(r => setTimeout(r, 300));
    const sheet = await js(`JSON.stringify({
      open: !document.getElementById('sheet').classList.contains('hidden'),
      title: document.getElementById('fTitle').value,
      alarmDisabled: document.getElementById('fAlarm').disabled,
      presets: [...document.getElementById('fAlarm').options].map(o => o.value + ':' + o.textContent),
    })`);
    console.log('    面板:', sheet);

    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

    await js(`(() => {
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      set(document.getElementById('fDate'), ${JSON.stringify(tomorrow)});
      set(document.getElementById('fTime'), '15:30');
      set(document.getElementById('fAlarm'), '30');
      const notes = document.getElementById('fNotes');
      notes.value = ${JSON.stringify(NOTES)};
      notes.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#fPriority button[data-p="1"]').click();
      const flag = document.getElementById('fFlagged');
      flag.checked = true;
      flag.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise(r => setTimeout(r, 200));
    console.log('    填写后:', await js(`JSON.stringify({
      date: document.getElementById('fDate').value,
      time: document.getElementById('fTime').value,
      alarm: document.getElementById('fAlarm').value,
      alarmHint: document.getElementById('alarmHint').textContent,
      prio: (document.querySelector('#fPriority .on') || {}).dataset,
      flag: document.getElementById('fFlagged').checked,
    })`));

    console.log('\n[4] 保存…');
    await js(`document.getElementById('btnSheetSave').click()`);
    await new Promise(r => setTimeout(r, 10000));
    console.log('    面板已关闭:', await js(`document.getElementById('sheet').classList.contains('hidden')`));

    console.log('\n[5] 回读界面…');
    const rowState = await js(`(() => {
      const row = document.querySelector('.row[data-uid="${uid}"]');
      if (!row) return null;
      return JSON.stringify({
        title: row.querySelector('.t1').textContent,
        due: row.querySelector('.due').textContent,
        prio: row.querySelector('.prio').textContent,
        flagged: row.classList.contains('flagged'),
        hasNotes: row.classList.contains('has-notes'),
        notes: row.querySelector('.notes-line').textContent,
        h: Math.round(row.getBoundingClientRect().height),
      });
    })()`);
    console.log('    行:', rowState);

    console.log('\n[6] 回读接口…');
    const data = await getJSON('http://127.0.0.1:8642/api/reminders');
    const item = data.items.find(x => x.uid === uid);
    console.log('   ', JSON.stringify({
      summary: item.summary, due: item.due ? new Date(item.due).toLocaleString() : null,
      allDay: item.allDay, priority: item.priority, flagged: item.flagged,
      alarmOffset: item.alarmOffset, alarmText: item.alarmText, notes: item.notes,
    }));

    console.log('\n[7] 删除自检条目…');
    await js(`(() => {
      const row = document.querySelector('.row[data-uid="${uid}"]');
      if (row) row.querySelector('.body').click();
    })()`);
    await new Promise(r => setTimeout(r, 300));
    await js(`document.getElementById('btnDelete').click()`);
    await new Promise(r => setTimeout(r, 250));
    await js(`document.getElementById('btnDelete').click()`);
    await new Promise(r => setTimeout(r, 8000));
    const after = await getJSON('http://127.0.0.1:8642/api/reminders');
    console.log('    删除后还在列表里:', after.items.some(x => x.uid === uid));

    if (logs.length) console.log('\n控制台:', logs.slice(0, 10).join(' | '));
  } finally {
    try { ws && ws.close(); } catch { }
    try { child.kill(); } catch { }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }, 1500);
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
