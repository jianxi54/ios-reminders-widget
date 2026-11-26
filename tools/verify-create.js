/* 端到端验证：界面新建 → 检查标题文档自洽（决定 iPhone 上是否空白）→ 界面删除 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CloudKitClient, checkTitleDoc, decodeTitle } = require('../lib/cloudkit.js');

const PORT = 9445;
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const TITLE = 'ZZ自检-可删除-' + Date.now().toString().slice(-4);

const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const sessionFile = path.join(process.env.LOCALAPPDATA, 'RemindersWidget', 'icloud-session.json');
  const ck = new CloudKitClient(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));

  const browser = CANDIDATES.find(p => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'wk-verify-' + Date.now());
  const child = spawn(browser, [
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=420,400',
    'http://127.0.0.1:8642/',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let list;
    for (let i = 0; i < 60; i++) { try { list = await getJSON(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
    const page = list.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cmd = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
    const js = async expr => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;

    for (let i = 0; i < 40; i++) { if ((await js("document.querySelectorAll('.row').length")) > 0) break; await new Promise(r => setTimeout(r, 400)); }
    const before = await js("document.getElementById('count').textContent");
    console.log('新建前计数:', before);

    // 通过界面新建
    await js(`(async () => {
      document.getElementById('btnAdd').click();
      const i = document.getElementById('quickInput');
      i.value = ${JSON.stringify(TITLE)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 2500));
    })()`);

    const after = await js(`(() => {
      const rows = [...document.querySelectorAll('.row')];
      const hit = rows.find(r => r.querySelector('.t1').textContent === ${JSON.stringify(TITLE)});
      return { count: document.getElementById('count').textContent,
               titles: rows.map(r => r.querySelector('.t1').textContent),
               uid: hit ? hit.dataset.uid : null };
    })()`);
    console.log('新建后计数:', after.count, '| 行数:', after.titles.length, '| 命中新条目:', !!after.uid);
    if (!after.uid) throw new Error('界面上没有出现新建条目：' + JSON.stringify(after.titles));

    // 检查云端记录：标题文档是否自洽（手机端显示的关键）
    const rec = (await ck.lookupReminders([after.uid]))[0];
    const doc = rec.fields.TitleDocument.value;
    const chk = checkTitleDoc(doc, TITLE);
    console.log('\n云端标题解码:', JSON.stringify(decodeTitle(doc)));
    console.log('标题文档自洽:', chk.ok, JSON.stringify({ runSum: chk.runSum ?? chk.runs, total: chk.total, expect: chk.expect }));
    console.log('字段列表:', Object.keys(rec.fields).join(','));

    // 界面删除（点两次确认）
    await js(`(async () => {
      const row = [...document.querySelectorAll('.row')].find(r => r.dataset.uid === ${JSON.stringify(after.uid)});
      row.querySelector('.del').click();
      await new Promise(r => setTimeout(r, 250));
      row.querySelector('.del').click();
      await new Promise(r => setTimeout(r, 2500));
    })()`);
    const fin = await js(`(() => ({ count: document.getElementById('count').textContent,
      still: [...document.querySelectorAll('.row')].some(r => r.dataset.uid === ${JSON.stringify(after.uid)}) }))()`);
    console.log('\n删除后计数:', fin.count, '| 行仍在:', fin.still);

    // 兜底：若界面删除失败则用接口清理，避免留脏数据
    if (fin.still) {
      await fetch('http://127.0.0.1:8642/api/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', uid: after.uid }) });
      console.log('已通过接口兜底删除');
    }
  } finally {
    try { ws && ws.close(); } catch { }
    try { child.kill(); } catch { }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }, 1500);
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
