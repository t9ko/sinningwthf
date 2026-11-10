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
      r = await fetch(url, opt);
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

  /* ---------- custom cursor ---------- */
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.documentElement.classList.add('has-cursor');
    const dot = $('#cur-dot');
    const ring = $('#cur-ring');
    let mx = -100, my = -100, rx = -100, ry = -100;
    addEventListener('mousemove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.transform = `translate(${mx}px, ${my}px)`;
      dot.classList.remove('gone');
      ring.classList.remove('gone');
    }, { passive: true });
    (function loop() {
      rx += (mx - rx) * 0.2;
      ry += (my - ry) * 0.2;
      ring.style.transform = `translate(${rx}px, ${ry}px)`;
      requestAnimationFrame(loop);
    })();
    addEventListener('mouseover', (e) => {
      const t = e.target;
      const isText = t.matches && t.matches('input:not([type=file]), textarea');
      ring.classList.toggle('text', !!isText);
      ring.classList.toggle('hover', !isText && !!(t.closest && t.closest('button, a, label, .bubble.image img')));
    });
    addEventListener('mousedown', (e) => {
      ring.classList.add('down');
      const p = el('div', { class: 'pulse' });
      p.style.left = e.clientX + 'px';
      p.style.top = e.clientY + 'px';
      p.addEventListener('animationend', () => p.remove());
      document.body.append(p);
    });
    addEventListener('mouseup', () => ring.classList.remove('down'));
    document.addEventListener('mouseleave', () => {
      dot.classList.add('gone');
      ring.classList.add('gone');
    });
  }

  /* ---------- state ---------- */
  let me = null;
  let gifsEnabled = false;
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
      $('#app').classList.add('hidden');
      $('#auth').classList.remove('hidden');
      return;
    }
    me = data.user;
    gifsEnabled = data.gifs;
    friends.clear();
    data.friends.forEach((f) => friends.set(f.id, f));
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderMe();
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
    $('#me-avatar').replaceChildren(avatarEl(me));
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
    document.title = (total ? `(${total}) ` : '') + 'sinning';
    if (!list.length) {
      box.replaceChildren(el('div', { class: 'none', text: 'No friends yet. Add someone by their username above.' }));
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

  /* ---------- friends ---------- */
  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#add-input');
    const note = $('#add-msg');
    const username = input.value.trim();
    if (!username) return;
    try {
      const { friend } = await api('POST', '/api/friends', { username });
      friends.set(friend.id, friend);
      input.value = '';
      note.className = 'note';
      note.textContent = 'Added ' + friend.username + '.';
      renderFriends();
      openChat(friend.id);
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
      msgs = data.messages;
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
        if (document.hidden) f.unread = (f.unread || 0) + 1;
        else markRead(peer);
      }
    } else if (incoming) f.unread = (f.unread || 0) + 1;
    if (incoming && (document.hidden || peer !== activeId)) alertUser(f, m);
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
    if (!document.hidden && f && f.unread) {
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

  // profile picture
  $('#me-avatar').addEventListener('click', () => $('#file-avatar').click());
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
  $('#open-settings').addEventListener('click', () => {
    renderSettings();
    $('#pw-msg').textContent = '';
    $('#settings').classList.remove('hidden');
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
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
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
      if (!friends.has(d.friend.id)) {
        friends.set(d.friend.id, d.friend);
        renderFriends();
        if (!d.self) {
          toast(d.friend.username + ' added you as a friend.');
          blip();
        }
      }
    } else if (d.t === 'friend_removed') {
      friends.delete(d.id);
      if (d.id === activeId) closeChat();
      else renderFriends();
    } else if (d.t === 'presence') {
      const f = friends.get(d.id);
      if (!f) return;
      f.online = d.online;
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
    } else if (d.t === 'typing' && d.from === activeId) {
      const f = friends.get(d.from);
      $('#typing').textContent = (f ? f.username : 'Friend') + ' is typing...';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => ($('#typing').textContent = ''), 3000);
    }
  }

  boot();
})();
