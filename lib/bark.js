'use strict';
/**
 * Bark 推送（iOS 通知）
 *   GET {server}/{key}/{title}/{body}?group=&sound=&level=&icon=
 * 默认服务器 https://api.day.app，也可填自建地址（如 http://192.168.1.10:8080）。
 */

function normalizeServer(s) {
  let v = String(s || '').trim() || 'https://api.day.app';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v.replace(/\/+$/, '');
}

function buildUrl(bark, title, body) {
  const base = normalizeServer(bark.server);
  const key = String(bark.key || '').trim();
  if (!key) throw new Error('还没填 Bark 设备 Key');
  const u = new URL(`${base}/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  if (bark.group) u.searchParams.set('group', String(bark.group));
  if (bark.sound) u.searchParams.set('sound', String(bark.sound));
  if (bark.level) u.searchParams.set('level', String(bark.level));
  if (bark.icon) u.searchParams.set('icon', String(bark.icon));
  return u;
}

async function send(bark, title, body, extra = {}) {
  const u = buildUrl(bark, title, body);
  for (const [k, v] of Object.entries(extra)) if (v) u.searchParams.set(k, String(v));
  const r = await fetch(u, { method: 'GET' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 自建服务可能不返回 JSON */ }
  if (!r.ok) throw new Error(`Bark HTTP ${r.status}：${(json && (json.message || json.code)) || text.slice(0, 120)}`);
  if (json && json.code !== undefined && Number(json.code) !== 200) {
    throw new Error(`Bark 返回 ${json.code}：${json.message || '推送失败'}`);
  }
  return { ok: true, url: u.toString().replace(encodeURIComponent(String(bark.key)), '***'), raw: json };
}

module.exports = { send, buildUrl, normalizeServer };
