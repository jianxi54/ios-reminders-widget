/* 通过真实浏览器完成 iCloud 登录，并导出会话
 *
 * 背景：Node 直接 POST idmsa.apple.com 的登录端点会被 Apple WAF 以 503 拦截
 *       （TLS/HTTP2 指纹识别，加任何请求头都无效）。因此改为：
 *       启动一个独立 profile 的 Chrome/Edge → 用户在里面正常登录（含 2FA）
 *       → 用 CDP 读出 cookie → 换取 iCloud webservices。
 *
 * 用法: node tools/browser-login.js
 * 说明: 账号密码完全在浏览器里输入，脚本接触不到。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const SESSION_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'RemindersWidget');
const SESSION_FILE = path.join(SESSION_DIR, 'icloud-session.json');
const PROFILE_DIR = path.join(SESSION_DIR, 'browser-profile');
const PORT = 9333;
// 中国区账号（云上贵州）只能用 icloud.com.cn，用 .com 会被拒绝
const LOGIN_URL = 'https://www.icloud.com.cn/';
const SITE_ORIGIN = 'https://www.icloud.com.cn';
const ICLOUD_DOMAIN_RE = /icloud\.com(\.cn)?$/i;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP 连接失败: ' + (e.message || 'unknown'))); });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, 20000);
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

/* ---------------- 主流程 ---------------- */
(async () => {
  const browser = findBrowser();
  if (!browser) {
    console.error('[ERROR] 未找到 Chrome 或 Edge，无法登录。');
    process.exit(1);
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log('=== iCloud 登录（浏览器方式）===');
  console.log('浏览器 :', browser);
  console.log('将会打开一个独立的浏览器窗口，请在里面正常登录 iCloud。');
  console.log('账号密码只输入在浏览器里，本脚本接触不到。\n');

  // 若上次的浏览器实例还开着（调试端口仍在），直接复用，避免开一堆窗口
  let child = null;
  let reused = false;
  try {
    await httpJSON(`http://127.0.0.1:${PORT}/json/version`);
    reused = true;
  } catch { /* 端口未监听，需要新开 */ }

  if (!reused) {
    child = spawn(browser, [
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      LOGIN_URL,
    ], { detached: false, stdio: 'ignore' });

    child.on('error', (e) => console.error('启动浏览器失败:', e.message));
  } else {
    console.log('检测到已有登录窗口，直接复用它。');
    console.log('请确认该窗口当前打开的是', LOGIN_URL);
  }

  // 等待调试端口就绪
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      targets = await httpJSON(`http://127.0.0.1:${PORT}/json/list`);
      if (targets.some(t => t.type === 'page')) break;
    } catch { /* 还没起来 */ }
  }
  if (!targets) {
    console.error('[ERROR] 浏览器调试端口未就绪');
    process.exit(1);
  }

  // 如果窗口停在 www.icloud.com（中国区账号会被拒绝），自动切到 .com.cn
  try {
    const list0 = await httpJSON(`http://127.0.0.1:${PORT}/json/list`);
    const p0 = list0.find(t => t.type === 'page' && /^https?:\/\/www\.icloud\.com\//i.test(t.url));
    if (p0) {
      const c0 = new CDP(p0.webSocketDebuggerUrl);
      await c0.open();
      await c0.send('Page.navigate', { url: LOGIN_URL });
      c0.close();
      console.log('已把登录页切换到', LOGIN_URL);
      await sleep(1500);
    }
  } catch { /* 忽略，交给用户手动操作 */ }

  console.log('已打开浏览器，请完成登录（含双重认证验证码）。');
  console.log('脚本会自动检测登录状态，最长等待 8 分钟…\n');

  let cookies = null;
  const deadline = Date.now() + 8 * 60 * 1000;
  let lastTip = 0;

  while (Date.now() < deadline) {
    await sleep(2000);
    let list;
    try { list = await httpJSON(`http://127.0.0.1:${PORT}/json/list`); } catch { continue; }
    const page = list.find(t => t.type === 'page' && /icloud\.com(\.cn)?/i.test(t.url))
      || list.find(t => t.type === 'page');
    if (!page) continue;

    let cdp;
    try {
      cdp = new CDP(page.webSocketDebuggerUrl);
      await cdp.open();
      await cdp.send('Network.enable');
      const res = await cdp.send('Network.getAllCookies');
      const all = res.cookies || [];
      const mine = all.filter(c => ICLOUD_DOMAIN_RE.test(c.domain));
      const token = mine.find(c => c.name === 'X-APPLE-WEBAUTH-TOKEN' && c.value);
      const user = mine.find(c => c.name === 'X-APPLE-WEBAUTH-USER' && c.value);
      if (token && user) {
        cookies = all;
        cdp.close();
        break;
      }
      cdp.close();
    } catch (e) {
      try { cdp?.close(); } catch { /* ignore */ }
    }

    const left = Math.round((deadline - Date.now()) / 1000);
    if (Date.now() - lastTip > 30000) {
      console.log(`  等待登录中… 剩余 ${Math.floor(left / 60)} 分 ${left % 60} 秒`);
      lastTip = Date.now();
    }
  }

  if (!cookies) {
    console.error('\n[ERROR] 超时未检测到登录成功。请重新运行本脚本。');
    try { child?.kill(); } catch { /* ignore */ }
    process.exit(1);
  }

  console.log('\n[OK] 检测到登录会话，正在导出…');

  // 只保留 iCloud 相关 cookie
  const keep = cookies.filter(c => ICLOUD_DOMAIN_RE.test(c.domain));
  const cookieMap = {};
  // 先放非域限定，再放 .icloud.com，后者覆盖
  for (const c of keep.sort((a, b) => (a.domain.startsWith('.') ? 1 : 0) - (b.domain.startsWith('.') ? 1 : 0))) {
    cookieMap[c.name] = c.value;
  }
  console.log('  cookie 数量:', Object.keys(cookieMap).length);

  const cookieHeader = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
  const clientId = require('node:crypto').randomUUID().toUpperCase();

  // 用 cookie 换取 webservices
  let session = null;
  for (const host of ['setup.icloud.com.cn', 'setup.icloud.com']) {
    try {
      const r = await fetch(`https://${host}/setup/ws/1/validate?clientBuildNumber=2535Project&clientId=${clientId}&dsid=`, {
        headers: {
          'Cookie': cookieHeader,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Origin': SITE_ORIGIN,
          'Referer': SITE_ORIGIN + '/',
        },
        redirect: 'manual',
      });
      const txt = await r.text();
      if (r.ok) {
        const j = JSON.parse(txt);
        session = {
          dsid: String(j.dsInfo?.dsid || ''),
          appleId: j.dsInfo?.primaryEmail || null,
          clientId,
          host,
          webservices: j.webservices || {},
          cookies: cookieMap,
          createdAt: Date.now(),
        };
        break;
      }
      console.log(`  ${host} -> HTTP ${r.status}`);
    } catch (e) {
      console.log(`  ${host} 失败: ${e.message}`);
    }
  }

  if (!session || !session.dsid) {
    console.error('[ERROR] 会话导出失败：无法换取 iCloud 服务列表');
    try { child?.kill(); } catch { /* ignore */ }
    process.exit(1);
  }

  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf8');
  try { fs.chmodSync(SESSION_FILE, 0o600); } catch { /* ignore */ }

  console.log('\n[OK] 登录成功');
  console.log('  dsid      :', session.dsid);
  console.log('  账号      :', session.appleId || '-');
  console.log('  区域      :', session.host);
  console.log('  reminders :', session.webservices.reminders?.url || '(未提供)');
  console.log('  cloudkit  :', session.webservices.ckdatabasews?.url || '(未提供)');
  console.log('  会话文件  :', SESSION_FILE);
  console.log('\n可以直接关闭这个浏览器窗口了。');

  try { await httpJSON(`http://127.0.0.1:${PORT}/json/version`); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  process.exit(0);
})().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
