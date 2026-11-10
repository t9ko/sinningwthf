(() => {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
    return n;
  }
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ic');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof Blob) {
      opt.body = body;
      opt.headers['Content-Type'] = body.type || 'application/octet-stream';
    } else if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let r;
    try {
      r = await fetch('/~' + url, opt);
    } catch {
      throw new Error('No connection. Try again.');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error || 'Something went wrong.');
      e.status = r.status;
      throw e;
    }
    return j;
  }
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayKey = (ts) => new Date(ts).toDateString();
  function fmtDay(ts) {
    const d = new Date(ts);
    if (d.toDateString() === new Date().toDateString()) return 'Today';
    if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const fmtWhen = (ts) =>
    dayKey(ts) === dayKey(Date.now()) ? fmtTime(ts) : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });

  // per-browser preferences
  const prefs = { sound: true, notify: false };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem('prefs') || '{}'));
  } catch {}
  const savePrefs = () => {
    try {
      localStorage.setItem('prefs', JSON.stringify(prefs));
    } catch {}
  };

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  function confirmBox(text, yesLabel) {
    return new Promise((resolve) => {
      $('#modal-text').textContent = text;
      $('#modal-yes').textContent = yesLabel || 'Confirm';
      $('#modal').classList.remove('hidden');
      const done = (v) => {
        $('#modal').classList.add('hidden');
        $('#modal-yes').onclick = $('#modal-no').onclick = $('#modal').onclick = null;
        resolve(v);
      };
      $('#modal-yes').onclick = () => done(true);
      $('#modal-no').onclick = () => done(false);
      $('#modal').onclick = (e) => e.target.id === 'modal' && done(false);
    });
  }

  /* ---------- state ---------- */
  let me = null;
  let gifsEnabled = false;
  let iceServers = [];
  let gamesCfg = { isolate: true, sandbox: '' };
  let view = 'home';
  let booted = false;
  const reqIn = new Map(); // id -> user who asked me
  const reqOut = new Map(); // id -> user I asked
  const friends = new Map(); // id -> friend
  const gotIds = new Set(); // incoming message ids already counted
  let activeId = null;
  let msgs = []; // messages of the active chat
  let hasMore = false;
  let loadingMore = false;
  let replyTo = null;
  let editing = null;
  let jumpCount = 0;
  let ws = null;
  let wsRetry = 0;
  let wsDropped = false;

  const QUICK = ['👍', '❤️', '😂', '🔥', '💀'];
  const EMOJI = ('😀 😁 😂 🤣 😅 😊 😇 🙂 😉 😍 😘 😋 😜 🤪 😎 🤩 🥳 😏 😒 🙄 😬 😴 🤤 😷 🤒 🤕 🤢 🤮 🥵 🥶 😵 🤯 🤠 😢 😭 😤 😡 🤬 😱 😨 😰 😳 🥺 🤔 🤫 🤭 🫡 🫠 😈 👿 💀 👻 👽 🤖 💩 🤡 ' +
    '👍 👎 👏 🙌 🙏 🤝 👊 ✊ 🤞 ✌️ 🤘 👌 🤌 👀 🫶 💪 🖕 👋 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 💢 💥 💫 💤 🔥 ✨ ⭐ 🌙 ⚡ ☠️ 🎉 🎁 🎮 🎧 🎵 🏆 💰 💸 🍕 🍔 🍟 🍺 ☕ 🚀 ✅ ❌ ❓ ❗').split(' ');

  /* ---------- auth ---------- */
  let mode = 'login';
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      mode = tab.dataset.mode;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#auth-submit').textContent = mode === 'login' ? 'Enter' : 'Create account';
      $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      $('#auth-error').textContent = '';
    })
  );
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      await api('POST', mode === 'login' ? '/api/login' : '/api/register', {
        username: $('#auth-user').value,
        password: $('#auth-pass').value,
      });
      $('#auth-pass').value = '';
      await boot();
    } catch (err) {
      $('#auth-error').textContent = err.message;
      const f = $('#auth-form');
      f.classList.remove('shake');
      void f.offsetWidth;
      f.classList.add('shake');
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- boot ---------- */
  async function boot() {
    let data;
    try {
      data = await api('GET', '/api/me');
    } catch (err) {
      if (err.status !== 401 && me) return; // keep the app up on a network blip
      $('#shell').classList.add('hidden');
      $('#auth').classList.remove('hidden');
      document.body.classList.remove('calm');
      return;
    }
    me = data.user;
    gifsEnabled = data.gifs;
    friends.clear();
    data.friends.forEach((f) => friends.set(f.id, f));
    iceServers = data.ice || [];
    gamesCfg = data.games || gamesCfg;
    reqIn.clear();
    reqOut.clear();
    data.requests.incoming.forEach((u) => reqIn.set(u.id, u));
    data.requests.outgoing.forEach((u) => reqOut.set(u.id, u));
    $('#auth').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    if (!booted) {
      booted = true;
      let v = 'home';
      try { v = sessionStorage.getItem('view') || 'home'; } catch {}
      go(['home', 'chat', 'games'].includes(v) ? v : 'home');
    }
    renderMe();
    renderRequests();
    renderFriends();
    connect();
    if (activeId && friends.has(activeId)) openChat(activeId);
    else closeChat();
  }

  function avatarEl(user, extra) {
    const a = el('div', { class: 'avatar' + (extra ? ' ' + extra : '') });
    if (user.avatar) a.append(el('img', { src: user.avatar, alt: '' }));
    else a.textContent = (user.username || '?')[0];
    return a;
  }

  function renderMe() {
    $('#me-name').textContent = me.username;
    $('#home-name').textContent = me.username;
    $('#me-avatar').replaceChildren(avatarEl(me));
    $('#set-avatar').replaceChildren(avatarEl(me));
    $('#set-pic-remove').classList.toggle('hidden', !me.avatar);
  }

  const TYPE_LABEL = { image: 'Image', gif: 'GIF', voice: 'Voice message' };
  const snippet = (m) => (m.type === 'text' ? m.content : TYPE_LABEL[m.type] || '');
  const nameOf = (id) => (id === me.id ? 'You' : (friends.get(id) || {}).username || 'Friend');
  function preview(m) {
    if (!m) return 'No messages yet';
    return (m.from === me.id ? 'You: ' : '') + snippet(m);
  }

  function renderFriends() {
    const box = $('#friends');
    const list = [...friends.values()].sort(
      (a, b) => (b.last ? b.last.created : 0) - (a.last ? a.last.created : 0) || a.username.localeCompare(b.username)
    );
    let total = 0;
    for (const f of list) total += f.unread || 0;
    unreadTotal = total;
    setTitle();
    const waiting = reqIn.size;
    const online = list.filter((f) => f.online).length;
    for (const id of ['#nav-badge', '#home-badge']) {
      $(id).classList.toggle('hidden', !(total + waiting));
      $(id).textContent = total + waiting > 99 ? '99+' : String(total + waiting);
    }
    $('#home-chat-sub').textContent = total
      ? total + (total === 1 ? ' unread message' : ' unread messages')
      : list.length ? `${online} of ${list.length} friends online` : 'Add your first friend';
    $('#tile-req-sub').textContent = waiting ? waiting + (waiting === 1 ? ' person wants to add you' : ' people want to add you') : 'Nothing waiting';
    if (!list.length) {
      box.replaceChildren(el('div', { class: 'none', text: 'No friends yet. Send someone a request by their username above.' }));
      return;
    }
    box.replaceChildren(
      ...list.map((f) => {
        const n = f.unread || 0;
        return el(
          'button',
          { class: 'friend' + (f.id === activeId ? ' active' : '') + (n ? ' unread' : ''), type: 'button', onclick: () => openChat(f.id) },
          avatarEl(f, f.online ? 'online' : ''),
          el('div', { class: 'text' }, el('div', { class: 'name', text: f.username }), el('div', { class: 'sub', text: preview(f.last) })),
          el('div', { class: 'side' },
            f.last ? el('div', { class: 'when', text: fmtWhen(f.last.created) }) : null,
            n ? el('div', { class: 'badge', text: n > 99 ? '99+' : String(n) }) : null)
        );
      })
    );
  }

  /* ---------- friend requests ---------- */
  function renderRequests() {
    $('#req-box').classList.toggle('hidden', !(reqIn.size + reqOut.size));
    const act = (method, url) => api(method, url).catch((e) => toast(e.message));
    $('#requests').replaceChildren(
      ...[...reqIn.values()].map((u) =>
        el('div', { class: 'req' }, avatarEl(u),
          el('div', { class: 'text' }, el('div', { class: 'name', text: u.username }), el('div', { class: 'sub', text: 'Wants to be friends' })),
          el('button', { class: 'icon-btn yes', type: 'button', title: 'Accept', onclick: () => act('POST', `/api/requests/${u.id}/accept`) }, icon('check')),
          el('button', { class: 'icon-btn no', type: 'button', title: 'Decline', onclick: () => act('DELETE', '/api/requests/' + u.id) }, icon('x')))),
      ...[...reqOut.values()].map((u) =>
        el('div', { class: 'req' }, avatarEl(u),
          el('div', { class: 'text' }, el('div', { class: 'name', text: u.username }), el('div', { class: 'sub', text: 'Request sent, waiting' })),
          el('button', { class: 'icon-btn no', type: 'button', title: 'Cancel request', onclick: () => act('DELETE', '/api/requests/' + u.id) }, icon('x'))))
    );
  }

  /* ---------- friends ---------- */
  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#add-input');
    const note = $('#add-msg');
    const username = input.value.trim();
    if (!username) return;
    try {
      const { friend, pending } = await api('POST', '/api/friends', { username });
      input.value = '';
      note.className = 'note';
      if (pending) {
        reqOut.set(pending.id, pending);
        note.textContent = 'Request sent to ' + pending.username + '.';
        renderRequests();
      } else {
        friends.set(friend.id, friend);
        reqIn.delete(friend.id);
        note.textContent = 'You and ' + friend.username + ' are now friends.';
        renderRequests();
        renderFriends();
        openChat(friend.id);
      }
    } catch (err) {
      note.className = 'note bad';
      note.textContent = err.message;
    }
    setTimeout(() => (note.textContent = ''), 4000);
  });

  $('#remove-friend').addEventListener('click', async () => {
    const f = friends.get(activeId);
    if (!f) return;
    if (!(await confirmBox(`Remove ${f.username} from your friends?`, 'Unfriend'))) return;
    api('DELETE', '/api/friends/' + f.id).catch((e) => toast(e.message));
  });

  $('#clear-chat').addEventListener('click', async () => {
    const f = friends.get(activeId);
    if (!f) return;
    if (!(await confirmBox(`Delete your chat with ${f.username}? This clears it on your side.`, 'Delete'))) return;
    api('DELETE', '/api/chats/' + f.id).catch((e) => toast(e.message));
  });

  /* ---------- chat ---------- */
  const msgBox = $('#msgs');
  const pinned = () => msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 120;
  function toBottom() {
    msgBox.scrollTop = msgBox.scrollHeight;
    setJump(0);
  }
  function setJump(n) {
    jumpCount = n;
    $('#jump').classList.toggle('hidden', !n);
    $('#jump').textContent = n === 1 ? '1 new message' : n + ' new messages';
  }
  $('#jump').addEventListener('click', toBottom);
  // stay at the bottom when a panel opens or the window resizes
  let wasPinned = true;
  msgBox.addEventListener('scroll', () => (wasPinned = pinned()), { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => wasPinned && (msgBox.scrollTop = msgBox.scrollHeight)).observe(msgBox);

  function renderHead() {
    const f = friends.get(activeId);
    if (!f) return;
    $('#peer-avatar').replaceChildren(avatarEl(f, f.online ? 'online' : ''));
    $('#peer-name').textContent = f.username;
    const s = $('#peer-status');
    s.textContent = f.online ? 'Online' : 'Offline';
    s.className = 'sub' + (f.online ? ' online' : '');
  }

  function closeChat() {
    stopAllAudio();
    cancelRec();
    clearCtx();
    activeId = null;
    msgs = [];
    $('#convo').classList.add('hidden');
    $('#empty').classList.remove('hidden');
    document.body.classList.remove('chat-open');
    renderFriends();
  }

  function markRead(id) {
    const f = friends.get(id);
    if (!f) return;
    f.unread = 0;
    api('POST', '/api/read/' + id).catch(() => {});
  }

  async function openChat(id) {
    const f = friends.get(id);
    if (!f) return;
    stopAllAudio();
    cancelRec();
    clearCtx();
    activeId = id;
    msgs = [];
    hasMore = false;
    setJump(0);
    $('#empty').classList.add('hidden');
    $('#convo').classList.remove('hidden');
    closePanels();
    $('#typing').textContent = '';
    document.body.classList.add('chat-open');
    msgBox.replaceChildren();
    renderHead();
    if (f.unread) markRead(id);
    renderFriends();
    try {
      const data = await api('GET', '/api/messages/' + id);
      if (activeId !== id) return;
      // keep anything that arrived while the history was still loading
      msgs = data.messages.concat(msgs.filter((x) => !data.messages.some((y) => y.id === x.id)));
      hasMore = data.more;
      renderMsgs();
      toBottom();
    } catch (err) {
      toast(err.message);
    }
    if (matchMedia('(min-width: 761px)').matches) $('#text').focus();
  }

  $('#back').addEventListener('click', closeChat);

  msgBox.addEventListener('scroll', async () => {
    if (jumpCount && pinned()) setJump(0);
    if (msgBox.scrollTop > 40 || !hasMore || loadingMore || !msgs.length) return;
    loadingMore = true;
    const id = activeId;
    try {
      const data = await api('GET', `/api/messages/${id}?before=${msgs[0].id}`);
      if (activeId === id) {
        const prev = msgBox.scrollHeight;
        msgs = data.messages.concat(msgs);
        hasMore = data.more;
        renderMsgs();
        msgBox.scrollTop = msgBox.scrollHeight - prev;
      }
    } catch {}
    loadingMore = false;
  });

  /* audio players */
  const players = new Set();
  function stopAllAudio(except) {
    for (const a of players) if (a !== except) a.pause();
  }
  function voiceEl(m) {
    const btn = el('button', { type: 'button', text: '▶', 'aria-label': 'Play voice message' });
    const fill = el('i');
    const bar = el('div', { class: 'bar' }, fill);
    const total = (m.meta && m.meta.duration) || 0;
    const dur = el('span', { class: 'dur', text: fmtDur(total) });
    let audio = null;
    btn.addEventListener('click', () => {
      if (!audio) {
        audio = new Audio(m.content);
        players.add(audio);
        audio.addEventListener('timeupdate', () => {
          const d = isFinite(audio.duration) && audio.duration ? audio.duration : total || 1;
          fill.style.width = Math.min(100, (audio.currentTime / d) * 100) + '%';
          dur.textContent = fmtDur(audio.currentTime);
        });
        audio.addEventListener('play', () => (btn.textContent = '❙❙'));
        audio.addEventListener('pause', () => (btn.textContent = '▶'));
        audio.addEventListener('ended', () => {
          fill.style.width = '0';
          dur.textContent = fmtDur(total);
        });
        audio.addEventListener('error', () => toast('Could not play this voice message.'));
      }
      if (audio.paused) {
        stopAllAudio(audio);
        audio.play().catch(() => {});
      } else audio.pause();
    });
    return el('div', { class: 'voice' }, btn, bar, dur);
  }

  // turn http(s) links in text into real links
  function linkify(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s<]+[^\s<.,!?)\]'"]/g)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function msgEl(m, fresh) {
    const mine = m.from === me.id;
    const node = el('div', { class: 'msg' + (mine ? ' mine' : '') + (fresh ? ' new' : ''), 'data-id': m.id });
    node._m = m;
    if (m.reply) {
      node.append(el('button', { class: 'reply-ref', type: 'button', onclick: () => jumpTo(m.reply.id) },
        el('b', { text: nameOf(m.reply.from) }), ' ' + snippet(m.reply)));
    }
    const bubble = el('div', { class: 'bubble ' + m.type });
    if (m.type === 'text') bubble.append(...linkify(m.content));
    else if (m.type === 'image' || m.type === 'gif') {
      const img = el('img', { src: m.content, alt: m.type === 'gif' ? 'GIF' : 'Image', loading: 'lazy' });
      const stick = pinned();
      img.addEventListener('load', () => stick && toBottom(), { once: true });
      if (m.type === 'image') img.addEventListener('click', () => openLightbox(m.content));
      bubble.append(img);
    } else if (m.type === 'voice') bubble.append(voiceEl(m));
    bubble.addEventListener('click', (e) => {
      if (e.target.closest('a, button, img')) return;
      const was = node.classList.contains('show');
      msgBox.querySelectorAll('.msg.show').forEach((n) => n.classList.remove('show'));
      node.classList.toggle('show', !was);
    });
    const acts = el('div', { class: 'acts' },
      QUICK.map((e) => el('button', { type: 'button', class: 'emo', text: e, title: 'React', onclick: () => react(m, e) })),
      el('button', { type: 'button', class: 'act-reply', text: 'Reply', onclick: () => setReply(m) }),
      mine && m.type === 'text' ? el('button', { type: 'button', class: 'act-edit', text: 'Edit', onclick: () => setEdit(m) }) : null,
      mine ? el('button', { type: 'button', class: 'act-del danger', text: 'Delete', onclick: () => deleteMsg(m) }) : null);
    node.append(el('div', { class: 'row' }, bubble, acts));

    if (m.reactions && m.reactions.length) {
      const groups = new Map();
      for (const r of m.reactions) groups.set(r.emoji, (groups.get(r.emoji) || []).concat(r.user));
      node.append(el('div', { class: 'reacts' }, [...groups].map(([emoji, users]) =>
        el('button', { type: 'button', class: 'react' + (users.includes(me.id) ? ' on' : ''), title: users.map(nameOf).join(', '), onclick: () => react(m, emoji) },
          emoji, users.length > 1 ? el('small', { text: String(users.length) }) : null))));
    }
    node.append(el('div', { class: 'meta' + (m.edited ? ' keep' : '') },
      el('span', { text: fmtTime(m.created) }), m.edited ? el('span', { text: 'edited' }) : null));
    return node;
  }

  // visually group consecutive messages from the same person
  function regroup() {
    let prev = null;
    for (const n of msgBox.children) {
      if (!n.classList.contains('msg')) {
        prev = null;
        continue;
      }
      const g = !!prev && prev._m.from === n._m.from && n._m.created - prev._m.created < 3e5 && !n._m.reply;
      n.classList.toggle('grp', g);
      n.classList.remove('has-next');
      if (prev) prev.classList.toggle('has-next', g);
      prev = n;
    }
  }

  function updateSeen() {
    msgBox.querySelectorAll('.status').forEach((n) => n.remove());
    const last = msgs[msgs.length - 1];
    const f = friends.get(activeId);
    if (!last || !f || last.from !== me.id) return;
    const node = msgBox.querySelector(`.msg[data-id="${last.id}"] .meta`);
    const seen = (f.theirRead || 0) >= last.id;
    if (node) node.append(el('span', { class: 'status' + (seen ? ' seen' : ''), text: seen ? 'Seen' : 'Sent' }));
  }

  function renderMsgs() {
    const nodes = [];
    let last = '';
    for (const m of msgs) {
      const k = dayKey(m.created);
      if (k !== last) {
        nodes.push(el('div', { class: 'sep', text: fmtDay(m.created) }));
        last = k;
      }
      nodes.push(msgEl(m));
    }
    if (!msgs.length) nodes.push(el('div', { class: 'sep', text: 'No messages yet. Say something.' }));
    msgBox.replaceChildren(...nodes);
    regroup();
    updateSeen();
  }

  function jumpTo(id) {
    const node = msgBox.querySelector(`.msg[data-id="${id}"]`);
    if (!node) return toast('That message is further up or was deleted.');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  function addMsg(m) {
    const peer = m.from === me.id ? m.to : m.from;
    const f = friends.get(peer);
    if (!f) return;
    const incoming = m.from !== me.id;
    if (incoming) {
      if (gotIds.has(m.id)) return;
      gotIds.add(m.id);
    }
    if (!f.last || m.id >= f.last.id) f.last = m;
    if (peer === activeId) {
      if (!msgs.some((x) => x.id === m.id)) {
        const stick = pinned() || !incoming;
        const first = !msgs.length;
        const newDay = first || dayKey(msgs[msgs.length - 1].created) !== dayKey(m.created);
        msgs.push(m);
        if (first) msgBox.replaceChildren();
        if (newDay) msgBox.append(el('div', { class: 'sep', text: fmtDay(m.created) }));
        msgBox.append(msgEl(m, true));
        regroup();
        updateSeen();
        if (stick) toBottom();
        else if (incoming) setJump(jumpCount + 1);
      }
      if (incoming) {
        $('#typing').textContent = '';
        if (document.hidden || view !== 'chat') f.unread = (f.unread || 0) + 1;
        else markRead(peer);
      }
    } else if (incoming) f.unread = (f.unread || 0) + 1;
    if (incoming && (document.hidden || view !== 'chat' || peer !== activeId)) alertUser(f, m);
    renderFriends();
  }

  function updateMsg(m) {
    const peer = m.from === me.id ? m.to : m.from;
    const f = friends.get(peer);
    if (f && f.last && f.last.id === m.id) {
      f.last = m;
      renderFriends();
    }
    if (peer !== activeId) return;
    const i = msgs.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    msgs[i] = m;
    const node = msgBox.querySelector(`.msg[data-id="${m.id}"]`);
    const stick = pinned();
    if (node) node.replaceWith(msgEl(m));
    regroup();
    updateSeen();
    if (stick) toBottom();
  }

  document.addEventListener('visibilitychange', () => {
    const f = friends.get(activeId);
    if (!document.hidden && view === 'chat' && f && f.unread) {
      markRead(activeId);
      renderFriends();
    }
  });

  async function deleteMsg(m) {
    if (!(await confirmBox('Delete this message for everyone?', 'Delete'))) return;
    api('DELETE', '/api/messages/' + m.id).catch((e) => toast(e.message));
  }
  function react(m, emoji) {
    api('POST', `/api/messages/${m.id}/react`, { emoji }).catch((e) => toast(e.message));
  }

  function removeMsg(id, peer) {
    if (peer === activeId) {
      msgs = msgs.filter((x) => x.id !== id);
      if (replyTo && replyTo.id === id) clearCtx();
      if (editing && editing.id === id) clearCtx();
      const node = msgBox.querySelector(`.msg[data-id="${id}"]`);
      if (node) {
        node.classList.add('out');
        setTimeout(() => {
          const top = msgBox.scrollTop;
          renderMsgs();
          msgBox.scrollTop = top;
        }, 200);
      }
    }
    const f = friends.get(peer);
    if (f && f.last && f.last.id === id) {
      f.last = peer === activeId && msgs.length ? msgs[msgs.length - 1] : null;
      renderFriends();
    }
  }

  /* lightbox */
  function openLightbox(src) {
    $('#lightbox img').src = src;
    $('#lightbox').classList.remove('hidden');
  }
  $('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('#lightbox').classList.add('hidden');
    $('#settings').classList.add('hidden');
    if (!$('#cloak').classList.contains('hidden')) pickCloak(cloak || 'none');
    closePanels();
    clearCtx();
  });

  /* ---------- composer ---------- */
  const text = $('#text');
  function grow() {
    text.style.height = 'auto';
    text.style.height = Math.min(140, text.scrollHeight + 2) + 'px';
  }
  function setText(v) {
    text.value = v;
    grow();
  }

  function showCtx(title, body) {
    $('#ctx-title').textContent = title;
    $('#ctx-body').textContent = body;
    $('#ctx').classList.remove('hidden');
    text.focus();
  }
  function clearCtx() {
    if (editing) setText('');
    replyTo = editing = null;
    $('#ctx').classList.add('hidden');
    $('#send').textContent = 'Send';
  }
  function setReply(m) {
    clearCtx();
    replyTo = m;
    showCtx('Replying to ' + nameOf(m.from), snippet(m));
  }
  function setEdit(m) {
    clearCtx();
    editing = m;
    setText(m.content);
    $('#send').textContent = 'Save';
    showCtx('Editing message', m.content);
  }
  $('#ctx-x').addEventListener('click', clearCtx);
  const replyParam = () => (replyTo ? '&reply=' + replyTo.id : '');

  let lastTyping = 0;
  text.addEventListener('input', () => {
    grow();
    if (!activeId || editing || Date.now() - lastTyping < 2000) return;
    lastTyping = Date.now();
    api('POST', '/api/typing', { to: activeId }).catch(() => {});
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    } else if (e.key === 'ArrowUp' && !text.value && !editing) {
      const mine = [...msgs].reverse().find((m) => m.from === me.id && m.type === 'text');
      if (mine) {
        e.preventDefault();
        setEdit(mine);
      }
    }
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (recorder) return stopRec(true);
    const content = text.value.trim();
    if (!content || !activeId) return;
    const wasEdit = editing;
    const reply = replyTo;
    setText('');
    lastTyping = 0;
    try {
      if (wasEdit) {
        clearCtx();
        const { msg } = await api('PATCH', '/api/messages/' + wasEdit.id, { content });
        updateMsg(msg);
      } else {
        clearCtx();
        const { msg } = await api('POST', '/api/messages', { to: activeId, type: 'text', content, reply: reply && reply.id });
        addMsg(msg);
      }
    } catch (err) {
      setText(content);
      toast(err.message);
    }
  });

  // images
  $('#btn-img').addEventListener('click', () => $('#file-img').click());
  $('#file-img').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) sendImage(file);
  });
  async function sendImage(file) {
    if (!activeId) return;
    if (file.size > 10 * 1024 * 1024) return toast('File is too big (10 MB max).');
    const url = '/api/upload/image?to=' + activeId + replyParam();
    clearCtx();
    toast('Sending image...');
    try {
      const { msg } = await api('POST', url, file);
      addMsg(msg);
    } catch (err) {
      toast(err.message);
    }
  }
  // paste or drop images straight into the chat
  text.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      sendImage(item.getAsFile());
    }
  });
  let dragTimer;
  $('#chat').addEventListener('dragover', (e) => {
    e.preventDefault();
    $('#chat').classList.add('drag');
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => $('#chat').classList.remove('drag'), 200);
  });
  $('#chat').addEventListener('drop', (e) => {
    e.preventDefault();
    $('#chat').classList.remove('drag');
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) sendImage(file);
  });

  // profile picture + username
  $('#set-pic').addEventListener('click', () => $('#file-avatar').click());
  $('#file-avatar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { avatar } = await api('POST', '/api/avatar', file);
      me.avatar = avatar;
      renderMe();
      toast('Profile picture updated.');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#set-pic-remove').addEventListener('click', async () => {
    try {
      await api('DELETE', '/api/avatar');
      me.avatar = null;
      renderMe();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = $('#name-msg');
    try {
      const { user } = await api('POST', '/api/profile', { username: $('#set-name').value });
      me.username = user.username;
      renderMe();
      note.className = 'note';
      note.textContent = 'Saved. You now log in as ' + user.username + '.';
    } catch (err) {
      note.className = 'note bad';
      note.textContent = err.message;
    }
  });

  /* ---------- gif + emoji panels ---------- */
  function closePanels() {
    $('#gif-panel').classList.add('hidden');
    $('#emoji-panel').classList.add('hidden');
    $('#btn-gif').classList.remove('on');
    $('#btn-emo').classList.remove('on');
  }
  function togglePanel(name) {
    const panel = $(`#${name}-panel`);
    const open = panel.classList.contains('hidden');
    closePanels();
    if (!open) return false;
    panel.classList.remove('hidden');
    $(name === 'gif' ? '#btn-gif' : '#btn-emo').classList.add('on');
    return true;
  }

  let gifTimer;
  async function loadGifs(term) {
    const grid = $('#gif-grid');
    if (!gifsEnabled) {
      grid.replaceChildren(el('div', { class: 'none', text: 'GIFs are not set up yet. Add a GIPHY_API_KEY on the server (see README).' }));
      return;
    }
    try {
      const { gifs } = await api('GET', '/api/gifs?q=' + encodeURIComponent(term));
      if (!gifs.length) return grid.replaceChildren(el('div', { class: 'none', text: 'Nothing found.' }));
      grid.replaceChildren(
        ...gifs.map((g) =>
          el('button', { type: 'button', title: g.title, onclick: () => sendGif(g.url) }, el('img', { src: g.preview, alt: g.title, loading: 'lazy' }))
        )
      );
      grid.scrollTop = 0;
    } catch (err) {
      grid.replaceChildren(el('div', { class: 'none', text: err.message }));
    }
  }
  async function sendGif(url) {
    closePanels();
    const reply = replyTo;
    clearCtx();
    try {
      const { msg } = await api('POST', '/api/messages', { to: activeId, type: 'gif', content: url, reply: reply && reply.id });
      addMsg(msg);
    } catch (err) {
      toast(err.message);
    }
  }
  $('#btn-gif').addEventListener('click', () => {
    if (!togglePanel('gif')) return;
    $('#gif-search').value = '';
    loadGifs('');
    $('#gif-search').focus();
  });
  $('#gif-close').addEventListener('click', closePanels);
  $('#gif-search').addEventListener('input', (e) => {
    clearTimeout(gifTimer);
    gifTimer = setTimeout(() => loadGifs(e.target.value.trim()), 350);
  });

  $('#emoji-grid').append(
    ...EMOJI.map((e) =>
      el('button', {
        type: 'button',
        text: e,
        onclick: () => {
          const s = text.selectionStart ?? text.value.length;
          text.setRangeText(e, s, text.selectionEnd ?? s, 'end');
          grow();
          text.focus();
        },
      })
    )
  );
  $('#btn-emo').addEventListener('click', () => togglePanel('emoji'));

  /* ---------- voice messages ---------- */
  let recorder = null;
  let recChunks = [];
  let recStart = 0;
  let recTick = null;
  let recSend = false;
  let recTo = null;

  async function startRec() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return toast('Voice messages need an https:// address (use the online link).');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast('Microphone access was blocked.');
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    recTo = '?to=' + activeId + replyParam();
    closePanels();
    const rec = recorder;
    rec.addEventListener('dataavailable', (e) => e.data.size && recChunks.push(e.data));
    rec.addEventListener('stop', () => {
      stream.getTracks().forEach((t) => t.stop());
      const duration = (Date.now() - recStart) / 1000;
      const blob = new Blob(recChunks, { type: rec.mimeType || mime || 'audio/webm' });
      const send = recSend;
      recorder = null;
      clearInterval(recTick);
      $('#composer').classList.remove('recording');
      $('#btn-mic').classList.remove('on');
      if (send && blob.size && duration > 0.4) uploadVoice(blob, duration, recTo);
    });
    rec.start();
    recStart = Date.now();
    $('#rec-time').textContent = '0:00';
    $('#composer').classList.add('recording');
    $('#btn-mic').classList.add('on');
    recTick = setInterval(() => {
      const s = (Date.now() - recStart) / 1000;
      $('#rec-time').textContent = fmtDur(s);
      if (s >= 300) stopRec(true); // 5 minute cap
    }, 250);
  }
  function stopRec(send) {
    if (!recorder || recorder.state === 'inactive') return;
    recSend = send;
    recorder.stop();
  }
  function cancelRec() {
    stopRec(false);
  }
  async function uploadVoice(blob, duration, query) {
    if (replyTo) clearCtx();
    try {
      const { msg } = await api('POST', `/api/upload/voice${query}&duration=${duration.toFixed(1)}`, blob);
      addMsg(msg);
    } catch (err) {
      toast(err.message);
    }
  }
  $('#btn-mic').addEventListener('click', () => (recorder ? stopRec(true) : startRec()));
  $('#rec-cancel').addEventListener('click', cancelRec);

  /* ---------- alerts: sound + desktop notifications ---------- */
  let actx = null;
  function blip() {
    if (!prefs.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(740, t);
      o.frequency.exponentialRampToValueAtTime(1180, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + 0.3);
    } catch {}
  }
  function alertUser(f, m) {
    blip();
    if (!prefs.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(f.username, { body: snippet(m), icon: f.avatar || undefined, tag: 'chat-' + f.id });
      n.onclick = () => {
        window.focus();
        openChat(f.id);
        n.close();
      };
    } catch {}
  }

  /* ---------- settings ---------- */
  function renderSettings() {
    $('#set-sound').textContent = prefs.sound ? 'On' : 'Off';
    $('#set-sound').classList.toggle('on', prefs.sound);
    const granted = 'Notification' in window && Notification.permission === 'granted';
    $('#set-notify').textContent = prefs.notify && granted ? 'On' : 'Off';
    $('#set-notify').classList.toggle('on', prefs.notify && granted);
  }
  const openSettings = () => {
    renderSettings();
    $('#set-name').value = me.username;
    $('#name-msg').textContent = '';
    $('#pw-msg').textContent = '';
    $('#settings').classList.remove('hidden');
  };
  $('#open-settings').addEventListener('click', openSettings);
  $('#tile-profile').addEventListener('click', openSettings);
  $('#set-cloak').addEventListener('click', () => {
    $('#settings').classList.add('hidden');
    openCloak(false);
  });
  $('#set-close').addEventListener('click', () => $('#settings').classList.add('hidden'));
  $('#settings').addEventListener('click', (e) => e.target.id === 'settings' && $('#settings').classList.add('hidden'));
  $('#set-sound').addEventListener('click', () => {
    prefs.sound = !prefs.sound;
    savePrefs();
    renderSettings();
    blip();
  });
  $('#set-notify').addEventListener('click', async () => {
    if (!('Notification' in window)) return toast('This browser does not support notifications.');
    if (prefs.notify && Notification.permission === 'granted') prefs.notify = false;
    else {
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (p !== 'granted') toast('Notifications are blocked in your browser settings.');
      prefs.notify = p === 'granted';
    }
    savePrefs();
    renderSettings();
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = $('#pw-msg');
    try {
      await api('POST', '/api/password', { current: $('#pw-current').value, next: $('#pw-next').value });
      $('#pw-current').value = $('#pw-next').value = '';
      note.className = 'note';
      note.textContent = 'Password changed. Other devices were logged out.';
    } catch (err) {
      note.className = 'note bad';
      note.textContent = err.message;
    }
  });
  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    location.reload();
  });

  /* ---------- realtime ---------- */
  let typingTimer;
  let pingTimer;
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/~/ws');
    ws.addEventListener('open', () => {
      $('#net').classList.add('hidden');
      wsRetry = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => ws.readyState === 1 && ws.send('p'), 20000);
      if (wsDropped) boot(); // resync after a dropped connection
      wsDropped = false;
    });
    ws.addEventListener('close', () => {
      clearInterval(pingTimer);
      if (!me) return;
      wsDropped = true;
      wsRetry += 1;
      if (wsRetry > 1) $('#net').classList.remove('hidden');
      setTimeout(connect, Math.min(10000, 700 * wsRetry));
    });
    ws.addEventListener('message', (e) => {
      let d;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      handle(d);
    });
  }
  addEventListener('online', connect);

  function handle(d) {
    if (d.t === 'message') addMsg(d.msg);
    else if (d.t === 'message_updated') updateMsg(d.msg);
    else if (d.t === 'message_deleted') removeMsg(d.id, d.from === me.id ? d.to : d.from);
    else if (d.t === 'read') {
      const f = friends.get(d.by);
      if (!f) return;
      f.theirRead = d.upto;
      if (d.by === activeId) updateSeen();
    } else if (d.t === 'read_self') {
      const f = friends.get(d.id);
      if (f) f.unread = 0;
      renderFriends();
    } else if (d.t === 'chat_cleared') {
      const f = friends.get(d.id);
      if (f) {
        f.last = null;
        f.unread = 0;
      }
      if (d.id === activeId) {
        msgs = [];
        hasMore = false;
        clearCtx();
        renderMsgs();
      }
      renderFriends();
    } else if (d.t === 'friend_added') {
      reqIn.delete(d.friend.id);
      reqOut.delete(d.friend.id);
      renderRequests();
      if (!friends.has(d.friend.id)) {
        friends.set(d.friend.id, d.friend);
        if (d.by !== me.id) {
          toast(d.friend.username + ' accepted your friend request.');
          blip();
        }
      }
      renderFriends();
    } else if (d.t === 'request_in') {
      if (!reqIn.has(d.user.id)) {
        toast(d.user.username + ' sent you a friend request.');
        blip();
      }
      reqIn.set(d.user.id, d.user);
      renderRequests();
      renderFriends();
    } else if (d.t === 'request_out') {
      reqOut.set(d.user.id, d.user);
      renderRequests();
    } else if (d.t === 'request_gone') {
      reqIn.delete(d.id);
      reqOut.delete(d.id);
      renderRequests();
      renderFriends();
    } else if (d.t === 'profile') {
      if (d.id === me.id) {
        me.username = d.username;
        renderMe();
      }
      for (const map of [friends, reqIn, reqOut]) if (map.has(d.id)) map.get(d.id).username = d.username;
      renderRequests();
      renderFriends();
      if (d.id === activeId) renderHead();
      renderCall();
    } else if (d.t === 'call') onSignal(d);
    else if (d.t === 'call_self') {
      if (call && d.tab !== TAB && call.peer === d.peer && call.state === 'incoming') endCall();
    } else if (d.t === 'friend_removed') {
      if (call && call.peer === d.id) endCall('Call ended.');
      friends.delete(d.id);
      if (d.id === activeId) closeChat();
      else renderFriends();
    } else if (d.t === 'presence') {
      const f = friends.get(d.id);
      if (!f) return;
      f.online = d.online;
      if (!d.online && call && call.peer === d.id) endCall(f.username + ' went offline.');
      renderFriends();
      if (d.id === activeId) renderHead();
    } else if (d.t === 'avatar') {
      if (d.id === me.id) {
        me.avatar = d.avatar;
        renderMe();
      }
      const f = friends.get(d.id);
      if (f) {
        f.avatar = d.avatar;
        renderFriends();
        if (d.id === activeId) renderHead();
      }
      for (const map of [reqIn, reqOut]) if (map.has(d.id)) map.get(d.id).avatar = d.avatar;
      renderRequests();
    } else if (d.t === 'typing' && d.from === activeId) {
      const f = friends.get(d.from);
      $('#typing').textContent = (f ? f.username : 'Friend') + ' is typing...';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => ($('#typing').textContent = ''), 3000);
    }
  }


  /* ---------- views: home / chat / games ---------- */
  function go(v) {
    view = v;
    for (const name of ['home', 'chat', 'games']) $('#view-' + name).classList.toggle('on', name === v);
    $('#nav').dataset.view = v;
    document.body.classList.toggle('calm', v !== 'home');
    try { sessionStorage.setItem('view', v); } catch {}
    if (v === 'games') loadGames(false);
    if (v === 'chat' && activeId) {
      const f = friends.get(activeId);
      if (f && f.unread) {
        markRead(activeId);
        renderFriends();
      }
      toBottom();
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) go(b.dataset.go);
  });
  $('#home-date').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  /* ---------- 3d tilt: things lean toward the mouse ---------- */
  if (matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const bg = $('#bg');
    let cur = null;
    let raf = 0;
    let last = null;
    const reset = (n) => {
      n.classList.remove('tilting');
      n.style.removeProperty('--rx');
      n.style.removeProperty('--ry');
    };
    const frame = () => {
      raf = 0;
      const e = last;
      bg.style.setProperty('--px', (e.clientX / innerWidth - 0.5).toFixed(3));
      bg.style.setProperty('--py', (e.clientY / innerHeight - 0.5).toFixed(3));
      const t = e.target instanceof Element ? e.target.closest('[data-tilt]') : null;
      if (cur && cur !== t) reset(cur);
      cur = t;
      if (!t) return;
      // measure the still wrapper when there is one, so the maths does not chase the tilt
      const box = t.parentElement.classList.contains('tilt-wrap') ? t.parentElement : t;
      const r = box.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const max = Number(t.dataset.tilt) || 10;
      t.classList.add('tilting');
      t.style.setProperty('--ry', ((x - 0.5) * 2 * max).toFixed(2) + 'deg');
      t.style.setProperty('--rx', ((0.5 - y) * 2 * max).toFixed(2) + 'deg');
      t.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      t.style.setProperty('--my', (y * 100).toFixed(1) + '%');
    };
    addEventListener('pointermove', (e) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(frame);
    }, { passive: true });
    document.addEventListener('pointerleave', () => {
      if (cur) reset(cur);
      cur = null;
    });
  }

  /* ---------- tab cloak ---------- */
  const CLOAKS = {
    gmail: { label: 'Gmail', title: 'Gmail' },
    classroom: { label: 'Google Classroom', title: 'Classes' },
    docs: { label: 'Google Docs', title: 'Google Docs' },
    drive: { label: 'Google Drive', title: 'My Drive - Google Drive' },
  };
  let unreadTotal = 0;
  let cloak = store.get('cloak'); // null means we have never asked
  let cloakFirst = false;
  if (cloak && cloak !== 'none' && !CLOAKS[cloak]) cloak = 'none';
  const cloakOn = () => !!cloak && cloak !== 'none';

  function setTitle() {
    document.title = cloakOn() ? CLOAKS[cloak].title : (unreadTotal ? `(${unreadTotal}) ` : '') + 'sinning';
  }
  function applyCloak() {
    // browsers only notice a new tab icon when the tag itself is swapped
    const link = el('link', { id: 'favicon', rel: 'icon', href: cloakOn() ? '/~/icon/' + cloak : '/~/icon.svg' });
    $('#favicon').replaceWith(link);
    setTitle();
    const label = cloakOn() ? CLOAKS[cloak].label : 'Cloak off';
    $('#cloak-state').textContent = label;
    $('#open-cloak').classList.toggle('on', cloakOn());
    $('#tile-cloak-sub').textContent = cloakOn() ? 'Looks like ' + CLOAKS[cloak].label : 'Off';
  }
  function pickCloak(k) {
    const changed = k !== cloak;
    cloak = k;
    store.set('cloak', k);
    applyCloak();
    $('#cloak').classList.add('hidden');
    if (changed || cloakFirst) toast(cloakOn() ? 'This tab now looks like ' + CLOAKS[k].label + '.' : 'Tab cloak is off.');
    cloakFirst = false;
  }
  function openCloak(first) {
    cloakFirst = first;
    $('#cloak-title').textContent = first ? 'Cloak this tab?' : 'Tab cloak';
    const keys = first ? ['gmail', 'classroom', 'none'] : ['gmail', 'classroom', 'docs', 'drive', 'none'];
    $('#cloak-grid').replaceChildren(
      ...keys.map((k) => {
        const c = CLOAKS[k];
        const pic = el('span', { class: 'pic' + (c ? '' : ' plain') });
        if (c) {
          const img = el('img', { src: '/~/icon/' + k, alt: '' });
          img.addEventListener('error', () => pic.replaceChildren(c.label.replace('Google ', '')[0]));
          pic.append(img);
        } else pic.append(icon('x'));
        return el('button', { class: 'cloak-opt' + (!first && (cloak || 'none') === k ? ' sel' : ''), type: 'button', 'data-tilt': '16', onclick: () => pickCloak(k) },
          el('i', { class: 'glare' }), pic,
          el('span', { text: c ? c.label : first ? 'Skip' : 'No cloak' }),
          el('small', { text: c ? 'Tab reads "' + c.title + '"' : 'Keep the real tab' }));
      })
    );
    $('#cloak').classList.remove('hidden');
  }
  $('#open-cloak').addEventListener('click', () => openCloak(false));
  $('#tile-cloak').addEventListener('click', () => openCloak(false));
  $('#cloak').addEventListener('click', (e) => e.target.id === 'cloak' && !cloakFirst && $('#cloak').classList.add('hidden'));
  applyCloak();
  if (cloak === null) openCloak(true);

  /* ---------- games ---------- */
  let gameFrame = null;
  const MAX_SAVE = 4_000_000;
  function readSaves() {
    try {
      const s = JSON.parse(store.get('games-save') || '{}');
      return { l: (s && s.l) || {}, c: (s && s.c) || {} };
    } catch {
      return { l: {}, c: {} };
    }
  }
  function loadGames(force) {
    if (gameFrame && !force) return;
    if (gameFrame) gameFrame.remove();
    $('#games-loading').classList.remove('hidden');
    const f = document.createElement('iframe');
    f.title = 'Games';
    if (gamesCfg.isolate) {
      // locked box: games run, but cannot reach the chat. Their saves are handed in by name.
      f.setAttribute('sandbox', gamesCfg.sandbox);
      f.name = JSON.stringify({ __gs: readSaves() });
    }
    f.setAttribute('allow', 'fullscreen; gamepad; autoplay');
    f.setAttribute('allowfullscreen', '');
    f.referrerPolicy = 'no-referrer';
    f.addEventListener('load', () => $('#games-loading').classList.add('hidden'));
    f.src = '/?~games';
    $('#games-frame').append(f);
    gameFrame = f;
  }
  $('#games-home').addEventListener('click', () => loadGames(true));
  $('#games-reload').addEventListener('click', () => loadGames(true));
  $('#games-full').addEventListener('click', () => {
    const box = $('#games-frame');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (box.requestFullscreen) box.requestFullscreen().catch(() => toast('Fullscreen was blocked.'));
  });
  // games send their save changes up here; they are stored as plain text and never run
  addEventListener('message', (e) => {
    const m = e.data;
    if (!gameFrame || !m || m.__games !== 'save' || !m.d || typeof m.d !== 'object') return;
    let w = e.source;
    let inside = false;
    try {
      for (let i = 0; i < 8 && w; i++) {
        if (w === gameFrame.contentWindow) { inside = true; break; }
        if (w === w.parent) break;
        w = w.parent;
      }
    } catch {}
    if (!inside) return;
    const saves = readSaves();
    const clean = { l: {}, c: {} };
    for (const area of ['l', 'c']) {
      const d = m.d[area];
      if (!d || typeof d !== 'object') continue;
      for (const k of Object.keys(d)) {
        if (typeof d[k] === 'string') saves[area][k] = clean[area][k] = d[k];
        else {
          delete saves[area][k];
          clean[area][k] = null;
        }
      }
    }
    const text = JSON.stringify(saves);
    if (text.length <= MAX_SAVE) store.set('games-save', text);
    if (e.source !== gameFrame.contentWindow) {
      try { gameFrame.contentWindow.postMessage({ __games: 'sync', d: clean }, '*'); } catch {}
    }
  });

  /* ---------- voice calls (browser to browser; the server only introduces the two sides) ---------- */
  const TAB = Math.random().toString(36).slice(2);
  let call = null; // { peer, state: starting|outgoing|incoming|connecting|live, stream, pc, queue, muted, started, timeout }
  let ringTone = null;
  let callTick = null;
  const sig = (to, kind, data) => api('POST', '/api/call', { to, kind, data, tab: TAB });
  const stopStream = (s) => s && s.getTracks().forEach((t) => t.stop());

  function beep(freq, len) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + len + 0.02);
    } catch {}
  }
  function tone(kind) {
    clearInterval(ringTone);
    ringTone = null;
    if (!kind) return;
    const play = kind === 'in'
      ? () => { beep(880, 0.25); setTimeout(() => beep(1100, 0.35), 220); }
      : () => beep(440, 0.9);
    play();
    ringTone = setInterval(play, kind === 'in' ? 1800 : 2600);
  }

  async function getMic() {
    if (!navigator.mediaDevices || !window.RTCPeerConnection) throw new Error('Calls need an https:// address (use the online link).');
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      throw new Error('Microphone access was blocked.');
    }
  }

  function makePc(c) {
    const pc = new RTCPeerConnection({ iceServers });
    c.pc = pc;
    c.stream.getTracks().forEach((t) => {
      t.enabled = !c.muted;
      pc.addTrack(t, c.stream);
    });
    pc.onicecandidate = (e) => e.candidate && call === c && sig(c.peer, 'ice', e.candidate).catch(() => {});
    pc.ontrack = (e) => {
      const a = $('#call-audio');
      a.srcObject = e.streams[0] || new MediaStream([e.track]);
      a.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (call !== c) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        c.shaky = false;
        if (c.state !== 'live') {
          c.state = 'live';
          c.started = Date.now();
          clearTimeout(c.timeout);
        }
        renderCall();
      } else if (s === 'disconnected') {
        c.shaky = true;
        renderCall();
      } else if (s === 'failed') endCall('Call dropped. The two networks could not connect.', true);
    };
    clearTimeout(c.timeout);
    c.timeout = setTimeout(() => call === c && c.state !== 'live' && endCall('Could not connect the call.', true), 30000);
  }
  async function flushIce(c) {
    for (const cand of c.queue.splice(0)) await c.pc.addIceCandidate(cand).catch(() => {});
  }

  async function startCall(id) {
    const f = friends.get(id);
    if (!f) return;
    if (call) return toast('You are already in a call.');
    if (!f.online) return toast(f.username + ' is offline.');
    const c = (call = { peer: id, state: 'starting', queue: [] });
    renderCall();
    try {
      const stream = await getMic();
      if (call !== c) return stopStream(stream);
      c.stream = stream;
      await sig(id, 'ring');
    } catch (e) {
      if (call === c) endCall(e.message);
      return;
    }
    if (call !== c || c.state !== 'starting') return;
    c.state = 'outgoing';
    tone('out');
    c.timeout = setTimeout(() => call === c && endCall('No answer.', true), 35000);
    renderCall();
  }

  async function acceptCall() {
    const c = call;
    if (!c || c.state !== 'incoming') return;
    tone(null);
    clearTimeout(c.timeout);
    c.state = 'connecting';
    renderCall();
    try {
      const stream = await getMic();
      if (call !== c) return stopStream(stream);
      c.stream = stream;
    } catch (e) {
      if (call === c) {
        sig(c.peer, 'decline').catch(() => {});
        endCall(e.message);
      }
      return;
    }
    makePc(c);
    sig(c.peer, 'accept').catch((e) => call === c && endCall(e.message));
  }

  function endCall(msg, tell) {
    const c = call;
    if (!c) return;
    call = null;
    tone(null);
    clearTimeout(c.timeout);
    if (tell) sig(c.peer, 'hangup').catch(() => {});
    if (c.pc) {
      c.pc.onicecandidate = c.pc.ontrack = c.pc.onconnectionstatechange = null;
      c.pc.close();
    }
    stopStream(c.stream);
    $('#call-audio').srcObject = null;
    renderCall();
    if (msg) toast(msg);
  }

  async function onSignal(d) {
    const f = friends.get(d.from);
    if (!f) return;
    const k = d.kind;
    try {
      if (k === 'ring') {
        if (call && call.peer === d.from) {
          // you both hit call at the same moment: one side quietly picks up
          if (call.state === 'outgoing' && me.id < d.from) {
            const c = call;
            tone(null);
            c.state = 'connecting';
            makePc(c);
            renderCall();
            await sig(c.peer, 'accept');
          }
          return;
        }
        if (call) return void sig(d.from, 'busy').catch(() => {});
        const c = (call = { peer: d.from, state: 'incoming', queue: [] });
        tone('in');
        c.timeout = setTimeout(() => call === c && endCall('Missed call from ' + f.username + '.'), 40000);
        renderCall();
        if (prefs.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          try { new Notification(f.username, { body: 'Incoming voice call', tag: 'call-' + f.id }); } catch {}
        }
        return;
      }
      const c = call;
      if (!c || c.peer !== d.from) return;
      if (k === 'accept' && c.state === 'outgoing') {
        tone(null);
        c.state = 'connecting';
        makePc(c);
        renderCall();
        await c.pc.setLocalDescription(await c.pc.createOffer());
        await sig(c.peer, 'offer', c.pc.localDescription);
      } else if (k === 'offer' && c.pc && c.state === 'connecting') {
        await c.pc.setRemoteDescription(d.data);
        await flushIce(c);
        await c.pc.setLocalDescription(await c.pc.createAnswer());
        await sig(c.peer, 'answer', c.pc.localDescription);
      } else if (k === 'answer' && c.pc) {
        await c.pc.setRemoteDescription(d.data);
        await flushIce(c);
      } else if (k === 'ice' && d.data) {
        if (c.pc && c.pc.remoteDescription) await c.pc.addIceCandidate(d.data).catch(() => {});
        else c.queue.push(d.data);
      } else if (k === 'decline') endCall(f.username + ' declined the call.');
      else if (k === 'busy') endCall(f.username + ' is in another call.');
      else if (k === 'hangup') endCall(c.state === 'incoming' ? 'Missed call from ' + f.username + '.' : 'Call ended.');
    } catch (err) {
      console.error(err);
      if (call && call.peer === d.from) endCall('The call failed to connect.', true);
    }
  }

  function callStatus() {
    const c = call;
    if (c.state === 'incoming') return 'Incoming voice call';
    if (c.state === 'starting' || c.state === 'outgoing') return 'Calling';
    if (c.state === 'connecting') return 'Connecting';
    return (c.shaky ? 'Reconnecting' : fmtDur((Date.now() - c.started) / 1000)) + (c.muted ? ' · muted' : '');
  }
  function renderCall() {
    const box = $('#call');
    clearInterval(callTick);
    if (!call) return box.classList.add('hidden');
    const f = friends.get(call.peer) || { username: 'Friend' };
    const incoming = call.state === 'incoming';
    box.classList.remove('hidden');
    box.classList.toggle('ringing', call.state !== 'live' && call.state !== 'connecting');
    box.classList.toggle('live', call.state === 'live');
    $('#call-avatar').replaceChildren(avatarEl(f));
    $('#call-name').textContent = f.username;
    $('#call-status').textContent = callStatus();
    $('#call-accept').classList.toggle('hidden', !incoming);
    $('#call-mute').classList.toggle('hidden', incoming);
    $('#call-mute').classList.toggle('muted', !!call.muted);
    $('#call-mute').title = call.muted ? 'Unmute' : 'Mute';
    $('#call-mute-ic').setAttribute('href', call.muted ? '#i-micoff' : '#i-mic');
    $('#call-end').title = incoming ? 'Decline' : 'Leave call';
    if (call.state === 'live') callTick = setInterval(() => call && ($('#call-status').textContent = callStatus()), 1000);
  }

  $('#call-btn').addEventListener('click', () => activeId && startCall(activeId));
  $('#call-accept').addEventListener('click', acceptCall);
  $('#call-mute').addEventListener('click', () => {
    if (!call) return;
    call.muted = !call.muted;
    if (call.stream) call.stream.getAudioTracks().forEach((t) => (t.enabled = !call.muted));
    renderCall();
  });
  $('#call-end').addEventListener('click', () => {
    if (!call) return;
    if (call.state === 'incoming') {
      sig(call.peer, 'decline').catch(() => {});
      endCall();
    } else endCall(null, true);
  });
  // closing the tab hangs up
  addEventListener('pagehide', () => {
    if (!call) return;
    const body = new Blob([JSON.stringify({ to: call.peer, kind: call.state === 'incoming' ? 'decline' : 'hangup', tab: TAB })], { type: 'application/json' });
    try { navigator.sendBeacon('/~/api/call', body); } catch {}
  });

  boot();
})();
