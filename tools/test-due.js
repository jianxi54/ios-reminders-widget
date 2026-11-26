/* 日期 + 提前提醒 全场景实测（自建条目，跑完删除）
 *   1) 设日期 + 提前 30 分钟
 *   2) 只改日期 → 提前量应保留 30
 *   3) 改成准时提醒(0)
 *   4) 清掉提醒（保留日期）
 *   5) 清掉日期
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { CloudKitClient, describeAlarm } = require('../lib/cloudkit.js');

const sessionFile = path.join(process.env.LOCALAPPDATA, 'RemindersWidget', 'icloud-session.json');
const ck = new CloudKitClient(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readItem(uid) {
  const data = await ck.fetchAll();
  for (const [, { items }] of data) {
    const hit = items.find(x => x.uid === uid);
    if (hit) return hit;
  }
  return null;
}

async function fresh(uid) {
  return (await ck.lookupReminders([uid]))[0];
}

function show(tag, it) {
  console.log(
    '  ' + tag.padEnd(18),
    '| 日期:', it.due ? new Date(it.due).toLocaleString() : 'null',
    '| 提醒:', describeAlarm(it.alarmOffset) || 'null',
    '| allDay:', it.allDay,
  );
}

(async () => {
  const lists = await ck.queryLists();
  const list = lists[0];
  const c = await ck.createReminder(list, 'ZZ日期自检-' + Date.now().toString().slice(-4), {});
  console.log('测试条目:', c.uuid);

  const d1 = (() => { const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(9, 30, 0, 0); return d.getTime(); })();
  const d2 = (() => { const d = new Date(); d.setDate(d.getDate() + 4); d.setHours(20, 15, 0, 0); return d.getTime(); })();
  let rec, it;

  try {
    console.log('\n[1] 设日期 + 提前 30 分钟');
    rec = await fresh(c.uuid);
    await ck.setDueAndAlarm(rec, d1, false, 30);
    await sleep(3500);
    it = await readItem(c.uuid);
    show('结果', it);
    console.log('  ✓', it.due === d1 && it.alarmOffset === 30 ? 'PASS' : 'FAIL');

    console.log('\n[2] 只改日期（提前量应保留 30）');
    rec = await fresh(c.uuid);
    await ck.setDueAndAlarm(rec, d2, false, 30);
    await sleep(3500);
    it = await readItem(c.uuid);
    show('结果', it);
    console.log('  ✓', it.due === d2 && it.alarmOffset === 30 ? 'PASS' : 'FAIL');

    console.log('\n[3] 改成准时提醒');
    rec = await fresh(c.uuid);
    await ck.setDueAndAlarm(rec, d2, false, 0);
    await sleep(3500);
    it = await readItem(c.uuid);
    show('结果', it);
    console.log('  ✓', it.due === d2 && it.alarmOffset === 0 ? 'PASS' : 'FAIL');

    console.log('\n[4] 清掉提醒，保留日期');
    rec = await fresh(c.uuid);
    await ck.setDueAndAlarm(rec, d2, false, null);
    await sleep(3500);
    it = await readItem(c.uuid);
    show('结果', it);
    console.log('  ✓', it.due === d2 && it.alarmOffset === null ? 'PASS' : 'FAIL');

    console.log('\n[5] 清掉日期');
    rec = await fresh(c.uuid);
    await ck.setDueAndAlarm(rec, null, true, null);
    await sleep(3500);
    it = await readItem(c.uuid);
    show('结果', it);
    const raw = (await fresh(c.uuid)).fields.DueDate;
    console.log('  云端 DueDate 字段:', JSON.stringify(raw));
    console.log('  ✓', !it.due ? 'PASS' : 'FAIL');

    console.log('\n[6] 改全天日期');
    rec = await fresh(c.uuid);
    await ck.setDueAndAlarm(rec, d1, true, null);
    await sleep(3500);
    it = await readItem(c.uuid);
    show('结果', it);
    console.log('  ✓', it.due === d1 && it.allDay === true ? 'PASS' : 'FAIL');
  } finally {
    const last = await fresh(c.uuid);
    await ck.removeReminder({ record: last, uid: c.uuid, listId: list.recordName });
    console.log('\n已清理自检条目 Deleted =', (await fresh(c.uuid)).fields?.Deleted?.value);
  }
})().catch(e => { console.error('FAIL:', e.message, e.payload ? JSON.stringify(e.payload).slice(0, 300) : ''); process.exit(1); });
