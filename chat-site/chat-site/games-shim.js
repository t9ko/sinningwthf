// This runs inside every game page (the server slips it in at the top).
// Game pages are locked in a sandbox so they cannot touch the chat. Inside that sandbox the
// browser's normal save storage is switched off, so this hands games a working copy and asks
// the main site to keep it for them. That is how game saves survive a refresh.
(function () {
  try { window.localStorage.getItem('x'); return; } catch (e) {}
  var saved = {};
  try { var n = JSON.parse(window.name || '{}'); if (n && n.__gs) saved = n.__gs; } catch (e) {}
  var L = saved.l || {}, C = saved.c || {}, S = {};
  var top = window.top, pend = null, timer = 0;
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  function blob() { return JSON.stringify({ __gs: { l: L, c: C } }); }
  function flush() {
    timer = 0;
    var p = pend; pend = null;
    try { window.name = blob(); } catch (e) {}
    try { top.postMessage({ __games: 'save', d: p }, '*'); } catch (e) {}
  }
  function note(area, k, v) {
    if (!area) return;
    pend = pend || { l: {}, c: {} };
    pend[area][k] = v;
    if (!timer) timer = setTimeout(flush, 300);
  }
  addEventListener('pagehide', function () { if (pend) flush(); });
  function apply(t, d) { for (var k in d || {}) { if (typeof d[k] === 'string') t[k] = d[k]; else delete t[k]; } }
  addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== top || !m || m.__games !== 'sync' || !m.d) return;
    apply(L, m.d.l); apply(C, m.d.c);
  });

  function make(d, area) {
    var api = {
      getItem: function (k) { k = String(k); return has(d, k) ? d[k] : null; },
      setItem: function (k, v) { k = String(k); d[k] = String(v); note(area, k, d[k]); },
      removeItem: function (k) { k = String(k); delete d[k]; note(area, k, null); },
      clear: function () { for (var k in d) { delete d[k]; note(area, k, null); } },
      key: function (i) { return Object.keys(d)[i] || null; }
    };
    return new Proxy(api, {
      get: function (t, k) {
        if (k === 'length') return Object.keys(d).length;
        if (k in t) return t[k];
        return typeof k === 'string' && has(d, k) ? d[k] : undefined;
      },
      set: function (t, k, v) { t.setItem(k, v); return true; },
      deleteProperty: function (t, k) { t.removeItem(k); return true; },
      has: function (t, k) { return k in t || has(d, k); },
      ownKeys: function () { return Object.keys(d); },
      getOwnPropertyDescriptor: function (t, k) {
        if (has(d, k)) return { value: d[k], writable: true, enumerable: true, configurable: true };
      }
    });
  }
  var ls = make(L, 'l'), ss = make(S, null);
  try { Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return ls; } }); } catch (e) {}
  try { Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return ss; } }); } catch (e) {}
  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () { return Object.keys(C).map(function (k) { return k + '=' + C[k]; }).join('; '); },
      set: function (v) {
        v = String(v);
        var first = v.split(';')[0], i = first.indexOf('=');
        if (i < 1) return;
        var k = first.slice(0, i).trim(), val = first.slice(i + 1).trim();
        var exp = /expires\s*=\s*([^;]+)/i.exec(v);
        var gone = /max-age\s*=\s*(0|-)/i.test(v) || (exp && new Date(exp[1]) < new Date());
        if (gone) { delete C[k]; note('c', k, null); } else { C[k] = val; note('c', k, val); }
      }
    });
  } catch (e) {}

  // Games inside this page run in their own frames. A frame can only be handed its saves at the
  // moment it is created (through its name), so catch frames as they are made.
  var sameSite = function (v) { try { return new URL(v || '', location.href).host === location.host; } catch (e) { return false; } };
  function drop(f, v) { if (f.__gs && !sameSite(v)) { f.__gs = 0; f.removeAttribute('name'); } }
  try {
    var make0 = Document.prototype.createElement;
    Document.prototype.createElement = function (t) {
      var e = make0.apply(this, arguments);
      try { if (String(t).toLowerCase() === 'iframe') { e.setAttribute('name', blob()); e.__gs = 1; } } catch (x) {}
      return e;
    };
    // a frame pointed at some other website does not get the saves
    var sd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true, enumerable: true, get: sd.get,
      set: function (v) { drop(this, v); sd.set.call(this, v); }
    });
    var set0 = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (k, v) {
      if (this.tagName === 'IFRAME' && String(k).toLowerCase() === 'src') drop(this, v);
      return set0.apply(this, arguments);
    };
  } catch (e) {}
  // frames written straight into the page are swapped for a copy that carries the saves
  function tag(f) {
    try {
      if (f.tagName !== 'IFRAME' || f.__gs || f.hasAttribute('name') || !f.hasAttribute('src')) return;
      if (!sameSite(f.getAttribute('src'))) return;
      var c = f.cloneNode(true);
      c.setAttribute('name', blob());
      c.__gs = 1;
      f.replaceWith(c);
    } catch (e) {}
  }
  try {
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          tag(node);
          if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(tag);
        });
      });
    }).observe(document, { childList: true, subtree: true });
  } catch (e) {}

  // background workers cannot be started from a file path in a sandbox, so wrap them
  var W = window.Worker;
  if (W) {
    window.Worker = function (u, o) {
      try {
        var a = new URL(u, location.href).href;
        if (/^https?:/.test(a)) {
          var src = o && o.type === 'module' ? 'import ' + JSON.stringify(a) + ';' : 'importScripts(' + JSON.stringify(a) + ');';
          u = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        }
      } catch (e) {}
      return new W(u, o);
    };
    window.Worker.prototype = W.prototype;
  }
})();
