'use strict';
/**
 * V0.01 验收（无头 Chrome + CDP，420×400）
 *   1. 末尾空行默认不显示圆圈；点进去编辑时才出现
 *   2. 行内编辑输入框没有边框/底色（不出现文本框线条）
 *   3. 设置抽屉底部显示服务端版本号
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 9487;
const BASE = 'http://127.0.0.1:8642/';

const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

const getJSON = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
}

(async () => {
  const child = spawn(browser, [
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--user-data-dir=' + path.join(os.tmpdir(), 'wk-v001-' + Date.now()),
    '--no-first-run', '--headless=new', '--window-size=420,400',
    '--force-device-scale-factor=1', BASE,
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
      return 'EXC: ' + ((d.exception && d.exception.description) || d.text);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 400, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 40; i++) {
    if (await js('!!document.querySelector("#list .row")')) break;
    await sleep(400);
  }
  await sleep(600);

  console.log('— 末尾空行 —');
  check('空行存在', await js('!!document.querySelector(".row.add")') === true);
  const addCheckDisplay = await js('getComputedStyle(document.querySelector(".row.add .check")).display');
  check('未编辑时圆圈隐藏', addCheckDisplay === 'none', 'display=' + addCheckDisplay);

  await js('document.querySelector(".row.add").click()');
  await sleep(350);
  const editDisplay = await js('getComputedStyle(document.querySelector(".row.add .check")).display');
  const hasInput = await js('!!document.querySelector(".row.add input")');
  check('进入编辑后圆圈出现', editDisplay !== 'none' && hasInput === true, 'display=' + editDisplay);
  const addInputStyle = await js(`(() => {
    const s = getComputedStyle(document.querySelector(".row.add input"));
    return [s.borderTopWidth, s.borderBottomWidth, s.borderLeftWidth, s.backgroundClip, s.backgroundColor].join('|');
  })()`);
  check('新增输入框无边框', /^0px\|0px\|0px\|/.test(addInputStyle), addInputStyle);
  await js('document.querySelector(".row.add input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(250);

  console.log('— 行内改名 —');
  await js('(() => { const t = document.querySelector(".row:not(.add) .t1"); if (t) t.click(); return true; })()');
  await sleep(350);
  const editStyle = await js(`(() => {
    const el = document.querySelector(".edit");
    if (!el) return "NO-INPUT";
    const s = getComputedStyle(el);
    return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth, s.backgroundColor, s.boxShadow].join("|");
  })()`);
  check('改名输入框无边框/无底色/无阴影',
    typeof editStyle === 'string' && editStyle.startsWith('0px|0px|0px|0px|') &&
    editStyle.includes('rgba(0, 0, 0, 0)') && editStyle.endsWith('none'), editStyle);
  await js('(() => { const i = document.querySelector(".edit"); if (i) i.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true; })()');
  await sleep(250);

  console.log('— 版本号 —');
  const verApi = await getJSON('http://127.0.0.1:8642/api/settings');
  await js('document.querySelector("#btnSettings").click()');
  await sleep(500);
  const verText = await js('document.querySelector("#appVer").textContent.trim()');
  check('设置里显示 ' + verApi.versionTag, verText === verApi.versionTag, 'appVer=' + verText);
  const verVisible = await js('(() => { const e = document.querySelector("#appVer"); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()');
  check('版本号在设置里可见', verVisible === true);

  console.log('');
  console.log(`结果：通过 ${pass}，失败 ${fail}`);
  try { ws.close(); } catch { }
  try { child.kill(); } catch { }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e.message); process.exit(2); });
