// Zero-dependency chat server. Needs Node.js 22.13 or newer. Run with: node server.js
const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...a) => {
  if (a[0] === 'ExperimentalWarning' || (a[0] && a[0].type === 'ExperimentalWarning')) return;
  origEmitWarning.call(process, w, ...a);
};

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT = 4000;
// Games: everything that is not part of this site (which lives under /~/) is fetched from here.
const GAMES_UPSTREAM = new URL(process.env.GAMES_UPSTREAM || 'https://duckmath.org');
// Keeps game code locked away from the chat (see README). Set GAMES_ISOLATE=0 to turn off.
const GAMES_ISOLATE = process.env.GAMES_ISOLATE !== '0';
const SANDBOX = 'allow-scripts allow-forms allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-modals allow-orientation-lock allow-presentation allow-downloads';
let ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
try {
  if (process.env.ICE_SERVERS) ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS);
} catch {
  console.log('  ICE_SERVERS is not valid JSON, using the default.');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    avatar TEXT,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friends (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cleared_upto INTEGER NOT NULL DEFAULT 0,
    read_upto INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    created INTEGER NOT NULL,
    reply_to INTEGER,
    edited INTEGER
  );
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS requests (
    from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages (sender_id, recipient_id, id);
`);
// upgrades for databases created by the first version
for (const sql of [
  'ALTER TABLE messages ADD COLUMN reply_to INTEGER',
  'ALTER TABLE messages ADD COLUMN edited INTEGER',
  'ALTER TABLE friends ADD COLUMN read_upto INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(sql);
  } catch {}
}

// everything this site owns now lives under /~/ so game paths can never clash with it
db.exec(`
  UPDATE users SET avatar = '/~' || avatar WHERE avatar LIKE '/uploads/%';
  UPDATE messages SET content = '/~' || content WHERE type IN ('image', 'voice') AND content LIKE '/uploads/%';
`);

const PAIR = '((sender_id = :a AND recipient_id = :b) OR (sender_id = :b AND recipient_id = :a))';
const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  addUser: db.prepare('INSERT INTO users (username, pass_hash, created) VALUES (?, ?, ?)'),
  setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
  setName: db.prepare('UPDATE users SET username = ? WHERE id = ?'),
  reqRow: db.prepare('SELECT 1 AS x FROM requests WHERE from_id = ? AND to_id = ?'),
  addReq: db.prepare('INSERT OR IGNORE INTO requests (from_id, to_id, created) VALUES (?, ?, ?)'),
  delReq: db.prepare('DELETE FROM requests WHERE from_id = ? AND to_id = ?'),
  reqIn: db.prepare('SELECT u.id, u.username, u.avatar FROM requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created DESC'),
  reqOut: db.prepare('SELECT u.id, u.username, u.avatar FROM requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created DESC'),
  reqPeers: db.prepare('SELECT to_id AS id FROM requests WHERE from_id = ? UNION SELECT from_id FROM requests WHERE to_id = ?'),
  setPass: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
  addSession: db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?'),
  userBySession: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  friendRow: db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?'),
  friendsOf: db.prepare(
    `SELECT u.id, u.username, u.avatar, f.cleared_upto, f.read_upto
     FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?`
  ),
  friendIds: db.prepare('SELECT friend_id FROM friends WHERE user_id = ?'),
  addFriend: db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, cleared_upto, read_upto) VALUES (?, ?, ?, ?)'),
  delFriend: db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?'),
  setCleared: db.prepare('UPDATE friends SET cleared_upto = ? WHERE user_id = ? AND friend_id = ?'),
  setRead: db.prepare('UPDATE friends SET read_upto = ? WHERE user_id = ? AND friend_id = ?'),
  maxMsgId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages'),
  lastFrom: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE sender_id = ? AND recipient_id = ?'),
  unread: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ? AND id > ?'),
  addMsg: db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, type, content, meta, created, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  editMsg: db.prepare('UPDATE messages SET content = ?, edited = ? WHERE id = ?'),
  msgById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  delMsg: db.prepare('DELETE FROM messages WHERE id = ?'),
  history: db.prepare(`SELECT * FROM messages WHERE ${PAIR} AND id > :after AND id < :before ORDER BY id DESC LIMIT 51`),
  lastMsg: db.prepare(`SELECT * FROM messages WHERE ${PAIR} AND id > :after ORDER BY id DESC LIMIT 1`),
  reactionsOf: db.prepare('SELECT user_id, emoji FROM reactions WHERE message_id = ?'),
  reaction: db.prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?'),
  setReaction: db.prepare('INSERT OR REPLACE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'),
  delReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?'),
};

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

const publicUser = (u) => ({ id: u.id, username: u.username, avatar: u.avatar || null });

function msgOut(m) {
  let reply = null;
  if (m.reply_to) {
    const r = q.msgById.get(m.reply_to);
    if (r) reply = { id: r.id, from: r.sender_id, type: r.type, content: r.type === 'text' ? r.content.slice(0, 140) : '' };
  }
  return {
    id: m.id,
    from: m.sender_id,
    to: m.recipient_id,
    type: m.type,
    content: m.content,
    meta: m.meta ? JSON.parse(m.meta) : null,
    created: m.created,
    edited: !!m.edited,
    reply,
    reactions: q.reactionsOf.all(m.id).map((r) => ({ user: r.user_id, emoji: r.emoji })),
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
async function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) {
      req.resume();
      return reject(new HttpError(413, 'File is too big (10 MB max).'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'File is too big (10 MB max).'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 50 * 1024);
  try {
    const data = JSON.parse(buf.toString('utf8') || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
}

function removeUpload(url) {
  if (!url || !url.startsWith('/~/uploads/')) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}
function saveUpload(buf, ext) {
  const name = crypto.randomBytes(18).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/~/uploads/' + name;
}

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const AUDIO_EXT = { 'audio/webm': 'weba', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

// tiny in-memory rate limiter
const buckets = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) buckets.set(key, (b = { n: 0, reset: now + windowMs }));
  if (++b.n > max) throw new HttpError(429, 'Slow down a little and try again.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

/* ---------- realtime (WebSocket, hand-rolled so there is nothing to install) ---------- */
const conns = new Map(); // userId -> Set<conn>

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function push(userId, payload) {
  const set = conns.get(userId);
  if (!set) return;
  const data = frame(1, Buffer.from(JSON.stringify(payload)));
  for (const c of set) if (!c.socket.destroyed) c.socket.write(data);
}
function pushToFriends(userId, payload) {
  for (const row of q.friendIds.all(userId)) push(row.friend_id, payload);
}
// friends plus anyone with a pending request either way (they can see your name and picture too)
function pushToCircle(userId, payload) {
  pushToFriends(userId, payload);
  for (const row of q.reqPeers.all(userId, userId)) push(row.id, payload);
}
const isOnline = (id) => conns.has(id);
const areFriends = (a, b) => Number.isInteger(b) && !!q.friendRow.get(a, b);

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  let okOrigin = false;
  try {
    okOrigin = new URL(req.headers.origin).host === req.headers.host;
  } catch {}
  const token = parseCookies(req.headers.cookie).sid;
  const user = token && q.userBySession.get(token);
  if (req.url !== '/~/ws' || !key || !okOrigin || !user) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const id = user.id;
  const conn = { socket, alive: true };
  let set = conns.get(id);
  const first = !set;
  if (!set) conns.set(id, (set = new Set()));
  set.add(conn);
  if (first) pushToFriends(id, { t: 'presence', id, online: true });

  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 65536) return socket.destroy();
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) return socket.destroy();
      const start = off + (masked ? 4 : 0);
      if (buf.length < start + len) return;
      const payload = Buffer.from(buf.subarray(start, start + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[off + (i & 3)];
      buf = buf.subarray(start + len);
      conn.alive = true;
      if (op === 8) return socket.end(frame(8, Buffer.alloc(0)));
      if (op === 9) socket.write(frame(10, payload));
    }
  });
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    set.delete(conn);
    if (set.size === 0 && conns.get(id) === set) {
      conns.delete(id);
      pushToFriends(id, { t: 'presence', id, online: false });
    }
  };
  socket.on('close', cleanup);
  socket.on('error', () => socket.destroy());
}

setInterval(() => {
  for (const set of conns.values()) {
    for (const c of set) {
      if (!c.alive) {
        c.socket.destroy();
        continue;
      }
      c.alive = false;
      if (!c.socket.destroyed) c.socket.write(frame(9, Buffer.alloc(0)));
    }
  }
}, 30_000).unref();

/* ---------- shared logic ---------- */
function createMessage(from, to, type, content, meta, replyTo) {
  if (!areFriends(from, to)) throw new HttpError(403, 'You can only message your friends.');
  limit('msg:' + from, 30, 10_000);
  let reply = null;
  if (Number.isInteger(replyTo) && replyTo > 0) {
    const r = q.msgById.get(replyTo);
    const samePair = r && ((r.sender_id === from && r.recipient_id === to) || (r.sender_id === to && r.recipient_id === from));
    if (samePair) reply = r.id;
  }
  const info = q.addMsg.run(from, to, type, content, meta ? JSON.stringify(meta) : null, Date.now(), reply);
  const msg = msgOut(q.msgById.get(info.lastInsertRowid));
  push(to, { t: 'message', msg });
  push(from, { t: 'message', msg });
  return msg;
}

function friendOut(meId, f) {
  const last = q.lastMsg.get({ a: meId, b: f.id, after: f.cleared_upto });
  const theirs = q.friendRow.get(f.id, meId);
  return {
    id: f.id,
    username: f.username,
    avatar: f.avatar || null,
    online: isOnline(f.id),
    last: last ? msgOut(last) : null,
    unread: q.unread.get(f.id, meId, Math.max(f.read_upto, f.cleared_upto)).n,
    theirRead: theirs ? theirs.read_upto : 0,
  };
}

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  q.addSession.run(token, user.id, Date.now());
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
}

function credentials(body) {
  return { username: String(body.username || '').trim().toLowerCase(), password: String(body.password || '') };
}
function checkNewPassword(password) {
  if (password.length < 6 || password.length > 200) throw new HttpError(400, 'Password must be at least 6 characters.');
}
function ownMessage(req) {
  const m = q.msgById.get(req.id);
  if (!m || m.sender_id !== req.user.id) throw new HttpError(404, 'Message not found.');
  return m;
}
function pushUpdated(m) {
  const msg = msgOut(q.msgById.get(m.id));
  push(m.sender_id, { t: 'message_updated', msg });
  push(m.recipient_id, { t: 'message_updated', msg });
  return msg;
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, open) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), handler, open });

route('POST', '/api/register', async (req) => {
  limit('auth:' + req.ip, 15, 60_000);
  const { username, password } = credentials(await readJson(req));
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw new HttpError(400, 'Username must be 3-20 characters: letters, numbers, _ or .');
  checkNewPassword(password);
  if (q.userByName.get(username)) throw new HttpError(409, 'That username is taken.');
  const info = q.addUser.run(username, await hashPassword(password), Date.now());
  const user = q.userById.get(info.lastInsertRowid);
  startSession(req, req.res, user);
  return { user: publicUser(user) };
}, true);

route('POST', '/api/login', async (req) => {
  limit('auth:' + req.ip, 15, 60_000);
  const { username, password } = credentials(await readJson(req));
  const user = q.userByName.get(username);
  if (!user || !(await checkPassword(password, user.pass_hash))) throw new HttpError(401, 'Wrong username or password.');
  startSession(req, req.res, user);
  return { user: publicUser(user) };
}, true);

route('POST', '/api/logout', (req) => {
  q.delSession.run(req.token);
  req.res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});

route('POST', '/api/password', async (req) => {
  limit('auth:' + req.ip, 15, 60_000);
  const body = await readJson(req);
  const next = String(body.next || '');
  if (!(await checkPassword(String(body.current || ''), req.user.pass_hash))) throw new HttpError(401, 'Current password is wrong.');
  checkNewPassword(next);
  q.setPass.run(await hashPassword(next), req.user.id);
  q.delOtherSessions.run(req.user.id, req.token); // log out everywhere else
  return { ok: true };
});

route('GET', '/api/me', (req) => ({
  user: publicUser(req.user),
  friends: q.friendsOf.all(req.user.id).map((f) => friendOut(req.user.id, f)),
  requests: {
    incoming: q.reqIn.all(req.user.id).map(publicUser),
    outgoing: q.reqOut.all(req.user.id).map(publicUser),
  },
  gifs: !!GIPHY_API_KEY,
  ice: ICE_SERVERS,
  games: { isolate: GAMES_ISOLATE, sandbox: SANDBOX },
}));

/* ---------- profile ---------- */
route('POST', '/api/profile', async (req) => {
  const username = String((await readJson(req)).username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw new HttpError(400, 'Username must be 3-20 characters: letters, numbers, _ or .');
  if (username === req.user.username) return { user: publicUser(req.user) };
  limit('name:' + req.user.id, 5, 3600_000);
  if (q.userByName.get(username)) throw new HttpError(409, 'That username is taken.');
  q.setName.run(username, req.user.id);
  const evt = { t: 'profile', id: req.user.id, username };
  push(req.user.id, evt);
  pushToCircle(req.user.id, evt);
  return { user: { ...publicUser(req.user), username } };
});

route('DELETE', '/api/avatar', (req) => {
  removeUpload(req.user.avatar);
  q.setAvatar.run(null, req.user.id);
  const evt = { t: 'avatar', id: req.user.id, avatar: null };
  push(req.user.id, evt);
  pushToCircle(req.user.id, evt);
  return { avatar: null };
});

/* ---------- voice calls: the server only passes notes between the two browsers ---------- */
const CALL_KINDS = new Set(['ring', 'accept', 'decline', 'busy', 'offer', 'answer', 'ice', 'hangup']);
route('POST', '/api/call', async (req) => {
  const body = await readJson(req);
  const to = Number(body.to);
  const kind = String(body.kind || '');
  if (!CALL_KINDS.has(kind)) throw new HttpError(400, 'Bad call signal.');
  if (!areFriends(req.user.id, to)) throw new HttpError(403, 'You can only call your friends.');
  limit('call:' + req.user.id, 300, 10_000);
  if (kind === 'ring') {
    limit('ring:' + req.user.id, 12, 60_000);
    if (!isOnline(to)) throw new HttpError(409, 'They are offline right now.');
  }
  const tab = String(body.tab || '').slice(0, 24);
  push(to, { t: 'call', from: req.user.id, kind, data: body.data ?? null });
  // lets your other open tabs stop ringing once one of them answers
  if (kind === 'accept' || kind === 'decline' || kind === 'hangup') push(req.user.id, { t: 'call_self', peer: to, kind, tab });
  return { ok: true };
});

route('POST', '/api/typing', async (req) => {
  const to = Number((await readJson(req)).to);
  if (areFriends(req.user.id, to)) push(to, { t: 'typing', from: req.user.id });
  return { ok: true };
});

function makeFriends(a, b) {
  q.delReq.run(a.id, b.id);
  q.delReq.run(b.id, a.id);
  const upto = q.maxMsgId.get().m;
  q.addFriend.run(a.id, b.id, upto, upto);
  q.addFriend.run(b.id, a.id, upto, upto);
  const base = { last: null, unread: 0, theirRead: upto };
  const forA = { ...publicUser(b), online: isOnline(b.id), ...base };
  const forB = { ...publicUser(a), online: isOnline(a.id), ...base };
  push(a.id, { t: 'friend_added', friend: forA, by: a.id });
  push(b.id, { t: 'friend_added', friend: forB, by: a.id });
  return forA;
}

// Sends a friend request. They have to accept it before you can talk.
route('POST', '/api/friends', async (req) => {
  limit('friend:' + req.user.id, 20, 60_000);
  const username = String((await readJson(req)).username || '').trim().toLowerCase().replace(/^@/, '');
  const other = q.userByName.get(username);
  if (!other) throw new HttpError(404, 'No user with that username.');
  if (other.id === req.user.id) throw new HttpError(400, "That's you.");
  if (areFriends(req.user.id, other.id)) throw new HttpError(409, 'Already friends.');
  if (q.reqRow.get(req.user.id, other.id)) throw new HttpError(409, 'Request already sent.');
  // they already asked you, so this is the same as accepting
  if (q.reqRow.get(other.id, req.user.id)) return { friend: makeFriends(req.user, other) };
  q.addReq.run(req.user.id, other.id, Date.now());
  push(other.id, { t: 'request_in', user: publicUser(req.user) });
  push(req.user.id, { t: 'request_out', user: publicUser(other) });
  return { pending: publicUser(other) };
});

route('POST', '/api/requests/:id/accept', (req) => {
  const other = q.userById.get(req.id);
  if (!other || !q.reqRow.get(req.id, req.user.id)) throw new HttpError(404, 'That request is gone.');
  return { friend: makeFriends(req.user, other) };
});

// Decline a request you got, or cancel one you sent.
route('DELETE', '/api/requests/:id', (req) => {
  q.delReq.run(req.id, req.user.id);
  q.delReq.run(req.user.id, req.id);
  push(req.id, { t: 'request_gone', id: req.user.id });
  push(req.user.id, { t: 'request_gone', id: req.id });
  return { ok: true };
});

route('DELETE', '/api/friends/:id', (req) => {
  const other = req.id;
  q.delFriend.run(req.user.id, other);
  q.delFriend.run(other, req.user.id);
  push(other, { t: 'friend_removed', id: req.user.id });
  push(req.user.id, { t: 'friend_removed', id: other });
  return { ok: true };
});

route('GET', '/api/messages/:id', (req) => {
  const row = q.friendRow.get(req.user.id, req.id);
  if (!row) throw new HttpError(403, 'You are not friends with this user.');
  const before = Number(req.query.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows = q.history.all({ a: req.user.id, b: req.id, after: row.cleared_upto, before });
  return { messages: rows.slice(0, 50).reverse().map(msgOut), more: rows.length > 50 };
});

// Mark everything this friend sent me as read.
route('POST', '/api/read/:id', (req) => {
  if (!areFriends(req.user.id, req.id)) throw new HttpError(404, 'Chat not found.');
  const upto = q.lastFrom.get(req.id, req.user.id).m;
  q.setRead.run(upto, req.user.id, req.id);
  push(req.id, { t: 'read', by: req.user.id, upto });
  push(req.user.id, { t: 'read_self', id: req.id });
  return { ok: true };
});

function checkText(content) {
  content = String(content || '').trim();
  if (!content) throw new HttpError(400, 'Message is empty.');
  if (content.length > MAX_TEXT) throw new HttpError(400, 'Message is too long.');
  return content;
}

route('POST', '/api/messages', async (req) => {
  const body = await readJson(req);
  let content;
  if (body.type === 'text') content = checkText(body.content);
  else if (body.type === 'gif') {
    let url;
    try {
      url = new URL(String(body.content));
    } catch {
      throw new HttpError(400, 'Invalid GIF.');
    }
    if (url.protocol !== 'https:' || !/(^|\.)giphy\.com$/.test(url.hostname)) throw new HttpError(400, 'Invalid GIF.');
    content = url.href;
  } else throw new HttpError(400, 'Unknown message type.');
  return { msg: createMessage(req.user.id, Number(body.to), body.type, content, null, Number(body.reply)) };
});

route('PATCH', '/api/messages/:id', async (req) => {
  const m = ownMessage(req);
  if (m.type !== 'text') throw new HttpError(400, 'Only text messages can be edited.');
  const content = checkText((await readJson(req)).content);
  if (content !== m.content) q.editMsg.run(content, Date.now(), m.id);
  return { msg: pushUpdated(m) };
});

route('POST', '/api/messages/:id/react', async (req) => {
  const m = q.msgById.get(req.id);
  if (!m || (m.sender_id !== req.user.id && m.recipient_id !== req.user.id)) throw new HttpError(404, 'Message not found.');
  limit('react:' + req.user.id, 40, 10_000);
  const emoji = String((await readJson(req)).emoji || '');
  if (emoji.length > 16 || !/\p{Extended_Pictographic}/u.test(emoji)) throw new HttpError(400, 'Invalid reaction.');
  const had = q.reaction.get(m.id, req.user.id);
  if (had && had.emoji === emoji) q.delReaction.run(m.id, req.user.id);
  else q.setReaction.run(m.id, req.user.id, emoji);
  return { msg: pushUpdated(m) };
});

// Uploads send the raw file as the request body.
async function uploadMessage(req, type) {
  const to = Number(req.query.get('to'));
  if (!areFriends(req.user.id, to)) throw new HttpError(403, 'You can only message your friends.');
  const buf = await readBody(req, MAX_UPLOAD);
  let ext, meta;
  if (type === 'image') {
    ext = sniffImage(buf);
    if (!ext) throw new HttpError(400, 'Only JPG, PNG, GIF or WEBP images are allowed.');
  } else {
    ext = AUDIO_EXT[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
    if (!ext || buf.length < 100) throw new HttpError(400, 'Unsupported audio format.');
    meta = { duration: Math.max(0, Math.min(3600, Number(req.query.get('duration')) || 0)) };
  }
  const url = saveUpload(buf, ext);
  try {
    return { msg: createMessage(req.user.id, to, type, url, meta, Number(req.query.get('reply'))) };
  } catch (e) {
    removeUpload(url);
    throw e;
  }
}
route('POST', '/api/upload/image', (req) => uploadMessage(req, 'image'));
route('POST', '/api/upload/voice', (req) => uploadMessage(req, 'voice'));

route('DELETE', '/api/messages/:id', (req) => {
  const m = ownMessage(req);
  q.delMsg.run(m.id);
  if (m.type === 'image' || m.type === 'voice') removeUpload(m.content);
  const evt = { t: 'message_deleted', id: m.id, from: m.sender_id, to: m.recipient_id };
  push(m.sender_id, evt);
  push(m.recipient_id, evt);
  return { ok: true };
});

// "Delete chat": clears the conversation on your side only.
route('DELETE', '/api/chats/:id', (req) => {
  if (!areFriends(req.user.id, req.id)) throw new HttpError(404, 'Chat not found.');
  const upto = q.maxMsgId.get().m;
  q.setCleared.run(upto, req.user.id, req.id);
  push(req.user.id, { t: 'chat_cleared', id: req.id });
  return { ok: true };
});

route('POST', '/api/avatar', async (req) => {
  const buf = await readBody(req, MAX_UPLOAD);
  const ext = sniffImage(buf);
  if (!ext) throw new HttpError(400, 'Only JPG, PNG, GIF or WEBP images are allowed.');
  const url = saveUpload(buf, ext);
  removeUpload(req.user.avatar);
  q.setAvatar.run(url, req.user.id);
  const evt = { t: 'avatar', id: req.user.id, avatar: url };
  push(req.user.id, evt);
  pushToCircle(req.user.id, evt);
  return { avatar: url };
});

route('GET', '/api/gifs', async (req) => {
  if (!GIPHY_API_KEY) throw new HttpError(503, 'GIFs are not set up yet (missing GIPHY_API_KEY).');
  limit('gif:' + req.user.id, 40, 60_000);
  const term = String(req.query.get('q') || '').trim().slice(0, 80);
  const url = new URL(`https://api.giphy.com/v1/gifs/${term ? 'search' : 'trending'}`);
  url.searchParams.set('api_key', GIPHY_API_KEY);
  url.searchParams.set('limit', '30');
  url.searchParams.set('rating', 'pg-13');
  if (term) url.searchParams.set('q', term);
  let data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('bad status ' + r.status);
    data = await r.json();
  } catch {
    throw new HttpError(502, 'GIPHY is not responding right now. Check the API key.');
  }
  const gifs = (data.data || [])
    .map((g) => ({
      preview: g.images?.fixed_width_small?.url || g.images?.fixed_width?.url,
      url: g.images?.fixed_height?.url || g.images?.original?.url,
      title: g.title || 'GIF',
    }))
    .filter((g) => g.preview && g.url);
  return { gifs };
});

/* ---------- static files ---------- */
const TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  weba: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
};

function sendFile(req, res, root, rel, cache) {
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) return notFound(res);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const type = TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2]) && st.size > 0) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      } else start = Math.max(0, st.size - Number(m[2]));
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}
function sendJson(res, status, data) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/* ---------- tab cloak icons (fetched once, then served from this site) ---------- */
const ICONS = {
  gmail: 'https://ssl.gstatic.com/ui/v1/icons/mail/rd/gmail.ico',
  classroom: 'https://ssl.gstatic.com/classroom/favicon.png',
  docs: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico',
  drive: 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png',
};
const iconCache = new Map();
async function sendIcon(res, name) {
  if (!Object.hasOwn(ICONS, name)) return notFound(res);
  let icon = iconCache.get(name);
  if (!icon) {
    try {
      const r = await fetch(ICONS[name], { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('bad status');
      icon = { type: r.headers.get('content-type') || 'image/x-icon', buf: Buffer.from(await r.arrayBuffer()) };
      if (icon.buf.length > 200_000 || !/^image\//.test(icon.type)) throw new Error('bad icon');
      iconCache.set(name, icon);
    } catch {
      return notFound(res);
    }
  }
  res.writeHead(200, { 'Content-Type': icon.type, 'Content-Length': icon.buf.length, 'Cache-Control': 'public, max-age=604800' });
  res.end(icon.buf);
}

/* ---------- games: pass-through to GAMES_UPSTREAM ---------- */
// Slipped into the top of every game page. See games-shim.js for what it does.
const SHIM = '<script>' + fs.readFileSync(path.join(__dirname, 'games-shim.js'), 'utf8') + '</script>';

const DROP_RES = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'clear-site-data', 'service-worker-allowed', 'report-to', 'nel',
  'alt-svc', 'access-control-allow-origin', 'access-control-allow-credentials',
]);
const PASS_REQ = ['accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since', 'if-range', 'content-type', 'content-length', 'user-agent', 'cache-control', 'pragma'];
const MAX_HTML = 8 * 1024 * 1024;

function gamesDown(res, why) {
  if (res.headersSent) return res.destroy();
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#08080b;color:#9a9aa6;font:15px system-ui;text-align:center">' +
      `<div><div style="font-size:20px;color:#fff;margin-bottom:8px">Games are not reachable right now</div>${why}<br>Hit reload in a moment.</div>`
  );
}

function proxyGames(req, res, target) {
  // never let game code install a service worker on this site
  if (req.headers['service-worker']) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Not allowed');
  }
  const headers = {};
  for (const h of PASS_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  headers.host = GAMES_UPSTREAM.host;
  headers.referer = GAMES_UPSTREAM.origin + '/';
  const ae = String(req.headers['accept-encoding'] || '');
  headers['accept-encoding'] = ['gzip', 'br'].filter((e) => ae.includes(e)).join(', ') || 'identity';
  const lib = GAMES_UPSTREAM.protocol === 'https:' ? https : http;
  const up = lib.request(
    { protocol: GAMES_UPSTREAM.protocol, hostname: GAMES_UPSTREAM.hostname, port: GAMES_UPSTREAM.port || undefined, method: req.method, path: target, headers },
    (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!DROP_RES.has(k)) out[k] = v;
      out['access-control-allow-origin'] = '*';
      out['referrer-policy'] = 'no-referrer';
      if (GAMES_ISOLATE) out['content-security-policy'] = 'sandbox ' + SANDBOX;
      if (out.location) {
        try {
          const loc = new URL(out.location, GAMES_UPSTREAM.origin + target);
          if (loc.host === GAMES_UPSTREAM.host) out.location = loc.pathname + loc.search + loc.hash;
        } catch {}
      }
      const isHtml = /^text\/html/i.test(r.headers['content-type'] || '') && r.statusCode === 200 && req.method === 'GET';
      if (!isHtml || !GAMES_ISOLATE) {
        res.writeHead(r.statusCode, out);
        return r.pipe(res);
      }
      // html: unpack it and slip the save-storage helper in before anything else runs
      const enc = String(r.headers['content-encoding'] || '').toLowerCase();
      const unpack = enc === 'gzip' ? zlib.createGunzip() : enc === 'br' ? zlib.createBrotliDecompress() : enc === 'deflate' ? zlib.createInflate() : null;
      if (enc && enc !== 'identity' && !unpack) {
        res.writeHead(r.statusCode, out);
        return r.pipe(res);
      }
      const src = unpack ? r.pipe(unpack) : r;
      const chunks = [];
      let size = 0;
      src.on('data', (c) => {
        size += c.length;
        if (size > MAX_HTML) {
          src.destroy();
          up.destroy();
          return gamesDown(res, 'That page is too big.');
        }
        chunks.push(c);
      });
      src.on('error', () => gamesDown(res, 'The page came back broken.'));
      src.on('end', () => {
        if (res.headersSent || res.destroyed) return;
        let html = Buffer.concat(chunks).toString('utf8');
        const m = /<head[^>]*>/i.exec(html) || /<html[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
        const at = m ? m.index + m[0].length : 0;
        html = html.slice(0, at) + SHIM + html.slice(at);
        const body = Buffer.from(html, 'utf8');
        delete out['content-encoding'];
        delete out['content-length'];
        delete out['etag'];
        delete out['accept-ranges'];
        out['content-length'] = body.length;
        res.writeHead(200, out);
        res.end(body);
      });
    }
  );
  up.setTimeout(30_000, () => up.destroy(new Error('timeout')));
  up.on('error', () => gamesDown(res, 'The games server did not answer.'));
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  let url, pathname;
  try {
    url = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(res);
  }

  // This site is "/" plus everything under "/~/". Every other address belongs to the games.
  const own = pathname.startsWith('/~/');
  const forGames = url.searchParams.has('~games') || req.headers['sec-fetch-dest'] === 'iframe';
  if (!own && (pathname !== '/' || forGames)) {
    if (url.searchParams.has('~games')) {
      url.searchParams.delete('~games');
      return proxyGames(req, res, url.pathname + url.search);
    }
    return proxyGames(req, res, req.url);
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https://*.giphy.com; media-src 'self' blob:; frame-src 'self'; " +
      "connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'"
  );
  pathname = own ? pathname.slice(2) : '/';

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    if (pathname.startsWith('/icon/')) return sendIcon(res, pathname.slice(6));
    if (pathname.startsWith('/uploads/')) {
      return sendFile(req, res, UPLOAD_DIR, path.basename(pathname), 'private, max-age=2592000, immutable');
    }
    return sendFile(req, res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1), 'no-cache');
  }

  try {
    // block cross-site requests that change things
    if (req.method !== 'GET' && req.headers.origin) {
      let host = '';
      try {
        host = new URL(req.headers.origin).host;
      } catch {}
      if (host !== req.headers.host) throw new HttpError(403, 'Forbidden.');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      req.res = res;
      req.query = url.searchParams;
      req.id = m[1] ? Number(m[1]) : null;
      req.ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
      if (!r.open) {
        const token = parseCookies(req.headers.cookie).sid;
        const user = token && q.userBySession.get(token);
        if (!user) throw new HttpError(401, 'Not logged in.');
        req.user = user;
        req.token = token;
      }
      return sendJson(res, 200, await r.handler(req));
    }
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: status === 500 ? 'Server error.' : err.message });
  }
});

server.on('upgrade', (req, socket) => {
  try {
    handleUpgrade(req, socket);
  } catch (e) {
    console.error(e);
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Chat is running.');
  console.log(`  On this computer:        http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Same Wi-Fi, other device: http://${n.address}:${PORT}`);
    }
  }
  console.log('  From anywhere:           run go-online.bat (see README)');
  console.log(`  Games come from:         ${GAMES_UPSTREAM.origin}`);
  if (!GIPHY_API_KEY) console.log('  GIF search is off until you set GIPHY_API_KEY (see README).');
  console.log('');
});
