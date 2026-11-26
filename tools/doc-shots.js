/* 生成 README 用的界面截图（演示数据，不含真实清单）
 *
 * 做法：用临时 LOCALAPPDATA 起一个 demo 模式的服务 → 无头 Chrome 以 420×400 打开 →
 *      分别截深色与浅色 → 关闭所有子进程。
 *
 * 用法: node tools/doc-shots.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8651;
const CDP_PORT = 9501;
const DEMO_DATA = path.join(os.tmpdir(), 'rw-demo-data');
const OUT_DIR = path.join(ROOT, 'docs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

function findBrowser() {
  const list = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome 或 Edge');
}

(async () => {
  fs.mkdirSync(DEMO_DATA, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 没有会话文件 → 服务进入 demo 模式
  for (const f of ['icloud-session.json', 'settings.json', 'pushed.json']) {
    try { fs.unlinkSync(path.join(DEMO_DATA, f)); } catch { }
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { LOCALAPPDATA: DEMO_DATA, WIDGET_PORT: String(PORT) }),
    stdio: 'ignore',
  });

  let mode = null;
  for (let i = 0; i < 60; i++) {
    try {
      const j = await getJSON(`http://127.0.0.1:${PORT}/api/reminders`);
      if (j && j.mode) { mode = j.mode; break; }
    } catch { }
    await sleep(400);
  }
  if (!mode) throw new Error('本地服务未就绪');
  console.log('服务模式:', mode);

  const browser = spawn(findBrowser(), [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${path.join(os.tmpdir(), 'rw-shot-profile-' + Date.now())}`,
    '--no-first-run', '--headless=new', '--hide-scrollbars',
    `--window-size=420,400`,
    `http://127.0.0.1:${PORT}/`,
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 80; i++) {
    try { list = await getJSON(`http://127.0.0.1:${CDP_PORT}/json/list`); break; } catch { await sleep(300); }
  }
  if (!list) throw new Error('调试端口未就绪');
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有可截图的页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const cmd = (method, params = {}) => new Promise(res => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 400, deviceScaleFactor: 2, mobile: false });
  await sleep(3500);

  const shoot = async (name) => {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('已保存', file, Math.round(fs.statSync(file).size / 1024) + ' KB');
  };

  // 深色
  await js("applyTheme && applyTheme('dark', false, false)");
  await sleep(600);
  await shoot('preview-dark.png');

  // 浅色
  await js("applyTheme && applyTheme('light', false, false)");
  await sleep(600);
  await shoot('preview-light.png');

  ws.close();
  browser.kill();
  server.kill();
  await sleep(300);
  process.exit(0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
