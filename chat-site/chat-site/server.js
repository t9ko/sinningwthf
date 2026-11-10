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
// Game files fetched once are kept on disk so the next person does not wait for them again.
const GAMES_CACHE_MB = Math.max(0, Number(process.env.GAMES_CACHE_MB ?? 2048) || 0);
const GAMES_CACHE_HOURS = 24;
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
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created INTEGER NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cleared_upto INTEGER NOT NULL DEFAULT 0,
    read_upto INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    bg TEXT,
    joined INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages (sender_id, recipient_id, id);
`);
// upgrades for databases created by the first version
for (const sql of [
  'ALTER TABLE messages ADD COLUMN reply_to INTEGER',
  'ALTER TABLE messages ADD COLUMN edited INTEGER',
  'ALTER TABLE friends ADD COLUMN read_upto INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE friends ADD COLUMN ttl INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE friends ADD COLUMN color TEXT',
  'ALTER TABLE friends ADD COLUMN bg TEXT',
  'ALTER TABLE users ADD COLUMN banner TEXT',
  'ALTER TABLE messages ADD COLUMN room_id INTEGER',
  'ALTER TABLE messages ADD COLUMN expires INTEGER',
  'ALTER TABLE rooms ADD COLUMN kind TEXT',
  'ALTER TABLE friends ADD COLUMN added INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(sql);
  } catch {}
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_msg_room ON messages (room_id, id);
  CREATE INDEX IF NOT EXISTS idx_msg_expires ON messages (expires);
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
`);

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
  setBanner: db.prepare('UPDATE users SET banner = ? WHERE id = ?'),
  setFriendTtl: db.prepare('UPDATE friends SET ttl = :ttl WHERE (user_id = :a AND friend_id = :b) OR (user_id = :b AND friend_id = :a)'),
  setFriendPrefs: db.prepare('UPDATE friends SET color = ?, bg = ? WHERE user_id = ? AND friend_id = ?'),
  expired: db.prepare('SELECT * FROM messages WHERE expires IS NOT NULL AND expires <= ?'),
  // group chats ("rooms")
  room: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  addRoom: db.prepare('INSERT INTO rooms (name, owner_id, created) VALUES (?, ?, ?)'),
  setRoomName: db.prepare('UPDATE rooms SET name = ? WHERE id = ?'),
  setRoomTtl: db.prepare('UPDATE rooms SET ttl = ? WHERE id = ?'),
  setRoomOwner: db.prepare('UPDATE rooms SET owner_id = ? WHERE id = ?'),
  delRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
  member: db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?'),
  memberIds: db.prepare('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined, user_id'),
  membersOf: db.prepare('SELECT u.id, u.username, u.avatar FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.joined, u.id'),
  roomsOf: db.prepare('SELECT r.*, m.cleared_upto, m.read_upto, m.color, m.bg FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ?'),
  roomFor: db.prepare('SELECT r.*, m.cleared_upto, m.read_upto, m.color, m.bg FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE r.id = ? AND m.user_id = ?'),
  addMember: db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, cleared_upto, read_upto, joined) VALUES (?, ?, ?, ?, ?)'),
  isMember: db.prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?'),
  delMember: db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?'),
  setMemberRead: db.prepare('UPDATE room_members SET read_upto = ? WHERE room_id = ? AND user_id = ?'),
  setMemberCleared: db.prepare('UPDATE room_members SET cleared_upto = ? WHERE room_id = ? AND user_id = ?'),
  setMemberPrefs: db.prepare('UPDATE room_members SET color = ?, bg = ? WHERE room_id = ? AND user_id = ?'),
  roomHistory: db.prepare('SELECT * FROM messages WHERE room_id = :r AND id > :after AND id < :before ORDER BY id DESC LIMIT 51'),
  roomLast: db.prepare('SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id DESC LIMIT 1'),
  roomLastId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE room_id = ?'),
  roomUnread: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND sender_id != ? AND type != 'sys' AND id > ?"),
  roomFiles: db.prepare("SELECT content FROM messages WHERE room_id = ? AND type IN ('image', 'voice')"),
  delRoomMsgs: db.prepare('DELETE FROM messages WHERE room_id = ?'),
  roomPeers: db.prepare('SELECT DISTINCT b.user_id AS id FROM room_members a JOIN room_members b ON a.room_id = b.room_id WHERE a.user_id = ?'),
  sharesRoom: db.prepare('SELECT 1 AS x FROM room_members a JOIN room_members b ON a.room_id = b.room_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1'),
  setPass: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
  // admin + news channel
  allUsers: db.prepare('SELECT id, username, avatar, created FROM users ORDER BY created, id'),
  newsRoom: db.prepare("SELECT * FROM rooms WHERE kind = 'news' ORDER BY id LIMIT 1"),
  addNewsRoom: db.prepare("INSERT INTO rooms (name, owner_id, created, kind) VALUES (?, ?, ?, 'news')"),
  // blocking
  blockRow: db.prepare('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
  addBlock: db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created) VALUES (?, ?, ?)'),
  delBlock: db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
  blockedByMe: db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?'),
  eitherBlock: db.prepare('SELECT 1 AS x FROM blocks WHERE (blocker_id = :a AND blocked_id = :b) OR (blocker_id = :b AND blocked_id = :a) LIMIT 1'),
  addSession: db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?'),
  userBySession: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  friendRow: db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?'),
  friendsOf: db.prepare(
    `SELECT u.id, u.username, u.avatar, f.cleared_upto, f.read_upto, f.ttl, f.color, f.bg,
     f.added
     FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?`
  ),
  friendIds: db.prepare('SELECT friend_id FROM friends WHERE user_id = ?'),
  addFriend: db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, cleared_upto, read_upto, added) VALUES (?, ?, ?, ?, ?)'),
  delFriend: db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?'),
  setCleared: db.prepare('UPDATE friends SET cleared_upto = ? WHERE user_id = ? AND friend_id = ?'),
  setRead: db.prepare('UPDATE friends SET read_upto = ? WHERE user_id = ? AND friend_id = ?'),
  maxMsgId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages'),
  lastFrom: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE sender_id = ? AND recipient_id = ?'),
  unread: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ? AND id > ?'),
  addMsg: db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, type, content, meta, created, reply_to, room_id, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
    room: m.room_id || null,
    expires: m.expires || null,
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
  const ids = new Set();
  for (const row of q.friendIds.all(userId)) ids.add(row.friend_id);
  for (const row of q.reqPeers.all(userId, userId)) ids.add(row.id);
  for (const row of q.roomPeers.all(userId)) ids.add(row.id);
  ids.delete(userId);
  for (const id of ids) push(id, payload);
}
const pushAll = (ids, payload) => ids.forEach((id) => push(id, payload));
const isOnline = (id) => conns.has(id);

// group voice calls: who is in the call of each group right now (kept in memory only)
const roomCalls = new Map(); // room id -> Set of user ids
const callList = (rid) => [...(roomCalls.get(rid) || [])];
function leaveRoomCall(rid, uid) {
  const set = roomCalls.get(rid);
  if (!set || !set.delete(uid)) return;
  if (!set.size) roomCalls.delete(rid);
  const ids = new Set(q.memberIds.all(rid).map((r) => r.user_id));
  ids.add(uid);
  for (const id of ids) push(id, { t: 'gcall', room: rid, members: callList(rid), left: uid });
}
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
      for (const rid of [...roomCalls.keys()]) leaveRoomCall(rid, id); // going offline drops you from group calls
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
// A "chat" is either one friend (key = their id) or a group (key = "g" + group id).
function chatOf(user, key) {
  key = String(key ?? '');
  if (key[0] === 'g') {
    const room = q.room.get(Number(key.slice(1)) || 0);
    const mine = room && q.member.get(room.id, user.id);
    if (!mine) throw new HttpError(403, 'You are not in this group.');
    return { key: 'g' + room.id, room, mine, ttl: room.ttl, ids: q.memberIds.all(room.id).map((r) => r.user_id) };
  }
  const peer = Number(key);
  const mine = Number.isInteger(peer) ? q.friendRow.get(user.id, peer) : null;
  if (!mine) throw new HttpError(403, 'You can only message your friends.');
  return { key: peer, peer, mine, ttl: mine.ttl, ids: [user.id, peer] };
}
// everyone who can see a message
const audience = (m) => (m.room_id ? q.memberIds.all(m.room_id).map((r) => r.user_id) : [m.sender_id, m.recipient_id]);
function canSee(userId, m) {
  return m.room_id ? !!q.member.get(m.room_id, userId) : m.sender_id === userId || m.recipient_id === userId;
}

function createMessage(from, chat, type, content, meta, replyTo) {
  limit('msg:' + from, 30, 10_000);
  let reply = null;
  if (Number.isInteger(replyTo) && replyTo > 0) {
    const r = q.msgById.get(replyTo);
    const same = r && (chat.room
      ? r.room_id === chat.room.id
      : !r.room_id && ((r.sender_id === from && r.recipient_id === chat.peer) || (r.sender_id === chat.peer && r.recipient_id === from)));
    if (same) reply = r.id;
  }
  const now = Date.now();
  // disappearing messages: stamped with the moment they should vanish
  const expires = chat.ttl && type !== 'sys' ? now + chat.ttl * 1000 : null;
  const info = q.addMsg.run(from, chat.room ? from : chat.peer, type, content, meta ? JSON.stringify(meta) : null, now, reply, chat.room ? chat.room.id : null, expires);
  const row = q.msgById.get(info.lastInsertRowid);
  for (const id of chat.ids) push(id, { t: 'message', msg: msgView(row, id) });
  return msgView(row, from);
}
// small grey notes in the chat like "alice added bob"
function note(user, chat, text) {
  try {
    createMessage(user.id, chat, 'sys', text);
  } catch {}
}
function dropMessage(m) {
  const ids = audience(m);
  q.delMsg.run(m.id);
  if (m.type === 'image' || m.type === 'voice') removeUpload(m.content);
  pushAll(ids, { t: 'message_deleted', id: m.id, from: m.sender_id, to: m.recipient_id, room: m.room_id || null });
}
setInterval(() => {
  try {
    for (const m of q.expired.all(Date.now())) dropMessage(m);
  } catch (e) {
    console.error(e);
  }
}, 5000).unref();

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
    ttl: f.ttl || 0,
    color: f.color || '',
    bg: f.bg || '',
    added: f.added || 0,
    blocked: !!q.blockRow.get(meId, f.id),
  };
}
// r = a rooms row joined with this user's own membership row
function roomOut(meId, r) {
  const last = q.roomLast.get(r.id, r.cleared_upto);
  const news = r.kind === 'news';
  const admin = meId === r.owner_id;
  // in the news channel ordinary people never see who owns it or who else is in it
  return {
    id: 'g' + r.id,
    group: true,
    username: r.name,
    owner: news && !admin ? 0 : r.owner_id,
    created: r.created,
    news,
    readOnly: news && !admin,
    members: news && !admin ? [] : q.membersOf.all(r.id).map((u) => ({ ...publicUser(u), online: isOnline(u.id) })),
    call: callList(r.id),
    last: last ? msgView(last, meId) : null,
    unread: q.roomUnread.get(r.id, meId, Math.max(r.read_upto, r.cleared_upto)).n,
    ttl: r.ttl || 0,
    color: r.color || '',
    bg: r.bg || '',
  };
}
const roomFor = (meId, roomId) => roomOut(meId, q.roomFor.get(roomId, meId));

/* ---------- admin + news channel ---------- */
// The one account that runs the place. Defaults to "kolton"; change with ADMIN_USER.
const ADMIN = (process.env.ADMIN_USER || 'kolton').trim().toLowerCase();
const isAdmin = (u) => !!u && u.username === ADMIN;
let NEWS_NAME = (process.env.NEWS_NAME || 'News').trim().slice(0, 40) || 'News';

// Make sure the news channel exists and everyone is in it.
function ensureNews() {
  const admin = q.userByName.get(ADMIN);
  if (!admin) return null; // the admin account has not been made yet
  let room = q.newsRoom.get();
  if (!room) {
    const rid = Number(q.addNewsRoom.run(NEWS_NAME, admin.id, Date.now()).lastInsertRowid);
    room = q.room.get(rid);
  } else if (room.owner_id !== admin.id) {
    q.setRoomOwner.run(admin.id, room.id); // keep the admin as owner even if they were renamed
  }
  NEWS_ROOM_ID = room.id;
  const read = q.roomLastId.get(room.id).m; // past posts stay visible but are not "unread"
  for (const u of q.allUsers.all()) if (!q.isMember.get(room.id, u.id)) q.addMember.run(room.id, u.id, 0, read, u.created || Date.now());
  return room;
}
// add a brand-new account to the news channel
function joinNews(user) {
  const room = user.username === ADMIN ? ensureNews() : q.newsRoom.get();
  if (!room) return;
  NEWS_ROOM_ID = room.id;
  if (q.isMember.get(room.id, user.id)) return;
  q.addMember.run(room.id, user.id, 0, q.roomLastId.get(room.id).m, Date.now());
  push(user.id, { t: 'group_added', group: roomFor(user.id, room.id), by: room.owner_id });
}
let NEWS_ROOM_ID = null;
const isNewsId = (rid) => !!rid && rid === NEWS_ROOM_ID;
const isNews = (room) => !!room && room.kind === 'news';
// In the news channel every post is shown as "News" with no name or picture. Only the poster
// (the admin, viewing their own) sees the real sender, so they can still edit or delete it.
function msgView(m, viewerId) {
  const o = msgOut(m);
  if (isNewsId(m.room_id) && viewerId !== m.sender_id) {
    o.from = 0;
    o.anon = true;
  }
  return o;
}
// only the admin may post in the news channel
function canPostHere(user, chat) {
  if (isNews(chat.room) && !isAdmin(user)) throw new HttpError(403, 'Only ' + ADMIN + ' can post in the news channel.');
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
  if (!m || m.sender_id !== req.user.id || m.type === 'sys') throw new HttpError(404, 'Message not found.');
  return m;
}
function pushUpdated(m, viewerId) {
  const row = q.msgById.get(m.id);
  for (const id of audience(m)) push(id, { t: 'message_updated', msg: msgView(row, id) });
  return msgView(row, viewerId != null ? viewerId : m.sender_id);
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, open) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)').replace(/:chat/g, '(g?\\d+)') + '$'), handler, open });

route('POST', '/api/register', async (req) => {
  limit('auth:' + req.ip, 15, 60_000);
  const { username, password } = credentials(await readJson(req));
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw new HttpError(400, 'Username must be 3-20 characters: letters, numbers, _ or .');
  checkNewPassword(password);
  if (q.userByName.get(username)) throw new HttpError(409, 'That username is taken.');
  const info = q.addUser.run(username, await hashPassword(password), Date.now());
  const user = q.userById.get(info.lastInsertRowid);
  try { joinNews(user); } catch (e) { console.error(e); }
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
  req.res.setHeader('Set-Cookie', [
    'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    'sid_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  ]);
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

route('GET', '/api/me', (req) => {
  const at = parseCookies(req.headers.cookie).sid_admin;
  const adminSession = at && q.userBySession.get(at);
  return {
    user: { ...publicUser(req.user), banner: req.user.banner || null, created: req.user.created },
    groups: q.roomsOf.all(req.user.id).map((r) => roomOut(req.user.id, r)),
    friends: q.friendsOf.all(req.user.id).map((f) => friendOut(req.user.id, f)),
    requests: {
      incoming: q.reqIn.all(req.user.id).map(publicUser),
      outgoing: q.reqOut.all(req.user.id).map(publicUser),
    },
    admin: isAdmin(req.user),
    canReturn: !!(adminSession && isAdmin(adminSession)),
    blocked: q.blockedByMe.all(req.user.id).map((r) => r.id),
    gifs: !!GIPHY_API_KEY,
    ice: ICE_SERVERS,
    games: { isolate: GAMES_ISOLATE, sandbox: SANDBOX },
  };
});

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
  let chat;
  try {
    chat = chatOf(req.user, (await readJson(req)).to);
    canPostHere(req.user, chat); // readers of the news channel do not send typing pings
  } catch {
    return { ok: true };
  }
  for (const id of chat.ids) if (id !== req.user.id) push(id, { t: 'typing', from: req.user.id, room: chat.room ? chat.room.id : null });
  return { ok: true };
});

/* ---------- profiles ---------- */
route('GET', '/api/users/:id', (req) => {
  const u = q.userById.get(req.id);
  const me = req.user.id;
  const friend = !!u && areFriends(me, u.id);
  const asked = !!u && !!q.reqRow.get(me, u.id);
  const askedMe = !!u && !!q.reqRow.get(u.id, me);
  if (!u || !(u.id === me || friend || asked || askedMe || q.sharesRoom.get(me, u.id))) throw new HttpError(404, 'User not found.');
  return {
    user: { ...publicUser(u), banner: u.banner || null, created: u.created, online: u.id === me || (friend && isOnline(u.id)) },
    friend,
    pending: asked ? 'out' : askedMe ? 'in' : null,
    blocked: !!q.blockRow.get(me, u.id),
    admin: isAdmin(u),
  };
});

route('POST', '/api/banner', async (req) => {
  const buf = await readBody(req, MAX_UPLOAD);
  const ext = sniffImage(buf);
  if (!ext) throw new HttpError(400, 'Only JPG, PNG, GIF or WEBP images are allowed.');
  const url = saveUpload(buf, ext);
  removeUpload(req.user.banner);
  q.setBanner.run(url, req.user.id);
  push(req.user.id, { t: 'banner', banner: url });
  return { banner: url };
});
route('DELETE', '/api/banner', (req) => {
  removeUpload(req.user.banner);
  q.setBanner.run(null, req.user.id);
  push(req.user.id, { t: 'banner', banner: null });
  return { banner: null };
});

/* ---------- group chats ---------- */
const cleanIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const names = (ids) => ids.map((id) => q.userById.get(id).username).join(', ');
function checkGroupName(v) {
  const name = String(v || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) throw new HttpError(400, 'Give the group a name (40 characters max).');
  return name;
}
function tellGroup(roomId, except) {
  for (const row of q.memberIds.all(roomId)) if (row.user_id !== except) push(row.user_id, { t: 'group_updated', group: roomFor(row.user_id, roomId) });
}

route('POST', '/api/groups', async (req) => {
  const body = await readJson(req);
  const name = checkGroupName(body.name);
  const ids = cleanIds(body.members).filter((id) => areFriends(req.user.id, id));
  if (!ids.length) throw new HttpError(400, 'Pick at least one friend.');
  if (ids.length > 49) throw new HttpError(400, 'Groups can have 50 people at most.');
  limit('group:' + req.user.id, 10, 3600_000);
  const now = Date.now();
  const rid = Number(q.addRoom.run(name, req.user.id, now).lastInsertRowid);
  const upto = q.maxMsgId.get().m;
  for (const id of [req.user.id, ...ids]) q.addMember.run(rid, id, upto, upto, now);
  for (const id of [req.user.id, ...ids]) push(id, { t: 'group_added', group: roomFor(id, rid), by: req.user.id });
  note(req.user, chatOf(req.user, 'g' + rid), `${req.user.username} created the group`);
  return { group: roomFor(req.user.id, rid) };
});

route('PATCH', '/api/groups/:id', async (req) => {
  const chat = chatOf(req.user, 'g' + req.id);
  if (chat.room.owner_id !== req.user.id) throw new HttpError(403, 'Only the group master can rename it.');
  if (isNews(chat.room)) throw new HttpError(403, 'The news channel cannot be renamed here.');
  const name = checkGroupName((await readJson(req)).name);
  q.setRoomName.run(name, chat.room.id);
  tellGroup(chat.room.id);
  note(req.user, chat, `${req.user.username} renamed the group to ${name}`);
  return { ok: true };
});

// Add your own friends to a group you are in.
route('POST', '/api/groups/:id/members', async (req) => {
  const chat = chatOf(req.user, 'g' + req.id);
  if (isNews(chat.room)) throw new HttpError(403, 'Everyone is added to the news channel automatically.');
  const ids = cleanIds((await readJson(req)).ids).filter((id) => areFriends(req.user.id, id) && !chat.ids.includes(id));
  if (!ids.length) throw new HttpError(400, 'Pick at least one friend who is not in the group yet.');
  if (chat.ids.length + ids.length > 50) throw new HttpError(400, 'Groups can have 50 people at most.');
  const upto = q.maxMsgId.get().m;
  for (const id of ids) q.addMember.run(chat.room.id, id, upto, upto, Date.now());
  for (const id of ids) push(id, { t: 'group_added', group: roomFor(id, chat.room.id), by: req.user.id });
  for (const id of chat.ids) push(id, { t: 'group_updated', group: roomFor(id, chat.room.id) });
  note(req.user, chatOf(req.user, chat.key), `${req.user.username} added ${names(ids)}`);
  return { ok: true };
});

// The master hands the group over to someone else in it.
route('POST', '/api/groups/:id/master', async (req) => {
  const chat = chatOf(req.user, 'g' + req.id);
  if (chat.room.owner_id !== req.user.id) throw new HttpError(403, 'Only the group master can do that.');
  const to = Number((await readJson(req)).id);
  if (to === req.user.id || !chat.ids.includes(to)) throw new HttpError(400, 'Pick someone else who is in the group.');
  q.setRoomOwner.run(to, chat.room.id);
  tellGroup(chat.room.id);
  note(req.user, chat, `${req.user.username} made ${names([to])} the group master`);
  return { ok: true };
});

/* ---------- group voice calls ---------- */
// Everyone in the call connects straight to everyone else; the server only keeps the list
// of who is in and passes the connection notes along.
const MAX_CALL = 8;
route('POST', '/api/groups/:id/call', async (req) => {
  const chat = chatOf(req.user, 'g' + req.id);
  const rid = chat.room.id;
  const action = String((await readJson(req)).action || '');
  if (action === 'leave') {
    leaveRoomCall(rid, req.user.id);
    return { members: callList(rid) };
  }
  if (action !== 'join') throw new HttpError(400, 'Bad call action.');
  limit('gjoin:' + req.user.id, 20, 60_000);
  let set = roomCalls.get(rid);
  if (!set) roomCalls.set(rid, (set = new Set()));
  const started = set.size === 0;
  if (!set.has(req.user.id) && set.size >= MAX_CALL) throw new HttpError(409, `The call is full (${MAX_CALL} people).`);
  set.add(req.user.id);
  pushAll(chat.ids, { t: 'gcall', room: rid, members: callList(rid), joined: req.user.id, started });
  if (started) note(req.user, chat, `${req.user.username} started a voice call`);
  return { members: callList(rid) };
});
route('POST', '/api/groups/:id/signal', async (req) => {
  const body = await readJson(req);
  const to = Number(body.to);
  const kind = String(body.kind || '');
  const set = roomCalls.get(req.id);
  if (!['offer', 'answer', 'ice'].includes(kind)) throw new HttpError(400, 'Bad call signal.');
  if (!set || !set.has(req.user.id) || !set.has(to) || to === req.user.id) throw new HttpError(409, 'They are not in the call.');
  limit('call:' + req.user.id, 300, 10_000);
  push(to, { t: 'gsig', room: req.id, from: req.user.id, kind, data: body.data ?? null });
  return { ok: true };
});

// Leave a group, or (master only) kick someone out of it.
route('DELETE', '/api/groups/:id/members/:id', (req) => {
  const chat = chatOf(req.user, 'g' + req.id);
  const target = req.id2;
  const row = q.member.get(chat.room.id, target);
  if (!row) throw new HttpError(404, 'They are not in this group.');
  if (isNews(chat.room)) throw new HttpError(403, 'Nobody can leave the news channel.');
  if (target !== req.user.id && chat.room.owner_id !== req.user.id) throw new HttpError(403, 'Only the group master can kick people.');
  note(req.user, chat, target === req.user.id ? `${req.user.username} left the group` : `${req.user.username} kicked ${names([target])}`);
  leaveRoomCall(chat.room.id, target);
  q.delMember.run(chat.room.id, target);
  removeUpload(row.bg);
  push(target, { t: 'group_removed', id: chat.key, by: req.user.id, name: chat.room.name });
  const left = q.memberIds.all(chat.room.id).map((r) => r.user_id);
  if (!left.length) {
    for (const f of q.roomFiles.all(chat.room.id)) removeUpload(f.content);
    q.delRoomMsgs.run(chat.room.id);
    q.delRoom.run(chat.room.id);
  } else {
    if (target === chat.room.owner_id) q.setRoomOwner.run(left[0], chat.room.id);
    tellGroup(chat.room.id);
  }
  return { ok: true };
});

/* ---------- chat settings ---------- */
const TTLS = { 0: 'off', 60: '1 minute', 3600: '1 hour', 86400: '24 hours', 604800: '7 days' };
// Disappearing messages: shared by everyone in the chat.
route('POST', '/api/chats/:chat/ttl', async (req) => {
  const chat = chatOf(req.user, req.p1);
  if (isNews(chat.room) && !isAdmin(req.user)) throw new HttpError(403, 'Only ' + ADMIN + ' can change the news channel.');
  const ttl = Number((await readJson(req)).ttl);
  if (!Object.hasOwn(TTLS, ttl)) throw new HttpError(400, 'Pick one of the listed times.');
  if (ttl === chat.ttl) return { ttl };
  if (chat.room) q.setRoomTtl.run(ttl, chat.room.id);
  else q.setFriendTtl.run({ ttl, a: req.user.id, b: chat.peer });
  pushAll(chat.ids, { t: 'chat_ttl', room: chat.room ? chat.room.id : null, a: req.user.id, b: chat.peer || null, ttl });
  note(req.user, chat, ttl ? `${req.user.username} set messages to disappear after ${TTLS[ttl]}` : `${req.user.username} turned off disappearing messages`);
  return { ttl };
});

// Colour and background: only you see these.
const BGS = new Set(['', 'grid', 'dots', 'lines', 'glow']);
function savePrefs(req, chat, color, bg) {
  if (chat.mine.bg !== bg) removeUpload(chat.mine.bg);
  if (chat.room) q.setMemberPrefs.run(color || null, bg || null, chat.room.id, req.user.id);
  else q.setFriendPrefs.run(color || null, bg || null, req.user.id, chat.peer);
  push(req.user.id, { t: 'chat_prefs', id: chat.key, color, bg });
  return { color, bg };
}
route('POST', '/api/chats/:chat/prefs', async (req) => {
  const chat = chatOf(req.user, req.p1);
  const body = await readJson(req);
  const color = body.color === undefined ? chat.mine.color || '' : String(body.color || '').toLowerCase();
  if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, 'Bad colour.');
  let bg = chat.mine.bg || '';
  if (body.bg !== undefined) {
    bg = String(body.bg || '');
    if (!BGS.has(bg)) throw new HttpError(400, 'Bad background.');
  }
  return savePrefs(req, chat, color, bg);
});
route('POST', '/api/chats/:chat/bg', async (req) => {
  const chat = chatOf(req.user, req.p1);
  const buf = await readBody(req, MAX_UPLOAD);
  const ext = sniffImage(buf);
  if (!ext) throw new HttpError(400, 'Only JPG, PNG, GIF or WEBP images are allowed.');
  return savePrefs(req, chat, chat.mine.color || '', saveUpload(buf, ext));
});

function makeFriends(a, b) {
  q.delReq.run(a.id, b.id);
  q.delReq.run(b.id, a.id);
  const upto = q.maxMsgId.get().m;
  const now = Date.now();
  q.addFriend.run(a.id, b.id, upto, upto, now);
  q.addFriend.run(b.id, a.id, upto, upto, now);
  const base = { last: null, unread: 0, theirRead: upto, added: now };
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
  if (q.blockRow.get(req.user.id, other.id)) throw new HttpError(403, 'You have this user blocked. Unblock them first.');
  if (q.blockRow.get(other.id, req.user.id)) throw new HttpError(403, 'You cannot add this user.');
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
  for (const row of [q.friendRow.get(req.user.id, other), q.friendRow.get(other, req.user.id)]) if (row) removeUpload(row.bg);
  q.delFriend.run(req.user.id, other);
  q.delFriend.run(other, req.user.id);
  push(other, { t: 'friend_removed', id: req.user.id });
  push(req.user.id, { t: 'friend_removed', id: other });
  return { ok: true };
});

/* ---------- admin ---------- */
function requireAdmin(req) {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Admins only.');
}

route('GET', '/api/admin/stats', (req) => {
  requireAdmin(req);
  const users = q.allUsers.all().map((u) => ({ id: u.id, username: u.username, avatar: u.avatar || null, created: u.created, online: isOnline(u.id) }));
  const online = users.filter((u) => u.online);
  const last = users.reduce((a, u) => (!a || u.created > a.created ? u : a), null);
  return {
    admin: ADMIN,
    total: users.length,
    onlineCount: online.length,
    offlineCount: users.length - online.length,
    last: last && { username: last.username, created: last.created },
    users,
  };
});

/* ---------- admin: log in as any account ---------- */
// Switches the browser into another user's session. The admin's own session token is
// stashed in an HttpOnly "sid_admin" cookie so they can return without re-typing a password.
route('POST', '/api/admin/login-as/:id', async (req) => {
  requireAdmin(req);
  const target = q.userById.get(req.id);
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.id === req.user.id) throw new HttpError(400, 'You are already this user.');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const cookies = [];
  if (!parseCookies(req.headers.cookie).sid_admin) {
    cookies.push(`sid_admin=${req.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  }
  const token = crypto.randomBytes(32).toString('hex');
  q.addSession.run(token, target.id, Date.now());
  cookies.push(`sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  req.res.setHeader('Set-Cookie', cookies);
  return { user: publicUser(target) };
});

// Puts the browser back into the admin account saved by login-as.
route('POST', '/api/admin/return', (req) => {
  const at = parseCookies(req.headers.cookie).sid_admin;
  const admin = at && q.userBySession.get(at);
  if (!admin || !isAdmin(admin)) throw new HttpError(403, 'No saved admin session.');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  req.res.setHeader('Set-Cookie', [
    `sid=${at}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`,
    `sid_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  ]);
  return { user: publicUser(admin) };
});
/* ---------- blocking ---------- */
route('POST', '/api/block/:id', (req) => {
  const other = q.userById.get(req.id);
  if (!other || other.id === req.user.id) throw new HttpError(400, 'Cannot block that.');
  q.addBlock.run(req.user.id, other.id, Date.now());
  // blocking drops any friendship and pending requests both ways
  q.delFriend.run(req.user.id, other.id);
  q.delFriend.run(other.id, req.user.id);
  q.delReq.run(req.user.id, other.id);
  q.delReq.run(other.id, req.user.id);
  push(other.id, { t: 'friend_removed', id: req.user.id });
  push(other.id, { t: 'request_gone', id: req.user.id });
  push(req.user.id, { t: 'friend_removed', id: other.id });
  push(req.user.id, { t: 'request_gone', id: other.id });
  push(req.user.id, { t: 'blocked', id: other.id, on: true });
  return { ok: true };
});
route('DELETE', '/api/block/:id', (req) => {
  q.delBlock.run(req.user.id, req.id);
  push(req.user.id, { t: 'blocked', id: req.id, on: false });
  return { ok: true };
});

route('GET', '/api/messages/:chat', (req) => {
  const chat = chatOf(req.user, req.p1);
  const before = Number(req.query.get('before')) || Number.MAX_SAFE_INTEGER;
  const after = chat.mine.cleared_upto;
  const rows = chat.room
    ? q.roomHistory.all({ r: chat.room.id, after, before })
    : q.history.all({ a: req.user.id, b: chat.peer, after, before });
  return { messages: rows.slice(0, 50).reverse().map((m) => msgView(m, req.user.id)), more: rows.length > 50 };
});

// Mark everything in this chat as read.
route('POST', '/api/read/:chat', (req) => {
  const chat = chatOf(req.user, req.p1);
  if (chat.room) q.setMemberRead.run(q.roomLastId.get(chat.room.id).m, chat.room.id, req.user.id);
  else {
    const upto = q.lastFrom.get(chat.peer, req.user.id).m;
    q.setRead.run(upto, req.user.id, chat.peer);
    push(chat.peer, { t: 'read', by: req.user.id, upto });
  }
  push(req.user.id, { t: 'read_self', id: chat.key });
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
  const chat = chatOf(req.user, body.to);
  canPostHere(req.user, chat);
  return { msg: createMessage(req.user.id, chat, body.type, content, null, Number(body.reply)) };
});

route('PATCH', '/api/messages/:id', async (req) => {
  const m = ownMessage(req);
  if (m.type !== 'text') throw new HttpError(400, 'Only text messages can be edited.');
  const content = checkText((await readJson(req)).content);
  if (content !== m.content) q.editMsg.run(content, Date.now(), m.id);
  return { msg: pushUpdated(m, req.user.id) };
});

route('POST', '/api/messages/:id/react', async (req) => {
  const m = q.msgById.get(req.id);
  if (!m || m.type === 'sys' || !canSee(req.user.id, m)) throw new HttpError(404, 'Message not found.');
  limit('react:' + req.user.id, 40, 10_000);
  const emoji = String((await readJson(req)).emoji || '');
  if (emoji.length > 16 || !/\p{Extended_Pictographic}/u.test(emoji)) throw new HttpError(400, 'Invalid reaction.');
  const had = q.reaction.get(m.id, req.user.id);
  if (had && had.emoji === emoji) q.delReaction.run(m.id, req.user.id);
  else q.setReaction.run(m.id, req.user.id, emoji);
  return { msg: pushUpdated(m, req.user.id) };
});

// Uploads send the raw file as the request body.
async function uploadMessage(req, type) {
  const chat = chatOf(req.user, req.query.get('to'));
  canPostHere(req.user, chat);
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
    return { msg: createMessage(req.user.id, chat, type, url, meta, Number(req.query.get('reply'))) };
  } catch (e) {
    removeUpload(url);
    throw e;
  }
}
route('POST', '/api/upload/image', (req) => uploadMessage(req, 'image'));
route('POST', '/api/upload/voice', (req) => uploadMessage(req, 'voice'));

route('DELETE', '/api/messages/:id', (req) => {
  dropMessage(ownMessage(req));
  return { ok: true };
});

// "Delete chat": clears the conversation on your side only.
route('DELETE', '/api/chats/:chat', (req) => {
  const chat = chatOf(req.user, req.p1);
  const upto = q.maxMsgId.get().m;
  if (chat.room) q.setMemberCleared.run(upto, chat.room.id, req.user.id);
  else q.setCleared.run(upto, req.user.id, chat.peer);
  push(req.user.id, { t: 'chat_cleared', id: chat.key });
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
const SHIM = '<script>' + fs.readFileSync(path.join(__dirname, 'games-shim.js'), 'utf8').replace('__UPSTREAM__', GAMES_UPSTREAM.host) + '</script>';

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

// Games sites keep some games on side addresses (db.duckmath.org and so on). Those are reached
// through this site as /~s/db/... so nobody needs a second domain.
const SUB_RE = /^\/~s\/(@|[a-z0-9-]+(?:\.[a-z0-9-]+)?)(\/.*)?$/i;
function mapUpstreamUrl(loc, fromSide) {
  const base = GAMES_UPSTREAM.host;
  const rest = loc.pathname + loc.search + loc.hash;
  if (loc.host === base) return (fromSide ? '/~s/@' : '') + rest;
  if (loc.host.endsWith('.' + base)) return '/~s/' + loc.host.slice(0, -base.length - 1) + rest;
  return null;
}

/* ---------- games file cache (on disk) ---------- */
const CACHE_DIR = path.join(DATA_DIR, 'games-cache');
const CACHE_ITEM_MAX = 400 * 1024 * 1024;
const STATIC_EXT = /\.(data|wasm|unityweb|bundle|pck|bin|mem|symbols|js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|mp3|ogg|wav|m4a|mp4|webm|woff2?|ttf|otf|swf|zip|br|gz)$/i;
if (GAMES_CACHE_MB) fs.mkdirSync(CACHE_DIR, { recursive: true });
const cacheKey = (host, target, enc) => crypto.createHash('sha1').update(host + '|' + target + '|' + enc).digest('hex');
function cacheGet(key) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + '.json'), 'utf8'));
    if (Date.now() - meta.time > GAMES_CACHE_HOURS * 3600_000) return null;
    const st = fs.statSync(path.join(CACHE_DIR, key + '.bin'));
    if (st.size !== meta.size) return null;
    return meta;
  } catch {
    return null;
  }
}
function pruneCache() {
  if (!GAMES_CACHE_MB) return;
  fs.readdir(CACHE_DIR, (err, names) => {
    if (err) return;
    const items = [];
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(CACHE_DIR, n));
        const old = Date.now() - st.mtimeMs > GAMES_CACHE_HOURS * 3600_000;
        const stray = n.endsWith('.tmp') && Date.now() - st.mtimeMs > 3600_000;
        if (old || stray) fs.unlink(path.join(CACHE_DIR, n), () => {});
        else if (n.endsWith('.bin')) items.push({ n, size: st.size, t: st.mtimeMs });
      } catch {}
    }
    // over the limit: throw out the oldest first
    let total = items.reduce((a, i) => a + i.size, 0);
    items.sort((a, b) => a.t - b.t);
    for (const i of items) {
      if (total <= GAMES_CACHE_MB * 1024 * 1024) break;
      total -= i.size;
      fs.unlink(path.join(CACHE_DIR, i.n), () => {});
      fs.unlink(path.join(CACHE_DIR, i.n.replace(/\.bin$/, '.json')), () => {});
    }
  });
}
pruneCache();
setInterval(pruneCache, 20 * 60_000).unref();

function proxyGames(req, res, target, sub) {
  const upHost = sub ? sub + '.' + GAMES_UPSTREAM.host : GAMES_UPSTREAM.host;
  const upName = sub ? sub + '.' + GAMES_UPSTREAM.hostname : GAMES_UPSTREAM.hostname;
  // never let game code install a service worker on this site
  if (req.headers['service-worker']) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Not allowed');
  }
  const headers = {};
  for (const h of PASS_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  // pages are always fetched fresh, so a browser never keeps one with an out-of-date helper inside
  const wantsPage = /text\/html/.test(req.headers.accept || '') || ['document', 'iframe', 'frame'].includes(req.headers['sec-fetch-dest']);
  if (wantsPage) for (const h of ['if-none-match', 'if-modified-since', 'if-range']) delete headers[h];
  headers.host = upHost;
  headers.referer = GAMES_UPSTREAM.protocol + '//' + upHost + '/';
  const ae = String(req.headers['accept-encoding'] || '');
  headers['accept-encoding'] = ['gzip', 'br'].filter((e) => ae.includes(e)).join(', ') || 'identity';
  // already on disk? send it straight away without asking the games site
  const canCache = GAMES_CACHE_MB > 0 && req.method === 'GET' && !req.headers.range && !wantsPage;
  const key = canCache ? cacheKey(upHost, target, headers['accept-encoding']) : null;
  const hit = canCache ? cacheGet(key) : null;
  if (hit) {
    const out = { ...hit.headers, 'x-games-cache': 'hit' };
    if (GAMES_ISOLATE) out['content-security-policy'] = 'sandbox ' + SANDBOX;
    if (out.etag && req.headers['if-none-match'] === out.etag) {
      res.writeHead(304, { etag: out.etag, 'cache-control': out['cache-control'] || 'public, max-age=3600', 'access-control-allow-origin': '*' });
      return res.end();
    }
    res.writeHead(200, out);
    return fs.createReadStream(path.join(CACHE_DIR, key + '.bin')).on('error', () => res.destroy()).pipe(res);
  }
  if (canCache) for (const h of ['if-none-match', 'if-modified-since']) delete headers[h]; // we want the whole file to keep

  let keeping = false;
  const lib = GAMES_UPSTREAM.protocol === 'https:' ? https : http;
  const up = lib.request(
    { protocol: GAMES_UPSTREAM.protocol, hostname: upName, port: GAMES_UPSTREAM.port || undefined, method: req.method, path: target, headers },
    (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!DROP_RES.has(k)) out[k] = v;
      out['access-control-allow-origin'] = '*';
      // pages tell this site which page asked for a file, so files land on the right side address
      out['referrer-policy'] = 'strict-origin-when-cross-origin';
      if (GAMES_ISOLATE) out['content-security-policy'] = 'sandbox ' + SANDBOX;
      if (out.location) {
        try {
          const mapped = mapUpstreamUrl(new URL(out.location, GAMES_UPSTREAM.protocol + '//' + upHost + target), !!sub);
          if (mapped) out.location = mapped;
        } catch {}
      }
      const isHtml = /^text\/html/i.test(r.headers['content-type'] || '') && r.statusCode === 200 && req.method === 'GET';
      if (!isHtml) {
        // game files rarely change: let the browser keep them when the games site did not say
        if (r.statusCode === 200 && !out['cache-control'] && STATIC_EXT.test(target.split('?')[0])) out['cache-control'] = 'public, max-age=86400';
        res.writeHead(r.statusCode, out);
        const size = Number(r.headers['content-length']);
        const type = String(r.headers['content-type'] || '');
        const keep = canCache && r.statusCode === 200 && !(size > CACHE_ITEM_MAX) &&
          !/no-store|private/i.test(String(r.headers['cache-control'] || '')) &&
          (STATIC_EXT.test(target.split('?')[0]) || !/json|html|text\/plain|event-stream/i.test(type));
        if (keep) {
          // copy the file to disk while it streams to the player
          const tmp = path.join(CACHE_DIR, key + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
          const file = fs.createWriteStream(tmp);
          let got = 0;
          let bad = false;
          let finished = false;
          keeping = true;
          file.on('error', () => (bad = true));
          r.on('data', (c) => {
            got += c.length;
            if (got > CACHE_ITEM_MAX) bad = true;
            if (!bad) file.write(c);
          });
          const done = (ok) => !finished && (finished = true) && file.end(() => {
            if (!ok || bad || !got || got > CACHE_ITEM_MAX || (size && got !== size)) return fs.unlink(tmp, () => {});
            const stored = { ...out };
            delete stored['content-security-policy'];
            stored['content-length'] = got;
            fs.rename(tmp, path.join(CACHE_DIR, key + '.bin'), (e) => {
              if (e) return fs.unlink(tmp, () => {});
              fs.writeFile(path.join(CACHE_DIR, key + '.json'), JSON.stringify({ time: Date.now(), size: got, headers: stored }), () => {});
            });
          });
          r.on('end', () => done(true));
          r.on('error', () => done(false));
          r.on('close', () => !r.complete && done(false));
        }
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
        delete out['last-modified'];
        delete out['expires'];
        delete out['accept-ranges'];
        out['cache-control'] = 'no-store';
        out['content-length'] = body.length;
        res.writeHead(200, out);
        res.end(body);
      });
    }
  );
  up.setTimeout(30_000, () => up.destroy(new Error('timeout')));
  up.on('error', () => gamesDown(res, 'The games server did not answer.'));
  // if the player leaves mid-download, a file being saved keeps downloading so it still lands in the cache
  res.on('close', () => { if (!keeping) up.destroy(); });
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

  // This site is "/" (the page) plus everything under "/~/". Nothing else exists.
  const own = pathname.startsWith('/~/');
  if (!own && pathname !== '/') return notFound(res);

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
    // the arcade is one self-contained page with its own inline code, so it gets its own CSP
    if (pathname === '/games.html') {
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'");
    }
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
      req.p1 = m[1] || null;
      req.id = m[1] ? Number(m[1]) : null;
      req.id2 = m[2] ? Number(m[2]) : null;
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

try {
  ensureNews(); // create the news channel and add everyone, if the admin account already exists
} catch (e) {
  console.error(e);
}

server.listen(PORT, () => {
  console.log('');
  console.log('  Chat is running.');
  console.log(`  Admin account:           ${ADMIN}${q.userByName.get(ADMIN) ? '' : ' (not created yet)'}`);
  console.log(`  On this computer:        http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Same Wi-Fi, other device: http://${n.address}:${PORT}`);
    }
  }
  console.log('  From anywhere:           run go-online.bat (see README)');
  console.log('  Games:                   built-in arcade at /~/games.html');
  if (!GIPHY_API_KEY) console.log('  GIF search is off until you set GIPHY_API_KEY (see README).');
  console.log('');
});
