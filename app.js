/* Family Gift Registry — front end */
(function () {
  'use strict';

  var CFG = window.GR_CONFIG || {};
  // The shared kit site sits on the same web domain as a family's own copy, so its saved data gets its own names.
  var NS = CFG.KIT ? 'kit_' : '';
  var LS_TOKEN = NS + 'gr_token', LS_LINK = NS + 'gr_link', LS_SNAP = NS + 'gr_snap', LS_API = NS + 'gr_api', LS_DEMO = NS + 'gr_demo';
  /*
   * Which family's registry (Apps Script backend) this site talks to:
   *  1. config.js API_URL: a family's own copy of the site (always wins)
   *  2. ?api=<web app id or URL> in a family's link: the shared site, remembered on this device
   *  3. nothing: the shared site shows a welcome screen (paste your link, or try the demo)
   */
  function apiFromParam(v) {
    v = String(v || '').trim();
    if (/^[A-Za-z0-9_-]{20,}$/.test(v)) return 'https://script.google.com/macros/s/' + v + '/exec';
    if (/^https:\/\/script\.google\.com\/(?:a\/[^\/?#]+\/)?macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(v)) return v;
    return '';
  }
  var API = CFG.API_URL || '', API_FROM_LINK = false;
  (function () {
    if (API) return;
    var m = location.search.match(/[?&]api=([^&#]+)/), fromLink = m ? apiFromParam(decodeURIComponent(m[1])) : '';
    var saved = lsGet(LS_API);
    if (fromLink) {
      if (fromLink !== saved) { // a different family's registry: forget the old sign-in and saved data on this device
        [LS_TOKEN, LS_SNAP, LS_LINK, LS_DEMO].forEach(function (k) { lsSet(k, null); });
        lsSet(LS_API, fromLink);
      }
      API = fromLink;
    } else if (saved) API = saved;
    API_FROM_LINK = !!API;
  })();
  if (!API && /[?&]demo=1\b/.test(location.search)) lsSet(LS_DEMO, '1'); // the README's "look around the demo" link
  var DEMO = !API && (!CFG.KIT || lsGet(LS_DEMO) === '1');
  var NEED_CONNECT = !API && !DEMO;
  var S = {
    token: lsGet(LS_TOKEN), user: null, items: [], settings: {}, lists: {}, myPledges: [], admin: null,
    f: { who: 'all', occ: '', cat: '', q: '', hideTaken: false }, adminFilter: 'Active'
  };

  /* ================================================================ helpers */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n, exact) {
    n = Number(n) || 0;
    var s = exact || n % 1 ? n.toFixed(2) : String(Math.round(n));
    return '$' + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function initials(name) {
    var w = String(name || '?').replace(/&/g, ' ').split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : String(name).slice(0, 2)).toUpperCase();
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function fmtDate(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }); }
  function ago(iso) {
    if (!iso) return 'never';
    var m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 2) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' hr ago';
    var d = Math.round(h / 24); return d === 1 ? 'yesterday' : d + ' days ago';
  }
  function isAdmin() { return S.user && S.user.role === 'admin'; }
  function isKid() { return S.user && S.user.role === 'kid'; }
  function toast(msg, kind, sub) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.innerHTML = esc(msg) + (sub ? '<small>' + esc(sub) + '</small>' : '');
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'err' ? 6000 : 3800);
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = label || 'Working…'; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }

  /* ==================================================================== api */
  var pending = 0;
  function api(action, body) {
    var req = Object.assign({ action: action, token: S.token }, body || {});
    pending++; setSync();
    var p = DEMO ? window.GRMockApi.call(req) : Promise.race([
      fetch(API, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(req) })
        .then(function (r) { return r.json(); }),
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, 45000); })
    ]);
    return p.then(function (res) {
      pending--; setSync();
      if (!res.ok) { var e = new Error(res.error || 'Something went wrong.'); e.auth = res.auth; throw e; }
      return res.data;
    }, function (err) {
      pending--; setSync(true);
      throw new Error(err && err.message === 'timeout'
        ? 'The registry took too long to answer. Your change may still have saved, so reload the page to check before trying again.'
        : 'Can\'t reach the registry right now. Check your internet connection and try again.');
    }).catch(function (e) {
      if (e.auth && action !== 'login') { S.token = null; lsSet(LS_TOKEN, null); clearSnap(); showSignIn(e.message); }
      throw e;
    });
  }
  /* Fast paths: one round trip per change, and last-known data shown instantly. */
  function snapshot() { return { user: S.user, items: S.items, settings: S.settings, lists: S.lists, myPledges: S.myPledges }; }
  function saveSnap() { if (S.token && S.user) lsSet(LS_SNAP, JSON.stringify({ token: S.token, boot: snapshot(), admin: S.admin })); }
  function loadSnap() { try { var x = JSON.parse(lsGet(LS_SNAP)); return x && x.token === S.token && x.boot ? x : null; } catch (e) { return null; } }
  function clearSnap() { lsSet(LS_SNAP, null); }
  function applyAll(d) {
    if (d.boot) applyBoot(d.boot);
    if ('admin' in d) S.admin = d.admin || null;
    saveSnap();
  }
  /** A change that comes back with fresh page data. Falls back to separate reloads on an older backend. */
  function act(action, body) {
    return api(action, Object.assign({ withData: true }, body || {})).then(function (d) {
      if (d && typeof d === 'object' && 'result' in d && 'boot' in d) { applyAll(d); return d.result; }
      return Promise.all([api('bootstrap').then(applyBoot), isAdmin() ? loadAdmin() : null]).then(function () { saveSnap(); return d; });
    });
  }
  function rerender() { renderChrome(); render(); }
  /** Background refresh: don't disturb an open dialog or a filter someone is typing in. */
  function softRender() {
    if (!$('modal').hidden) return;
    renderChrome();
    if (route().page === 'registry' && $('grid')) drawGrid(); else render();
  }
  function setSync(err) {
    var el = $('sync'); if (!el) return;
    el.innerHTML = err ? '<span class="err">● Offline</span>' : pending ? '● Saving…' : '';
  }

  /* ================================================================== icons */
  var I = {
    'Ski & Snow': '<path d="M2 20l6.5-11 4 6 2.8-4.2L22 20z"/><path d="M6.6 12.3l1.9 1.3 1.6-1.4 1.4 1.1"/>',
    Climbing: '<path d="M8.5 3.5c3.5-1.4 8 .6 9.6 4.4 1.7 4-.3 8.6-4.3 10.6-3 1.5-6.9.4-8.4-2.6L3.6 11c-1-2.6 1.6-6.3 4.9-7.5z"/><path d="M9.5 8.5l3 6.5"/>',
    Camping: '<path d="M3 20L12 4l9 16z"/><path d="M12 4v16M9 20l3-5 3 5"/>',
    Hiking: '<path d="M7 7a5 5 0 0110 0v13H7z"/><path d="M7 11h10M10 15h4M10 3.5h4"/>',
    Bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h6l2 8M10 8l2.5 8H6M14.5 5h3"/>',
    Water: '<path d="M2 15c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0M2 19c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0"/><path d="M5 11l7-7 7 7"/>',
    Fishing: '<path d="M3 12c3-4 8-5.5 13-2.5L21 6v12l-5-3.5C11 17.5 6 16 3 12z"/><circle cx="7.5" cy="11.2" r=".8" fill="currentColor"/>',
    Clothing: '<path d="M8 3l4 3 4-3 5 3-2 5-2-1v11H7V10l-2 1-2-5z"/><path d="M12 6v15"/>',
    Other: '<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M3 13h18M12 9v12M12 9c-1.5-4-6-4.5-6-1.8C6 9 12 9 12 9s6 0 6-1.8C18 4.5 13.5 5 12 9z"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
    gift: '<rect x="3.5" y="9" width="17" height="11.5" rx="1.5"/><path d="M2.5 9h19M12 9v11.5M12 9c-1.4-3.8-5.6-4.4-5.6-1.8C6.4 8.9 12 9 12 9s5.6-.1 5.6-1.8C17.6 4.6 13.4 5.2 12 9z"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0112 7.3a4.3 4.3 0 017.5 2.5C19.5 15.4 12 20 12 20z"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 00-1 1v8a1 1 0 001 1h14a1 1 0 001-1v-8a1 1 0 00-1-1h-1"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>'
  };
  function icon(name, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[name] || I.Other) + '</svg>';
  }
  function imgOf(it) { return it.image || (it.photos && it.photos[0]) || ''; }
  function picture(it) {
    var src = imgOf(it);
    return src ? '<img src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<div class=ph>' + icon(it.category).replace(/"/g, '&quot;') + '</div>\'">'
      : '<div class="ph">' + icon(it.category) + '</div>';
  }
  var STATE_LABEL = { available: 'Available', partial: 'Partly pledged', full: 'Fully pledged' };
  function statePill(it) {
    if (it.admin && it.admin.hidden) return '<span class="pill hidden">Surprise</span>';
    if (!it.pledgeState) return '';
    return '<span class="pill ' + it.pledgeState + '">' + STATE_LABEL[it.pledgeState] + '</span>';
  }

  /* ================================================================ sign in */
  function showSignIn(msg) {
    $('app').hidden = true; $('signin').hidden = false; closeModal();
    $('signinErr').textContent = msg || '';
    $('signinPin').value = '';
    var link = lsGet(LS_LINK);
    api('signinInfo', link ? { k: link } : {}).catch(function () {
      // older backend: two calls
      return api('people').then(function (names) {
        return link ? api('linkInfo', { k: link }).then(function (i) { return { names: names, linked: i && i.name }; }) : { names: names, linked: null };
      });
    }).then(function (info) {
      if (info.familyName) { $('signinFamily').textContent = info.familyName; document.title = info.familyName + ' Gift Registry'; }
      if (info.hosts) $('signinHelp').textContent = 'Don\'t have a PIN? Ask ' + info.hosts + '.';
      var sel = $('signinName'), names = info.names || [];
      sel.innerHTML = '<option value="">Choose your name…</option>' + names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
      if (info.linked && names.indexOf(info.linked) >= 0) { sel.value = info.linked; setLinked(info.linked); }
      else setLinked(null);
    }).catch(function (e) { $('signinErr').textContent = e.message; });
  }
  function setLinked(name) {
    $('linkedName').hidden = !name; $('nameField').hidden = !!name;
    $('linkedNameText').textContent = name || '';
    if (name) setTimeout(function () { $('signinPin').focus(); }, 50);
  }
  $('notMe').onclick = function () { lsSet(LS_LINK, null); $('signinName').value = ''; setLinked(null); };
  $('signinForm').onsubmit = function (e) {
    e.preventDefault();
    var btn = $('signinBtn'); busy(btn, true, 'Signing in…'); $('signinErr').textContent = '';
    api('login', { name: $('signinName').value, pin: $('signinPin').value.trim(), withData: true }).then(function (r) {
      S.token = r.token; lsSet(LS_TOKEN, r.token); S.user = r.user; S.admin = null;
      return start(r.boot ? r : null);
    }).catch(function (err) { $('signinErr').textContent = err.message; })
      .then(function () { busy(btn, false); });
  };

  /* ================================================================== start */
  function showApp() {
    $('signin').hidden = true; $('app').hidden = false;
    renderChrome();
    if (!location.hash || location.hash === '#') location.hash = '#/registry'; else render();
  }
  function start(loginData) {
    if (loginData) { applyAll(loginData); showApp(); return Promise.resolve(); }
    // Show the last-known data right away, then refresh it in the background.
    var snap = loadSnap();
    if (snap) { applyBoot(snap.boot); S.admin = snap.admin || null; showApp(); }
    return api('bootstrap').then(function (d) {
      applyBoot(d); saveSnap();
      if (snap) softRender(); else showApp();
      if (snap && isAdmin()) loadAdmin().then(function () { saveSnap(); if (route().page === 'admin') softRender(); }).catch(function () {});
    });
  }
  function applyBoot(d) {
    S.user = d.user; S.items = d.items; S.settings = d.settings; S.lists = d.lists; S.myPledges = d.myPledges;
  }
  function refresh(quiet) {
    return api('bootstrap').then(function (d) { applyBoot(d); saveSnap(); softRender(); })
      .catch(function (e) { if (!quiet) toast(e.message, 'err'); });
  }
  function loadAdmin() { return api('adminData').then(function (d) { S.admin = d; saveSnap(); return d; }); }

  /* ================================================================= chrome */
  function renderChrome() {
    $('familyName').textContent = S.settings.familyName || 'Our Family';
    document.title = (S.settings.familyName || 'Family') + ' Gift Registry';
    $('userChip').innerHTML = '<span class="av">' + esc(initials(S.user.name)) + '</span><span class="nm">' + esc(S.user.name) + '</span>';
    var r = route();
    var tabs = [['registry', isKid() ? 'Wish list' : 'Registry']];
    if (!isKid()) tabs.push(['mine', 'My pledges']);
    var html = tabs.map(function (t) { return '<a href="#/' + t[0] + '" class="mainl' + (r.page === t[0] ? ' on' : '') + '">' + t[1] + '</a>'; }).join('');
    if (isAdmin()) {
      html += '<span class="sep"></span>' + [['items', 'Manage items'], ['money', 'Pledges & money'], ['alerts', 'Price alerts'],
        ['thanks', 'Thank-yous'], ['people', 'People'], ['settings', 'Settings']].map(function (t) {
        return '<a href="#/admin/' + t[0] + '" class="adml' + (r.page === 'admin' && r.sub === t[0] ? ' on' : '') + '">' + t[1] + '</a>';
      }).join('');
    }
    $('nav').innerHTML = html;
    // Phones: bottom tab bar (kids only have one page, so they don't get one)
    var bar = [];
    if (!isKid()) {
      var active = S.myPledges.filter(function (p) { return p.status === 'active'; }).length;
      bar.push(['#/registry', 'gift', 'Registry', r.page === 'registry' || r.page === '']);
      bar.push(['#/mine', 'heart', 'My pledges', r.page === 'mine', active]);
      if (isAdmin()) bar.push(['#/admin/' + (r.page === 'admin' && r.sub ? r.sub : 'items'), 'sliders', 'Manage', r.page === 'admin']);
    }
    $('tabbar').innerHTML = bar.map(function (b) {
      return '<a href="' + b[0] + '" class="' + (b[3] ? 'on' : '') + '"' + (b[3] ? ' aria-current="page"' : '') + '>' + icon(b[1]) +
        (b[4] ? '<span class="badge">' + b[4] + '</span>' : '') + '<span>' + b[2] + '</span></a>';
    }).join('');
    document.body.classList.toggle('has-tabbar', bar.length > 0);
    document.body.classList.toggle('on-admin', r.page === 'admin');
  }
  $('userChip').onclick = function (e) {
    e.stopPropagation();
    var m = $('userMenu');
    if (!m.hidden) { m.hidden = true; return; }
    var u = S.user;
    m.innerHTML = '<div class="uh"><b>' + esc(u.name) + '</b><span>' + (u.role === 'admin' ? 'Admin' : u.role === 'kid' ? 'Wish list' : 'Family') + '</span></div>' +
      (u.role === 'admin' ? '<button type="button" id="mSurprise">Surprise mode <span class="sw ' + (u.surprise ? 'on' : '') + '"></span></button>' +
        '<p class="hint">When on, you won\'t see pledges on items tagged ' + esc(u.name) + '.</p>' : '') +
      (canOfferInstall() ? '<button type="button" id="mInstall">Add to Home Screen</button>' : '') +
      '<button type="button" id="mPin">Change my PIN</button>' +
      '<button type="button" id="mOut">Sign out</button>';
    m.hidden = false; $('userChip').setAttribute('aria-expanded', 'true');
    if ($('mSurprise')) $('mSurprise').onclick = function () {
      act('setSurprise', { on: !S.user.surprise }).then(function (u2) {
        if (u2 && u2.name) S.user = u2;
        m.hidden = true;
        toast(S.user.surprise ? 'Surprise mode on. Pledges on your items are hidden.' : 'Surprise mode off.');
        rerender();
      }).catch(function (er) { toast(er.message, 'err'); });
    };
    $('mPin').onclick = function () { m.hidden = true; changePinModal(); };
    if ($('mInstall')) $('mInstall').onclick = function () { m.hidden = true; doInstall(); };
    $('mOut').onclick = function () {
      api('logout').catch(function () {});
      S.token = null; S.user = null; S.admin = null; lsSet(LS_TOKEN, null); clearSnap(); m.hidden = true;
      showSignIn();
    };
  };
  document.addEventListener('click', function (e) {
    var m = $('userMenu');
    if (!m.hidden && !m.contains(e.target)) { m.hidden = true; $('userChip').setAttribute('aria-expanded', 'false'); }
  });

  /* ================================================================= router */
  function route() {
    var h = location.hash.replace(/^#\/?/, ''), qi = h.indexOf('?');
    var p = (qi >= 0 ? h.slice(0, qi) : h).split('/');
    return { page: p[0] || 'registry', sub: p[1] || '', query: qi >= 0 ? h.slice(qi + 1) : '' };
  }
  window.addEventListener('hashchange', function () { if (S.user) { renderChrome(); render(); window.scrollTo(0, 0); } });
  function render() {
    var r = route(), main = $('main');
    if (r.page === 'add') return handleAddFromStore(r.query);
    if (r.page === 'mine' && !isKid()) return renderMine(main);
    if (r.page === 'admin' && isAdmin()) return renderAdmin(main, r.sub || 'items');
    return renderRegistry(main);
  }

  /* =============================================================== registry */
  function renderRegistry(main) {
    var kid = isKid(), f = S.f;
    var name = S.user.name;
    var hero = kid
      ? '<section class="hero kid topo"><p class="eyebrow">Hi, ' + esc(name) + '</p><h2>Your wish list</h2><p>Everything on the family list. Want something added? Ask Mom or Dad.</p></section>'
      : '<section class="hero topo"><p class="eyebrow">Hi, ' + esc(name) + '</p><h2>Help outfit the next adventure</h2>' +
        '<p>Pick something, pledge it, and we\'ll do the buying' + (S.settings.stores ? ' through our ' + esc(S.settings.stores) + ' memberships' : '') + ', so everything is warrantied and bought at the best price we can find.</p>' +
        '<div class="promises"><span>' + icon('lock') + 'Your pledges are private</span><span>' + icon('shield') + 'Warrantied purchases</span><span>' + icon('tag') + 'We watch for sales</span></div></section>';

    var tags = S.lists.tags || [];
    var who = '<div class="who"><button type="button" data-who="all" class="all ' + (f.who === 'all' ? 'on' : '') + '">Everyone</button>' +
      tags.map(function (t) { return '<button type="button" data-who="' + t + '" class="' + (f.who === t ? 'on' : '') + '"><span class="av">' + initials(t) + '</span>' + t + '</button>'; }).join('') + '</div>';
    var occs = '<select id="fOcc" aria-label="Occasion"><option value="">All occasions</option>' + (S.lists.occasions || []).map(function (o) { return '<option' + (f.occ === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>';
    var cats = S.items.map(function (i) { return i.category; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).sort();
    var catSel = '<select id="fCat" aria-label="Category"><option value="">All gear</option>' + cats.map(function (c) { return '<option' + (f.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>';
    var filters = '<div class="filters">' + who +
      '<button type="button" class="btn btn-ghost btn-sm filt-btn" id="fToggle" aria-expanded="' + (S.filtersOpen ? 'true' : 'false') + '">' + icon('sliders').replace('<svg', '<svg width="16" height="16"') + 'Filters<span class="fcount" id="fCount"></span></button>' +
      '<div class="more-filters' + (S.filtersOpen ? ' open' : '') + '" id="moreF">' + occs + catSel +
      '<div class="search">' + icon('search') + '<input type="search" id="fQ" placeholder="Search" value="' + esc(f.q) + '" aria-label="Search"></div>' +
      (kid ? '' : '<label class="toggle-inline"><input type="checkbox" id="fHide"' + (f.hideTaken ? ' checked' : '') + '> Hide taken</label>') + '</div></div>';

    main.innerHTML = hero + installTip() + filters + '<p class="count-line" id="countLine"></p><div class="grid" id="grid"></div>';
    wireInstallTip();
    $('fToggle').onclick = function () {
      S.filtersOpen = !S.filtersOpen;
      $('moreF').classList.toggle('open', S.filtersOpen); this.setAttribute('aria-expanded', S.filtersOpen ? 'true' : 'false');
    };
    main.querySelectorAll('.who button').forEach(function (b) { b.onclick = function () { f.who = b.dataset.who; renderRegistry(main); }; });
    $('fOcc').onchange = function () { f.occ = this.value; drawGrid(); };
    $('fCat').onchange = function () { f.cat = this.value; drawGrid(); };
    $('fQ').oninput = function () { f.q = this.value; drawGrid(); };
    if ($('fHide')) $('fHide').onchange = function () { f.hideTaken = this.checked; drawGrid(); };
    drawGrid();
  }
  function visibleItems() {
    var f = S.f, q = f.q.trim().toLowerCase();
    var order = { available: 0, partial: 1, full: 2 };
    return S.items.filter(function (it) {
      if (it.status !== 'Active' && it.status !== 'Purchased' && !(isAdmin() && it.status === 'Given')) return false;
      if (f.who !== 'all' && it.tags.indexOf(f.who) < 0) return false;
      if (f.occ && it.occasion !== f.occ && it.occasion !== 'Anytime') return false;
      if (f.cat && it.category !== f.cat) return false;
      if (f.hideTaken && it.pledgeState === 'full') return false;
      if (q && (it.title + ' ' + it.brand + ' ' + it.category + ' ' + it.tags.join(' ') + ' ' + it.notes).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) {
      var sa = order[a.pledgeState] || 0, sb = order[b.pledgeState] || 0;
      return sa - sb || a.priority - b.priority || a.title.localeCompare(b.title);
    });
  }
  function drawGrid() {
    var list = visibleItems(), grid = $('grid');
    if (!grid) return;
    var nf = (S.f.occ ? 1 : 0) + (S.f.cat ? 1 : 0) + (S.f.q.trim() ? 1 : 0) + (S.f.hideTaken ? 1 : 0);
    if ($('fCount')) $('fCount').textContent = nf ? String(nf) : '';
    var avail = list.filter(function (i) { return i.pledgeState !== 'full'; }).length;
    $('countLine').textContent = list.length + ' item' + (list.length === 1 ? '' : 's') + (isKid() ? '' : ' · ' + avail + ' still open');
    if (!list.length) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><b>Nothing here yet</b>Try a different filter.</div>'; return; }
    grid.innerHTML = list.map(function (it) {
      var taken = it.pledgeState === 'full';
      return '<button type="button" class="card' + (taken ? ' taken' : '') + '" data-id="' + esc(it.id) + '">' +
        '<div class="card-img">' + picture(it) + (it.priority === 1 && !taken ? '<span class="rib">Most wanted</span>' : '') + '<span class="st">' + statePill(it) + '</span></div>' +
        '<div class="card-b"><div class="card-t">' + esc(it.title) + '</div>' + (it.brand ? '<div class="card-brand">' + esc(it.brand) + '</div>' : '') +
        '<div class="card-meta">' + it.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
        (it.size ? '<span class="tag sz">' + esc(it.size) + '</span>' : '') + (it.groupGift && !taken ? '<span class="tag group">Group gift</span>' : '') + '</div>' +
        '<div class="card-f"><span class="price">' + (it.price ? '<small>about </small>' + money(it.price) : '') + '</span><span class="tag occ">' + esc(it.occasion) + '</span></div></div></button>';
    }).join('');
    grid.querySelectorAll('.card').forEach(function (c) { c.onclick = function () { openItem(c.dataset.id); }; });
  }

  /* ============================================================ item modal */
  function openModal(html, wide) {
    $('modalBody').innerHTML = html;
    $('modal').querySelector('.modal').className = 'modal' + (wide ? ' wide' : '');
    $('modal').hidden = false; document.body.style.overflow = 'hidden'; document.body.classList.add('modal-open');
    $('modal').scrollTop = 0;
  }
  function closeModal() { $('modal').hidden = true; $('modalBody').innerHTML = ''; document.body.style.overflow = ''; document.body.classList.remove('modal-open'); }
  $('modalClose').onclick = closeModal;
  $('modal').addEventListener('mousedown', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

  function findItem(id) { return S.items.filter(function (i) { return i.id === id; })[0] || (S.admin && S.admin.items.filter(function (i) { return i.id === id; })[0]); }

  function openItem(id) {
    var it = findItem(id); if (!it) return;
    var pics = [it.image].concat(it.photos || []).filter(Boolean);
    var gal = '<div class="gal"><div class="main-img" id="mainImg">' + picture(it) + '</div>' +
      (pics.length > 1 ? '<div class="thumbs">' + pics.map(function (p, i) { return '<button type="button" data-src="' + esc(p) + '" class="' + (i ? '' : 'on') + '"><img src="' + esc(p) + '" alt="" referrerpolicy="no-referrer"></button>'; }).join('') + '</div>' : '') + '</div>';
    var details = '<dl class="dl">' + [['For', it.tags.join(', ')], ['Occasion', it.occasion], ['Size', it.size], ['Color', it.color], ['Gear', it.category], ['Estimate', it.price ? 'about ' + money(it.price) : '']]
      .filter(function (r) { return r[1]; }).map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>';
    var links = it.links && it.links.length ? '<p class="section-t">See it online</p><div class="storelinks">' + it.links.map(function (l) {
      return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(l.retailer || 'Store') + icon('ext').replace('<svg', '<svg width="15" height="15"') + '</a>';
    }).join('') + '</div>' : '';
    var body = '<div class="m-hero">' + gal + '<div class="mb">' +
      '<h3 id="modalTitle">' + esc(it.title) + '</h3><p class="sub">' + esc(it.brand || '') + (it.priority === 1 ? ' · <b style="color:var(--alpen)">Most wanted</b>' : '') + '</p>' +
      statePill(it) + details +
      (it.notes ? '<div class="note">' + esc(it.notes) + '</div>' : '') +
      '<div id="pledgeArea">' + pledgeArea(it) + '</div>' + links +
      (it.description ? '<details><summary class="section-t" style="cursor:pointer">Product details</summary><p style="font-size:13px;color:var(--ink2)">' + esc(it.description) + '</p></details>' : '') +
      (S.settings.contactNote && !isKid() ? '<p style="font-size:12px;color:var(--mute);margin-top:14px">' + esc(S.settings.contactNote) + '</p>' : '') +
      '</div></div>';
    openModal(body, true);
    $('modalBody').querySelectorAll('.thumbs button').forEach(function (b) {
      b.onclick = function () {
        $('modalBody').querySelectorAll('.thumbs button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        $('mainImg').innerHTML = '<img src="' + esc(b.dataset.src) + '" alt="" referrerpolicy="no-referrer">';
      };
    });
    wirePledge(it);
  }

  function myActivePledge(it) {
    return S.myPledges.filter(function (p) { return p.itemId === it.id && p.status === 'active'; })[0];
  }
  function pledgeArea(it) {
    if (isKid()) return '<div class="note privacy">' + icon('check') + '<span>This is on the family wish list.</span></div>';
    var mine = myActivePledge(it);
    if (it.tags.length === 1 && it.tags[0] === S.user.name) return '<div class="note">This one is on your own list.</div>';
    if (mine) {
      return '<div class="note privacy">' + icon('check') + '<span>You pledged <b>' + money(mine.amount, true) + '</b> toward this. Thank you! ' +
        (it.status === 'Active' ? 'You can change or cancel it under <a href="#/mine">My pledges</a>.' : 'We\'ve bought it.') + '</span></div>' +
        (it.groupGift && it.pledgeState === 'partial' ? '' : '');
    }
    if (it.admin && it.admin.hidden) return '<div class="note">Surprise mode is on, so pledge activity on this item is hidden from you.</div>';
    if (it.pledgeState === 'full' || it.status !== 'Active') return '<div class="note">This gift is taken care of. Thank you, family!</div>';
    var group = it.groupGift;
    return '<form id="pledgeForm" class="pledge">' +
      '<p class="section-t">' + (group ? 'Chip in on this group gift' : 'Pledge this gift') + '</p>' +
      (group
        ? '<p style="font-size:13px;color:var(--ink2);margin-bottom:10px">Several people can go in on this one. Pledge any amount.</p>' +
          '<div class="chips-pick" style="margin-bottom:10px">' + [25, 50, 100, 250].map(function (a) { return '<label><input type="radio" name="amtq" value="' + a + '"> ' + money(a) + '</label>'; }).join('') + '</div>' +
          '<label class="fld"><span>Amount</span><input type="number" id="pAmt" min="5" step="1" inputmode="decimal" placeholder="$" required></label>'
        : '<p style="font-size:13px;color:var(--ink2);margin-bottom:10px">About <b>' + money(it.price) + '</b>. You\'ll pay what we actually pay, which is often less once we find a sale.</p>') +
      '<span class="fld" style="margin-bottom:6px"><span>How would you like to pay?</span></span>' +
      '<label class="check on"><input type="radio" name="pay" value="reimburse" checked><div><b>Pay you back after you buy it</b><small>We\'ll email the final price and your share.</small></div></label>' +
      '<label class="check"><input type="radio" name="pay" value="upfront"><div><b>Send money now</b><small>' + esc(S.settings.paymentNote || '') + '</small></div></label>' +
      '<label class="fld" style="margin-top:12px"><span>Note to ' + esc(S.settings.hosts || 'us') + ' (optional)</span><textarea id="pNote" maxlength="500" placeholder="Anything we should know?"></textarea></label>' +
      '<div class="note privacy">' + icon('lock') + '<span>Only ' + esc(S.settings.hosts || 'the organizers') + ' will know this is from you. Everyone else just sees that it\'s ' + (group ? 'pledged' : 'taken') + '.</span></div>' +
      '<p class="form-err" id="pErr"></p>' +
      '<div class="sticky-cta"><button class="btn btn-primary btn-block" type="submit" id="pBtn">' + (group ? 'Pledge' : 'Pledge this gift') + '</button></div></form>';
  }
  function wirePledge(it) {
    var form = $('pledgeForm'); if (!form) return;
    form.querySelectorAll('input[name=amtq]').forEach(function (r) {
      r.onchange = function () {
        $('pAmt').value = r.value;
        form.querySelectorAll('input[name=amtq]').forEach(function (x) { x.parentNode.classList.toggle('on', x.checked); });
      };
    });
    form.querySelectorAll('input[name=pay]').forEach(function (r) {
      r.onchange = function () { form.querySelectorAll('input[name=pay]').forEach(function (x) { x.closest('.check').classList.toggle('on', x.checked); }); };
    });
    form.onsubmit = function (e) {
      e.preventDefault();
      var btn = $('pBtn'); busy(btn, true, 'Saving your pledge…'); $('pErr').textContent = '';
      act('pledge', { itemId: it.id, amount: $('pAmt') ? $('pAmt').value : 0, payMethod: form.querySelector('input[name=pay]:checked').value, note: $('pNote').value })
        .then(function (r) {
          $('pledgeArea').innerHTML = '<div class="success"><div class="big">' + icon('check') + '</div>' +
            '<h3 style="padding:0">Thank you!</h3><p style="margin:6px 0 4px">You pledged <b>' + money(r.pledge.amount, true) + '</b> toward ' + esc(it.title) + '.</p>' +
            (r.capped ? '<p style="font-size:12.5px;color:var(--mute)">That was the amount still needed to finish this gift.</p>' : '') +
            '<p style="font-size:12.5px;color:var(--mute)">' + (S.user.email ? 'A confirmation is on its way to your email. ' : '') + 'See it any time under My pledges.</p></div>';
          if ($('grid')) drawGrid();
        })
        .catch(function (er) { $('pErr').textContent = er.message; busy(btn, false); });
    };
  }

  /* ============================================================ my pledges */
  function renderMine(main) {
    var list = S.myPledges;
    var active = list.filter(function (p) { return p.status === 'active'; });
    var owed = active.filter(function (p) { return !p.paid && p.itemStatus !== 'Active' && p.payMethod === 'reimburse'; })
      .reduce(function (s, p) { return s + (p.share || p.amount); }, 0);
    var html = '<div class="page-h"><div><h2>My pledges</h2><p>Only you and ' + esc(S.settings.hosts || 'the organizers') + ' can see these.</p></div></div>';
    if (active.length) {
      html += '<div class="stats"><div class="stat hl"><span>Active pledges</span><b>' + active.length + '</b></div>' +
        '<div class="stat"><span>Total pledged</span><b>' + money(active.reduce(function (s, p) { return s + p.amount; }, 0), true) + '</b></div>' +
        (owed ? '<div class="stat"><span>To pay back</span><b>' + money(owed, true) + '</b></div>' : '') + '</div>';
    }
    if (!list.length) {
      html += '<div class="panel"><div class="empty"><b>No pledges yet</b>Browse the <a href="#/registry">registry</a> and pick something.</div></div>';
      main.innerHTML = html; return;
    }
    html += '<div class="panel">' + list.map(function (p) {
      var st, acts = '';
      if (p.status === 'cancelled') st = '<span class="tag occ">Cancelled</span>';
      else if (p.itemStatus === 'Active') { st = '<span class="tag">Pledged · waiting for the best price</span>'; acts = '<button class="btn btn-ghost btn-sm" data-cancel="' + p.id + '">Cancel</button>'; }
      else if (p.itemStatus === 'Purchased') st = '<span class="tag ok">Bought</span>';
      else st = '<span class="tag ok">Given</span>';
      var money1 = p.status === 'active' && p.share ? 'Your share ' + money(p.share, true) + (p.share !== p.amount ? ' (pledged ' + money(p.amount, true) + ')' : '') : money(p.amount, true);
      var pay = p.status !== 'active' ? '' : p.paid ? '<span class="tag ok">Paid</span>' : p.payMethod === 'upfront' ? '<span class="tag sale">Paying up front</span>' : p.itemStatus === 'Active' ? '<span class="tag occ">Pay after purchase</span>' : '<span class="tag sale">Payment due</span>';
      return '<div class="li"><div class="thumb">' + picture({ image: p.itemImage, category: '' }) + '</div><div class="grow"><div class="t">' + esc(p.itemTitle) + '</div>' +
        '<div class="s"><b style="color:var(--ink)">' + money1 + '</b>' + st + pay + '<span>' + fmtDate(p.createdAt) + '</span></div></div><div class="acts">' + acts + '</div></div>';
    }).join('') + '</div>';
    if (owed) html += '<div class="note">' + esc(S.settings.paymentNote || '') + '</div>';
    main.innerHTML = html;
    main.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Cancel this pledge? The item will open back up for others.')) return;
        busy(b, true, 'Cancelling…');
        act('cancelPledge', { id: b.dataset.cancel }).then(function () { toast('Pledge cancelled.'); rerender(); })
          .catch(function (e) { toast(e.message, 'err'); busy(b, false); });
      };
    });
  }

  /* ================================================================= admin */
  function renderAdmin(main, sub) {
    if (!S.admin) {
      main.innerHTML = '<div class="empty">Loading…</div>';
      return loadAdmin().then(function () { renderAdmin(main, sub); }).catch(function (e) { main.innerHTML = '<div class="empty"><b>Couldn\'t load</b>' + esc(e.message) + '</div>'; });
    }
    var fn = { items: adminItems, money: adminMoney, alerts: adminAlerts, thanks: adminThanks, people: adminPeople, settings: adminSettings }[sub] || adminItems;
    fn(main);
  }


  /* ---------- "Add to registry" bookmark button */
  // Runs on the store's product page in the admin's own browser, reads the product's
  // structured data, and opens the registry with the item form filled in.
  function bookmarkletSource(SITE) {
    var out = { url: location.href.split('#')[0], title: '', brand: '', image: '', price: 0, description: '' };
    var prods = [], prices = [];
    function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      var t = [].concat(n['@type'] || []);
      if (t.indexOf('Product') >= 0 || t.indexOf('ProductGroup') >= 0) prods.push(n);
      if (n['@graph']) walk(n['@graph']);
      if (n.hasVariant) walk(n.hasVariant);
    }
    function offers(o) {
      [].concat(o || []).forEach(function (x) {
        if (!x) return;
        [x.lowPrice, x.price, x.priceSpecification && x.priceSpecification.price].forEach(function (p) {
          p = parseFloat(String(p == null ? '' : p).replace(/[$,]/g, '')); if (p > 0) prices.push(p);
        });
        if (x.offers) offers(x.offers);
      });
    }
    function meta(k) {
      var m = document.querySelector('meta[property="' + k + '"],meta[name="' + k + '"],meta[itemprop="' + k + '"]');
      return m ? m.getAttribute('content') || '' : '';
    }
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) { try { walk(JSON.parse(s.textContent)); } catch (e) { } });
    prods.forEach(function (p) {
      out.title = out.title || p.name || '';
      if (!out.brand && p.brand) out.brand = typeof p.brand === 'object' ? p.brand.name || '' : p.brand;
      if (!out.image && p.image) { var im = [].concat(p.image)[0]; out.image = typeof im === 'object' ? im.url || im.contentUrl || '' : im; }
      out.description = out.description || p.description || '';
      offers(p.offers);
    });
    if (prices.length) out.price = Math.min.apply(null, prices);
    else { var mp = parseFloat(meta('product:price:amount') || meta('og:price:amount') || meta('price')); if (mp > 0) out.price = mp; }
    out.title = out.title || meta('og:title') || document.title;
    out.image = out.image || meta('og:image');
    try { if (out.image) out.image = new URL(out.image, location.href).href; } catch (e) { }
    out.description = String(out.description || meta('og:description')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400);
    window.open(SITE + '#/add?d=' + encodeURIComponent(JSON.stringify(out)), '_blank');
  }
  function siteBase() { return ((S.admin && S.admin.settings.SiteURL) || (location.origin + location.pathname)).replace(/[?#].*$/, ''); }
  /** Query string that points a shared site at this family's registry ('' for a family's own copy). */
  function apiParam() {
    if (!API_FROM_LINK) return '';
    var id = (API.match(/\/macros\/s\/([^\/]+)\/exec$/) || [])[1];
    return id && /^https:\/\/script\.google\.com\/macros\//.test(API) ? 'api=' + id : 'api=' + encodeURIComponent(API);
  }
  function bookmarkletHref() {
    var q = apiParam();
    return 'javascript:' + encodeURIComponent('(' + bookmarkletSource.toString() + ')(' + JSON.stringify(siteBase() + (q ? '?' + q : '')) + ');void 0');
  }
  function handleAddFromStore(query) {
    if (!isAdmin()) { location.replace('#/registry'); return; }
    var m = String(query || '').match(/(?:^|&)d=([^&]*)/), data = null;
    try { data = m ? JSON.parse(decodeURIComponent(m[1])) : null; } catch (e) { data = null; }
    history.replaceState(null, '', location.pathname + '#/admin/items');
    renderChrome();
    var go = function () {
      renderAdmin($('main'), 'items');
      if (!data) return;
      var matches = storeMatches(data.url);
      if (matches.length) updatePriceModal(matches, data.price, data); else itemEditor(null, data);
    };
    if (S.admin) go(); else loadAdmin().then(go).catch(function (e) { toast(e.message, 'err'); });
  }

  /* ---------- update a price by hand */
  /** Store links on the registry (active items, or bought and still in the price-adjustment window) for this product page. */
  function storeMatches(url) {
    var out = [];
    (S.admin ? S.admin.items : []).forEach(function (it) {
      if (it.status !== 'Active' && it.status !== 'Purchased') return;
      it.admin.links.forEach(function (l) { if (window.GR && GR.sameProduct(l.url, url)) out.push({ it: it, l: l }); });
    });
    return out;
  }
  function updatePriceModal(matches, pagePrice, pageData) {
    var first = matches[0], store = first.l.retailer || 'the store';
    var html = '<div class="mb"><h3 id="modalTitle">Update price</h3><p class="sub">' +
      (pageData ? 'This page is already on the registry' + (matches.length > 1 ? ' (' + matches.length + ' entries)' : '') + '. Record today\'s price?' : 'Look up today\'s price at ' + esc(store) + ' and enter it here.') + '</p>' +
      '<div class="panel" style="box-shadow:none;margin-bottom:12px">' + matches.map(function (x) {
        var since = x.l.lastPrice ? money(x.l.lastPrice, true) + ' · ' + ago(x.l.lastChecked) : 'no price yet';
        return '<div class="li"><div class="grow"><div class="t">' + esc(x.it.title) + '</div><div class="s"><span class="tag">' + esc(x.it.tags.join(', ')) + '</span>' +
          (x.it.size ? '<span>' + esc(x.it.size) + '</span>' : '') + '<span>' + esc(x.l.retailer) + ': ' + since + '</span>' +
          (x.it.status === 'Purchased' ? '<span class="tag sale">price watch</span>' : '') + '</div></div></div>';
      }).join('') + '</div>' +
      (!pageData ? '<a class="btn btn-ghost btn-block" href="' + esc(first.l.url) + '" target="_blank" rel="noopener noreferrer" style="margin-bottom:12px">Open ' + esc(store) + ' ' + icon('ext').replace('<svg', '<svg width="15" height="15"') + '</a>' : '') +
      '<form id="upForm"><label class="fld"><span>Price today at ' + esc(store) + '</span><input type="number" id="upPrice" step="0.01" min="0.01" inputmode="decimal" required value="' + (pagePrice > 0 ? esc(pagePrice) : '') + '" placeholder="$"></label>' +
      (pageData && !(pagePrice > 0) ? '<p class="fetch-msg err" style="margin:-6px 0 10px">Couldn\'t read the price from that page. Type it in.</p>' : '') +
      '<p class="form-err" id="upErr"></p><div class="btn-row"><button class="btn btn-primary" type="submit" id="upSave">Record price</button>' +
      (pageData ? '<button type="button" class="btn btn-ghost" id="upNew">Add as a new item instead</button>' : '<button type="button" class="btn btn-ghost" id="upCancel">Cancel</button>') + '</div></form></div>';
    openModal(html);
    if ($('upNew')) $('upNew').onclick = function () { closeModal(); itemEditor(null, pageData); };
    if ($('upCancel')) $('upCancel').onclick = closeModal;
    setTimeout(function () { if ($('upPrice') && !pageData) $('upPrice').focus(); }, 80);
    $('upForm').onsubmit = function (e) {
      e.preventDefault();
      var btn = $('upSave'); busy(btn, true, 'Saving…'); $('upErr').textContent = '';
      act('recordPrice', { linkIds: matches.map(function (x) { return x.l.id; }), price: $('upPrice').value }).then(function (r) {
        closeModal();
        var hit = (r.items || []).filter(function (x) { return x.alert; })[0];
        if (hit && hit.alert.type === 'adjust') toast('Price dropped since you bought it.', '', 'Ask ' + store + ' for a price adjustment: you paid ' + money(hit.alert.refPrice, true) + ', now ' + money(hit.alert.newPrice, true) + '.');
        else if (hit) toast('That\'s a sale!', '', money(hit.alert.newPrice, true) + ' vs. your ' + money(hit.alert.refPrice, true) + ' estimate. It\'s on the Price alerts page.');
        else toast('Price recorded.', '', r.recorded > 1 ? 'Saved on ' + r.recorded + ' entries.' : '');
        rerender();
      }).catch(function (er) { $('upErr').textContent = er.message; busy(btn, false); });
    };
  }

  /* ---------- items */
  function adminItems(main) {
    var A = S.admin, fs = S.adminFilter;
    var counts = {}; A.items.forEach(function (i) { counts[i.status] = (counts[i.status] || 0) + 1; });
    var list = A.items.filter(function (i) { return fs === 'All' || i.status === fs; })
      .sort(function (a, b) { return a.priority - b.priority || a.title.localeCompare(b.title); });
    var html = '<div class="page-h"><div><h2>Manage items</h2><p>Add gear, record purchases and keep the list current.</p></div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="chkAll">Check prices now</button><button class="btn btn-primary" id="addItem">+ Add item</button></div></div>' +
      '<div class="filters"><div class="who">' + ['Active', 'Purchased', 'Given', 'Archived', 'All'].map(function (s) {
        return '<button type="button" class="all ' + (fs === s ? 'on' : '') + '" data-fs="' + s + '">' + s + (s !== 'All' && counts[s] ? ' · ' + counts[s] : '') + '</button>';
      }).join('') + '</div>' + (counts.Given ? '<button class="btn btn-ghost btn-sm" id="archive">Archive given items</button>' : '') + '</div>';
    html += '<div class="panel">' + (list.length ? list.map(adminItemRow).join('') : '<div class="empty"><b>No ' + fs.toLowerCase() + ' items</b></div>') + '</div>';
    html += '<details class="panel bm-panel"><summary class="panel-h" style="cursor:pointer"><div><h3>Add items straight from a store page</h3>' +
      '<p>Works on most stores, even ones that block the automatic lookup.</p></div></summary><div class="mb">' +
      '<ol style="padding-left:18px;font-size:13.5px;line-height:1.8"><li>On a computer, drag this button up to your browser\'s bookmarks bar: ' +
      '<a class="btn btn-deep btn-sm" id="bmLink" href="#" onclick="return false" title="Drag me to your bookmarks bar">+ Add to registry</a></li>' +
      '<li>Open any product page and pick the size or color you want.</li>' +
      '<li>Click <b>+ Add to registry</b> in your bookmarks bar. The registry opens with the name, price, photo and link filled in.</li></ol>' +
      '<p style="font-size:12px;color:var(--mute)">Can\'t see the bookmarks bar? Chrome: ⌘⇧B (Mac) or Ctrl+Shift+B. Safari: View → Show Favorites Bar.</p></div></details>';
    main.innerHTML = html;
    $('bmLink').setAttribute('href', bookmarkletHref());
    $('bmLink').onclick = function () { toast('Drag this button to your bookmarks bar, then click it on a store page.'); return false; };
    main.querySelectorAll('[data-fs]').forEach(function (b) { b.onclick = function () { S.adminFilter = b.dataset.fs; adminItems(main); }; });
    $('addItem').onclick = function () { itemEditor(null); };
    $('chkAll').onclick = function () { runPriceCheck(this); };
    if ($('archive')) $('archive').onclick = function () {
      if (!confirm('Move all given items to the archive? They\'ll leave the registry but stay in the Sheet.')) return;
      act('archiveGiven').then(function (r) { toast(r.archived + ' items archived.'); rerender(); }).catch(function (e) { toast(e.message, 'err'); });
    };
    main.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () {
        var it = A.items.filter(function (i) { return i.id === b.dataset.id; })[0];
        var what = b.dataset.act;
        if (what === 'edit') itemEditor(it);
        if (what === 'copy') itemEditor(null, null, copyFromItem(it));
        if (what === 'bought') purchaseModal(it);
        if (what === 'view') openItem(it.id);
        if (what === 'check') runPriceCheck(b, it.id);
        if (what === 'given' || what === 'reopen') {
          var st = what === 'given' ? 'Given' : 'Active';
          if (what === 'reopen' && !confirm('Put this item back on the active list? Purchase details will be cleared.')) return;
          act('setStatus', { id: it.id, status: st }).then(function () { toast(what === 'given' ? 'Marked as given.' : 'Back on the list.'); rerender(); }).catch(function (e) { toast(e.message, 'err'); });
        }
        if (what === 'delete') {
          if (!confirm('Delete "' + it.title + '"? This can\'t be undone.')) return;
          act('deleteItem', { id: it.id }).then(function () { toast('Deleted.'); rerender(); }).catch(function (e) { toast(e.message, 'err'); });
        }
      };
    });
  }
  function adminItemRow(it) {
    var a = it.admin, sub = [];
    sub.push(it.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join(' '));
    if (a.hidden) sub.push('<span class="pill hidden">Pledges hidden (surprise mode)</span>');
    else if (it.status === 'Active') {
      if (it.groupGift) {
        var pct = a.pledgeGoal ? Math.min(100, Math.round(a.pledgeTotal / a.pledgeGoal * 100)) : 0;
        sub.push('<span class="mini-progress"><i class="' + (pct >= 100 ? 'done' : '') + '" style="width:' + pct + '%"></i></span> ' + money(a.pledgeTotal) + ' of ' + money(a.pledgeGoal));
      } else sub.push(statePill(it));
      if (a.pledges && a.pledges.length) sub.push(esc(a.pledges.map(function (p) { return p.giver; }).filter(function (g, i, arr) { return arr.indexOf(g) === i; }).join(', ')));
    } else if (it.status === 'Purchased') {
      sub.push('<span class="tag ok">Bought ' + money(a.purchasePrice, true) + (a.purchaseRetailer ? ' at ' + esc(a.purchaseRetailer) : '') + '</span>');
      if (a.watchUntil && new Date(a.watchUntil) > new Date()) sub.push('<span class="tag sale">Price watch until ' + fmtDate(a.watchUntil) + '</span>');
    } else sub.push('<span class="tag occ">' + esc(it.status) + (a.givenAt ? ' ' + fmtDate(a.givenAt) : '') + '</span>');
    var best = a.bestPrice;
    if (best && it.status === 'Active') sub.push((it.price && best < it.price ? '<span class="tag sale">Now ' + money(best, true) + '</span>' : 'Best ' + money(best, true)));
    var blocked = a.links.filter(function (l) { return l.checkStatus === 'blocked' || l.checkStatus === 'no-price'; }).length;
    if (blocked) sub.push('<span class="tag warn">' + blocked + ' store' + (blocked > 1 ? 's' : '') + ' not tracked</span>');
    var acts = '<button class="btn btn-ghost btn-sm" data-act="edit" data-id="' + it.id + '">Edit</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="copy" data-id="' + it.id + '" title="Same item for someone else, or another size or color">Copy</button>';
    if (it.status === 'Active') acts += '<button class="btn btn-deep btn-sm" data-act="bought" data-id="' + it.id + '">Mark bought</button>';
    if (it.status === 'Purchased') acts += '<button class="btn btn-primary btn-sm" data-act="given" data-id="' + it.id + '">Mark given</button>';
    if (it.status !== 'Active') acts += '<button class="btn btn-ghost btn-sm" data-act="reopen" data-id="' + it.id + '">Reopen</button>';
    if (a.links.length && (it.status === 'Active' || it.status === 'Purchased')) acts += '<button class="btn btn-ghost btn-sm" data-act="check" data-id="' + it.id + '">Check price</button>';
    if (!a.hidden && (!a.pledges || !a.pledges.length)) acts += '<button class="btn btn-danger btn-sm" data-act="delete" data-id="' + it.id + '">Delete</button>';
    return '<div class="li"><button type="button" class="thumb" data-act="view" data-id="' + it.id + '" style="cursor:pointer;padding:0">' + picture(it) + '</button>' +
      '<div class="grow"><div class="t">' + esc(it.title) + (it.priority === 1 ? ' <span class="tag sale">Most wanted</span>' : '') + '</div><div class="s">' +
      (it.price ? '<b style="color:var(--ink)">' + money(it.price) + '</b>' : '') + sub.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div></div><div class="acts">' + acts + '</div></div>';
  }
  function priceSummary(r) {
    return r.ok + ' with a price · ' + r.blocked + ' blocked · ' + r.noPrice + ' no price · ' + r.alerts + ' new alert' + (r.alerts === 1 ? '' : 's') +
      (r.skipped ? ' · ' + r.skipped + ' left for next run' : '');
  }
  function runPriceCheck(btn, itemId) {
    busy(btn, true, 'Starting…');
    act('checkPrices', { itemId: itemId }).then(function (r) {
      busy(btn, false);
      if (r && r.started) {
        toast(r.already ? 'A price check is already running.' : 'Price check started.', '',
          'It runs in the background and takes 1–5 minutes. You can keep using the site. Results show on Price alerts; sales are emailed.');
        rerender(); watchPriceRun();
        return;
      }
      toast('Checked ' + r.checked + ' store link' + (r.checked === 1 ? '' : 's') + '.', '', priceSummary(r)); // demo mode runs inline
      rerender();
    }).catch(function (e) { toast(e.message, 'err'); busy(btn, false); });
  }
  var priceWatch = null;
  /** While a background check runs, poll its status every 15 s (max 8 min) and refresh when it's done. */
  function watchPriceRun() {
    if (priceWatch) return;
    var started = Date.now();
    priceWatch = setInterval(function () {
      if (!S.user || !isAdmin() || Date.now() - started > 8 * 60000) { clearInterval(priceWatch); priceWatch = null; return; }
      api('priceRun').then(function (run) {
        if (S.admin) S.admin.priceRun = run;
        var pg = route();
        if (pg.page === 'admin' && pg.sub === 'alerts') softRender();
        if (run && run.state === 'done') {
          clearInterval(priceWatch); priceWatch = null;
          loadAdmin().then(function () {
            var fresh = S.admin.priceRun;
            if (!fresh || !fresh.finishedAt || fresh.finishedAt < run.finishedAt) { S.admin.priceRun = run; saveSnap(); }
            toast('Price check finished.', '', priceSummary(run.summary || {}));
            if (route().page === 'admin') softRender();
          }).catch(function () {});
        }
      }).catch(function () {});
    }, 15000);
  }
  function priceRunLine(run) {
    if (!run) return '<div class="note">No price check has run yet. They run automatically every morning around 6 AM.</div>';
    var active = (run.state === 'running' || run.state === 'queued') && Date.now() - new Date(run.startedAt || run.queuedAt) < 8 * 60000;
    if (active) return '<div class="note"><b>' + (run.state === 'queued' ? 'Price check starting…' : 'Checking prices now…') + '</b> Started ' + ago(run.startedAt || run.queuedAt) +
      '. Stores that block automated checks can take a minute each. This page updates when it\'s done.</div>';
    if (run.state === 'done') return '<div class="note">Last check finished ' + ago(run.finishedAt) + ': ' + priceSummary(run.summary || {}) + '.</div>';
    return '<div class="note warn">The last price check didn\'t finish (Google stops scripts after 6 minutes). The next run picks up where it left off.</div>';
  }

  /* ---------- item editor */
  /** Everything about an item worth copying, minus who it's for, size and color. */
  function copyOf(src) {
    return {
      title: src.title || '', brand: src.brand || '', price: src.price || '', description: src.description || '',
      occasion: src.occasion || 'Christmas', category: src.category || '', priority: src.priority || 2, groupGift: !!src.groupGift,
      notes: src.notes || '', image: src.image || '', photos: (src.photos || []).slice(),
      links: (src.links || []).filter(function (l) { return l.url; }).map(function (l) { return { retailer: l.retailer || '', url: l.url }; }),
      targetPrice: src.targetPrice || '', alertPct: src.alertPct || '',
      fromTags: (src.tags || []).slice(), fromSize: src.size || '', fromColor: src.color || ''
    };
  }
  function copyFromItem(it) {
    var c = copyOf(it);
    c.links = it.admin.links.map(function (l) { return { retailer: l.retailer, url: l.url }; });
    c.targetPrice = it.admin.targetPrice || ''; c.alertPct = it.admin.alertPct || '';
    return c;
  }
  function itemEditor(it, prefill, copy) {
    var L = S.lists, a = it && it.admin;
    var d = it ? JSON.parse(JSON.stringify(it)) : { title: '', brand: '', tags: [], occasion: 'Christmas', category: '', size: '', color: '', notes: '', description: '', priority: 2, groupGift: false, price: '', image: '', photos: [] };
    var links = a ? a.links.map(function (l) { return { retailer: l.retailer, url: l.url }; }) : [];
    var alertVals = { target: a ? a.targetPrice || '' : '', pct: a ? a.alertPct || '' : '' };
    if (copy) {
      Object.keys(copy).forEach(function (k) { if (k in d) d[k] = copy[k]; });
      d.tags = []; d.size = ''; d.color = '';
      links = copy.links.slice();
      alertVals = { target: copy.targetPrice, pct: copy.alertPct };
    }
    if (prefill) {
      d.title = String(prefill.title || '').replace(/\s*\|\s*[^|]*$/, '').trim().slice(0, 200);
      d.brand = String(prefill.brand || '').slice(0, 100);
      d.price = Number(prefill.price) > 0 ? Math.round(prefill.price * 100) / 100 : '';
      d.description = String(prefill.description || '').slice(0, 2000);
      d.image = /^https?:\/\//.test(prefill.image || '') ? prefill.image : '';
      if (/^https?:\/\//.test(prefill.url || '')) links.push({ retailer: window.GR ? GR.retailerFor(prefill.url) : '', url: prefill.url });
    }
    var was = copy ? [copy.fromTags.join(' & '), copy.fromSize, copy.fromColor].filter(Boolean).join(', ') : '';
    var html = '<div class="mb"><h3 id="modalTitle">' + (it ? 'Edit item' : copy ? 'Copy of this item' : 'Add an item') + '</h3><p class="sub">' +
      (it ? 'Changes show up for the family right away.' : copy ? 'Same item, store links and photos. Pick who this one is for, then set the size or color.' :
        prefill ? 'Filled in from the store page. Pick who it\'s for and check the details.' : 'Paste a product link and we\'ll fill in what we can.') + '</p>' +
      (copy && was ? '<div class="note" style="margin-top:-6px">Copying from: <b>' + esc(was) + '</b></div>' : '') +
      '<div class="fetch-box"' + (copy ? ' hidden' : '') + '><label class="fld"><span>Product link</span><input type="url" id="eUrl" placeholder="https://www.rei.com/product/…"></label>' +
      '<div class="btn-row"><button type="button" class="btn btn-deep btn-sm" id="eFetch">Fetch details</button><span class="fetch-msg" id="eMsg"></span></div></div>' +
      '<form id="eForm">' +
      '<label class="fld"><span>Item name</span><input type="text" id="eTitle" required maxlength="200" value="' + esc(d.title) + '"></label>' +
      '<div class="row"><label class="fld"><span>Brand</span><input type="text" id="eBrand" value="' + esc(d.brand) + '"></label>' +
      '<label class="fld"><span>Estimated price</span><input type="number" id="ePrice" step="0.01" min="0" value="' + esc(d.price || '') + '"><small>What givers see. Sale alerts compare against this.</small></label></div>' +
      '<div class="fld' + (copy ? ' copy-focus' : '') + '"><span>For</span><div class="chips-pick" id="eTags">' + L.tags.map(function (t) {
        var on = d.tags.indexOf(t) >= 0; return '<label class="' + (on ? 'on' : '') + '"><input type="checkbox" value="' + t + '"' + (on ? ' checked' : '') + '> ' + t + '</label>';
      }).join('') + '</div></div>' +
      '<div class="row3"><label class="fld"><span>Occasion</span><select id="eOcc">' + L.occasions.map(function (o) { return '<option' + (d.occasion === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>' +
      '<label class="fld"><span>Gear type</span><select id="eCat"><option value="">Choose…</option>' + L.categories.map(function (c) { return '<option' + (d.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>' +
      '<label class="fld"><span>Priority</span><select id="ePri">' + [1, 2, 3].map(function (p) { return '<option value="' + p + '"' + (+d.priority === p ? ' selected' : '') + '>' + L.priorities[p] + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="row' + (copy ? ' copy-focus' : '') + '"><label class="fld"><span>Size</span><input type="text" id="eSize" value="' + esc(d.size) + '" placeholder="e.g. Youth M, 152 cm"></label>' +
      '<label class="fld"><span>Color</span><input type="text" id="eColor" value="' + esc(d.color) + '"></label></div>' +
      '<label class="check' + (d.groupGift ? ' on' : '') + '"><input type="checkbox" id="eGroup"' + (d.groupGift ? ' checked' : '') + '><div><b>Group gift</b><small>Several people can chip in. Leave off for one-giver items.</small></div></label>' +
      '<label class="fld" style="margin-top:12px"><span>Note for the family</span><textarea id="eNotes" maxlength="1000" placeholder="Why it matters, sizing tips, what not to buy…">' + esc(d.notes) + '</textarea></label>' +
      '<p class="section-t">Photos</p><div class="photo-strip" id="ePhotos"></div>' +
      '<div class="btn-row" style="margin:8px 0 4px"><label class="btn btn-ghost btn-sm" style="cursor:pointer">Upload photos<input type="file" id="eFile" accept="image/*" multiple hidden></label>' +
      '<input type="url" id="eImgUrl" placeholder="or paste an image link" style="flex:1;min-width:180px;padding:7px 10px;font-size:13px"></div>' +
      '<small style="color:var(--mute);font-size:11.5px">The first photo is the cover. Click a photo to make it the cover.</small>' +
      '<p class="section-t">Store links</p><div id="eLinks"></div><button type="button" class="btn btn-ghost btn-sm" id="eAddLink">+ Add a store</button>' +
      '<p class="section-t">Sale alerts</p><div class="row"><label class="fld"><span>Alert at this price or lower</span><input type="number" id="eTarget" step="0.01" min="0" value="' + esc(alertVals.target) + '"></label>' +
      '<label class="fld"><span>Or this % off</span><input type="number" id="ePct" step="1" min="1" max="90" value="' + esc(alertVals.pct) + '" placeholder="' + esc(S.admin.settings.DefaultAlertPct || 15) + ' (default)"></label></div>' +
      '<label class="fld"><span>Product details (optional)</span><textarea id="eDesc" maxlength="2000">' + esc(d.description) + '</textarea></label>' +
      '<p class="form-err" id="eErr"></p><div class="btn-row"><button class="btn btn-primary" type="submit" id="eSave">' + (it ? 'Save changes' : 'Add to registry') + '</button>' +
      '<button type="button" class="btn btn-deep" id="eCopy" title="Saves this item, then starts a copy for another person, size or color">' + (it ? 'Save & make a copy' : 'Add & make a copy') + '</button>' +
      '<button type="button" class="btn btn-ghost" id="eCancel">Cancel</button></div></form></div>';
    openModal(html, true);

    var photos = [d.image].concat(d.photos || []).filter(Boolean);
    function drawPhotos() {
      $('ePhotos').innerHTML = photos.length ? photos.map(function (p, i) {
        return '<div class="p' + (i ? '' : ' cover') + '" data-i="' + i + '"><img src="' + esc(p) + '" alt="" referrerpolicy="no-referrer"><button type="button" data-rm="' + i + '" aria-label="Remove">×</button></div>';
      }).join('') : '<span style="font-size:12px;color:var(--mute)">No photos yet.</span>';
      $('ePhotos').querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); photos.splice(+b.dataset.rm, 1); drawPhotos(); }; });
      $('ePhotos').querySelectorAll('.p').forEach(function (p) { p.onclick = function () { var i = +p.dataset.i; photos.unshift(photos.splice(i, 1)[0]); drawPhotos(); }; });
    }
    function drawLinks() {
      $('eLinks').innerHTML = links.map(function (l, i) {
        return '<div class="linkrow"><input type="text" data-k="retailer" data-i="' + i + '" value="' + esc(l.retailer) + '" placeholder="Store"><input type="url" data-k="url" data-i="' + i + '" value="' + esc(l.url) + '" placeholder="https://…">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-rml="' + i + '">Remove</button></div>';
      }).join('') || '<p style="font-size:12px;color:var(--mute);margin-bottom:8px">Add at least one store so we can watch the price.</p>';
      $('eLinks').querySelectorAll('input').forEach(function (inp) {
        inp.oninput = function () {
          links[+inp.dataset.i][inp.dataset.k] = inp.value;
          if (inp.dataset.k === 'url' && !links[+inp.dataset.i].retailer) {
            var r = window.GR ? GR.retailerFor(inp.value) : '';
            if (r) { links[+inp.dataset.i].retailer = r; inp.previousElementSibling.value = r; }
          }
        };
      });
      $('eLinks').querySelectorAll('[data-rml]').forEach(function (b) { b.onclick = function () { links.splice(+b.dataset.rml, 1); drawLinks(); }; });
    }
    drawPhotos(); drawLinks();

    $('eTags').querySelectorAll('input').forEach(function (c) { c.onchange = function () { c.parentNode.classList.toggle('on', c.checked); }; });
    $('eGroup').onchange = function () { this.closest('.check').classList.toggle('on', this.checked); };
    $('eAddLink').onclick = function () { links.push({ retailer: '', url: '' }); drawLinks(); };
    $('eCancel').onclick = closeModal;
    $('eImgUrl').onchange = function () { if (/^https?:\/\//.test(this.value)) { photos.push(this.value.trim()); this.value = ''; drawPhotos(); } };
    $('eFile').onchange = function () {
      var files = Array.prototype.slice.call(this.files); this.value = '';
      files.forEach(function (f) {
        $('eMsg').textContent = 'Uploading ' + f.name + '…';
        resizeImage(f, 1200).then(function (dataUrl) { return api('uploadPhoto', { dataUrl: dataUrl, name: f.name }); })
          .then(function (r) { photos.push(r.url); drawPhotos(); $('eMsg').textContent = 'Photo added.'; })
          .catch(function (e) { $('eMsg').textContent = e.message; $('eMsg').className = 'fetch-msg err'; });
      });
    };
    $('eFetch').onclick = function () {
      var url = $('eUrl').value.trim(), btn = this, msg = $('eMsg');
      if (!url) { msg.textContent = 'Paste a product link first.'; return; }
      busy(btn, true, 'Fetching…'); msg.className = 'fetch-msg'; msg.textContent = 'Asking the store… this can take up to 20 seconds.';
      // Keep the link no matter what the lookup does.
      if (!links.some(function (l) { return l.url === url; })) { links.push({ retailer: window.GR ? GR.retailerFor(url) : '', url: url }); drawLinks(); }
      var store = (window.GR && GR.retailerFor(url)) || 'The store';
      var timeout = new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error(store + ' didn\'t respond. Many stores block automatic lookups. The link is saved below, so fill in the details by hand, or use the "+ Add to registry" bookmark button on the store page (see the bottom of Manage items).'));
        }, 20000);
      });
      Promise.race([api('fetchProduct', { url: url }), timeout]).then(function (p) {
        if (p.title && !$('eTitle').value) $('eTitle').value = p.title;
        if (p.brand && !$('eBrand').value) $('eBrand').value = p.brand;
        if (p.price && !$('ePrice').value) $('ePrice').value = p.price;
        if (p.description && !$('eDesc').value) $('eDesc').value = p.description;
        if (p.image && photos.indexOf(p.image) < 0) { photos.unshift(p.image); drawPhotos(); }
        msg.className = 'fetch-msg' + (p.error ? ' err' : '');
        msg.textContent = p.error || ('Found it' + (p.price ? ' at ' + money(p.price, true) : '') + '. Check the details below.');
        $('eUrl').value = '';
      }).catch(function (e) { msg.className = 'fetch-msg err'; msg.textContent = e.message; })
        .then(function () { busy(btn, false); });
    };
    if (copy) setTimeout(function () { var f = $('eTags'); if (f) f.scrollIntoView({ block: 'center' }); }, 60);
    var saveAndCopy = false;
    $('eCopy').onclick = function () {
      saveAndCopy = true;
      if ($('eForm').requestSubmit) $('eForm').requestSubmit(); else $('eForm').dispatchEvent(new Event('submit', { cancelable: true }));
    };
    $('eForm').onsubmit = function (e) {
      e.preventDefault();
      var wantCopy = saveAndCopy; saveAndCopy = false;
      var btn = wantCopy ? $('eCopy') : $('eSave'); busy(btn, true, 'Saving…'); $('eErr').textContent = '';
      $('eSave').disabled = true; $('eCopy').disabled = true;
      var item = {
        id: it && it.id, title: $('eTitle').value, brand: $('eBrand').value, price: $('ePrice').value,
        tags: Array.prototype.map.call($('eTags').querySelectorAll('input:checked'), function (c) { return c.value; }),
        occasion: $('eOcc').value, category: $('eCat').value, priority: $('ePri').value, size: $('eSize').value, color: $('eColor').value,
        groupGift: $('eGroup').checked, notes: $('eNotes').value, description: $('eDesc').value,
        image: photos[0] || '', photos: photos.slice(1), links: links.filter(function (l) { return l.url; }),
        targetPrice: $('eTarget').value, alertPct: $('ePct').value
      };
      act('saveItem', { item: item }).then(function () {
        closeModal(); rerender();
        if (wantCopy) {
          toast(it ? 'Saved. Now set up the copy.' : 'Added. Now set up the copy.');
          itemEditor(null, null, copyOf(item));
        } else toast(it ? 'Saved.' : 'Added to the registry.');
      }).catch(function (er) {
        $('eErr').textContent = er.message; busy(btn, false); $('eSave').disabled = false; $('eCopy').disabled = false;
      });
    };
  }
  function resizeImage(file, max) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { reject(new Error('Couldn\'t read that image.')); };
      img.src = url;
    });
  }

  /* ---------- purchase */
  function purchaseModal(it) {
    var a = it.admin, best = a.links.slice().filter(function (l) { return l.lastPrice; }).sort(function (x, y) { return x.lastPrice - y.lastPrice; })[0];
    var today = new Date(); var iso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    var pl = a.pledges || [];
    var html = '<div class="mb"><h3 id="modalTitle">Mark as bought</h3><p class="sub">' + esc(it.title) + '</p>' +
      (a.hidden ? '<div class="note">Surprise mode is on, so pledges on this item stay hidden. Givers are still emailed their share.</div>'
        : pl.length ? '<div class="note"><b>' + pl.length + ' pledge' + (pl.length > 1 ? 's' : '') + ':</b> ' + pl.map(function (p) { return esc(p.giver) + ' ' + money(p.amount, true); }).join(', ') + '</div>'
          : '<div class="note warn">No one has pledged this item yet. You can still record the purchase.</div>') +
      '<form id="bForm"><div class="row"><label class="fld"><span>What you paid</span><input type="number" id="bPrice" step="0.01" min="0.01" required value="' + (best ? best.lastPrice : it.price || '') + '"></label>' +
      '<label class="fld"><span>Date</span><input type="date" id="bDate" value="' + iso + '"></label></div>' +
      '<div class="row"><label class="fld"><span>Store</span><select id="bStore">' + a.links.map(function (l, i) { return '<option value="' + i + '"' + (best && l.id === best.id ? ' selected' : '') + '>' + esc(l.retailer) + '</option>'; }).join('') + '<option value="other">Other</option></select></label>' +
      '<label class="fld"><span>Order or receipt #</span><input type="text" id="bRef" maxlength="80"></label></div>' +
      '<label class="fld" id="bOtherWrap" hidden><span>Store name</span><input type="text" id="bOther"></label>' +
      '<label class="check on"><input type="checkbox" id="bNotify" checked><div><b>Email the givers</b><small>Sends each giver the final price and their share' + (it.groupGift ? ' (split in proportion to pledges if it came in under)' : '') + '.</small></div></label>' +
      '<div class="note">We\'ll keep checking this store\'s price for ' + esc(S.admin.settings.WatchDays || 14) + ' days and alert you if it drops, so you can request a price adjustment.</div>' +
      '<p class="form-err" id="bErr"></p><div class="btn-row"><button class="btn btn-deep" id="bSave" type="submit">Mark bought</button><button type="button" class="btn btn-ghost" id="bCancel">Cancel</button></div></form></div>';
    openModal(html);
    if (!a.links.length) { $('bStore').value = 'other'; $('bOtherWrap').hidden = false; }
    $('bStore').onchange = function () { $('bOtherWrap').hidden = this.value !== 'other'; var l = a.links[+this.value]; if (l && l.lastPrice) $('bPrice').value = l.lastPrice; };
    $('bNotify').onchange = function () { this.closest('.check').classList.toggle('on', this.checked); };
    $('bCancel').onclick = closeModal;
    $('bForm').onsubmit = function (e) {
      e.preventDefault();
      var btn = $('bSave'); busy(btn, true, 'Saving…');
      var sel = $('bStore').value, link = sel === 'other' ? null : a.links[+sel];
      act('markPurchased', { id: it.id, price: $('bPrice').value, date: $('bDate').value, retailer: link ? link.retailer : $('bOther').value,
        url: link ? link.url : '', orderRef: $('bRef').value, notify: $('bNotify').checked })
        .then(function (r) { closeModal(); toast('Marked bought.', '', r.notified ? r.notified + ' giver' + (r.notified > 1 ? 's' : '') + ' emailed.' : ''); rerender(); })
        .catch(function (er) { $('bErr').textContent = er.message; busy(btn, false); });
    };
  }

  /* ---------- money */
  function adminMoney(main) {
    var P = S.admin.pledges.filter(function (p) { return p.status === 'active'; });
    var due = function (p) { return p.share || p.amount; };
    var unpaid = P.filter(function (p) { return !p.paid; });
    var unpaidBought = unpaid.filter(function (p) { return p.itemStatus !== 'Active'; });
    var hiddenNote = S.user.surprise ? '<div class="note">Surprise mode is on: pledges on items tagged ' + esc(S.user.name) + ' aren\'t included.</div>' : '';
    var html = '<div class="page-h"><div><h2>Pledges & money</h2><p>Who pledged what, and who has paid.</p></div></div>' + hiddenNote +
      '<div class="stats"><div class="stat hl"><span>Active pledges</span><b>' + P.length + '</b></div>' +
      '<div class="stat"><span>Total pledged</span><b>' + money(P.reduce(function (s, p) { return s + p.amount; }, 0)) + '</b></div>' +
      '<div class="stat"><span>Owed on bought items</span><b>' + money(unpaidBought.reduce(function (s, p) { return s + due(p); }, 0), true) + '</b></div>' +
      '<div class="stat"><span>Paid</span><b>' + P.filter(function (p) { return p.paid; }).length + ' of ' + P.length + '</b></div></div>';
    var byGiver = {};
    P.forEach(function (p) { (byGiver[p.giver] = byGiver[p.giver] || []).push(p); });
    var givers = Object.keys(byGiver).sort();
    if (!givers.length) html += '<div class="panel"><div class="empty"><b>No pledges yet</b>Share the registry links from the People page.</div></div>';
    givers.forEach(function (g) {
      var rows = byGiver[g];
      var owe = rows.filter(function (p) { return !p.paid && p.itemStatus !== 'Active'; }).reduce(function (s, p) { return s + due(p); }, 0);
      html += '<div class="panel"><div class="panel-h"><h3>' + esc(g) + '</h3><p>' + rows.length + ' pledge' + (rows.length > 1 ? 's' : '') + (owe ? ' · <b style="color:var(--alpen)">owes ' + money(owe, true) + '</b>' : '') + '</p></div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th class="num">Pledged</th><th class="num">Share</th><th>Paying</th><th>Status</th><th>Paid</th></tr></thead><tbody>' +
        rows.map(function (p) {
          return '<tr><td data-label="Item">' + esc(p.itemTitle) + (p.note ? '<div style="font-size:11.5px;color:var(--mute)">“' + esc(p.note) + '”</div>' : '') + '</td>' +
            '<td class="num" data-label="Pledged">' + money(p.amount, true) + '</td><td class="num" data-label="Share">' + (p.share ? money(p.share, true) : '<span style="color:var(--mute)">—</span>') + '</td>' +
            '<td data-label="Paying">' + (p.payMethod === 'upfront' ? 'Up front' : 'After purchase') + '</td>' +
            '<td data-label="Status">' + (p.itemStatus === 'Active' ? '<span class="tag occ">Not bought yet</span>' : '<span class="tag ok">' + esc(p.itemStatus === 'Purchased' ? 'Bought' : p.itemStatus) + '</span>') + '</td>' +
            '<td data-label="Paid"><label class="toggle-inline"><input type="checkbox" data-paid="' + p.id + '"' + (p.paid ? ' checked' : '') + '> ' + (p.paid ? 'Paid' : 'No') + '</label></td></tr>';
        }).join('') + '</tbody></table></div></div>';
    });
    main.innerHTML = html;
    main.querySelectorAll('[data-paid]').forEach(function (c) {
      c.onchange = function () {
        act('setPaid', { id: c.dataset.paid, paid: c.checked }).then(function () { toast(c.checked ? 'Marked paid.' : 'Marked unpaid.'); adminMoney(main); }).catch(function (e) { toast(e.message, 'err'); c.checked = !c.checked; });
      };
    });
  }

  /* ---------- alerts */
  function adminAlerts(main) {
    var A = S.admin;
    var links = [];
    A.items.forEach(function (it) { if (it.status === 'Active' || it.status === 'Purchased') it.admin.links.forEach(function (l) { links.push({ it: it, l: l }); }); });
    var stTag = function (s) {
      return s === 'ok' ? '<span class="tag ok">Tracking</span>' : s === 'blocked' ? '<span class="tag warn">Blocked by store</span>' : s === 'no-price' ? '<span class="tag sale">No price found</span>' : '<span class="tag occ">Not checked yet</span>';
    };
    var html = '<div class="page-h"><div><h2>Price alerts</h2><p>Stores that allow it are checked every morning, Google price-drop emails are read every hour, and stores that block checks go on a Monday spot-check email. Alerts go to ' + esc(A.settings.AlertEmails || 'the admins') + '.</p></div>' +
      '<button class="btn btn-primary" id="chkNow">Check prices now</button></div>' + priceRunLine(A.priceRun);
    html += '<div class="panel"><div class="panel-h"><h3>Recent alerts</h3></div>' + (A.alerts.length ? A.alerts.map(function (al) {
      var pct = al.refPrice ? Math.round((1 - al.newPrice / al.refPrice) * 100) : 0;
      var kind = al.type === 'adjust' ? '<span class="tag warn">Price adjustment</span> ' : al.type === 'seen' ? '<span class="tag occ">Price drop seen</span> ' : '<span class="tag sale">On sale</span> ';
      var src = al.source === 'email' ? '<span class="tag group">from price email</span>' : al.source === 'manual' ? '<span class="tag group">entered by hand</span>' : '';
      return '<div class="li"><div class="grow"><div class="t">' + kind + esc(al.itemTitle) + '</div>' +
        '<div class="s"><b style="color:var(--ink)">' + esc(al.retailer) + ' ' + money(al.newPrice, true) + '</b>' + (al.refPrice ? '<span>was ' + money(al.refPrice, true) + (pct > 0 ? ' · ' + pct + '% off' : '') + '</span>' : '') +
        '<span>' + ago(al.createdAt) + '</span>' + src + '</div>' +
        (al.type === 'adjust' ? '<div class="s">You bought this within the last 14 days. Ask the store for a price adjustment.</div>' : '') + '</div>' +
        '<div class="acts">' + (al.url ? '<a class="btn btn-ghost btn-sm" href="' + esc(al.url) + '" target="_blank" rel="noopener noreferrer">View</a>' : '') + '</div></div>';
    }).join('') : '<div class="empty"><b>No alerts yet</b>You\'ll see sales here and in your email.</div>') + '</div>';
    html += '<div class="panel"><div class="panel-h"><h3>Store links being watched</h3><p>For stores that block automatic checks, tap <b>Update</b> to enter today\'s price, or use the <b>+ Add to registry</b> bookmark on the store page.</p></div>' +
      (links.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Store</th><th class="num">Now</th><th class="num">Lowest seen</th><th>Checked</th><th>Status</th><th></th></tr></thead><tbody>' +
        links.map(function (x) {
          return '<tr><td data-label="Item">' + esc(x.it.title) + (x.it.status === 'Purchased' ? ' <span class="tag sale">price watch</span>' : '') + '</td><td data-label="Store"><a href="' + esc(x.l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.l.retailer) + '</a></td>' +
            '<td class="num" data-label="Now">' + (x.l.lastPrice ? money(x.l.lastPrice, true) : '—') + '</td><td class="num" data-label="Lowest">' + (x.l.lowestPrice ? money(x.l.lowestPrice, true) : '—') + '</td>' +
            '<td data-label="Checked">' + ago(x.l.lastChecked) + '</td><td data-label="Status">' + stTag(x.l.checkStatus) + (x.l.checkNote ? '<div style="font-size:11px;color:var(--mute)">' + esc(x.l.checkNote) + '</div>' : '') + '</td>' +
            '<td data-label=""><button type="button" class="btn btn-ghost btn-sm" data-upd="' + esc(x.l.id) + '">Update</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="empty">No store links yet.</div>') + '</div>';
    var log = A.emailLog || [];
    html += '<div class="panel"><div class="panel-h"><h3>Price emails read</h3><p>Google price-drop emails (and anything you label <b>gift-registry-prices</b> in Gmail) are read every hour. Full details: the EmailLog tab in the Sheet.</p></div>' +
      (log.length ? log.map(function (e) {
        var tag = e.result === 'Recorded' ? 'ok' : /Lead/.test(e.result) ? 'sale' : 'occ';
        return '<div class="li"><div class="grow"><div class="t" style="font-size:13px">' + esc(e.subject || '(no subject)') + '</div><div class="s"><span class="tag ' + tag + '">' + esc(e.result) + '</span>' +
          (e.itemTitle ? '<span>' + esc(e.itemTitle) + '</span>' : '') + (e.price ? '<span>' + esc(e.retailer) + ' ' + money(e.price, true) + '</span>' : '') + '<span>' + ago(e.at) + '</span></div></div></div>';
      }).join('') : '<div class="empty"><b>No price emails yet</b>Turn on Google price tracking for an item (see the README), and drops show up here.</div>') + '</div>';
    main.innerHTML = html;
    $('chkNow').onclick = function () { runPriceCheck(this); };
    main.querySelectorAll('[data-upd]').forEach(function (b) {
      b.onclick = function () {
        var x = links.filter(function (y) { return y.l.id === b.dataset.upd; })[0];
        if (!x) return;
        // the same product on several entries (copies for different kids) gets the price on all of them
        var all = storeMatches(x.l.url); updatePriceModal(all.length ? all : [x], 0, null);
      };
    });
  }

  /* ---------- thank-yous */
  function adminThanks(main) {
    var P = S.admin.pledges.filter(function (p) { return p.status === 'active' && (p.itemStatus === 'Given' || p.itemStatus === 'Archived'); });
    var todo = P.filter(function (p) { return !p.thankedAt; }), done = P.filter(function (p) { return p.thankedAt; });
    function row(p) {
      return '<div class="li"><div class="thumb">' + picture({ image: p.itemImage, category: '' }) + '</div><div class="grow"><div class="t">' + esc(p.giver) + '</div>' +
        '<div class="s">' + esc(p.itemTitle) + (p.thankedAt ? '<span class="tag ok">Thanked ' + fmtDate(p.thankedAt) + '</span>' : '') + '</div></div>' +
        '<div class="acts"><button class="btn ' + (p.thankedAt ? 'btn-ghost' : 'btn-primary') + ' btn-sm" data-ty="' + p.id + '" data-v="' + (p.thankedAt ? '0' : '1') + '">' + (p.thankedAt ? 'Undo' : 'Mark thanked') + '</button></div></div>';
    }
    main.innerHTML = '<div class="page-h"><div><h2>Thank-yous</h2><p>Once an item is marked given, each giver shows up here until you mark them thanked. A reminder goes out Monday mornings.</p></div></div>' +
      '<div class="panel"><div class="panel-h"><h3>To send (' + todo.length + ')</h3></div>' + (todo.length ? todo.map(row).join('') : '<div class="empty"><b>All caught up</b></div>') + '</div>' +
      (done.length ? '<div class="panel"><div class="panel-h"><h3>Sent</h3></div>' + done.map(row).join('') + '</div>' : '');
    main.querySelectorAll('[data-ty]').forEach(function (b) {
      b.onclick = function () {
        busy(b, true, 'Saving…');
        act('setThanked', { id: b.dataset.ty, thanked: b.dataset.v === '1' }).then(function () { adminThanks(main); })
          .catch(function (e) { toast(e.message, 'err'); });
      };
    });
  }

  /* ---------- people */
  function personLink(p) {
    var q = apiParam();
    return siteBase() + '?' + (q ? q + '&' : '') + 'k=' + encodeURIComponent(p.linkToken);
  }
  function adminPeople(main) {
    var P = S.admin.people.slice().sort(function (a, b) {
      var o = { admin: 0, giver: 1, kid: 2 }; return (o[a.role] - o[b.role]) || a.name.localeCompare(b.name);
    });
    var roleTag = { admin: '<span class="tag">Admin</span>', giver: '<span class="tag group">Giver</span>', kid: '<span class="tag occ">Kid · no status</span>' };
    main.innerHTML = '<div class="page-h"><div><h2>People</h2><p>Each person signs in with their own PIN. Their personal link skips picking their name.</p></div>' +
      '<button class="btn btn-primary" id="addP">+ Add person</button></div><div class="panel">' + P.map(function (p) {
        return '<div class="li"><span class="av" style="width:40px;height:40px;font-size:13px">' + esc(initials(p.name)) + '</span><div class="grow"><div class="t">' + esc(p.name) + (p.active ? '' : ' <span class="tag occ">Inactive</span>') + '</div>' +
          '<div class="s">' + roleTag[p.role] + (p.email ? '<span>' + esc(p.email) + '</span>' : '<span>No email</span>') + (p.hasPin ? '' : '<span class="tag warn">No PIN yet</span>') + '</div></div>' +
          '<div class="acts"><button class="btn btn-ghost btn-sm" data-copy="' + esc(p.name) + '">Copy link</button><button class="btn btn-ghost btn-sm" data-edit="' + esc(p.name) + '">Edit</button></div></div>';
      }).join('') + '</div><div class="note">Send each person their link and PIN separately (for example, the link by email and the PIN by text). Changing someone\'s name keeps their pledges.</div>';
    $('addP').onclick = function () { personModal(null); };
    main.querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = function () {
        var p = S.admin.people.filter(function (x) { return x.name === b.dataset.copy; })[0];
        var url = personLink(p);
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { toast('Link copied for ' + p.name + '.', '', url); })
          .catch(function () { prompt('Copy this link:', url); });
      };
    });
    main.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { personModal(S.admin.people.filter(function (x) { return x.name === b.dataset.edit; })[0]); }; });
  }
  function personModal(p) {
    var d = p || { name: '', email: '', role: 'giver', active: true };
    openModal('<div class="mb"><h3 id="modalTitle">' + (p ? 'Edit ' + esc(p.name) : 'Add a person') + '</h3><p class="sub">' + (p ? 'Leave PIN blank to keep the current one.' : 'Grandparents, aunts, uncles, anyone who gives gifts.') + '</p>' +
      '<form id="pForm"><label class="fld"><span>Name as it appears</span><input type="text" id="pName" required maxlength="60" value="' + esc(d.name) + '" placeholder="e.g. Grandma & Grandpa B"></label>' +
      '<label class="fld"><span>Email</span><input type="email" id="pEmail" value="' + esc(d.email) + '"><small>For pledge receipts and purchase notices. Optional.</small></label>' +
      '<div class="row"><label class="fld"><span>Role</span><select id="pRole">' + [['giver', 'Giver'], ['admin', 'Organizer (sees everything)'], ['kid', 'Kid (no pledge status)']].map(function (r) { return '<option value="' + r[0] + '"' + (d.role === r[0] ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="fld"><span>' + (p ? 'New PIN' : 'PIN') + '</span><input type="text" id="pPin" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" placeholder="4–6 digits"' + (p ? '' : ' required') + '></label></div>' +
      (p ? '<label class="check' + (d.active ? ' on' : '') + '"><input type="checkbox" id="pActive"' + (d.active ? ' checked' : '') + '><div><b>Active</b><small>Turn off to block sign-in. Their pledges stay.</small></div></label>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="pNewLink" style="margin-bottom:12px">Make a new personal link</button>' : '') +
      '<p class="form-err" id="pErr2"></p><div class="btn-row"><button class="btn btn-primary" type="submit" id="pSave">' + (p ? 'Save' : 'Add person') + '</button><button type="button" class="btn btn-ghost" id="pCancel">Cancel</button></div></form></div>');
    $('pCancel').onclick = closeModal;
    if ($('pActive')) $('pActive').onchange = function () { this.closest('.check').classList.toggle('on', this.checked); };
    if ($('pNewLink')) $('pNewLink').onclick = function () {
      if (!confirm('Make a new link for ' + p.name + '? Their old link will stop pre-filling their name.')) return;
      act('newLink', { name: p.name }).then(function () { toast('New link created.'); closeModal(); adminPeople($('main')); })
        .catch(function (e) { toast(e.message, 'err'); });
    };
    $('pForm').onsubmit = function (e) {
      e.preventDefault();
      var btn = $('pSave'); busy(btn, true, 'Saving…');
      act('savePerson', { originalName: p && p.name, name: $('pName').value, email: $('pEmail').value, role: $('pRole').value, pin: $('pPin').value.trim(), active: $('pActive') ? $('pActive').checked : true })
        .then(function () { closeModal(); toast('Saved.'); rerender(); })
        .catch(function (er) { $('pErr2').textContent = er.message; busy(btn, false); });
    };
  }

  /* ---------- settings */
  function adminSettings(main) {
    var s = S.admin.settings;
    var F = [['FamilyName', 'Family name', 'Shown at the top of the site and in emails.'],
      ['AlertEmails', 'Price alert emails', 'Comma-separated. Leave blank to use admin emails.'],
      ['DefaultAlertPct', 'Default sale alert (% off)', 'Used when an item has no target price or % of its own.'],
      ['Stores', 'Stores you buy through', 'Shown to givers, e.g. "REI and Scheels". Leave blank to leave it out.'],
      ['Recipients', 'Who gifts can be for', 'Comma-separated. Leave blank to use the kids and organizers on the People page.'],
      ['WatchDays', 'Price watch after purchase (days)', 'Many stores (REI, for one) adjust prices within 14 days of purchase.'],
      ['SiteURL', 'Site address', 'Used for personal links and the button in emails. Filled in for you by Gift Registry → Show our registry links.'],
      ['PaymentNote', 'How to pay', 'Shown to givers who choose to pay, and in purchase emails.'],
      ['ContactNote', 'Questions note', 'Shown at the bottom of each item.'],
      ['PriceEmailQuery', 'Price emails to read (Gmail search)', 'Which emails the hourly reader looks at. Leave as is unless price emails are being missed.']];
    main.innerHTML = '<div class="page-h"><div><h2>Settings</h2></div></div><div class="panel"><form class="mb" id="sForm">' + F.map(function (f) {
      var long = f[0] === 'PaymentNote' || f[0] === 'ContactNote' || f[0] === 'PriceEmailQuery';
      return '<label class="fld"><span>' + f[1] + '</span>' + (long ? '<textarea data-k="' + f[0] + '">' + esc(s[f[0]]) + '</textarea>' : '<input type="text" data-k="' + f[0] + '" value="' + esc(s[f[0]]) + '">') + '<small>' + f[2] + '</small></label>';
    }).join('') + '<button class="btn btn-primary" type="submit" id="sSave">Save settings</button></form></div>';
    $('sForm').onsubmit = function (e) {
      e.preventDefault();
      var out = {}; $('sForm').querySelectorAll('[data-k]').forEach(function (i) { out[i.dataset.k] = i.value; });
      var btn = $('sSave'); busy(btn, true, 'Saving…');
      act('saveSettings', { settings: out }).then(function () { toast('Settings saved.'); rerender(); })
        .catch(function (er) { toast(er.message, 'err'); busy(btn, false); });
    };
  }

  /* ============================================================ change PIN */
  function changePinModal() {
    openModal('<div class="mb"><h3 id="modalTitle">Change my PIN</h3><p class="sub">4 to 6 digits.</p><form id="cpForm">' +
      '<label class="fld"><span>Current PIN</span><input type="password" id="cpOld" inputmode="numeric" maxlength="6" required></label>' +
      '<label class="fld"><span>New PIN</span><input type="password" id="cpNew" inputmode="numeric" maxlength="6" required></label>' +
      '<p class="form-err" id="cpErr"></p><button class="btn btn-primary" type="submit" id="cpBtn">Change PIN</button></form></div>');
    $('cpForm').onsubmit = function (e) {
      e.preventDefault();
      var btn = $('cpBtn'); busy(btn, true, 'Saving…');
      api('changePin', { oldPin: $('cpOld').value, newPin: $('cpNew').value }).then(function () { closeModal(); toast('PIN changed.'); })
        .catch(function (er) { $('cpErr').textContent = er.message; busy(btn, false); });
    };
  }

  /* ======================================================= home-screen app */
  var installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; if (route().page === 'registry' && S.user) softRender(); });
  window.addEventListener('appinstalled', function () { installEvt = null; lsSet(NS + 'gr_tip_off', '1'); });
  function isStandalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function isPhoneSize() { return window.matchMedia && matchMedia('(max-width: 700px)').matches; }
  function canOfferInstall() { return !isStandalone() && (!!installEvt || isIOS()); }
  function installTip() {
    if (isStandalone() || lsGet(NS + 'gr_tip_off') || !(installEvt || (isIOS() && isPhoneSize()))) return '';
    var how = installEvt ? 'Opens like an app, full screen, from an icon on your phone.'
      : 'In Safari, tap ' + icon('share', 'share') + ' <b style="display:inline">Share</b>, then <b style="display:inline">Add to Home Screen</b>.';
    return '<div class="install-tip" id="installTip"><span class="ic" aria-hidden="true"></span><div class="grow"><b>Put the registry on your home screen</b>' + how +
      (installEvt ? '<div style="margin-top:8px"><button type="button" class="btn btn-primary btn-sm" id="tipInstall">Add it</button></div>' : '') +
      '</div><button type="button" class="x" id="tipClose" aria-label="Dismiss">×</button></div>';
  }
  function wireInstallTip() {
    if ($('tipClose')) $('tipClose').onclick = function () { lsSet(NS + 'gr_tip_off', '1'); $('installTip').remove(); };
    if ($('tipInstall')) $('tipInstall').onclick = doInstall;
  }
  function doInstall() {
    if (installEvt) {
      var e = installEvt; installEvt = null;
      e.prompt();
      (e.userChoice || Promise.resolve({})).then(function (c) { if (c.outcome === 'accepted') lsSet(NS + 'gr_tip_off', '1'); if ($('installTip')) $('installTip').remove(); });
      return;
    }
    openModal('<div class="mb"><h3 id="modalTitle">Add to your Home Screen</h3><p class="sub">The registry then opens like an app, from an icon.</p>' +
      '<ol style="padding-left:20px;line-height:2;font-size:15px"><li>Open this page in <b>Safari</b>.</li>' +
      '<li>Tap the <b>Share</b> button ' + icon('share').replace('<svg', '<svg width="18" height="18" style="vertical-align:-3px"') + ' at the bottom of the screen.</li>' +
      '<li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>' +
      '<p style="font-size:12.5px;color:var(--mute)">The first time you open it from the icon, pick your name and enter your PIN again.</p></div>');
  }

  /* ================================================================== boot */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ }); });
  }
  /* Shared site with no registry chosen yet: paste a family link, or look around the demo. */
  function showConnect(msg) {
    $('signin').hidden = true; $('app').hidden = true; $('connect').hidden = false;
    $('connectErr').textContent = msg || '';
    $('connectForm').onsubmit = function (e) {
      e.preventDefault();
      var v = $('connectLink').value.trim(), m = v.match(/[?&]api=([^&#\s]+)/), api = apiFromParam(m ? decodeURIComponent(m[1]) : v);
      if (!api) { $('connectErr').textContent = 'That doesn\'t look like a registry link. Copy the whole link from the email your family sent.'; return; }
      var k = (v.match(/[?&]k=([A-Za-z0-9]+)/) || [])[1];
      location.href = location.pathname + '?api=' + encodeURIComponent(m ? decodeURIComponent(m[1]) : v) + (k ? '&k=' + k : '');
    };
    $('connectDemo').onclick = function () { lsSet(LS_DEMO, '1'); location.reload(); };
  }

  (function boot() {
    var m = location.search.match(/[?&]k=([A-Za-z0-9]+)/);
    if (m) lsSet(LS_LINK, m[1]);
    if (m || /[?&](api|demo)=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
    if (NEED_CONNECT) { showConnect(); return; }
    if (DEMO) {
      $('demoBar').hidden = false;
      $('demoReset').onclick = function () { window.GRMockApi.reset(); lsSet(LS_TOKEN, null); lsSet(LS_LINK, null); location.reload(); };
      if (CFG.KIT) {
        $('demoReset').insertAdjacentHTML('afterend', ' <button type="button" id="demoExit">Leave demo</button>');
        $('demoExit').onclick = function () { lsSet(LS_DEMO, null); lsSet(LS_TOKEN, null); lsSet(LS_SNAP, null); location.reload(); };
      }
      window.addEventListener('gr-demo-mail', function (e) { toast('Email sent (demo): ' + e.detail.subject, 'mail', 'To ' + e.detail.to); });
    }
    if (S.token) start().catch(function () { if (!S.user) showSignIn(); });
    else showSignIn();
    setInterval(function () {
      if (!S.user || !$('modal').hidden || document.hidden) return;
      var r = route();
      if (r.page === 'registry' || r.page === 'mine') refresh(true);
    }, (CFG.REFRESH_SECONDS || 120) * 1000);
  })();
})();
