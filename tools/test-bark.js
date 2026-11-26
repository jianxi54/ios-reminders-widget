/* Bark 推送链路验证：
 *   1) 起一个假的 Bark 服务器（本地），记录收到的请求
 *   2) 把小组件的推送设置指向它
 *   3) 建一条 40 秒后到期的提醒（无提前提醒，靠「到期也推」）
 *   4) 等推送循环命中，检查收到的 URL
 *   5) 清理：删提醒、恢复设置、关服务器
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { CloudKitClient } = require('../lib/cloudkit.js');

const FAKE_PORT = 9099;
const sessionFile = path.join(process.env.LOCALAPPDATA, 'RemindersWidget', 'icloud-session.json');
const settingsFile = path.join(process.env.LOCALAPPDATA, 'RemindersWidget', 'settings.json');
const WIDGET = 'http://127.0.0.1:8642';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const received = [];

function post(pathname, body) {
  return fetch(WIDGET + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

(async () => {
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;

  const fake = http.createServer((req, res) => {
    received.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, message: 'success' }));
  });
  await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
  console.log('假 Bark 服务器已启动 :' + FAKE_PORT);

  const ck = new CloudKitClient(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));
  const lists = await ck.queryLists();
  const list = lists[0];
  let uid = null;

  try {
    await post('/api/settings', {
      bark: { enabled: true, server: 'http://127.0.0.1:' + FAKE_PORT, key: 'testkey', group: '提醒事项', sound: '', level: 'active', notifyOnDue: true },
    });
    console.log('推送已指向假服务器');

    const due = Date.now() + 40000;
    const c = await ck.createReminder(list, 'ZZ推送自检-' + Date.now().toString().slice(-4), { dueMs: due, allDay: false });
    uid = c.uuid;
    console.log('测试提醒已建：', new Date(due).toLocaleTimeString(), '到期');

    // 推送循环是每 60 秒一轮，最多等 90 秒
    for (let i = 0; i < 30 && !received.length; i++) await sleep(3000);
    console.log('\n收到的推送请求:', received.length ? received : '（无）');
    if (received.length) {
      const u = new URL('http://x' + received[0]);
      console.log('  path 解码:', decodeURIComponent(u.pathname));
      console.log('  group:', u.searchParams.get('group'), '| level:', u.searchParams.get('level'));
    }
  } finally {
    if (uid) {
      const rec = (await ck.lookupReminders([uid]))[0];
      if (rec && (rec.fields?.Deleted?.value ?? 0) === 0) await ck.removeReminder({ record: rec, uid, listId: list.recordName });
      console.log('测试提醒已删除');
    }
    if (original !== null) fs.writeFileSync(settingsFile, original, 'utf8'); else fs.unlinkSync(settingsFile);
    console.log('推送设置已还原');
    fake.close();
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
