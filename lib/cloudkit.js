/* CloudKit 客户端 —— iOS 13+ 提醒事项的唯一同步通道
 *
 * 数据模型（实测）：
 *   Lists   : 可 query，字段 Name / Color / ReminderIDs(JSON 数组) / Count / Deleted
 *   Reminder: 不可 query（not indexable），只能按 recordName lookup
 *             标题在 TitleDocument = gzip(protobuf{2:protobuf{3:protobuf{2:标题}}}})
 *             备注在 NotesDocument = zlib(protobuf)，结构不同，按需解
 *             时间字段均为毫秒时间戳；ResolutionTokenMap 是 CRDT 版本向量
 */
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const CF_EPOCH_OFFSET = 978307200; // 2001-01-01 到 1970-01-01 的秒数

function cfNow() {
  return Date.now() / 1000 - CF_EPOCH_OFFSET;
}

function newUuid() {
  return crypto.randomUUID().toUpperCase();
}

/* ---------------- protobuf 最小编解码 ---------------- */
function readVarint(buf, i) {
  let result = 0, shift = 0;
  while (i < buf.length) {
    const b = buf[i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return [result, i];
    shift += 7;
  }
  return [result, i];
}

function writeVarint(n) {
  const out = [];
  let v = Math.max(0, Math.floor(n));
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function tag(field, wire) {
  return writeVarint(field * 8 + wire);
}

function encVarintField(field, n) {
  return Buffer.concat([tag(field, 0), writeVarint(n)]);
}

function encBytesField(field, buf) {
  return Buffer.concat([tag(field, 2), writeVarint(buf.length), buf]);
}

/** 解析为有序字段数组，便于原样重建 */
function parseFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) {
      let v; [v, i] = readVarint(buf, i);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len; [len, i] = readVarint(buf, i);
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.readUInt32LE(i) }); i += 4;
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.readBigUInt64LE(i) }); i += 8;
    } else break;
  }
  return out;
}

function encodeFields(fields) {
  const parts = [];
  for (const f of fields) {
    if (f.wire === 0) parts.push(encVarintField(f.field, f.value));
    else if (f.wire === 2) parts.push(encBytesField(f.field, f.value));
    else if (f.wire === 5) {
      const b = Buffer.alloc(4); b.writeUInt32LE(f.value);
      parts.push(Buffer.concat([tag(f.field, 5), b]));
    } else if (f.wire === 1) {
      const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(f.value));
      parts.push(Buffer.concat([tag(f.field, 1), b]));
    }
  }
  return Buffer.concat(parts);
}

/* ---------------- 文档字段（标题 / 备注） ---------------- */

/**
 * Apple 的 *Document 字段有两种压缩格式，必须都支持：
 *   gzip → base64 以 "H4sI" 开头
 *   zlib → base64 以 "eJz" 开头
 * 只认 gzip 会导致 zlib 的记录被判为「无标题」。
 */
function isGzip(buf) {
  return buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function decodeDoc(b64) {
  const buf = Buffer.from(b64, 'base64');
  return isGzip(buf) ? zlib.gunzipSync(buf) : zlib.inflateSync(buf);
}

function encodeDoc(raw, gzip) {
  return (gzip ? zlib.gzipSync(raw) : zlib.deflateSync(raw)).toString('base64');
}

/** 标题文档：压缩( protobuf{2: protobuf{3: protobuf{2: 标题}}}} */
function decodeTitle(b64) {
  if (!b64) return null;
  try {
    const raw = decodeDoc(b64);
    const f2 = parseFields(raw).find(x => x.field === 2 && x.wire === 2);
    if (!f2) return null;
    const f3 = parseFields(f2.value).find(x => x.field === 3 && x.wire === 2);
    if (!f3) return null;
    const t = parseFields(f3.value).find(x => x.field === 2 && x.wire === 2);
    return t ? t.value.toString('utf8') : null;
  } catch {
    return null;
  }
}

/**
 * 把一个已有标题文档改写为新的文本，保留 CRDT 元数据与原始压缩格式。
 *
 * ⚠️ 两个必须同时满足的条件，否则 iPhone 端会显示**空白**（桌面端读起来却完全正常）：
 *
 * 1) 长度元数据必须与正文一致。文档里散落三处长度：
 *      3:{…, 2: 长度}          属性 run 覆盖的字符数
 *      4:{1:{…, 2:{1: 长度}}}  字体 run 覆盖的字符数
 *      5:{1: 长度}             文档总长度
 * 2) run 结构必须自洽。Apple 多次编辑过的文档会有多个属性 run（各 run 长度之和
 *    并不等于正文长度，属于 CRDT 的插入历史）。直接把正文换掉、却留下旧 run，
 *    解析器会读到越界的 run 而整条标题渲染为空。
 *
 * 所以这里统一把文档「压平」成一个 run —— 与 Apple 新写入一条标题时的结构一致：
 *    [锚点 run(长度 0)] [正文 run(长度 N)] [结尾哨兵 run(长度 0)]
 */
function encodeTitleLike(sampleB64, title) {
  const text = String(title);
  const len = text.length; // Apple 按 UTF-16 码元计数，与 JS 的 length 一致
  const gz = isGzip(Buffer.from(sampleB64, 'base64'));
  const raw = decodeDoc(sampleB64);

  const l1 = parseFields(raw);
  const i2 = l1.findIndex(x => x.field === 2 && x.wire === 2);
  if (i2 < 0) throw new Error('标题文档结构异常（缺 field2）');
  const l2 = parseFields(l1[i2].value);
  const i3 = l2.findIndex(x => x.field === 3 && x.wire === 2);
  if (i3 < 0) throw new Error('标题文档结构异常（缺 field3）');
  const l3 = parseFields(l2[i3].value);

  const isVarint = n => (x => x.field === n && x.wire === 0);

  /* ---- 1) 正文 ---- */
  const is = l3.findIndex(x => x.field === 2 && x.wire === 2);
  if (is < 0) throw new Error('标题文档结构异常（缺文本节点）');
  l3[is] = { field: 2, wire: 2, value: Buffer.from(text, 'utf8') };

  /* ---- 2) 属性 run：压平成一个 ---- */
  const runPos = [];
  const runs = [];
  l3.forEach((f, i) => {
    if (f.field !== 3 || f.wire !== 2) return;
    runPos.push(i);
    const fields = parseFields(f.value);
    const li = fields.findIndex(isVarint(2));
    const ts = fields.find(x => x.field === 1 && x.wire === 2);
    const tsFields = ts ? parseFields(ts.value) : [];
    const replicaIdx = tsFields.find(isVarint(2));
    runs.push({ fields, lenIdx: li, len: li >= 0 ? fields[li].value : 0, sentinel: !!(replicaIdx && replicaIdx.value === 4294967295) });
  });
  if (!runs.length) throw new Error('标题文档结构异常（缺属性 run）');

  const anchor = runs.find(r => !r.sentinel && r.len === 0) || runs[0];
  const sentinel = runs.find(r => r.sentinel);
  const textRun = [...runs].reverse().find(r => r.len > 0) || anchor;

  const rebuilt = [];
  // 锚点（长度 0，必须保留）
  {
    const f = anchor.fields.slice();
    if (anchor.lenIdx >= 0) f[anchor.lenIdx] = { field: 2, wire: 0, value: 0 };
    rebuilt.push({ field: 3, wire: 2, value: encodeFields(f) });
  }
  // 正文 run（长度 N）
  {
    const f = textRun.fields.slice();
    if (textRun.lenIdx >= 0) f[textRun.lenIdx] = { field: 2, wire: 0, value: len };
    rebuilt.push({ field: 3, wire: 2, value: encodeFields(f) });
  }
  // 结尾哨兵（replica 序号 0xFFFFFFFF，长度 0）
  if (sentinel) {
    const f = sentinel.fields.slice();
    if (sentinel.lenIdx >= 0) f[sentinel.lenIdx] = { field: 2, wire: 0, value: 0 };
    rebuilt.push({ field: 3, wire: 2, value: encodeFields(f) });
  }

  // 用新 run 列表替换原有位置
  const before = l3.slice(0, runPos[0]);
  const after = l3.slice(runPos[runPos.length - 1] + 1);
  const next = [...before, ...rebuilt, ...after];

  /* ---- 3) 字体 run：只保留第一个，长度改为 N ---- */
  const i4 = next.findIndex(x => x.field === 4 && x.wire === 2);
  if (i4 >= 0) {
    const l4 = parseFields(next[i4].value);
    const keep = l4.filter(x => x.field === 1 && x.wire === 2).slice(0, 1);
    let built = null;
    if (keep.length) {
      const inner = parseFields(keep[0].value);
      const iLen = inner.findIndex(x => x.field === 2 && x.wire === 2);
      if (iLen >= 0) {
        const lv = parseFields(inner[iLen].value);
        const iv = lv.findIndex(x => x.field === 1 && x.wire === 0);
        if (iv >= 0) lv[iv] = { field: 1, wire: 0, value: len };
        inner[iLen] = { field: 2, wire: 2, value: encodeFields(lv) };
        built = { field: 1, wire: 2, value: encodeFields(inner) };
      }
    }
    next[i4] = {
      field: 4,
      wire: 2,
      value: encodeFields(built ? [built, { field: 2, wire: 2, value: encodeFields([{ field: 1, wire: 0, value: 1 }]) }] : l4),
    };
  }

  /* ---- 4) 文档总长度 ---- */
  const i5 = next.findIndex(x => x.field === 5 && x.wire === 2);
  if (i5 >= 0) {
    const l5 = parseFields(next[i5].value);
    const iv = l5.findIndex(x => x.field === 1 && x.wire === 0);
    if (iv >= 0) {
      l5[iv] = { field: 1, wire: 0, value: len };
      next[i5] = { field: 5, wire: 2, value: encodeFields(l5) };
    }
  }

  l2[i3] = { field: 3, wire: 2, value: encodeFields(next) };
  l1[i2] = { field: 2, wire: 2, value: encodeFields(l2) };
  return encodeDoc(encodeFields(l1), gz);
}

/** 校验写出的标题文档是否自洽（手机端能否正常显示的关键） */
function checkTitleDoc(b64, title) {
  try {
    const raw = decodeDoc(b64);
    const f2 = parseFields(raw).find(x => x.field === 2 && x.wire === 2);
    if (!f2) return { ok: false, reason: '缺 field2' };
    const f3 = parseFields(f2.value).find(x => x.field === 3 && x.wire === 2);
    if (!f3) return { ok: false, reason: '缺 field3' };
    const l3 = parseFields(f3.value);
    const t = l3.find(x => x.field === 2 && x.wire === 2);
    const str = t ? t.value.toString('utf8') : '';
    const expect = title === undefined ? str.length : String(title).length;
    const lens = [];
    for (const f of l3) {
      if (f.field !== 3 || f.wire !== 2) continue;
      const r = parseFields(f.value).find(x => x.field === 2 && x.wire === 0);
      if (r) lens.push(r.value);
    }
    const f5 = l3.find(x => x.field === 5 && x.wire === 2);
    const total = f5 ? (parseFields(f5.value).find(x => x.field === 1 && x.wire === 0) || {}).value : null;
    const want = title === undefined ? str : String(title);
    // 判断标准只取「总长度 = 正文长度」：这是 iPhone 解析的必要条件。
    // 多次编辑过的原生记录会有多个属性 run，长度之和允许大于总长，不能据此判坏。
    const ok = str === want && total === expect;
    return { ok, text: str, expect, total, runs: lens };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}


/**
 * 备注文档：结构与标题一致，文本在 protobuf{2:protobuf{3:protobuf{2}}}}。
 *
 * 和标题不同的是：备注通常是**多段富文本**，Apple 会把内容切成多个文本节点
 * （每段一个，甚至一次编辑一个）。只读第一个文本节点会只留下开头几个字，
 * 所以这里把所有文本节点按出现顺序拼起来。
 */
function decodeNotes(b64) {
  if (!b64) return null;
  try {
    const raw = decodeDoc(b64);
    const f2 = parseFields(raw).find(x => x.field === 2 && x.wire === 2);
    if (!f2) return null;
    const f3 = parseFields(f2.value).find(x => x.field === 3 && x.wire === 2);
    if (!f3) return null;
    const parts = [];
    for (const f of parseFields(f3.value)) {
      if (f.field === 2 && f.wire === 2 && f.value.length) parts.push(f.value.toString('utf8'));
    }
    if (!parts.length) return null;
    // \u2028 是 Apple 在富文本里用的换行分隔符
    const s = parts.join('').replace(/\u2028/g, '\n').replace(/\r\n?/g, '\n').trim();
    return s || null;
  } catch {
    return null;
  }
}

/* ---------------- 日期 / 提前提醒 ---------------- */

const CF_LIST_ZONE = { zoneName: 'Reminders' };

function localTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; } catch { return 'Asia/Shanghai'; }
}

/** 时间戳 → iOS 的 DateComponents（AlarmTrigger.DateComponentsData 就是它的 JSON） */
function toDateComponents(ms) {
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: 0,
    era: 1,
    timeZone: { identifier: localTz() },
  };
}

function fromDateComponents(o) {
  if (!o || !o.year) return null;
  return new Date(o.year, (o.month || 1) - 1, o.day || 1, o.hour || 0, o.minute || 0, o.second || 0, 0).getTime();
}

/** iOS 设置里的标准提前量（分钟）。0 = 准时提醒 */
const ALARM_PRESETS = [0, 5, 15, 30, 60, 120, 1440, 2880, 10080];

/** 把提前量说成人话，与 iOS 设置面板的措辞一致 */
function describeAlarm(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 0) return null;
  if (m === 0) return '准时提醒';
  if (m < 60) return `提前 ${m} 分钟`;
  if (m === 60) return '提前 1 小时';
  if (m < 1440) {
    const h = m / 60;
    return `提前 ${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  }
  if (m === 1440) return '提前 1 天';
  if (m === 2880) return '提前 2 天';
  if (m === 10080) return '提前 1 周';
  const d = m / 1440;
  return `提前 ${Number.isInteger(d) ? d : d.toFixed(1)} 天`;
}

/* ---------------- 客户端 ---------------- */
class CloudKitClient {
  constructor(session) {
    this.session = session;
    this.ckBase = (session.webservices?.ckdatabasews?.url || '').replace(/\/$/, '');
    if (!this.ckBase) throw new Error('会话中没有 ckdatabasews 服务地址，请重新登录');
    this.cookie = Object.entries(session.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
    this.token = session.cookies?.['X-APPLE-WEBAUTH-TOKEN'] || '';
    this.site = /\.com\.cn/.test(this.ckBase) ? 'https://www.icloud.com.cn' : 'https://www.icloud.com';
  }

  async call(method, body) {
    const MAX = 5;
    for (let attempt = 1; ; attempt++) {
      // CloudKit 对同一账号有突发限流，连续十几个 lookup 就会 THROTTLED。
      // 这里给请求之间留一点间隔，配合下面的退避，避免整次刷新被打挂。
      const gap = 260 - (Date.now() - (this._lastCall || 0));
      if (gap > 0) await new Promise(res => setTimeout(res, gap));
      this._lastCall = Date.now();

      const r = await fetch(`${this.ckBase}/database/1/com.apple.reminders/production/private/records/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Accept': 'application/json',
          'Cookie': this.cookie,
          'X-APPLE-WEBAUTH-TOKEN': this.token,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Origin': this.site,
          'Referer': this.site + '/',
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      if (r.ok) return json;

      // CloudKit 偶发限流，按它给的时间（不够就翻倍）等一下重试，别当失败
      if ((json?.serverErrorCode === 'THROTTLED' || r.status === 503) && attempt < MAX) {
        const advice = Number(json?.retryAfter || 0) * 1000;
        const backoff = Math.min(10000, Math.max(advice, 1500 * Math.pow(2, attempt - 1)));
        await new Promise(res => setTimeout(res, backoff));
        continue;
      }
      const e = new Error(`CloudKit ${method} HTTP ${r.status}: ${json?.serverErrorCode || ''} ${json?.reason || text.slice(0, 200)}`);
      e.status = r.status;
      e.payload = json;
      throw e;
    }
  }

  async queryLists() {
    const j = await this.call('query', {
      zoneID: { zoneName: 'Reminders' },
      query: { recordType: 'Lists' },
      resultsLimit: 200,
    });
    return (j.records || [])
      .filter(r => (r.fields?.Deleted?.value ?? 0) === 0 && (r.fields?.IsGroup?.value ?? 0) === 0)
      .map(r => {
        let ids = r.fields?.ReminderIDs?.value;
        if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
        return {
          recordName: r.recordName,
          name: r.fields?.Name?.value || '(未命名)',
          color: parseColor(r.fields?.Color?.value),
          count: r.fields?.Count?.value ?? 0,
          reminderIds: Array.isArray(ids) ? ids : [],
          record: r,
        };
      });
  }

  async lookupReminders(ids) {
    if (!ids.length) return [];
    const out = [];
    const CHUNK = 50;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const records = ids.slice(i, i + CHUNK).map(x => ({
        recordName: String(x).includes('/') ? String(x) : `Reminder/${x}`,
      }));
      const j = await this.call('lookup', { records, zoneID: { zoneName: 'Reminders' } });
      out.push(...(j.records || []));
    }
    return out;
  }

  /** 读取所有列表及其未删除的提醒事项 */
  async fetchAll() {
    const lists = await this.queryLists();
    const staged = [];
    const all = [];
    for (const l of lists) {
      const recs = (await this.lookupReminders(l.reminderIds))
        .filter(r => (r.fields?.Deleted?.value ?? 0) === 0);
      staged.push({ list: l, recs });
      all.push(...recs);
    }

    // 提前提醒是独立记录（Alarm → AlarmTrigger），一次批量取回，避免逐条请求
    let alarmMap = new Map();
    try { alarmMap = await this.loadAlarms(all); } catch { /* 提醒时间读不到不影响主列表 */ }

    const byName = new Map();
    for (const { list, recs } of staged) {
      const items = recs.map(r => this.normalize(r, list, alarmMap.get(r.recordName) || []));
      byName.set(list.recordName, { list, items });
    }
    return byName;
  }

  /**
   * 批量读取提前提醒。
   * 链路：Reminder.AlarmIDs → Alarm 记录（TriggerID）→ AlarmTrigger.DateComponentsData
   * DateComponentsData 是 base64 的 JSON（年月日时分 + 时区），即「提醒触发的绝对时刻」。
   * 于是提前量 = DueDate − 触发时刻。
   */
  async loadAlarms(recs) {
    // Alarm / AlarmTrigger 的 id 每次改动都会新生成，所以「见过就复用」天然不会读到旧值，
    // 可以把逐次刷新的两次批量请求省掉（CloudKit 限流很紧）
    if (!this._alarmRecs) this._alarmRecs = new Map();  // alarmId -> record | null
    if (!this._trigCache) this._trigCache = new Map();  // triggerId -> DateComponentsData | null
    if (this._alarmRecs.size > 4000) this._alarmRecs.clear();
    if (this._trigCache.size > 4000) this._trigCache.clear();

    const map = new Map();
    const ids = [];
    for (const r of recs) {
      const a = r.fields?.AlarmIDs?.value;
      if (Array.isArray(a) && a.length) ids.push(...a.map(x => String(x)));
    }
    if (!ids.length) return map;

    const uniqIds = [...new Set(ids)];
    const unknown = uniqIds.filter(x => !this._alarmRecs.has(x));
    for (let i = 0; i < unknown.length; i += 50) {
      const chunk = unknown.slice(i, i + 50);
      const j = await this.call('lookup', {
        records: chunk.map(x => ({ recordName: 'Alarm/' + x })),
        zoneID: CF_LIST_ZONE,
      });
      const got = new Set();
      for (const a of j.records || []) {
        const id = a.recordName.replace(/^Alarm\//, '');
        got.add(id);
        this._alarmRecs.set(id, a.fields ? a : null);
      }
      for (const x of chunk) if (!got.has(x)) this._alarmRecs.set(x, null);
    }

    const alarms = uniqIds
      .map(x => this._alarmRecs.get(x))
      .filter(a => a && (a.fields?.Deleted?.value ?? 0) !== 1);

    const trgIds = [...new Set(alarms.map(a => a.fields?.TriggerID?.value).filter(Boolean))];
    const unknownTrg = trgIds.filter(t => !this._trigCache.has(t));
    for (let i = 0; i < unknownTrg.length; i += 50) {
      const chunk = unknownTrg.slice(i, i + 50);
      const j = await this.call('lookup', {
        records: chunk.map(x => ({ recordName: 'AlarmTrigger/' + x })),
        zoneID: CF_LIST_ZONE,
      });
      const got = new Set();
      for (const t of j.records || []) {
        const id = t.recordName.replace(/^AlarmTrigger\//, '');
        got.add(id);
        this._trigCache.set(id, t.fields ? (t.fields.DateComponentsData?.value ?? null) : null);
      }
      for (const x of chunk) if (!got.has(x)) this._trigCache.set(x, null);
    }

    for (const a of alarms) {
      const remName = a.fields?.Reminder?.value?.recordName;
      if (!remName) continue;
      const tid = a.fields?.TriggerID?.value;
      const raw = tid ? this._trigCache.get(tid) : null;
      let at = null;
      if (raw) {
        try { at = fromDateComponents(JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))); } catch { at = null; }
      }
      const list = map.get(remName) || [];
      list.push({
        alarmId: a.recordName.replace(/^Alarm\//, ''),
        triggerId: tid || null,
        triggerType: null,
        at,
      });
      map.set(remName, list);
    }
    return map;
  }

  normalize(rec, list, alarms = []) {
    const f = rec.fields || {};
    const due = f.DueDate?.value ?? null;
    // 提前量取「最接近到期时间」的那条提醒（iOS 只会存一条）
    let alarmOffset = null;
    let alarmAt = null;
    if (due && alarms.length) {
      const withAt = alarms.filter(a => a.at);
      if (withAt.length) {
        const best = withAt.reduce((a, b) => (Math.abs(a.at - due) <= Math.abs(b.at - due) ? a : b));
        alarmAt = best.at;
        alarmOffset = Math.round((due - best.at) / 60000);
      }
    }
    return {
      id: rec.recordName,
      uid: rec.recordName.replace(/^Reminder\//, ''),
      title: decodeTitle(f.TitleDocument?.value) || '(无标题)',
      notes: decodeNotes(f.NotesDocument?.value),
      completed: (f.Completed?.value ?? 0) === 1,
      completedAt: f.CompletionDate?.value ?? null,
      created: f.CreationDate?.value ?? null,
      due,
      start: f.StartDate?.value ?? null,
      allDay: (f.AllDay?.value ?? 0) === 1,
      timeZone: f.TimeZone?.value || '',
      flagged: (f.Flagged?.value ?? 0) === 1,
      priority: f.Priority?.value ?? 0,
      alarmOffset,
      alarmAt,
      alarmId: alarms[0]?.alarmId || null,
      listName: list?.name || '',
      listId: list?.recordName || '',
      listColor: list?.color || '',
      record: rec,
    };
  }

  /** 更新字段：patch 为 { 字段名: value }，tokenFields 为需要递增版本的字段名 */
  async modifyFields(rec, patch, tokenFields = []) {
    const fields = {};
    for (const [k, v] of Object.entries(patch)) {
      fields[k] = v === null ? { value: null } : { value: v };
    }
    if (tokenFields.length && rec.fields?.ResolutionTokenMap?.value) {
      fields.ResolutionTokenMap = {
        value: bumpTokens(rec.fields.ResolutionTokenMap.value, tokenFields),
      };
    }
    const j = await this.call('modify', {
      zoneID: { zoneName: 'Reminders' },
      operations: [{
        operationType: 'update',
        record: {
          recordName: rec.recordName,
          recordType: 'Reminder',
          recordChangeTag: rec.recordChangeTag,
          fields,
        },
      }],
    });
    const updated = (j.records || [])[0] || null;
    // 把最新的 changeTag / 字段合并回原记录：连续多次写入时，下一次必须用新 tag，
    // 否则服务端会以 409 或静默丢弃的方式拒绝。
    if (updated) {
      if (updated.fields) rec.fields = Object.assign({}, rec.fields, updated.fields);
      if (updated.recordChangeTag) rec.recordChangeTag = updated.recordChangeTag;
    }
    return updated;
  }

  async setCompleted(rec, done) {
    const now = Date.now();
    const patch = {
      Completed: done ? 1 : 0,
      LastModifiedDate: now,
    };
    if (done) patch.CompletionDate = now;
    return this.modifyFields(rec, patch, ['completed', 'completionDate', 'lastModifiedDate']);
  }

  async setTitle(rec, title) {
    const sample = rec.fields?.TitleDocument?.value;
    if (!sample) throw new Error('该记录没有标题文档，无法改写');
    const doc = encodeTitleLike(sample, title);
    return this.modifyFields(rec, {
      TitleDocument: doc,
      LastModifiedDate: Date.now(),
    }, ['titleDocument', 'lastModifiedDate']);
  }

  async deleteReminder(rec) {
    return this.modifyFields(rec, {
      Deleted: 1,
      LastModifiedDate: Date.now(),
    }, ['deleted', 'lastModifiedDate']);
  }

  /* ---------- 优先级 / 旗标 / 备注 ---------- */

  /** 优先级只接受 Apple 的四个取值：0 无、1 高、5 中、9 低 */
  async setPriority(rec, priority) {
    const p = [0, 1, 5, 9].includes(Number(priority)) ? Number(priority) : 0;
    return this.modifyFields(rec, {
      Priority: p,
      LastModifiedDate: Date.now(),
    }, ['priority', 'lastModifiedDate']);
  }

  async setFlagged(rec, flagged) {
    return this.modifyFields(rec, {
      Flagged: flagged ? 1 : 0,
      LastModifiedDate: Date.now(),
    }, ['flagged', 'lastModifiedDate']);
  }

  /**
   * 找一条**有真实内容**的备注文档当模板。
   * 不能用空备注当模板：Apple 的空文档没有总长字段（field5），
   * 拿它当骨架写出来的文档会缺长度元数据，iPhone 上会显示空白。
   */
  async findNotesTemplate() {
    if (this._notesTemplate !== undefined) return this._notesTemplate;
    this._notesTemplate = null;
    const lists = await this.queryLists();
    for (const l of lists) {
      const recs = await this.lookupReminders(l.reminderIds);
      for (const r of recs) {
        if ((r.fields?.Deleted?.value ?? 0) === 1) continue;
        const doc = r.fields?.NotesDocument?.value;
        if (!doc) continue;
        if (!decodeNotes(doc)) continue;
        const probe = encodeTitleLike(doc, 'x');
        if (checkTitleDoc(probe, 'x').ok) { this._notesTemplate = doc; break; }
      }
      if (this._notesTemplate) break;
    }
    return this._notesTemplate;
  }

  /**
   * 写备注。备注文档与标题文档同构，直接复用「压平成单 run」的逻辑：
   * 三处长度元数据同步 + run 结构自洽，iPhone 才不会显示空白。
   * 代价：富文本的原生格式（粗体/列表色块）会被压平为纯文本，文字内容不丢。
   * 段落分隔用 U+2028（Apple 富文本内部的换行符）。
   */
  async setNotes(rec, text) {
    const t = String(text ?? '').replace(/\r\n?/g, '\n');
    const enc = t.trim() ? t.replace(/\n/g, '\u2028') : '';
    // 骨架优先用这条记录自己的备注文档；它若是空文档（无总长字段）就退回全局模板
    const candidates = [];
    if (rec.fields?.NotesDocument?.value) candidates.push(rec.fields.NotesDocument.value);
    const tpl = await this.findNotesTemplate();
    if (tpl) candidates.push(tpl);
    if (!candidates.length) {
      if (!t.trim()) return null;
      throw new Error('没有可用的备注模板，无法写入备注');
    }
    let doc = null;
    for (const sample of candidates) {
      try {
        const d = encodeTitleLike(sample, enc);
        if (checkTitleDoc(d, enc).ok) { doc = d; break; }
      } catch { /* 试下一个骨架 */ }
    }
    if (!doc) throw new Error('备注文档长度校验失败，已放弃写入');
    return this.modifyFields(rec, {
      NotesDocument: doc,
      LastModifiedDate: Date.now(),
    }, ['notesDocument', 'lastModifiedDate']);
  }

  /* ---------- 日期 / 提前提醒 ---------- */

  /**
   * 一次写入「日期 + 提前提醒」。
   *
   * 为什么必须合成一个请求：
   *   iOS 在到期时间变化时会重算/清空提醒，如果先写日期、再单独写提醒，
   *   第二次提交的 AlarmIDs 会被服务端覆盖掉（本地看起来成功，云端却读不到）。
   *   把 create Alarm + create AlarmTrigger + update Reminder 放进同一个原子批次，
   *   服务端就不会互相覆盖。
   *
   * 注意：创建 Alarm 时不能带 parent 字段——那会让 CloudKit 认为同批次里
   * Reminder 被更新两次，整批以 "Record updated multiple times in one batch" 失败。
   */
  async setDueAndAlarm(rec, dueMs, allDay, offsetMinutes) {
    const now = Date.now();
    const ops = [];

    // 1) 旧提醒标记删除（Alarm 与 AlarmTrigger 都要，和 Apple 的做法一致）
    const oldIds = (rec.fields?.AlarmIDs?.value || []).filter(Boolean).map(String);
    if (oldIds.length) {
      try {
        const alarms = (await this.call('lookup', {
          records: oldIds.map(x => ({ recordName: 'Alarm/' + x })),
          zoneID: CF_LIST_ZONE,
        })).records || [];
        const trgIds = [];
        for (const a of alarms) {
          if (!a.fields) continue;
          if (a.fields.TriggerID?.value) trgIds.push(a.fields.TriggerID.value);
          ops.push({
            operationType: 'update',
            record: {
              recordName: a.recordName, recordType: 'Alarm',
              recordChangeTag: a.recordChangeTag,
              fields: { Deleted: { value: 1 } },
            },
          });
        }
        if (trgIds.length) {
          const trgs = (await this.call('lookup', {
            records: trgIds.map(x => ({ recordName: 'AlarmTrigger/' + x })),
            zoneID: CF_LIST_ZONE,
          })).records || [];
          for (const t of trgs) {
            if (!t.fields) continue;
            ops.push({
              operationType: 'update',
              record: {
                recordName: t.recordName, recordType: 'AlarmTrigger',
                recordChangeTag: t.recordChangeTag,
                fields: { Deleted: { value: 1 } },
              },
            });
          }
        }
      } catch { /* 旧提醒清不掉不影响新提醒 */ }
    }

    // 2) 新提醒：DateComponents 存的是「到期时间 − 提前量」的绝对时刻
    let newAlarmId = null;
    if (dueMs && offsetMinutes !== null && offsetMinutes !== undefined) {
      newAlarmId = newUuid();
      const triggerId = newUuid();
      const at = Number(dueMs) - Number(offsetMinutes) * 60000;
      ops.push({
        operationType: 'create',
        record: {
          recordName: 'Alarm/' + newAlarmId,
          recordType: 'Alarm',
          fields: {
            AlarmUID: { value: newAlarmId },
            Reminder: { value: { recordName: rec.recordName, action: 'VALIDATE' } },
            TriggerID: { value: triggerId },
            Imported: { value: 0 },
            Deleted: { value: 0 },
          },
        },
      });
      ops.push({
        operationType: 'create',
        record: {
          recordName: 'AlarmTrigger/' + triggerId,
          recordType: 'AlarmTrigger',
          fields: {
            DateComponentsData: { value: Buffer.from(JSON.stringify(toDateComponents(at))).toString('base64') },
            Type: { value: 'Date' },
            Alarm: { value: { recordName: 'Alarm/' + newAlarmId, action: 'VALIDATE' } },
            Imported: { value: 0 },
            Deleted: { value: 0 },
          },
        },
      });
    }

    // 3) 记录本体：日期与 AlarmIDs 同一个字段集合
    const fields = {
      AlarmIDs: { value: newAlarmId ? [newAlarmId] : [] },
      LastModifiedDate: { value: now },
    };
    if (dueMs) {
      fields.DueDate = { value: Number(dueMs) };
      fields.AllDay = { value: allDay ? 1 : 0 };
      fields.TimeZone = { value: localTz() };
    } else {
      fields.DueDate = { value: null };
      fields.AllDay = { value: 1 };
    }
    ops.push({
      operationType: 'update',
      record: {
        recordName: rec.recordName, recordType: 'Reminder',
        recordChangeTag: rec.recordChangeTag, fields,
      },
    });

    const j = await this.call('modify', { zoneID: CF_LIST_ZONE, operations: ops });
    const updated = (j.records || []).find(r => r.recordName === rec.recordName) || null;
    if (updated?.fields) rec.fields = Object.assign({}, rec.fields, updated.fields);
    if (updated?.recordChangeTag) rec.recordChangeTag = updated.recordChangeTag;
    rec.fields.AlarmIDs = { value: newAlarmId ? [newAlarmId] : [] };
    return updated;
  }

  /** 写到期时间（dueMs 为 null/0 时清空日期） */
  async setDue(rec, dueMs, allDay) {
    const offset = (rec.fields?.AlarmIDs?.value || []).length ? 0 : null;
    return this.setDueAndAlarm(rec, dueMs, allDay, dueMs ? offset : null);
  }

  /**
   * 设置提前提醒（offsetMinutes = 0 表示准时提醒）。
   * iOS 把提醒存成「绝对时刻」：AlarmTrigger.DateComponentsData = 到期时间 − 提前量。
   */
  async setAlarm(rec, dueMs, offsetMinutes) {
    const allDay = (rec.fields?.AllDay?.value ?? 0) === 1;
    return this.setDueAndAlarm(rec, dueMs, allDay, offsetMinutes);
  }

  /* ---------- 新建 / 删除（需同时维护 List.ReminderIDs） ---------- */

  /** 取一条现成记录的标题文档当模板（保留 Apple 的 CRDT 结构） */
  async findTitleTemplate() {
    const lists = await this.queryLists();
    for (const l of lists) {
      const recs = await this.lookupReminders(l.reminderIds.slice(0, 5));
      const hit = recs.find(r => r.fields?.TitleDocument?.value && (r.fields?.Deleted?.value ?? 0) === 0);
      if (hit) return hit.fields.TitleDocument.value;
    }
    return null;
  }

  /** 更新指定列表的 ReminderIDs（append 或 remove），返回新列表记录 */
  async patchListIds(listRecordName, mutate, retry = 2) {
    const lists = await this.queryLists();
    const fresh = lists.find(l => l.recordName === listRecordName);
    if (!fresh) throw new Error('目标列表不存在');
    let ids = fresh.reminderIds.slice();
    const before = ids.length;
    ids = mutate(ids);
    if (process.env.CK_DEBUG) console.error('[patchListIds]', listRecordName, before, '->', ids.length, 'tag=', fresh.record?.recordChangeTag);
    if (ids.length === before) return fresh.record;

    const listRec = fresh.record;
    // 关键：只提交 ReminderIDs。
    // 实测附带 Count 会让服务端静默丢弃整条更新（返回体无 records，tag 不变）；
    // 附带 ResolutionTokenMap 同样无效。Count 由服务端自行重算，不必维护。
    const fields = {
      ReminderIDs: { value: JSON.stringify(ids) },
    };

    try {
      const j = await this.call('modify', {
        zoneID: { zoneName: 'Reminders' },
        operations: [{
          operationType: 'update',
          record: {
            recordName: listRec.recordName,
            recordType: 'List',
            recordChangeTag: listRec.recordChangeTag,
            fields,
          },
        }],
      });
      return (j.records || [])[0] || listRec;
    } catch (e) {
      // 典型为 changeTag 冲突（其他设备同时修改），重读后重试
      if (retry > 0 && (e.status === 409 || /CHANGE_TAG|CONFLICT/i.test(String(e.message)))) {
        return this.patchListIds(listRecordName, mutate, retry - 1);
      }
      throw e;
    }
  }

  /**
   * 新建提醒
   * @param {object} list  queryLists 返回的列表对象
   * @param {string} title
   * @param {object|number|null} opts  可直接传到期毫秒数，或
   *        { dueMs, allDay, priority, flagged, notes, offsetMinutes }
   */
  async createReminder(list, title, opts = null) {
    const o = typeof opts === 'number' ? { dueMs: opts } : (opts || {});
    const template = await this.findTitleTemplate();
    if (!template) throw new Error('无法获取标题模板，新建失败');

    const uuid = newUuid();
    const now = Date.now();
    const titleDoc = encodeTitleLike(template, title);
    const chk = checkTitleDoc(titleDoc, title);
    if (!chk.ok) throw new Error('标题文档长度校验失败：' + JSON.stringify(chk));

    const record = {
      recordName: `Reminder/${uuid}`,
      recordType: 'Reminder',
      fields: {
        TitleDocument: { value: titleDoc },
        Completed: { value: 0 },
        CreationDate: { value: now },
        LastModifiedDate: { value: now },
        Priority: { value: [0, 1, 5, 9].includes(Number(o.priority)) ? Number(o.priority) : 0 },
        AllDay: { value: o.dueMs && !o.allDay ? 0 : 1 },
        Flagged: { value: o.flagged ? 1 : 0 },
        Deleted: { value: 0 },
        List: { value: { recordName: list.recordName, action: 'VALIDATE' } },
        ResolutionTokenMap: { value: freshTokenMap(null) },
      },
    };
    if (o.dueMs) {
      record.fields.DueDate = { value: Number(o.dueMs) };
      record.fields.TimeZone = { value: localTz() };
    }
    if (o.notes && String(o.notes).trim()) {
      const tpl = await this.findNotesTemplate();
      if (tpl) {
        const noteText = String(o.notes).replace(/\r\n?/g, '\n').replace(/\n/g, '\u2028');
        const doc = encodeTitleLike(tpl, noteText);
        if (checkTitleDoc(doc, noteText).ok) record.fields.NotesDocument = { value: doc };
      }
    }

    // 顺序很关键：必须先把 ID 挂进列表，再创建记录。
    // 反之（先 create 再 update List）服务端会静默丢弃列表更新。
    await this.patchListIds(list.recordName, ids => (ids.includes(uuid) ? ids : [...ids, uuid]));

    let created;
    try {
      const j = await this.call('modify', {
        zoneID: CF_LIST_ZONE,
        operations: [{ operationType: 'create', record }],
      });
      created = (j.records || [])[0];
    } catch (e) {
      // 创建失败则把刚挂上的 ID 摘掉，避免留下孤儿
      try {
        await this.patchListIds(list.recordName, ids => ids.filter(x => String(x).toUpperCase() !== uuid));
      } catch { /* ignore */ }
      throw e;
    }

    // 提前提醒要单独建 Alarm 链，等记录存在之后再做
    if (o.dueMs && o.offsetMinutes !== null && o.offsetMinutes !== undefined) {
      const rec = created?.fields ? created : (await this.lookupReminders([uuid]))[0];
      if (rec) {
        try { await this.setAlarm(rec, Number(o.dueMs), Number(o.offsetMinutes)); }
        catch (e) { if (process.env.CK_DEBUG) console.error('[createReminder] alarm failed:', e.message); }
      }
    }
    return { recordName: `Reminder/${uuid}`, uuid, record: created };
  }

  /** 删除提醒：标记 Deleted 并从列表 ReminderIDs 摘除 */
  async removeReminder(item) {
    const rec = item.record;
    await this.modifyFields(rec, { Deleted: 1, LastModifiedDate: Date.now() }, ['deleted', 'lastModifiedDate']);
    if (item.listId) {
      const uid = String(item.uid).toUpperCase();
      try {
        await this.patchListIds(item.listId, ids => ids.filter(x => String(x).toUpperCase() !== uid));
      } catch { /* 摘除失败不影响主流程，下次刷新会以 Deleted 过滤 */ }
    }
  }
}

function freshTokenMap(sample) {
  let obj = { map: {} };
  if (sample) {
    try { obj = JSON.parse(sample); } catch { /* ignore */ }
  }
  if (!obj.map) obj.map = {};
  const t = cfNow();
  for (const k of Object.keys(obj.map)) {
    obj.map[k] = { counter: 1, replicaID: newUuid(), modificationTime: t };
  }
  return JSON.stringify(obj);
}

function bumpTokens(mapStr, names) {
  let obj;
  try { obj = JSON.parse(mapStr); } catch { return mapStr; }
  if (!obj.map) obj.map = {};
  const t = cfNow();
  for (const n of names) {
    const cur = obj.map[n] || { counter: 0, replicaID: newUuid(), modificationTime: t };
    cur.counter = (cur.counter || 0) + 1;
    cur.modificationTime = t;
    if (!cur.replicaID) cur.replicaID = newUuid();
    obj.map[n] = cur;
  }
  return JSON.stringify(obj);
}

function parseColor(s) {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if (o.daHexString) return o.daHexString;
    const r = Math.round((o.red ?? 0) * 255), g = Math.round((o.green ?? 0) * 255), b = Math.round((o.blue ?? 0) * 255);
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

module.exports = {
  CloudKitClient,
  decodeTitle,
  decodeNotes,
  encodeTitleLike,
  checkTitleDoc,
  parseFields,
  encodeFields,
  cfNow,
  newUuid,
  ALARM_PRESETS,
  describeAlarm,
  toDateComponents,
  fromDateComponents,
};
