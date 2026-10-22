/**
 * Family Gift Registry — core logic.
 *
 * This one file runs in two places:
 *   1. Google Apps Script (paste it into a script file named "Core"), where
 *      Code.gs supplies a Google Sheet database, Gmail and UrlFetch.
 *   2. The browser demo (mock-api.js), which supplies a localStorage database.
 *
 * Privacy rule enforced here: giver names and amounts are only ever returned
 * to admins, and never to an admin for items tagged with their own name while
 * their surprise mode is on.
 */
var GR = (function () {
  'use strict';

  var TABLES = {
    Items: ['ID', 'Title', 'Brand', 'Description', 'Tags', 'Occasion', 'Category', 'Size', 'Color', 'Notes',
      'Priority', 'GroupGift', 'Price', 'TargetPrice', 'AlertPct', 'Status', 'ImageURL', 'Photos',
      'PurchasePrice', 'PurchaseRetailer', 'PurchaseURL', 'PurchasedAt', 'OrderRef', 'WatchUntil',
      'GivenAt', 'CreatedAt', 'UpdatedAt'],
    Links: ['ID', 'ItemID', 'Retailer', 'URL', 'LastPrice', 'LowestPrice', 'LastChecked', 'CheckStatus', 'CheckNote'],
    Pledges: ['ID', 'ItemID', 'Giver', 'Amount', 'Share', 'PayMethod', 'Paid', 'Status', 'Note',
      'CreatedAt', 'CancelledAt', 'NotifiedAt', 'ThankedAt'],
    People: ['Name', 'Email', 'Role', 'PinHash', 'LinkToken', 'SurpriseMode', 'Active'],
    PriceHistory: ['ItemID', 'LinkID', 'Retailer', 'Price', 'CheckedAt'],
    Alerts: ['ID', 'ItemID', 'LinkID', 'Type', 'Retailer', 'RefPrice', 'NewPrice', 'URL', 'CreatedAt', 'Emailed', 'Source'],
    EmailLog: ['MessageID', 'ReceivedAt', 'From', 'Subject', 'Result', 'ItemID', 'Retailer', 'Price', 'Detail', 'LoggedAt'],
    Settings: ['Key', 'Value']
  };

  var DEFAULT_SETTINGS = {
    FamilyName: 'Our Family',
    AlertEmails: '',
    DefaultAlertPct: '15',
    WatchDays: '14',
    SiteURL: '',
    PaymentNote: 'Venmo, Zelle or a check all work. Whatever is easiest for you.',
    ContactNote: 'Questions about sizes or colors? Call or text us anytime.',
    Stores: '',
    Recipients: '',
    PriceEmailQuery: 'newer_than:30d ((from:google.com ("price drop" OR "price dropped" OR "lower price" OR "price alert" OR "tracked")) OR label:gift-registry-prices)'
  };

  var OCCASIONS = ['Christmas', 'Birthday', 'Anytime'];
  var CATEGORIES = ['Ski & Snow', 'Climbing', 'Camping', 'Hiking', 'Bike', 'Water', 'Fishing', 'Clothing', 'Other'];
  var PRIORITIES = { 1: 'Most wanted', 2: 'Would love', 3: 'Nice to have' };
  var ROLES = ['admin', 'giver', 'kid'];
  var SESSION_DAYS = 30;
  var MAX_PIN_FAILS = 5;
  var LOCKOUT_MIN = 15;

  var RETAILERS = [
    [/(^|\.)rei\.com$/, 'REI'], [/(^|\.)scheels\.com$/, 'Scheels'], [/(^|\.)backcountry\.com$/, 'Backcountry'],
    [/(^|\.)evo\.com$/, 'evo'], [/(^|\.)christysports\.com$/, 'Christy Sports'],
    [/(^|\.)nemoequipment\.com$/, 'NEMO'], [/(^|\.)patagonia\.com$/, 'Patagonia'],
    [/(^|\.)blackdiamondequipment\.com$/, 'Black Diamond'], [/(^|\.)osprey\.com$/, 'Osprey'],
    [/(^|\.)moosejaw\.com$/, 'Moosejaw'], [/(^|\.)steepandcheap\.com$/, 'Steep & Cheap'],
    [/(^|\.)amazon\.com$/, 'Amazon'], [/(^|\.)dickssportinggoods\.com$/, "Dick's"]
  ];

  /* --------------------------------------------------------------- helpers */
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }
  function bool(v) { return v === true || /^(true|yes|1)$/i.test(String(v || '').trim()); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function money(n) { return '$' + num(n).toFixed(2).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function round2(n) { return Math.round(num(n) * 100) / 100; }
  function tagsOf(item) { return str(item.Tags).split(/\s*,\s*/).filter(Boolean); }
  function esc(s) { return str(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clip(s, n) { s = str(s); return s.length > n ? s.slice(0, n) : s; }
  function fail(msg) { throw new Error(msg); }
  function authFail(msg) { throw new Error('AUTH:' + msg); }

  function hostOf(url) {
    var m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
  }

  /** Two store links point at the same product (ignores tracking codes, colors in the query string, www, trailing slashes). */
  function productKey(url) {
    var m = String(url || '').trim().match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
    if (!m) return '';
    var host = m[1].toLowerCase().replace(/^www\./, ''), path = decodeURIComponent(m[2]).toLowerCase().replace(/\/+$/, '');
    var id = (path.match(/\/product\/(\d{4,})/) || path.match(/(\d{5,})(?:\.html?)?$/) || [])[1];
    return host + '|' + (id || path);
  }
  function sameProduct(a, b) { var ka = productKey(a); return !!ka && ka === productKey(b); }

  function retailerFor(url) {
    var host = '';
    try { host = String(url).match(/^https?:\/\/([^\/?#]+)/i)[1].toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
    for (var i = 0; i < RETAILERS.length; i++) if (RETAILERS[i][0].test(host)) return RETAILERS[i][1];
    var base = host.split('.').slice(-2, -1)[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  /* ------------------------------------------------------- product parsing */
  function decodeEntities(s) {
    return str(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); });
  }
  function metaContent(html, key) {
    var re1 = new RegExp('<meta[^>]+(?:property|name|itemprop)=["\']' + key + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
    var re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name|itemprop)=["\']' + key + '["\']', 'i');
    var m = html.match(re1) || html.match(re2);
    return m ? decodeEntities(m[1]) : '';
  }
  function findProducts(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(function (n) { findProducts(n, out); }); return; }
    var t = node['@type'];
    var types = Array.isArray(t) ? t : [t];
    if (types.indexOf('Product') >= 0 || types.indexOf('ProductGroup') >= 0) out.push(node);
    if (node['@graph']) findProducts(node['@graph'], out);
    if (node.hasVariant) findProducts(node.hasVariant, out);
  }
  function offerPrices(offers) {
    var out = [];
    (Array.isArray(offers) ? offers : [offers]).forEach(function (o) {
      if (!o) return;
      if (o.lowPrice != null) out.push(num(o.lowPrice));
      if (o.price != null) out.push(num(o.price));
      if (o.priceSpecification && o.priceSpecification.price != null) out.push(num(o.priceSpecification.price));
      if (o.offers) out = out.concat(offerPrices(o.offers));
    });
    return out.filter(function (p) { return p > 0; });
  }
  function firstImage(img) {
    if (!img) return '';
    if (Array.isArray(img)) return firstImage(img[0]);
    if (typeof img === 'object') return str(img.url || img.contentUrl);
    return str(img);
  }

  /** Reads name, brand, image, description and price from a product page. */
  function parseProduct(html, url) {
    html = String(html || '');
    var products = [];
    var re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, m;
    while ((m = re.exec(html))) {
      try { findProducts(JSON.parse(m[1].trim()), products); } catch (e) { /* skip bad block */ }
    }
    var r = { title: '', brand: '', image: '', description: '', price: 0, retailer: retailerFor(url), found: false, source: '' };
    var prices = [];
    products.forEach(function (p) {
      if (!r.title && p.name) r.title = decodeEntities(p.name);
      if (!r.brand && p.brand) r.brand = decodeEntities(typeof p.brand === 'object' ? p.brand.name : p.brand);
      if (!r.image) r.image = firstImage(p.image);
      if (!r.description && p.description) r.description = clip(decodeEntities(p.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 600);
      prices = prices.concat(offerPrices(p.offers));
    });
    if (prices.length) { r.price = Math.min.apply(null, prices); r.source = 'structured data'; }
    if (!r.title) r.title = metaContent(html, 'og:title') || decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]);
    if (!r.image) r.image = metaContent(html, 'og:image');
    if (!r.description) r.description = clip(metaContent(html, 'og:description') || metaContent(html, 'description'), 600);
    if (!r.price) {
      var mp = metaContent(html, 'product:price:amount') || metaContent(html, 'og:price:amount') || metaContent(html, 'price');
      if (num(mp) > 0) { r.price = num(mp); r.source = 'page tags'; }
    }
    r.title = str(r.title).replace(/\s*\|\s*[^|]*$/, '').trim();
    r.price = round2(r.price);
    r.found = !!(r.title && r.price);
    return r;
  }

  /* ===================================================================== */
  /** Builds an API bound to an environment (database, mail, fetch...). */
  function create(env) {
    var db = env.db;

    function now() { return env.now(); }
    function nowIso() { return now().toISOString(); }
    function newId(prefix) { return prefix + env.uuid().replace(/-/g, '').slice(0, 10); }
    function settings() {
      var s = {}; Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
      db.all('Settings').forEach(function (r) { if (r.Key) s[r.Key] = str(r.Value); });
      return s;
    }
    function people() { return db.all('People'); }
    function activePeople() { return people().filter(function (p) { return bool(p.Active) && p.Name; }); }
    function findPerson(name) {
      var n = str(name).toLowerCase();
      return activePeople().filter(function (p) { return str(p.Name).toLowerCase() === n; })[0] || null;
    }
    function hashPin(pin) {
      var salt = env.props.get('PIN_SALT');
      if (!salt) { salt = env.uuid(); env.props.set('PIN_SALT', salt); }
      return env.hash(salt + ':' + str(pin));
    }
    function validatePin(pin) { if (!/^\d{4,6}$/.test(str(pin))) fail('PIN must be 4 to 6 digits.'); }
    function userOut(p) {
      return { name: p.Name, role: str(p.Role || 'giver').toLowerCase(), email: str(p.Email), surprise: bool(p.SurpriseMode) };
    }
    function isAdmin(u) { return u && u.role === 'admin'; }
    function requireAdmin(u) { if (!isAdmin(u)) fail('Only ' + hosts(' or ') + ' can do that.'); }
    /** The organizers' names ("Alex and Jordan"), used wherever the site or emails speak for the family. */
    function hosts(joiner) {
      var names = activePeople().filter(function (p) { return str(p.Role).toLowerCase() === 'admin'; }).map(function (p) { return p.Name; });
      if (!names.length) return 'the organizers';
      return names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + (joiner || ' and ') + names[names.length - 1];
    }
    /** Who gifts can be for: the Recipients setting if filled in, otherwise the kids then the parents on the People tab. */
    function recipients() {
      var list = str(settings().Recipients);
      if (list) return list.split(/\s*,\s*/).filter(Boolean);
      var ppl = activePeople(), role = function (p) { return str(p.Role).toLowerCase(); };
      return ppl.filter(function (p) { return role(p) === 'kid'; }).map(function (p) { return p.Name; })
        .concat(ppl.filter(function (p) { return role(p) === 'admin'; }).map(function (p) { return p.Name; }));
    }

    /* ------------------------------------------------------------ auth */
    function login(name, pin) {
      var key = 'fail_' + str(name).toLowerCase();
      var rec = JSON.parse(env.props.get(key) || '{"n":0,"t":0}');
      if (rec.n >= MAX_PIN_FAILS && now().getTime() - rec.t < LOCKOUT_MIN * 60000) {
        authFail('Too many wrong PINs. Try again in 15 minutes.');
      }
      var p = findPerson(name);
      if (!p || !p.PinHash || p.PinHash !== hashPin(pin)) {
        env.props.set(key, JSON.stringify({ n: rec.n + 1, t: now().getTime() }));
        authFail('Name or PIN not recognized.');
      }
      env.props.del(key);
      var token = env.uuid();
      env.props.set('sess_' + token, JSON.stringify({ name: p.Name, exp: now().getTime() + SESSION_DAYS * 864e5 }));
      return { token: token, user: userOut(p) };
    }
    function userFromToken(token) {
      if (!token) authFail('Please sign in.');
      var raw = env.props.get('sess_' + token);
      if (!raw) authFail('Your session ended. Please sign in again.');
      var s = JSON.parse(raw);
      if (s.exp < now().getTime()) { env.props.del('sess_' + token); authFail('Your session ended. Please sign in again.'); }
      var p = findPerson(s.name);
      if (!p) authFail('This name is no longer active.');
      return userOut(p);
    }
    function signOutAll() { env.props.keys().forEach(function (k) { if (k.indexOf('sess_') === 0) env.props.del(k); }); }

    /* ------------------------------------------------------- visibility */
    function canSeeStatus(u, item) {
      if (!u || u.role === 'kid') return false;
      if (u.role === 'admin' && u.surprise && tagsOf(item).indexOf(u.name) >= 0) return false;
      return true;
    }
    function itemPledges(itemId, all) {
      return (all || db.all('Pledges')).filter(function (p) { return p.ItemID === itemId && p.Status === 'active'; });
    }
    function totals(item, allPledges) {
      var act = itemPledges(item.ID, allPledges);
      var total = round2(act.reduce(function (s, p) { return s + num(p.Amount); }, 0));
      var goal = num(item.PurchasePrice) || num(item.Price);
      var state = 'available';
      if (item.Status !== 'Active') state = 'full';
      else if (act.length) state = !bool(item.GroupGift) || (goal > 0 && total >= goal - 0.01) ? 'full' : 'partial';
      return { state: state, total: total, goal: goal, count: act.length, pledges: act };
    }
    function linksFor(itemId, allLinks) {
      return (allLinks || db.all('Links')).filter(function (l) { return l.ItemID === itemId; });
    }
    function bestPrice(links) {
      var ps = links.map(function (l) { return num(l.LastPrice); }).filter(function (p) { return p > 0; });
      return ps.length ? Math.min.apply(null, ps) : 0;
    }
    function itemOut(item, u, ctx) {
      var links = linksFor(item.ID, ctx.links);
      var o = {
        id: item.ID, title: item.Title, brand: item.Brand, description: item.Description,
        tags: tagsOf(item), occasion: item.Occasion, category: item.Category, size: item.Size, color: item.Color,
        notes: item.Notes, priority: num(item.Priority) || 2, groupGift: bool(item.GroupGift),
        price: num(item.Price), image: item.ImageURL,
        photos: str(item.Photos).split(/\s*\n\s*|\s*,\s*(?=https?:)/).filter(Boolean),
        status: item.Status, links: links.map(function (l) { return { retailer: l.Retailer, url: l.URL }; })
      };
      if (canSeeStatus(u, item)) o.pledgeState = totals(item, ctx.pledges).state;
      if (isAdmin(u)) {
        var t = totals(item, ctx.pledges), visible = canSeeStatus(u, item);
        o.admin = {
          targetPrice: num(item.TargetPrice), alertPct: num(item.AlertPct), bestPrice: bestPrice(links),
          purchasePrice: num(item.PurchasePrice), purchaseRetailer: item.PurchaseRetailer, purchaseURL: item.PurchaseURL,
          purchasedAt: item.PurchasedAt, orderRef: item.OrderRef, watchUntil: item.WatchUntil, givenAt: item.GivenAt,
          createdAt: item.CreatedAt, hidden: !visible,
          links: links.map(function (l) {
            return { id: l.ID, retailer: l.Retailer, url: l.URL, lastPrice: num(l.LastPrice), lowestPrice: num(l.LowestPrice),
              lastChecked: l.LastChecked, checkStatus: l.CheckStatus, checkNote: l.CheckNote };
          })
        };
        if (visible) {
          o.admin.pledgeTotal = t.total; o.admin.pledgeGoal = t.goal;
          o.admin.pledges = t.pledges.map(function (p) { return pledgeOut(p); });
        }
      }
      return o;
    }
    function pledgeOut(p, item) {
      var o = { id: p.ID, itemId: p.ItemID, giver: p.Giver, amount: num(p.Amount), share: num(p.Share),
        payMethod: p.PayMethod, paid: bool(p.Paid), status: p.Status, note: p.Note, createdAt: p.CreatedAt,
        notifiedAt: p.NotifiedAt, thankedAt: p.ThankedAt };
      if (item) { o.itemTitle = item.Title; o.itemStatus = item.Status; o.itemImage = item.ImageURL; o.groupGift = bool(item.GroupGift); }
      return o;
    }
    function ctx() { return { links: db.all('Links'), pledges: db.all('Pledges') }; }

    /* ---------------------------------------------------------- reads */
    function bootstrap(u) {
      var c = ctx(), s = settings();
      var visibleStatuses = u.role === 'admin' ? ['Active', 'Purchased', 'Given'] : ['Active', 'Purchased'];
      var items = db.all('Items').filter(function (i) { return visibleStatuses.indexOf(i.Status) >= 0; })
        .map(function (i) { return itemOut(i, u, c); });
      return {
        user: u, items: items,
        settings: { familyName: s.FamilyName, paymentNote: s.PaymentNote, contactNote: s.ContactNote, hosts: hosts(), stores: str(s.Stores) },
        lists: { tags: recipients(), occasions: OCCASIONS, categories: CATEGORIES, priorities: PRIORITIES },
        myPledges: u.role === 'kid' ? [] : myPledges(u)
      };
    }
    function myPledges(u) {
      var items = {}; db.all('Items').forEach(function (i) { items[i.ID] = i; });
      return db.all('Pledges').filter(function (p) { return p.Giver === u.name && items[p.ItemID]; })
        .map(function (p) { return pledgeOut(p, items[p.ItemID]); })
        .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    }
    function getItem(id) { var it = db.find('Items', 'ID', id); if (!it) fail('That item no longer exists.'); return it; }

    /* -------------------------------------------------------- pledges */
    function pledge(u, req) {
      if (u.role === 'kid') fail('Kids can browse but not pledge.');
      var item = getItem(req.itemId);
      if (item.Status !== 'Active') fail('This item has already been taken care of.');
      if (tagsOf(item).indexOf(u.name) >= 0 && tagsOf(item).length === 1) fail("This one is on your own list.");
      var t = totals(item, db.all('Pledges'));
      var mine = t.pledges.filter(function (p) { return p.Giver === u.name; });
      var group = bool(item.GroupGift);
      var amount, capped = false;
      if (!group) {
        if (mine.length) fail('You already pledged this item. See My pledges.');
        if (t.count) fail('Someone already pledged this item. Please pick another.');
        amount = num(item.Price);
      } else {
        if (t.state === 'full') fail('This group gift is already fully pledged. Thank you!');
        amount = round2(req.amount);
        if (amount < 5) fail('Please pledge at least $5.');
        if (t.goal > 0 && amount > t.goal - t.total) { amount = round2(t.goal - t.total); capped = true; }
      }
      var payMethod = req.payMethod === 'upfront' ? 'upfront' : 'reimburse';
      var row = { ID: newId('P'), ItemID: item.ID, Giver: u.name, Amount: amount, Share: '', PayMethod: payMethod,
        Paid: 'FALSE', Status: 'active', Note: clip(req.note, 500), CreatedAt: nowIso(), CancelledAt: '', NotifiedAt: '', ThankedAt: '' };
      db.insert('Pledges', row);
      var after = totals(item, db.all('Pledges'));
      mailPledgeToAdmins(item, row, 'new', after);
      mailGiverConfirmation(u, item, row, capped);
      return { pledge: pledgeOut(row, item), capped: capped, state: after.state };
    }
    function cancelPledge(u, id) {
      var p = db.find('Pledges', 'ID', id);
      if (!p || p.Status !== 'active') fail('That pledge is not active.');
      if (p.Giver !== u.name && !isAdmin(u)) fail('You can only cancel your own pledges.');
      var item = getItem(p.ItemID);
      if (item.Status !== 'Active' && !isAdmin(u)) fail('We already bought this one, so it can\'t be cancelled here. Please contact ' + hosts(' or ') + '.');
      db.update('Pledges', 'ID', id, { Status: 'cancelled', CancelledAt: nowIso() });
      mailPledgeToAdmins(item, p, 'cancel', totals(item, db.all('Pledges')));
      return { ok: true };
    }

    /* ---------------------------------------------------------- admin */
    function adminData(u) {
      requireAdmin(u);
      var c = ctx(), items = {};
      var all = db.all('Items');
      all.forEach(function (i) { items[i.ID] = i; });
      var pledges = c.pledges.filter(function (p) { return items[p.ItemID] && canSeeStatus(u, items[p.ItemID]); })
        .map(function (p) { return pledgeOut(p, items[p.ItemID]); });
      return {
        items: all.map(function (i) { return itemOut(i, u, c); }),
        pledges: pledges,
        people: people().map(function (p) {
          return { name: p.Name, email: p.Email, role: str(p.Role || 'giver').toLowerCase(), active: bool(p.Active),
            hasPin: !!p.PinHash, linkToken: p.LinkToken, surprise: bool(p.SurpriseMode) };
        }),
        alerts: db.all('Alerts').slice(-60).reverse().map(function (a) {
          var it = items[a.ItemID] || {};
          return { id: a.ID, itemId: a.ItemID, itemTitle: it.Title || '(removed)', type: a.Type, retailer: a.Retailer,
            refPrice: num(a.RefPrice), newPrice: num(a.NewPrice), url: a.URL, createdAt: a.CreatedAt, source: a.Source || 'check' };
        }),
        settings: settings(),
        priceRun: priceRun(),
        emailLog: db.all('EmailLog').slice(-15).reverse().map(function (r) {
          return { at: r.LoggedAt, subject: r.Subject, result: r.Result, itemTitle: (db.find('Items', 'ID', r.ItemID) || {}).Title || '', retailer: r.Retailer, price: num(r.Price) };
        })
      };
    }
    function saveItem(u, input) {
      requireAdmin(u);
      input = input || {};
      var title = clip(input.title, 200);
      if (!title) fail('Give the item a name.');
      var allowed = recipients();
      var tags = (input.tags || []).filter(function (t) { return allowed.indexOf(t) >= 0; });
      if (!tags.length) fail('Pick who the item is for.');
      var fields = {
        Title: title, Brand: clip(input.brand, 100), Description: clip(input.description, 2000),
        Tags: tags.join(', '), Occasion: OCCASIONS.indexOf(input.occasion) >= 0 ? input.occasion : 'Anytime',
        Category: clip(input.category, 40), Size: clip(input.size, 60), Color: clip(input.color, 60), Notes: clip(input.notes, 1000),
        Priority: [1, 2, 3].indexOf(+input.priority) >= 0 ? +input.priority : 2, GroupGift: input.groupGift ? 'TRUE' : 'FALSE',
        Price: round2(input.price) || '', TargetPrice: round2(input.targetPrice) || '', AlertPct: num(input.alertPct) || '',
        ImageURL: clip(input.image, 1000), Photos: (input.photos || []).join('\n'), UpdatedAt: nowIso()
      };
      var id = input.id;
      if (id) { getItem(id); db.update('Items', 'ID', id, fields); }
      else {
        id = newId('I');
        fields.ID = id; fields.Status = 'Active'; fields.CreatedAt = nowIso();
        db.insert('Items', fields);
      }
      // Links: replace the set, keeping price data for URLs that stay.
      var existing = linksFor(id);
      var keep = {};
      (input.links || []).forEach(function (l) {
        var url = str(l.url);
        if (!/^https?:\/\//i.test(url)) return;
        var match = existing.filter(function (e) { return e.URL === url; })[0];
        if (match) { keep[match.ID] = true; db.update('Links', 'ID', match.ID, { Retailer: clip(l.retailer, 40) || retailerFor(url) }); }
        else db.insert('Links', { ID: newId('L'), ItemID: id, Retailer: clip(l.retailer, 40) || retailerFor(url), URL: url,
          LastPrice: l.price ? round2(l.price) : '', LowestPrice: l.price ? round2(l.price) : '', LastChecked: l.price ? nowIso() : '',
          CheckStatus: l.price ? 'ok' : '', CheckNote: '' });
      });
      existing.forEach(function (e) { if (!keep[e.ID]) db.remove('Links', 'ID', e.ID); });
      return itemOut(getItem(id), u, ctx());
    }
    function deleteItem(u, id) {
      requireAdmin(u);
      if (itemPledges(id).length) fail('This item has active pledges. Mark it given or cancel the pledges first.');
      linksFor(id).forEach(function (l) { db.remove('Links', 'ID', l.ID); });
      db.remove('Items', 'ID', id);
      return { ok: true };
    }
    function setStatus(u, id, status) {
      requireAdmin(u);
      if (['Active', 'Given', 'Archived'].indexOf(status) < 0) fail('Unknown status.');
      var item = getItem(id), ch = { Status: status, UpdatedAt: nowIso() };
      if (status === 'Given') ch.GivenAt = nowIso();
      if (status === 'Active') { ch.PurchasePrice = ''; ch.PurchaseRetailer = ''; ch.PurchaseURL = ''; ch.PurchasedAt = ''; ch.WatchUntil = ''; ch.OrderRef = ''; ch.GivenAt = ''; }
      db.update('Items', 'ID', item.ID, ch);
      return itemOut(getItem(id), u, ctx());
    }
    function markPurchased(u, req) {
      requireAdmin(u);
      var item = getItem(req.id);
      var price = round2(req.price);
      if (price <= 0) fail('Enter what you paid.');
      var when = str(req.date) ? new Date(str(req.date) + 'T12:00:00') : now();
      if (isNaN(when.getTime())) when = now();
      var watchDays = num(settings().WatchDays) || 14;
      var watch = new Date(when.getTime() + watchDays * 864e5);
      db.update('Items', 'ID', item.ID, {
        Status: 'Purchased', PurchasePrice: price, PurchaseRetailer: clip(req.retailer, 40), PurchaseURL: clip(req.url, 1000),
        PurchasedAt: when.toISOString(), OrderRef: clip(req.orderRef, 80), WatchUntil: watch.toISOString(), UpdatedAt: nowIso()
      });
      item = getItem(item.ID);
      var act = itemPledges(item.ID), total = act.reduce(function (s, p) { return s + num(p.Amount); }, 0);
      act.forEach(function (p) {
        var share = !bool(item.GroupGift) ? price : (total > price ? round2(num(p.Amount) * price / total) : num(p.Amount));
        db.update('Pledges', 'ID', p.ID, { Share: share });
      });
      var sent = 0;
      if (req.notify !== false) sent = notifyPurchase(item);
      return { item: itemOut(item, u, ctx()), notified: sent };
    }
    function setPaid(u, id, paid) {
      requireAdmin(u);
      if (!db.find('Pledges', 'ID', id)) fail('Pledge not found.');
      db.update('Pledges', 'ID', id, { Paid: paid ? 'TRUE' : 'FALSE' });
      return { ok: true };
    }
    function setThanked(u, id, thanked) {
      requireAdmin(u);
      if (!db.find('Pledges', 'ID', id)) fail('Pledge not found.');
      db.update('Pledges', 'ID', id, { ThankedAt: thanked ? nowIso() : '' });
      return { ok: true };
    }
    function archiveGiven(u) {
      requireAdmin(u);
      var n = 0;
      db.all('Items').forEach(function (i) { if (i.Status === 'Given') { db.update('Items', 'ID', i.ID, { Status: 'Archived', UpdatedAt: nowIso() }); n++; } });
      return { archived: n };
    }
    function setSurprise(u, on) {
      requireAdmin(u);
      db.update('People', 'Name', u.name, { SurpriseMode: on ? 'TRUE' : 'FALSE' });
      return userOut(findPerson(u.name));
    }
    function savePerson(u, req) {
      requireAdmin(u);
      var name = clip(req.name, 60);
      if (!name) fail('Enter a name.');
      var role = ROLES.indexOf(req.role) >= 0 ? req.role : 'giver';
      var email = clip(req.email, 120);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('That email address doesn\'t look right.');
      var orig = req.originalName ? people().filter(function (p) { return p.Name === req.originalName; })[0] : null;
      var clash = people().filter(function (p) { return str(p.Name).toLowerCase() === name.toLowerCase() && p !== orig; })[0];
      if (clash) fail('Someone named ' + name + ' already exists.');
      if (req.pin) validatePin(req.pin);
      if (orig && orig.Name === u.name && role !== 'admin') fail('You can\'t remove your own admin role.');
      var ch = { Name: name, Email: email, Role: role, Active: req.active === false ? 'FALSE' : 'TRUE' };
      if (req.pin) ch.PinHash = hashPin(req.pin);
      if (orig) {
        db.update('People', 'Name', orig.Name, ch);
        if (orig.Name !== name) {
          db.all('Pledges').forEach(function (p) { if (p.Giver === orig.Name) db.update('Pledges', 'ID', p.ID, { Giver: name }); });
        }
      } else {
        ch.LinkToken = env.uuid().replace(/-/g, '').slice(0, 16);
        ch.SurpriseMode = 'FALSE';
        if (!ch.PinHash) ch.PinHash = '';
        db.insert('People', ch);
      }
      return { ok: true };
    }
    function newLink(u, name) {
      requireAdmin(u);
      if (!people().some(function (p) { return p.Name === name; })) fail('Person not found.');
      db.update('People', 'Name', name, { LinkToken: env.uuid().replace(/-/g, '').slice(0, 16) });
      return { ok: true };
    }
    function changePin(u, oldPin, newPin) {
      var p = findPerson(u.name);
      if (!p || p.PinHash !== hashPin(oldPin)) fail('Current PIN is incorrect.');
      validatePin(newPin);
      db.update('People', 'Name', p.Name, { PinHash: hashPin(newPin) });
      return { ok: true };
    }
    function putSetting(k, v) {
      if (db.find('Settings', 'Key', k)) db.update('Settings', 'Key', k, { Value: v });
      else db.insert('Settings', { Key: k, Value: v });
    }
    /** First-time setup from the Sheet's "Set up our family" wizard. */
    function setupFamily(d) {
      d = d || {};
      var sys = { name: '__setup__', role: 'admin' }, added = [];
      if (str(d.familyName)) putSetting('FamilyName', clip(d.familyName, 60));
      if (d.stores != null) putSetting('Stores', clip(d.stores, 100));
      var exists = function (n) { return people().some(function (p) { return str(p.Name).toLowerCase() === str(n).toLowerCase(); }); };
      (d.parents || []).forEach(function (p) {
        if (!str(p.name) || exists(p.name)) return;
        savePerson(sys, { name: p.name, email: p.email, role: 'admin', pin: p.pin }); added.push(p.name);
      });
      (d.kids || []).forEach(function (k) {
        if (!str(k) || exists(k)) return;
        savePerson(sys, { name: k, role: 'kid', pin: d.kidPin || '' }); added.push(k);
      });
      return { added: added, familyName: settings().FamilyName };
    }
    function saveSettings(u, s) {
      requireAdmin(u);
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
        if (s[k] == null) return;
        putSetting(k, clip(s[k], 500));
      });
      return settings();
    }
    function fetchProduct(u, url) {
      requireAdmin(u);
      url = str(url);
      if (!/^https?:\/\//i.test(url)) fail('Paste a full web address starting with https://');
      var res;
      try { res = env.fetchUrl(url); } catch (e) { return { found: false, retailer: retailerFor(url), error: retailerFor(url) + ' didn\'t respond to the automatic lookup. Fill in the details by hand, or use the "Add to registry" bookmark button on the store page.' }; }
      if (res.code >= 400) return { found: false, retailer: retailerFor(url), error: retailerFor(url) + ' blocked the automatic lookup (error ' + res.code + '). Fill in the details by hand, or use the "Add to registry" bookmark button on the store page. Price alerts may not work for this store.' };
      var p = parseProduct(res.body, url);
      if (!p.found) p.error = p.title ? 'Found the item but not its price. Add the price by hand.' : 'Couldn\'t read details from that page. Fill them in by hand.';
      return p;
    }
    function uploadPhoto(u, dataUrl, name) {
      requireAdmin(u);
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(str(dataUrl))) fail('Photos must be JPG, PNG or WebP.');
      if (dataUrl.length > 8e6) fail('That photo is too large.');
      return { url: env.saveImage(dataUrl, clip(name, 80) || 'photo') };
    }

    /* --------------------------------------------------- price checks */
    /** Checks every link on active items and items still inside the price-adjustment window. */
    /* ------------------------------------------------ recording prices */
    function watchActive(item) { return item.Status === 'Purchased' && item.WatchUntil && new Date(item.WatchUntil).getTime() >= now().getTime(); }
    /** Is this price worth an alert? Sale (target or % off the estimate) or a drop inside the price-adjustment window. */
    function judgePrice(item, link, price, defPct) {
      if (link && watchActive(item) && sameStore(link, item) && price < num(item.PurchasePrice) - 0.01) return { Type: 'adjust', RefPrice: num(item.PurchasePrice) };
      if (item.Status === 'Active') {
        var ref = num(item.Price), target = num(item.TargetPrice), pct = num(item.AlertPct) || defPct;
        if ((target && price <= target) || (ref && price <= ref * (1 - pct / 100))) return { Type: 'sale', RefPrice: ref || target };
      }
      return null;
    }
    function addAlert(item, link, price, a, source, url, retailer, alerts) {
      var dup = alerts.some(function (x) {
        return x.ItemID === item.ID && (x.LinkID || '') === (link ? link.ID : '') && x.Type === a.Type && Math.abs(num(x.NewPrice) - price) < 0.01;
      });
      if (dup) return null;
      var row = { ID: newId('A'), ItemID: item.ID, LinkID: link ? link.ID : '', Type: a.Type, Retailer: retailer || (link && link.Retailer) || '',
        RefPrice: a.RefPrice, NewPrice: price, URL: url || (link && link.URL) || '', CreatedAt: nowIso(), Emailed: 'FALSE', Source: source };
      db.insert('Alerts', row); alerts.push(row);
      return row;
    }
    /** Save a price found for a store link (by a check, an email, or by hand) and return an alert row if it's worth one. */
    function savePrice(item, link, price, note, source, alerts, defPct) {
      db.update('Links', 'ID', link.ID, { LastPrice: price, LowestPrice: num(link.LowestPrice) ? Math.min(num(link.LowestPrice), price) : price,
        LastChecked: nowIso(), CheckStatus: 'ok', CheckNote: note });
      db.insert('PriceHistory', { ItemID: item.ID, LinkID: link.ID, Retailer: link.Retailer, Price: price, CheckedAt: nowIso() });
      var a = judgePrice(item, link, price, defPct);
      return a ? addAlert(item, link, price, a, source, '', '', alerts) : null;
    }
    /** "Update price" from the store page or the Price alerts page. Several links when the same product is on the list more than once. */
    function recordPrice(u, req) {
      requireAdmin(u);
      var price = round2(req.price);
      if (price <= 0) fail('Enter the price shown on the store page.');
      var ids = [].concat(req.linkIds || req.linkId || []).map(str).filter(Boolean);
      if (!ids.length) fail('Pick which store link this price is for.');
      var s = settings(), defPct = num(s.DefaultAlertPct) || 15, alerts = db.all('Alerts'), out = [];
      ids.forEach(function (id) {
        var link = db.find('Links', 'ID', id); if (!link) return;
        var item = db.find('Items', 'ID', link.ItemID); if (!item) return;
        var row = savePrice(item, link, price, 'Entered by ' + u.name, 'manual', alerts, defPct);
        out.push({ itemId: item.ID, title: item.Title, alert: row ? { type: row.Type, refPrice: num(row.RefPrice), newPrice: price } : null });
      });
      if (!out.length) fail('That store link is no longer on the registry.');
      return { recorded: out.length, items: out };
    }

    /* --------------------------------------------- weekly spot-check */
    function spotCheckList() {
      var items = {}; db.all('Items').forEach(function (i) { items[i.ID] = i; });
      var weekAgo = now().getTime() - 6 * 864e5;
      return db.all('Links').map(function (l) {
        var item = items[l.ItemID]; if (!item) return null;
        var watch = watchActive(item) && sameStore(l, item);
        if (item.Status !== 'Active' && !watch) return null;
        var fresh = l.CheckStatus === 'ok' && l.LastChecked && new Date(l.LastChecked).getTime() > weekAgo;
        if (fresh) return null;
        return { item: item, link: l, watch: watch };
      }).filter(Boolean).sort(function (a, b) { return (b.watch ? 1 : 0) - (a.watch ? 1 : 0) || str(a.item.Title).localeCompare(str(b.item.Title)); });
    }
    function spotCheckDigest() {
      var list = spotCheckList();
      if (!list.length) return 0;
      var s = settings(), site = str(s.SiteURL).replace(/[?#].*$/, '');
      var rows = list.map(function (x) {
        var l = x.link, it = x.item;
        return '<tr><td style="padding:8px 0;border-bottom:1px solid #eee"><b>' + esc(it.Title) + '</b>' + (it.Tags ? ' <span style="color:#777">(' + esc(it.Tags) + ')</span>' : '') +
          (x.watch ? '<div style="color:#B4541F;font-size:12px;font-weight:700">Bought ' + esc(String(it.PurchaseRetailer || '')) + ' ' + money(it.PurchasePrice) +
            '. Price-adjustment window ends ' + esc(new Date(it.WatchUntil).toDateString()) + '</div>' : '') +
          '<div style="font-size:12px;color:#666">Last known: ' + (num(l.LastPrice) ? money(l.LastPrice) : 'none yet') + '</div></td>' +
          '<td style="padding:8px 0 8px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap"><a href="' + esc(l.URL) + '">Open ' + esc(l.Retailer || 'store') + '</a></td></tr>';
      }).join('');
      var html = '<p>These stores block automatic price checks, so here\'s your weekly list to glance at. It takes a couple of minutes.</p>' +
        '<p style="font-size:13px;color:#555">Open each page. If the price changed, click <b>+ Add to registry</b> in your bookmarks bar (it offers to record the price), ' +
        'or use <b>Update</b> on the Price alerts page' + (site ? ' (<a href="' + esc(site) + '#/admin/alerts">open it</a>)' : '') + '.</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:14px">' + rows + '</table>';
      send(alertEmails(), 'Weekly price spot-check: ' + list.length + ' item' + (list.length > 1 ? 's' : ''), wrap('Weekly price spot-check', html));
      return list.length;
    }

    /* ------------------------------------- Google price-drop emails */
    var STOP = ' the and for with kids kid youth boys girls mens womens men women unisex jr junior pack set new size color ';
    function emailText(html, text) {
      var t = String(html || '');
      if (t) {
        t = t.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/&nbsp;/gi, ' ')
          .replace(/<\/(p|div|td|tr|li|h\d|table)>/gi, '\n').replace(/<[^>]+>/g, ' ');
        t = decodeEntities(t);
      } else t = String(text || '');
      return t.split(/\n/).map(function (x) { return x.replace(/[\s\u00a0]+/g, ' ').trim(); }).filter(Boolean);
    }
    function emailLinks(html) {
      var out = [], re = /href=["']([^"']+)["']/gi, m;
      while ((m = re.exec(String(html || '')))) {
        var u = decodeEntities(m[1]);
        var inner = u.match(/[?&](?:q|url|adurl|u)=(https?[^&]+)/i);
        if (inner) { try { u = decodeURIComponent(inner[1]); } catch (e) { /* keep */ } }
        if (/^https?:/i.test(u)) out.push(u);
      }
      return out;
    }
    function words(t) {
      return str(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(function (w) { return w.length >= 3 && STOP.indexOf(' ' + w + ' ') < 0; });
    }
    function pricesIn(line) {
      var out = [], re = /\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g, m;
      while ((m = re.exec(line))) out.push(num(m[1]));
      return out;
    }
    /** Reads one price email. Returns what it found; records prices and alerts when it can tell which item and store. */
    function ingestPriceEmail(msg, ctx) {
      var lines = emailText(msg.html, msg.text), links = emailLinks(msg.html), flat = lines.join('\n');
      var results = [];
      ctx.candidates.forEach(function (item) {
        var itemLinks = ctx.links.filter(function (l) { return l.ItemID === item.ID; });
        var urlHit = null;
        links.some(function (u) { var hit = itemLinks.filter(function (l) { return sameProduct(l.URL, u); })[0]; if (hit) { urlHit = { link: hit, url: u }; } return !!hit; });
        var tw = words(item.Title), at = -1, best = 0;
        var scoreOf = function (t) { t = t.toLowerCase(); return tw.filter(function (w) { return t.indexOf(w) >= 0; }).length / tw.length; };
        if (tw.length >= 2) {
          // the line that holds the product name; names wrapped over two lines are the fallback
          lines.forEach(function (ln, i) { var sc = scoreOf(ln); if (sc > best) { best = sc; at = i; } });
          if (best < 0.7) lines.forEach(function (ln, i) { var sc = scoreOf(ln + ' ' + (lines[i + 1] || '')); if (sc > best) { best = sc; at = i; } });
        }
        if (!urlHit && best < 0.7) return;
        var start = at >= 0 && best >= 0.7 ? at : 0, win = lines.slice(start, start + 9);
        var ref = num(item.Price);
        var prices = [];
        win.forEach(function (ln) { prices = prices.concat(pricesIn(ln)); });
        var nowMatch = win.join(' ').match(/\b(?:now|to|price:?|sale)\s*\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/i);
        var plausible = prices.filter(function (p) { return !ref || (p >= ref * 0.3 && p <= ref * 1.6); });
        var price = nowMatch && num(nowMatch[1]) ? num(nowMatch[1]) : plausible.length ? Math.min.apply(null, plausible) : 0;
        var winText = win.join(' ').toLowerCase();
        var link = urlHit ? urlHit.link : itemLinks.filter(function (l) { return l.Retailer && winText.indexOf(str(l.Retailer).toLowerCase()) >= 0; })[0] || null;
        var storeName = link ? link.Retailer : (RETAILERS.map(function (r) { return r[1]; }).filter(function (n) { return winText.indexOf(n.toLowerCase()) >= 0; })[0] || 'Google Shopping');
        var url = urlHit ? urlHit.url : (links.filter(function (u) { return retailerFor(u).toLowerCase() === storeName.toLowerCase(); })[0] || '');
        results.push({ item: item, link: link, price: round2(price), store: storeName, url: url, how: urlHit ? 'link' : 'title ' + Math.round(best * 100) + '%' });
      });
      var logged = [];
      if (!results.length) logged.push({ Result: 'No match', Detail: lines.slice(0, 6).join(' | ').slice(0, 400) });
      results.forEach(function (r) {
        if (!r.price) { logged.push({ Result: 'No price', ItemID: r.item.ID, Retailer: r.store, Detail: 'Matched by ' + r.how }); return; }
        var row = null;
        if (r.link) row = savePrice(r.item, r.link, r.price, 'From a price email', 'email', ctx.alerts, ctx.defPct);
        else {
          var a = judgePrice(r.item, null, r.price, ctx.defPct) || (r.item.Price && r.price < num(r.item.Price) - 0.01 ? { Type: 'seen', RefPrice: num(r.item.Price) } : null);
          if (a) row = addAlert(r.item, null, r.price, a, 'email', r.url, r.store, ctx.alerts);
        }
        if (row && row.Type !== 'seen') ctx.created.push(row);
        logged.push({ Result: r.link ? 'Recorded' : row ? 'Lead (store not on item)' : 'No drop', ItemID: r.item.ID, Retailer: r.store, Price: r.price, Detail: 'Matched by ' + r.how });
      });
      logged.forEach(function (x) {
        db.insert('EmailLog', { MessageID: msg.id, ReceivedAt: msg.date || '', From: clip(msg.from, 120), Subject: clip(msg.subject, 200),
          Result: x.Result, ItemID: x.ItemID || '', Retailer: x.Retailer || '', Price: x.Price || '', Detail: x.Detail || '', LoggedAt: nowIso() });
      });
      return results.length;
    }
    function ingestPriceEmails(msgs) {
      var done = {}; db.all('EmailLog').forEach(function (r) { done[r.MessageID] = true; });
      var s = settings(), items = {};
      db.all('Items').forEach(function (i) { items[i.ID] = i; });
      var ctx = {
        candidates: db.all('Items').filter(function (i) { return i.Status === 'Active' || watchActive(i); }),
        links: db.all('Links'), alerts: db.all('Alerts'), created: [], defPct: num(s.DefaultAlertPct) || 15
      };
      var seen = 0, matched = 0;
      (msgs || []).forEach(function (m) { if (!m || !m.id || done[m.id]) return; seen++; matched += ingestPriceEmail(m, ctx) ? 1 : 0; done[m.id] = true; });
      if (ctx.created.length) mailAlerts(ctx.created, items, s);
      return { emails: seen, matched: matched, alerts: ctx.created.length };
    }

    function priceRun() { try { return JSON.parse(env.props.get('PRICE_RUN') || 'null'); } catch (e) { return null; } }
    function setPriceRun(o) { env.props.set('PRICE_RUN', JSON.stringify(o)); }
    function runActive(run) {
      if (!run || (run.state !== 'running' && run.state !== 'queued')) return false;
      var since = new Date(run.startedAt || run.queuedAt).getTime();
      return now().getTime() - since < 8 * 60000; // older than that means it was cut off
    }
    /** Start a price check without making the browser wait (the web app hands it to a background trigger). */
    function startPriceCheck(u, itemId) {
      requireAdmin(u);
      if (!env.queue) return checkPrices({ itemId: itemId }); // demo mode: just run it
      var run = priceRun();
      if (runActive(run)) return { started: true, already: true, run: run };
      run = { state: 'queued', queuedAt: nowIso(), itemId: str(itemId), by: u.name };
      setPriceRun(run);
      env.queue('runQueuedPriceCheck');
      return { started: true, run: run };
    }
    function checkPrices(opts) {
      opts = opts || {};
      var startedAt = nowIso();
      setPriceRun({ state: 'running', startedAt: startedAt, itemId: str(opts.itemId) });
      var s = settings(), defPct = num(s.DefaultAlertPct) || 15, nowMs = now().getTime();
      var items = {}; db.all('Items').forEach(function (i) { items[i.ID] = i; });
      var alerts = db.all('Alerts');
      var created = [], summary = { checked: 0, ok: 0, blocked: 0, noPrice: 0, alerts: 0, skipped: 0 };
      // Oldest-checked first, so a run cut short by the time limit resumes where it stopped next time.
      var links = db.all('Links').sort(function (a, b) { return str(a.LastChecked) < str(b.LastChecked) ? -1 : str(a.LastChecked) > str(b.LastChecked) ? 1 : 0; });
      var budgetMs = (opts.budgetSec || 240) * 1000, badHosts = {};
      // Stores that hung a previous run (Google killed the script while waiting) are skipped
      // for 20 hours, then tried once more, so one silent store can't stall every check.
      var HUNG_NOTE = 'Store never answered (blocks automated checks). Retried once a day.';
      var hung = {};
      try { hung = JSON.parse(env.props.get('PRICE_HUNG') || '{}'); } catch (e) { hung = {}; }
      var inflight = env.props.get('PRICE_INFLIGHT');
      if (inflight) { try { var fl = JSON.parse(inflight); hung[fl.host] = fl.at; } catch (e) { /* ignore */ } env.props.del('PRICE_INFLIGHT'); }
      Object.keys(hung).forEach(function (h) {
        if (nowMs - new Date(hung[h]).getTime() < 20 * 3600000) badHosts[h] = HUNG_NOTE; else delete hung[h];
      });
      env.props.set('PRICE_HUNG', JSON.stringify(hung));
      links.forEach(function (l) {
        var item = items[l.ItemID];
        if (!item) return;
        if (opts.itemId && item.ID !== opts.itemId) return;
        var inWatch = item.Status === 'Purchased' && item.WatchUntil && new Date(item.WatchUntil).getTime() >= nowMs;
        if (item.Status !== 'Active' && !inWatch) return;
        if (inWatch && !sameStore(l, item)) return;
        if (now().getTime() - nowMs > budgetMs) { summary.skipped++; return; } // Google stops scripts at 6 minutes
        var host = hostOf(l.URL);
        if (badHosts[host]) { // this store already stalled or refused this run; don't wait on it again
          summary.checked++; summary.blocked++;
          db.update('Links', 'ID', l.ID, { LastChecked: nowIso(), CheckStatus: 'blocked', CheckNote: badHosts[host] });
          return;
        }
        summary.checked++;
        // Save a provisional result first: if Google stops the script while this store keeps us
        // waiting, the link still shows what happened and the next run knows to skip this store.
        db.update('Links', 'ID', l.ID, { LastChecked: nowIso(), CheckStatus: 'blocked', CheckNote: HUNG_NOTE });
        env.props.set('PRICE_INFLIGHT', JSON.stringify({ host: host, at: nowIso() }));
        var res, price = 0, status = 'ok', note = '';
        try { res = env.fetchUrl(l.URL); }
        catch (e) { res = { code: 0, body: '' }; note = /timeout|timed out/i.test(String(e && e.message)) ? 'Store did not respond (likely blocks automated checks)' : 'Could not connect'; }
        env.props.del('PRICE_INFLIGHT');
        if (res.code >= 400 || res.code === 0) {
          status = 'blocked'; note = note || 'Store returned error ' + res.code; summary.blocked++;
          badHosts[host] = note;
          if (res.code === 0) { hung[host] = nowIso(); env.props.set('PRICE_HUNG', JSON.stringify(hung)); }
        }
        else {
          price = parseProduct(res.body, l.URL).price;
          if (!price) { status = 'no-price'; note = 'Page loaded but no price found'; summary.noPrice++; }
          else summary.ok++;
        }
        if (!price) { db.update('Links', 'ID', l.ID, { LastChecked: nowIso(), CheckStatus: status, CheckNote: note }); return; }
        var row = savePrice(item, l, price, '', 'check', alerts, defPct);
        if (row) { created.push(row); summary.alerts++; }
        if (env.sleep) env.sleep(300);
      });
      if (created.length) mailAlerts(created, items, s);
      setPriceRun({ state: 'done', startedAt: startedAt, finishedAt: nowIso(), itemId: str(opts.itemId), summary: summary });
      return summary;
    }
    function sameStore(link, item) {
      if (item.PurchaseURL) return link.URL === item.PurchaseURL;
      return str(item.PurchaseRetailer).toLowerCase() === str(link.Retailer).toLowerCase();
    }

    /* ---------------------------------------------------------- email */
    function adminEmails(item) {
      return activePeople().filter(function (p) {
        if (str(p.Role).toLowerCase() !== 'admin' || !p.Email) return false;
        if (item && bool(p.SurpriseMode) && tagsOf(item).indexOf(p.Name) >= 0) return false;
        return true;
      }).map(function (p) { return p.Email; });
    }
    function alertEmails() {
      var list = str(settings().AlertEmails).split(/[,;\s]+/).filter(Boolean);
      return list.length ? list : adminEmails(null);
    }
    function wrap(title, body) {
      var s = settings();
      return '<div style="font-family:Montserrat,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1A1A1B">' +
        '<div style="background:#1E3A36;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">' +
        '<div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75">' + esc(s.FamilyName) + ' Gift Registry</div>' +
        '<div style="font-size:18px;font-weight:600;margin-top:4px">' + esc(title) + '</div></div>' +
        '<div style="background:#fff;border:1px solid #E4E2DA;border-top:none;padding:20px;border-radius:0 0 10px 10px;font-size:14px;line-height:1.55">' +
        body + (s.SiteURL ? '<p style="margin-top:20px"><a href="' + esc(s.SiteURL) + '" style="background:#4F6749;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open the registry</a></p>' : '') +
        '</div></div>';
    }
    function send(to, subject, html) {
      if (!to || (Array.isArray(to) && !to.length)) return false;
      try { env.mail(Array.isArray(to) ? to.join(',') : to, subject, html); return true; } catch (e) { return false; }
    }
    function mailPledgeToAdmins(item, p, kind, t) {
      var to = adminEmails(item);
      var line = kind === 'new'
        ? '<b>' + esc(p.Giver) + '</b> pledged <b>' + money(p.Amount) + '</b> toward <b>' + esc(item.Title) + '</b>' +
          ' and will ' + (p.PayMethod === 'upfront' ? 'pay up front.' : 'reimburse you after you buy it.')
        : '<b>' + esc(p.Giver) + '</b> cancelled their ' + money(p.Amount) + ' pledge on <b>' + esc(item.Title) + '</b>.';
      var status = t.state === 'full' ? 'Fully pledged' : t.state === 'partial' ? 'Partly pledged (' + money(t.total) + ' of ' + money(t.goal) + ')' : 'Available again';
      var body = '<p>' + line + '</p>' + (p.Note && kind === 'new' ? '<p style="color:#555">Note: “' + esc(p.Note) + '”</p>' : '') +
        '<p>Status now: <b>' + status + '</b></p>' + (t.state === 'full' && kind === 'new' ? '<p>Time to find the best deal and buy it.</p>' : '');
      send(to, (kind === 'new' ? 'New pledge: ' : 'Pledge cancelled: ') + item.Title, wrap(kind === 'new' ? 'New pledge' : 'Pledge cancelled', body));
    }
    function mailGiverConfirmation(u, item, p, capped) {
      if (!u.email) return;
      var s = settings();
      var body = '<p>Hi ' + esc(u.name) + ',</p><p>Thank you! You pledged <b>' + money(p.Amount) + '</b> toward <b>' + esc(item.Title) + '</b>' +
        (capped ? ' (that was the amount still needed to finish this gift)' : '') + '.</p>' +
        '<p>' + esc(hosts()) + ' will buy it' + (str(s.Stores) ? ' through their ' + esc(s.Stores) + ' memberships' : '') + ' so it\'s fully warrantied, and watch for the best price. ' +
        (p.PayMethod === 'upfront' ? 'You chose to pay up front: ' + esc(s.PaymentNote) : 'You chose to pay them back after they buy it. You\'ll get an email with the final price.') + '</p>' +
        '<p style="color:#666;font-size:13px">Your pledge is private. Other family members only see that the item is taken. You can see or cancel it under <b>My pledges</b> until it\'s bought.</p>';
      send(u.email, 'Your pledge: ' + item.Title, wrap('Thanks for your pledge', body));
    }
    function notifyPurchase(item) {
      var s = settings(), n = 0;
      itemPledges(item.ID).forEach(function (p) {
        var person = findPerson(p.Giver);
        var share = num(db.find('Pledges', 'ID', p.ID).Share) || num(p.Amount);
        var paid = bool(p.Paid);
        if (person && person.Email) {
          var body = '<p>Hi ' + esc(p.Giver) + ',</p><p>Good news: we bought <b>' + esc(item.Title) + '</b>' +
            (item.PurchaseRetailer ? ' from ' + esc(item.PurchaseRetailer) : '') + ' for ' + money(item.PurchasePrice) + '.</p>' +
            '<p>Your share: <b>' + money(share) + '</b>' + (bool(item.GroupGift) ? ' (you pledged ' + money(p.Amount) + ')' : '') + '.</p>' +
            (paid ? '<p>You\'ve already paid. Thank you! If what you sent doesn\'t match your share, we\'ll settle up the difference.</p>'
              : '<p>How to pay: ' + esc(s.PaymentNote) + '</p>') +
            '<p>We\'ll keep watching the price for ' + (num(s.WatchDays) || 14) + ' days in case the store drops it and we can get money back.</p>';
          if (send(person.Email, 'We bought it: ' + item.Title, wrap('We bought it!', body))) n++;
        }
        db.update('Pledges', 'ID', p.ID, { NotifiedAt: nowIso() });
      });
      return n;
    }
    function mailAlerts(rows, items, s) {
      var html = rows.map(function (a) {
        var it = items[a.ItemID] || {};
        var head = a.Type === 'adjust'
          ? '⚑ Price dropped after you bought it: request a price adjustment'
          : '↓ On sale' + (a.Source === 'email' ? ' (from a Google price alert)' : '');
        var pct = num(a.RefPrice) ? Math.round((1 - num(a.NewPrice) / num(a.RefPrice)) * 100) : 0;
        return '<div style="border:1px solid #E4E2DA;border-radius:8px;padding:12px;margin-bottom:10px">' +
          '<div style="font-size:12px;color:' + (a.Type === 'adjust' ? '#B4541F' : '#4F6749') + ';font-weight:700">' + head + '</div>' +
          '<div style="font-weight:600;margin:4px 0">' + esc(it.Title) + '</div>' +
          '<div>' + esc(a.Retailer) + ': <b>' + money(a.NewPrice) + '</b>' + (num(a.RefPrice) ? ' <span style="color:#777">(was ' + money(a.RefPrice) + (pct > 0 ? ', ' + pct + '% off' : '') + ')</span>' : '') + '</div>' +
          (a.Type === 'adjust' ? '<div style="font-size:12px;color:#555;margin-top:4px">Many stores (REI, for one) adjust the price within ' + (num(s.WatchDays) || 14) + ' days of purchase. Bring your receipt or call customer service.</div>' : '') +
          '<div style="margin-top:6px"><a href="' + esc(a.URL) + '">View at ' + esc(a.Retailer) + '</a></div></div>';
      }).join('');
      if (send(alertEmails(), rows.length + ' price alert' + (rows.length > 1 ? 's' : '') + ' — gift registry', wrap('Price alerts', html))) {
        rows.forEach(function (a) { db.update('Alerts', 'ID', a.ID, { Emailed: 'TRUE' }); });
      }
    }
    function thankYouList() {
      var items = {}; db.all('Items').forEach(function (i) { items[i.ID] = i; });
      return db.all('Pledges').filter(function (p) {
        var i = items[p.ItemID];
        return p.Status === 'active' && !p.ThankedAt && i && (i.Status === 'Given' || i.Status === 'Archived');
      }).map(function (p) { return pledgeOut(p, items[p.ItemID]); });
    }
    function thankYouDigest() {
      var list = thankYouList();
      if (!list.length) return 0;
      var html = '<p>Thank-you notes still to send:</p><ul>' + list.map(function (p) {
        return '<li><b>' + esc(p.giver) + '</b> for ' + esc(p.itemTitle) + '</li>';
      }).join('') + '</ul><p style="color:#666;font-size:13px">Mark them done on the Thank-yous page.</p>';
      send(adminEmails(null), 'Thank-you notes to send (' + list.length + ')', wrap('Thank-you reminder', html));
      return list.length;
    }

    /* --------------------------------------------------------- router */
    function handle(req) {
      req = req || {};
      try { return { ok: true, data: route(req) }; }
      catch (e) {
        var msg = (e && e.message) || String(e);
        if (msg.indexOf('AUTH:') === 0) return { ok: false, auth: true, error: msg.slice(5) };
        return { ok: false, error: msg };
      }
    }
    function signinNames() { return activePeople().filter(function (p) { return p.PinHash; }).map(function (p) { return p.Name; }).sort(); }
    function linkName(k) {
      var lp = activePeople().filter(function (p) { return p.LinkToken && p.LinkToken === str(k); })[0];
      return lp ? lp.Name : null;
    }
    function route(req) {
      var a = req.action;
      if (a === 'people') return signinNames();
      if (a === 'linkInfo') { var ln = linkName(req.k); return ln ? { name: ln } : null; }
      if (a === 'signinInfo') return { names: signinNames(), linked: req.k ? linkName(req.k) : null, familyName: settings().FamilyName, hosts: hosts(' or ') };
      if (a === 'login') {
        var res = login(req.name, req.pin);
        if (req.withData) { var lu = userFromToken(res.token); res.boot = bootstrap(lu); if (isAdmin(lu)) res.admin = adminData(lu); }
        return res;
      }
      var u = userFromToken(req.token);
      var result = act(a, u, req);
      if (!req.withData) return result;
      // Hand back fresh page data in the same reply, so the browser needs one round trip, not three.
      u = userFromToken(req.token);
      return { result: result, boot: bootstrap(u), admin: isAdmin(u) ? adminData(u) : null };
    }
    function act(a, u, req) {
      var L = env.lock || function (fn) { return fn(); };
      switch (a) {
        case 'logout': env.props.del('sess_' + req.token); return { ok: true };
        case 'bootstrap': return bootstrap(u);
        case 'myPledges': return myPledges(u);
        case 'pledge': return L(function () { return pledge(u, req); });
        case 'cancelPledge': return L(function () { return cancelPledge(u, req.id); });
        case 'changePin': return L(function () { return changePin(u, req.oldPin, req.newPin); });
        case 'adminData': return adminData(u);
        case 'saveItem': return L(function () { return saveItem(u, req.item); });
        case 'deleteItem': return L(function () { return deleteItem(u, req.id); });
        case 'setStatus': return L(function () { return setStatus(u, req.id, req.status); });
        case 'markPurchased': return L(function () { return markPurchased(u, req); });
        case 'setPaid': return L(function () { return setPaid(u, req.id, req.paid); });
        case 'setThanked': return L(function () { return setThanked(u, req.id, req.thanked); });
        case 'archiveGiven': return L(function () { return archiveGiven(u); });
        case 'setSurprise': return L(function () { return setSurprise(u, req.on); });
        case 'savePerson': return L(function () { return savePerson(u, req); });
        case 'newLink': return L(function () { return newLink(u, req.name); });
        case 'saveSettings': return L(function () { return saveSettings(u, req.settings || {}); });
        case 'fetchProduct': return fetchProduct(u, req.url);
        case 'uploadPhoto': return uploadPhoto(u, req.dataUrl, req.name);
        case 'checkPrices': return startPriceCheck(u, req.itemId);
        case 'priceRun': requireAdmin(u); return priceRun();
        case 'recordPrice': return L(function () { return recordPrice(u, req); });
        case 'thankYous': requireAdmin(u); return thankYouList();
      }
      fail('Unknown request.');
    }

    return {
      handle: handle, checkPrices: checkPrices, thankYouDigest: thankYouDigest, signOutAll: signOutAll,
      spotCheckDigest: spotCheckDigest, setupFamily: setupFamily, ingestPriceEmails: function (msgs) { return (env.lock || function (f) { return f(); })(function () { return ingestPriceEmails(msgs); }); },
      setPinDirect: function (name, pin) {
        validatePin(pin);
        if (!people().some(function (p) { return p.Name === name; })) fail('No person named ' + name + '.');
        db.update('People', 'Name', name, { PinHash: hashPin(pin) });
      },
      addPersonDirect: function (name, email, role, pin) {
        var admin = { name: '__setup__', role: 'admin' };
        return savePerson(admin, { name: name, email: email, role: role, pin: pin });
      },
      settings: settings
    };
  }

  return {
    TABLES: TABLES, DEFAULT_SETTINGS: DEFAULT_SETTINGS, OCCASIONS: OCCASIONS, CATEGORIES: CATEGORIES,
    PRIORITIES: PRIORITIES, create: create, parseProduct: parseProduct, retailerFor: retailerFor, sameProduct: sameProduct, productKey: productKey
  };
})();

if (typeof module !== 'undefined') module.exports = GR;
