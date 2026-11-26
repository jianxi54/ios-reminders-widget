/* 全量自检：找出标题文档内部长度不自洽的记录（iPhone 上会显示空白的根因） */
'use strict';
const fs = require('fs');
const path = require('path');
const { CloudKitClient, checkTitleDoc, decodeTitle } = require('../lib/cloudkit.js');

const sessionFile = path.join(process.env.LOCALAPPDATA, 'RemindersWidget', 'icloud-session.json');
const ck = new CloudKitClient(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));

const FIX = process.argv.includes('--fix');

(async () => {
  const byList = await ck.fetchAll();
  let total = 0;
  const bad = [];

  for (const [, { list, items }] of byList) {
    for (const it of items) {
      const doc = it.record.fields.TitleDocument?.value;
      if (!doc) { bad.push({ uid: it.uid, title: it.title, reason: '无 TitleDocument' }); continue; }
      total++;
      const chk = checkTitleDoc(doc, it.title);
      if (!chk.ok) bad.push({ uid: it.uid, title: it.title, list: list.name, chk });
    }
  }

  console.log('扫描条目:', total, '| 不自洽:', bad.length);
  for (const b of bad.slice(0, 20)) {
    console.log(' -', JSON.stringify(b.title), b.list || '', b.reason || JSON.stringify({ runs: b.chk.runs, total: b.chk.total, expect: b.chk.expect }));
  }

  if (FIX && bad.length) {
    console.log('\n开始修复…');
    for (const b of bad) {
      if (!b.title || b.title === '(无标题)') { console.log('  跳过（无标题）:', b.uid); continue; }
      try {
        const rec = (await ck.lookupReminders([b.uid]))[0];
        if (!rec) { console.log('  找不到记录:', b.uid); continue; }
        await ck.setTitle(rec, b.title);
        console.log('  已修复:', JSON.stringify(b.title));
      } catch (e) { console.log('  修复失败:', b.uid, e.message); }
    }
    // 复核
    const again = await ck.fetchAll();
    let bad2 = 0;
    for (const [, { items }] of again) for (const it of items) {
      const doc = it.record.fields.TitleDocument?.value;
      if (doc && !checkTitleDoc(doc, it.title).ok) bad2++;
    }
    console.log('复核后不自洽数量:', bad2);
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
