// Zero-dependency chat server. Needs Node.js 22.13 or newer. Run with: node server.js
const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...a) => {
  if (a[0] === 'ExperimentalWarning' || (a[0] && a[0].type === 'ExperimentalWarning')) return;
  origEmitWarning.call(process, w, ...a);
};

const http = require('http');
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

const PAIR = '((sender_id = :a AND recipient_id = :b) OR (sender_id = :b AND recipient_id = :a))';
const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  addUser: db.prepare('INSERT INTO users (username, pass_hash, created) VALUES (?, ?, ?)'),
  setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
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
  if (!url || !url.startsWith('/uploads/')) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}
function saveUpload(buf, ext) {
  const name = crypto.randomBytes(18).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
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
  if (req.url !== '/ws' || !key || !okOrigin || !user) {
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
  gifs: !!GIPHY_API_KEY,
}));

route('POST', '/api/typing', async (req) => {
  const to = Number((await readJson(req)).to);
  if (areFriends(req.user.id, to)) push(to, { t: 'typing', from: req.user.id });
  return { ok: true };
});

route('POST', '/api/friends', async (req) => {
  limit('friend:' + req.user.id, 20, 60_000);
  const username = String((await readJson(req)).username || '').trim().toLowerCase().replace(/^@/, '');
  const other = q.userByName.get(username);
  if (!other) throw new HttpError(404, 'No user with that username.');
  if (other.id === req.user.id) throw new HttpError(400, "That's you.");
  if (areFriends(req.user.id, other.id)) throw new HttpError(409, 'Already friends.');
  const upto = q.maxMsgId.get().m;
  q.addFriend.run(req.user.id, other.id, upto, upto);
  q.addFriend.run(other.id, req.user.id, upto, upto);
  const base = { last: null, unread: 0, theirRead: upto };
  const mine = { ...publicUser(other), online: isOnline(other.id), ...base };
  const theirs = { ...publicUser(req.user), online: isOnline(req.user.id), ...base };
  push(other.id, { t: 'friend_added', friend: theirs });
  push(req.user.id, { t: 'friend_added', friend: mine, self: true });
  return { friend: mine };
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
  pushToFriends(req.user.id, evt);
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
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
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

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https://*.giphy.com; media-src 'self' blob:; " +
      "connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'"
  );

  let url, pathname;
  try {
    url = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(res);
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
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
  if (!GIPHY_API_KEY) console.log('  GIF search is off until you set GIPHY_API_KEY (see README).');
  console.log('');
});
