'use strict';
/**
 * 版式 / 主题 / 下拉 / 优先级验证（无头 Chrome + CDP）
 *   - 420×400 真实视口
 *   - 检查：无滚动条、行高、!!! 标记、明暗切换、自定义下拉可读性与取值联动
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 9481;
const BASE = 'http://127.0.0.1:8642/';

const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

const getJSON = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const child = spawn(browser, [
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + path.join(os.tmpdir(), 'wk-theme-' + Date.now()),
    '--no-first-run', '--headless=new',
    '--window-size=420,400',
    '--force-device-scale-factor=1',
    BASE,
  ], { stdio: 'ignore' });

  const list = await (async () => {
    for (let i = 0; i < 80; i++) {
      try { return await getJSON(`http://127.0.0.1:${PORT}/json/list`); } catch { await sleep(300); }
    }
    throw new Error('CDP 未就绪');
  })();

  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  const cmd = (method, params = {}) => new Promise(res => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return 'EXC: ' + (d.exception && d.exception.description || d.text);
    }
    return r.result.result.value;
  };

  await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 400, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 60; i++) {
    if ((await js('document.querySelectorAll(".row:not(.add)").length')) > 2) break;
    await sleep(400);
  }

  console.log('== 列表 ==');
  console.log(await js(`JSON.stringify({
    rows: document.querySelectorAll('.row:not(.add)').length,
    scrollbarW: document.getElementById('list').offsetWidth - document.getElementById('list').clientWidth,
    rowH: [...document.querySelectorAll('.row:not(.add)')].slice(0,6).map(r => Math.round(r.getBoundingClientRect().height)),
    t1lh: getComputedStyle(document.querySelector('.t1')).lineHeight,
    prio: [...document.querySelectorAll('.row:not(.add)')].filter(r => r.querySelector('.prio').classList.contains('on'))
            .map(r => ({ m: r.querySelector('.prio').textContent, before: r.querySelector('.line1').firstElementChild.className,
                         color: getComputedStyle(r.querySelector('.prio')).color,
                         t: r.querySelector('.t1').textContent.slice(0,10) })),
    listOverflowX: document.getElementById('list').scrollWidth - document.getElementById('list').clientWidth
  }, null, 1)`));

  console.log('\n== 暗色主题 ==');
  console.log(await js(`JSON.stringify({
    theme: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.querySelector('.t1')).color,
    nameColor: getComputedStyle(document.getElementById('viewTitle')).color
  })`));

  console.log('\n== 切到明亮 ==');
  console.log(await js(`(async () => {
    document.getElementById('btnSettings').click();
    await new Promise(r => setTimeout(r, 150));
    document.querySelector('#fTheme button[data-t="light"]').click();
    await new Promise(r => setTimeout(r, 150));
    const g = s => getComputedStyle(document.querySelector(s));
    return JSON.stringify({
      theme: document.documentElement.getAttribute('data-theme'),
      bg: g('body').backgroundColor,
      text: g('.t1').color,
      nameColor: g('#viewTitle').color,
      drawer: g('#drawer').backgroundColor,
      fieldBg: g('#barkKey').backgroundColor,
      fieldText: g('#barkKey').color,
      segOn: (document.querySelector('#fTheme button.on') || {}).textContent
    });
  })()`));

  console.log('\n== 设置项：中断级别下拉（明亮主题下） ==');
  console.log(await js(`(async () => {
    const s = document.getElementById('barkLevel');
    const ctl = s.closest('.sel');
    const btn = ctl.querySelector('.sel-btn');
    const lab = btn.querySelector('.sel-label').textContent;
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    const menu = document.querySelector('.sel-menu:not(.hidden)');
    const g = menu ? getComputedStyle(menu) : null;
    const opt = menu ? menu.querySelector('.sel-opt') : null;
    const o = opt ? getComputedStyle(opt) : null;
    return JSON.stringify({
      label: lab,
      menuOpen: !!menu,
      menuBg: g && g.backgroundColor,
      menuText: o && o.color,
      opts: menu ? [...menu.querySelectorAll('.sel-opt')].map(x => x.textContent) : [],
      rect: menu ? (r => ({ top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }))(menu.getBoundingClientRect()) : null
    });
  })()`));

  console.log('\n== 选中 passsive 后回写 ==');
  console.log(await js(`(async () => {
    const menu = document.querySelector('.sel-menu:not(.hidden)');
    const t = [...menu.querySelectorAll('.sel-opt')].find(x => x.textContent.indexOf('passive') === 0);
    t.click();
    await new Promise(r => setTimeout(r, 80));
    const s = document.getElementById('barkLevel');
    return JSON.stringify({
      nativeValue: s.value,
      label: s.closest('.sel').querySelector('.sel-label').textContent,
      menuClosed: document.querySelector('.sel-menu.hidden') !== null
    });
  })()`));

  console.log('\n== 已完成视图（带日期行） ==');
  console.log(await js(`(async () => {
    document.getElementById('btnCloseDrawer').click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('btnDone').click();
    await new Promise(r => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('.row:not(.add)')];
    const dated = rows.filter(r => r.querySelector('.due').textContent);
    return JSON.stringify({
      view: view,
      items: state.items.length,
      count: document.getElementById('count').textContent,
      rows: rows.length,
      children: document.getElementById('list').children.length,
      datedRows: dated.length,
      firstDue: dated.length ? dated[0].querySelector('.due').textContent : null,
      dueColor: dated.length ? getComputedStyle(dated[0].querySelector('.due')).color : null,
      scrollbarW: document.getElementById('list').offsetWidth - document.getElementById('list').clientWidth,
      scrollable: document.getElementById('list').scrollHeight > document.getElementById('list').clientHeight
    });
  })()`));

  console.log('\n== 详情面板里的提前提醒下拉 ==');
  console.log(await js(`(async () => {
    const row = [...document.querySelectorAll('.row:not(.add)')].find(r => r.querySelector('.due').textContent);
    if (!row) return JSON.stringify({ error: '没有带日期的行' });
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const sheetOpen = !document.getElementById('sheet').classList.contains('hidden');
    const btn = document.querySelector('#fAlarm').closest('.sel').querySelector('.sel-btn');
    const res = {
      sheetOpen, rowTitle: row.querySelector('.t1').textContent.slice(0, 12),
      dateValue: document.getElementById('fDate').value,
      timeValue: document.getElementById('fTime').value,
      alarmBtnDisabled: btn.disabled,
      label: btn.querySelector('.sel-label').textContent
    };
    if (!btn.disabled) {
      btn.click();
      await new Promise(r => setTimeout(r, 120));
      const menu = document.querySelector('.sel-menu:not(.hidden)');
      const g = menu && getComputedStyle(menu);
      const o = menu && getComputedStyle(menu.querySelector('.sel-opt'));
      res.menuOpen = !!menu;
      res.menuBg = g && g.backgroundColor;
      res.optText = o && o.color;
      res.firstOpts = menu ? [...menu.querySelectorAll('.sel-opt')].slice(0, 4).map(x => x.textContent) : [];
      res.insideWindow = menu ? (r => r.top >= 0 && r.top < 400 && r.left >= 0 && r.left < 420)(menu.getBoundingClientRect()) : false;
      if (menu) {
        const t = [...menu.querySelectorAll('.sel-opt')].find(x => x.textContent.indexOf('提前 30 分钟') === 0);
        if (t) { t.click(); await new Promise(r => setTimeout(r, 120)); }
        res.pickedLabel = document.querySelector('#fAlarm').closest('.sel').querySelector('.sel-label').textContent;
        res.hint = document.getElementById('alarmHint').textContent;
        res.native = document.getElementById('fAlarm').value;
      }
    }
    document.getElementById('btnSheetCancel').click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('btnBack').click();
    await new Promise(r => setTimeout(r, 300));
    return JSON.stringify(res);
  })()`));

  console.log('\n== 回到暗色 ==');
  console.log(await js(`(async () => {
    document.getElementById('btnSheetCancel').click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('btnSettings').click();
    await new Promise(r => setTimeout(r, 150));
    document.querySelector('#fTheme button[data-t="dark"]').click();
    await new Promise(r => setTimeout(r, 120));
    const g = s => getComputedStyle(document.querySelector(s));
    const btn = document.querySelector('#barkLevel').closest('.sel').querySelector('.sel-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    const menu = document.querySelector('.sel-menu:not(.hidden)');
    const opts = menu ? [...menu.querySelectorAll('.sel-opt')] : [];
    const lastOpt = opts[3] ? getComputedStyle(opts[3]) : null;
    const out = {
      theme: document.documentElement.getAttribute('data-theme'),
      bg: g('body').backgroundColor,
      drawer: g('#drawer').backgroundColor,
      name: g('#viewTitle').color,
      stored: localStorage.getItem('rw.theme'),
      menuBg: menu ? getComputedStyle(menu).backgroundColor : null,
      optText: lastOpt ? lastOpt.color : null,
      optBg: lastOpt ? lastOpt.backgroundColor : null
    };
    if (menu) menu.remove();
    return JSON.stringify(out);
  })()`));

  ws.close();
  child.kill();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
