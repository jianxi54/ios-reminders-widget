/* 端到端实测：新建带「日期 + 提前提醒 + 备注 + 优先级」的提醒 → 回读校验 → 删除
 * 会在真实列表里短暂出现一条「ZZ自检-可删除-xxxx」，跑完即删。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { CloudKitClient, decodeNotes, describeAlarm } = require('../lib/cloudkit.js');

const sessionFile = path.join(process.env.LOCALAPPDATA, 'RemindersWidget', 'icloud-session.json');
const ck = new CloudKitClient(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));
const TITLE = 'ZZ自检-可删除-' + Date.now().toString().slice(-4);
const NOTES = '第一行备注\n第二行备注，带中文与 ASCII abc';

(async () => {
  const lists = await ck.queryLists();
  const list = lists[0];
  console.log('列表:', list.name);

  // 明天 15:30，提前 30 分钟
  const due = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(15, 30, 0, 0);
    return d.getTime();
  })();

  console.log('\n[1] 创建…');
  const created = await ck.createReminder(list, TITLE, {
    dueMs: due,
    allDay: false,
    priority: 1,
    flagged: true,
    notes: NOTES,
  });
  console.log('  recordName:', created.recordName);

  console.log('[2] 写提前提醒 30 分钟…');
  const rec0 = (await ck.lookupReminders([created.uuid]))[0];
  const alarm = await ck.setAlarm(rec0, due, 30);
  console.log('  alarm:', JSON.stringify(alarm), '触发时刻:', new Date(alarm.at).toLocaleString());

  console.log('[3] 回读…');
  const rec = (await ck.lookupReminders([created.uuid]))[0];
  const items = await ck.fetchAll();
  let found = null;
  for (const [, { items: arr }] of items) {
    const hit = arr.find(x => x.uid === created.uuid);
    if (hit) { found = hit; break; }
  }
  console.log('  标题:', JSON.stringify(found?.title));
  console.log('  日期:', found?.due ? new Date(found.due).toLocaleString() : null, '| allDay:', found?.allDay);
  console.log('  提前提醒:', describeAlarm(found?.alarmOffset), '(offset=' + found?.alarmOffset + ' 分钟)');
  console.log('  备注:', JSON.stringify(found?.notes));
  console.log('  优先级:', found?.priority, '| 旗标:', found?.flagged);
  console.log('  AlarmIDs:', JSON.stringify(rec.fields?.AlarmIDs?.value));
  console.log('  备注解码:', JSON.stringify(decodeNotes(rec.fields?.NotesDocument?.value)));

  const okTitle = found?.title === TITLE;
  const okDue = found?.due === due;
  const okAlarm = found?.alarmOffset === 30;
  const okNotes = (found?.notes || '').replace(/\r/g, '') === NOTES;
  const okPrio = found?.priority === 1;
  console.log('\n结果:', JSON.stringify({ 标题: okTitle, 日期: okDue, 提前提醒: okAlarm, 备注: okNotes, 优先级: okPrio }));

  console.log('\n[4] 清理（删除自检记录）…');
  await ck.removeReminder(found);
  const after = (await ck.lookupReminders([created.uuid]))[0];
  console.log('  Deleted =', after?.fields?.Deleted?.value);

  if (!(okTitle && okDue && okAlarm && okNotes && okPrio)) process.exitCode = 2;
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
