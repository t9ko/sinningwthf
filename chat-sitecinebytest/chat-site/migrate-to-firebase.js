// One-time mover: copies accounts, friends, groups, the news channel and messages from the old
// chat.db into Firebase, so everyone can log in to the new site with the same username and password.
//
// It only runs when the FIREBASE_SERVICE_ACCOUNT setting is present, and only once (it leaves a
// "firebase-migrated.json" file in the data folder when it is done). It never changes chat.db.
// No packages needed: Node.js 22.13 or newer.
'use strict';
const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...a) => {
  if (a[0] === 'ExperimentalWarning' || (a[0] && a[0].type === 'ExperimentalWarning')) return;
  origEmitWarning.call(process, w, ...a);
};
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MARKER = path.join(DATA_DIR, 'firebase-migrated.json');
const DRY = process.env.MIGRATE_DRY_RUN === '1';
const MAX_MESSAGES = Number(process.env.MIGRATE_MAX_MESSAGES || 15000); // Firebase free plan: 20,000 writes a day
const log = (...a) => console.log('[firebase move]', ...a);

/* ---------- Google sign-in with the service account ---------- */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Google sign-in failed: ' + JSON.stringify(j));
  return j.access_token;
}

/* ---------- Firestore values ---------- */
function val(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } };
  return { mapValue: { fields: fields(v) } };
}
function fields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = val(v);
  return out;
}

/* ---------- reading files from the old uploads folder ---------- */
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
function fileAsDataUrl(url, maxChars) {
  if (!url || typeof url !== 'string' || !url.includes('/uploads/')) return null;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    const st = fs.statSync(file);
    if (st.size * 1.34 + 40 > maxChars) return null;
    const out = 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
    return out.length <= maxChars ? out : null;
  } catch {
    return null;
  }
}

/* ---------- build everything from chat.db ---------- */
function build(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const uid = (id) => 'old' + id;
  const now = Date.now();

  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const userById = new Map(users.map((u) => [u.id, u]));

  // messages, newest kept if there are too many
  const msgCols = { room: has('messages', 'room_id'), expires: has('messages', 'expires'), reply: has('messages', 'reply_to'), edited: has('messages', 'edited') };
  let rows = db.prepare('SELECT * FROM messages ORDER BY id').all()
    .filter((m) => !(msgCols.expires && m.expires && m.expires <= now))
    .filter((m) => userById.has(m.sender_id));
  let dropped = 0;
  if (rows.length > MAX_MESSAGES) {
    dropped = rows.length - MAX_MESSAGES;
    rows = rows.slice(-MAX_MESSAGES);
  }
  const rowById = new Map(rows.map((m) => [m.id, m]));
  const reactions = new Map();
  for (const r of db.prepare('SELECT * FROM reactions').all()) {
    if (!rowById.has(r.message_id) || !userById.has(r.user_id)) continue;
    const map = reactions.get(r.message_id) || {};
    (map[uid(r.user_id)] = map[uid(r.user_id)] || []).push(r.emoji);
    reactions.set(r.message_id, map);
  }

  // rooms: groups and the news channel
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY id').all();
  const kindCol = has('rooms', 'kind');
  const newsRoom = kindCol ? rooms.find((r) => r.kind === 'news') : null;
  const chatIdOfRoom = (rid) => (newsRoom && rid === newsRoom.id ? 'news' : 'room' + rid);
  const roomMembers = new Map();
  for (const rm of db.prepare('SELECT * FROM room_members').all()) {
    if (!userById.has(rm.user_id)) continue;
    (roomMembers.get(rm.room_id) || roomMembers.set(rm.room_id, []).get(rm.room_id)).push(rm);
  }

  // one-to-one chats from the friends table (stored both ways)
  const dmKey = (a, b) => [uid(a), uid(b)].sort().join('_');
  const dms = new Map();
  for (const f of db.prepare('SELECT * FROM friends').all()) {
    if (!userById.has(f.user_id) || !userById.has(f.friend_id)) continue;
    const id = dmKey(f.user_id, f.friend_id);
    const c = dms.get(id) || { members: [uid(f.user_id), uid(f.friend_id)].sort(), cleared: {}, created: f.added || now };
    if (f.cleared_upto) c.clearedUpto = { ...(c.clearedUpto || {}), [uid(f.user_id)]: f.cleared_upto };
    dms.set(id, c);
  }

  const chatOfMsg = (m) => {
    if (msgCols.room && m.room_id) return chatIdOfRoom(m.room_id);
    return dmKey(m.sender_id, m.recipient_id);
  };
  const snippet = (m) => (m.type === 'image' ? 'Image' : m.type === 'voice' ? 'Voice message' : m.type === 'gif' ? 'GIF' : String(m.content || '').slice(0, 100));

  const messages = []; // { chat, id, data }
  const perChat = new Map(); // chat id -> { n, last }
  let imagesMoved = 0, imagesSkipped = 0, voiceSkipped = 0;
  for (const m of rows) {
    const chat = chatOfMsg(m);
    // only keep one-to-one messages if the two are still friends
    if (!chat.startsWith('room') && chat !== 'news' && !dms.has(chat)) continue;
    let type = m.type;
    let text = null;
    let image = null;
    if (type === 'image') {
      image = fileAsDataUrl(m.content, 900_000);
      if (image) imagesMoved++;
      else { imagesSkipped++; type = 'text'; text = '[picture was too big to move]'; }
    } else if (type === 'voice') {
      voiceSkipped++;
      type = 'text';
      text = '[voice message, could not be moved]';
    } else if (type === 'gif') {
      type = 'text';
      text = String(m.content || '');
    } else if (type === 'sys') {
      text = String(m.content || '');
    } else {
      type = 'text';
      text = String(m.content || '').slice(0, 4000);
    }
    const data = { from: uid(m.sender_id), type, reactions: reactions.get(m.id) || {}, created: new Date(m.created) };
    if (text !== null) data.text = text;
    if (image) data.image = image;
    if (msgCols.edited && m.edited) data.edited = true;
    if (msgCols.reply && m.reply_to && rowById.has(m.reply_to)) {
      const r = rowById.get(m.reply_to);
      data.reply = { id: 'm' + r.id, from: uid(r.sender_id), snip: snippet(r) };
    }
    messages.push({ chat, id: 'm' + m.id, data });
    const pc = perChat.get(chat) || { n: 0, last: null };
    pc.n++;
    pc.last = { id: 'm' + m.id, from: uid(m.sender_id), type, text: type === 'image' ? '' : (text || '').slice(0, 140), at: m.created };
    perChat.set(chat, pc);
  }
  const createdOfMsg = (id) => (rowById.get(id) || {}).created || 0;

  // chat documents
  const chats = [];
  for (const [id, c] of dms) {
    const pc = perChat.get(id) || { n: 0, last: null };
    const cleared = {};
    for (const [u, upto] of Object.entries(c.clearedUpto || {})) {
      // hide everything up to that old message on that person's side
      let t = createdOfMsg(upto);
      if (!t) for (const r of rows) if (r.id <= upto) t = r.created;
      if (t) cleared[u] = t;
    }
    chats.push({ id, data: { type: 'dm', members: c.members, n: pc.n, last: pc.last, readN: Object.fromEntries(c.members.map((u) => [u, pc.n])), cleared, created: c.created || now } });
  }
  for (const r of rooms) {
    const id = chatIdOfRoom(r.id);
    const pc = perChat.get(id) || { n: 0, last: null };
    if (id === 'news') {
      chats.push({ id, data: { type: 'news', name: r.name || 'News', n: pc.n, last: pc.last, created: r.created || now } });
      continue;
    }
    const members = (roomMembers.get(r.id) || []).map((rm) => uid(rm.user_id));
    if (!members.length) continue;
    chats.push({ id, data: { type: 'group', name: r.name || 'Group', owner: uid(r.owner_id), members, n: pc.n, last: pc.last, readN: Object.fromEntries(members.map((u) => [u, pc.n])), created: r.created || now } });
  }
  const newsN = (perChat.get('news') || { n: 0 }).n;

  // pending friend requests
  const requests = db.prepare('SELECT * FROM requests').all()
    .filter((q) => userById.has(q.from_id) && userById.has(q.to_id) && !dms.has(dmKey(q.from_id, q.to_id)))
    .map((q) => ({ id: uid(q.from_id) + '_' + uid(q.to_id), data: { from: uid(q.from_id), to: uid(q.to_id), created: q.created || now } }));

  // accounts
  const accounts = [];
  let badHash = 0;
  for (const u of users) {
    const name = String(u.username || '').toLowerCase();
    if (!/^[a-z0-9_.]{3,20}$/.test(name)) { badHash++; continue; }
    const [salt, hash] = String(u.pass_hash || '').split(':');
    if (!salt || !hash) { badHash++; continue; }
    const email = name.replace(/\./g, '-') + '-old' + u.id + '@users.sinning.chat';
    accounts.push({
      uid: uid(u.id),
      name,
      email,
      salt: b64url(Buffer.from(salt, 'hex')),
      hash: b64url(Buffer.from(hash, 'hex')),
      created: u.created || now,
      profile: {
        username: name,
        created: u.created || now,
        lastSeen: 0,
        avatar: fileAsDataUrl(u.avatar, 149_000),
        banner: has('users', 'banner') ? fileAsDataUrl(u.banner, 399_000) : null,
        newsRead: newsN,
      },
    });
  }

  return { accounts, chats, messages, requests, stats: { users: users.length, accounts: accounts.length, skippedAccounts: badHash, chats: chats.length, messages: messages.length, dropped, imagesMoved, imagesSkipped, voiceSkipped, requests: requests.length } };
}

/* ---------- send it to Firebase ---------- */
async function send(plan, sa) {
  const project = sa.project_id;
  const token = await getToken(sa);
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const docBase = `projects/${project}/databases/(default)/documents`;

  // 1. which usernames are already taken on the new site?
  const taken = new Set();
  for (const a of plan.accounts) {
    const r = await fetch(`https://firestore.googleapis.com/v1/${docBase}/usernames/${encodeURIComponent(a.name)}`, { headers: auth });
    if (r.ok) {
      const j = await r.json();
      const owner = j.fields && j.fields.uid && j.fields.uid.stringValue;
      if (owner && owner !== a.uid) taken.add(a.uid);
    }
  }
  if (taken.size) log('These usernames were already made on the new site, so those old accounts were NOT moved:',
    plan.accounts.filter((a) => taken.has(a.uid)).map((a) => a.name).join(', '));
  const accounts = plan.accounts.filter((a) => !taken.has(a.uid));
  const moved = new Set(accounts.map((a) => a.uid));

  // 2. logins (same passwords: the old site used standard scrypt N=16384 r=8 p=1, 64 bytes)
  for (let i = 0; i < accounts.length; i += 500) {
    const part = accounts.slice(i, i + 500);
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchCreate`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        hashAlgorithm: 'STANDARD_SCRYPT',
        cpuMemCost: 16384,
        parallelization: 1,
        blockSize: 8,
        dkLen: 64,
        users: part.map((a) => ({ localId: a.uid, email: a.email, emailVerified: false, passwordHash: a.hash, salt: a.salt, createdAt: String(a.created) })),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Making the logins failed: ' + JSON.stringify(j));
    for (const e of j.error || []) {
      const a = part[e.index];
      if (/exist/i.test(e.message || '')) continue; // already there from an earlier try
      log('Could not make the login for', a ? a.name : '?', '-', e.message);
      if (a) moved.delete(a.uid);
    }
  }

  // 3. everything else, in batches
  const writes = [];
  const put = (p, data) => writes.push({ update: { name: `${docBase}/${p}`, fields: fields(data) } });
  for (const a of accounts) {
    if (!moved.has(a.uid)) continue;
    put('usernames/' + a.name, { uid: a.uid, email: a.email });
    put('users/' + a.uid, a.profile);
  }
  const ok = (u) => moved.has(u);
  const keptChats = new Set();
  for (const c of plan.chats) {
    if (c.data.type === 'dm' && !c.data.members.every(ok)) continue;
    if (c.data.type === 'group') {
      c.data.members = c.data.members.filter(ok);
      if (!c.data.members.length) continue;
      if (!ok(c.data.owner)) c.data.owner = c.data.members[0];
    }
    keptChats.add(c.id);
    put('chats/' + c.id, c.data);
  }
  for (const q of plan.requests) if (ok(q.data.from) && ok(q.data.to)) put('requests/' + q.id, q.data);
  for (const m of plan.messages) if (keptChats.has(m.chat)) put(`chats/${m.chat}/messages/${m.id}`, m.data);

  let batch = [];
  let size = 0;
  let done = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await fetch(`https://firestore.googleapis.com/v1/${docBase}:commit`, { method: 'POST', headers: auth, body: JSON.stringify({ writes: batch }) });
    if (!r.ok) throw new Error('Saving to Firestore failed: ' + (await r.text()).slice(0, 500));
    done += batch.length;
    log(`saved ${done} of ${writes.length}`);
    batch = [];
    size = 0;
  };
  for (const w of writes) {
    const s = JSON.stringify(w).length;
    if (batch.length >= 400 || size + s > 8_000_000) await flush();
    batch.push(w);
    size += s;
  }
  await flush();
  return { moved: moved.size, notMoved: plan.accounts.length - moved.size, writes: writes.length };
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw && !DRY) return; // nothing to do
  if (fs.existsSync(MARKER) && !DRY) return log('Already moved earlier. Skipping. (Delete firebase-migrated.json in the data folder to run it again.)');
  const dbFile = path.join(DATA_DIR, 'chat.db');
  if (!fs.existsSync(dbFile)) return log('No chat.db found in', DATA_DIR, '- nothing to move.');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const plan = build(db);
  db.close();
  log('Found:', JSON.stringify(plan.stats));
  if (plan.stats.dropped) log(`Only the newest ${MAX_MESSAGES} messages are moved (Firebase free plan limit). ${plan.stats.dropped} older ones were left behind.`);
  if (DRY) return plan;
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole key file.');
  }
  const res = await send(plan, sa);
  fs.writeFileSync(MARKER, JSON.stringify({ at: new Date().toISOString(), ...plan.stats, ...res }, null, 2));
  log(`DONE. ${res.moved} accounts moved (${res.notMoved} not moved), ${res.writes} things saved. You can now remove FIREBASE_SERVICE_ACCOUNT from Railway.`);
}

if (require.main === module) {
  main().catch((err) => {
    log('FAILED:', err.message);
    log('Nothing on the old site was changed. Fix the problem and redeploy to try again.');
  });
}
module.exports = { build, main, fields };
