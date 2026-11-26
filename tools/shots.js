'use strict';
/**
 * 生成两张截图（明 / 暗）用于确认外观，不改动真实设置。
 * 输出：shots/widget-dark.png、shots/widget-light.png、shots/detail-light.png
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 9493;
const OUT = path.join(__dirname, '..', 'shots');
const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

const getJSON = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const child = spawn(browser, [
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + path.join(os.tmpdir(), 'wk-shot-' + Date.now()),
    '--no-first-run', '--headless=new', '--hide-scrollbars',
    '--window-size=420,400', '--force-device-scale-factor=2',
    'http://127.0.0.1:8642/',
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
    if (r.result && r.result.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
    return r.result.result.value;
  };
  const shot = async name => {
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('已保存', name);
  };

  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 400, deviceScaleFactor: 2, mobile: false });
  for (let i = 0; i < 60; i++) {
    if ((await js('document.querySelectorAll(".row:not(.add)").length')) > 2) break;
    await sleep(400);
  }
  await sleep(400);

  await js("applyTheme('dark', false, false)");
  await sleep(300);
  await shot('widget-dark.png');

  await js("applyTheme('light', false, false)");
  await sleep(300);
  await shot('widget-light.png');

  // 详情面板 + 下拉展开（亮色）
  await js(`(async () => {
    document.getElementById('btnDone').click();
    await new Promise(r => setTimeout(r, 600));
    const row = [...document.querySelectorAll('.row:not(.add)')].find(r => r.querySelector('.due').textContent);
    if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const btn = document.querySelector('#fAlarm').closest('.sel').querySelector('.sel-btn');
    if (btn && !btn.disabled) btn.click();
    await new Promise(r => setTimeout(r, 250));
  })()`);
  await shot('detail-light.png');

  ws.close();
  child.kill();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
