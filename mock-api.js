/**
 * Demo-mode backend. Runs the real Core logic (apps-script/Core.js) against a
 * database kept in this browser's localStorage. Used only when config.js has
 * no API_URL. Emails are shown as toasts and logged to the console.
 */
(function () {
  'use strict';
  if (window.GR_CONFIG && window.GR_CONFIG.API_URL) return; // a family's own site: not needed
  var NS = window.GR_CONFIG && window.GR_CONFIG.KIT ? 'kit_' : '';
  var DB_KEY = NS + 'gr_demo_db_v1', PROPS_KEY = NS + 'gr_demo_props_v1';

  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full */ } }

  var data, props;
  function makeEnv() {
    data = load(DB_KEY, null);
    props = load(PROPS_KEY, {});
    if (!data) { data = {}; Object.keys(GR.TABLES).forEach(function (t) { data[t] = []; }); }
    function persist() { save(DB_KEY, data); }
    return {
      db: {
        all: function (t) { return (data[t] || []).slice(); },
        find: function (t, k, v) { return (data[t] || []).filter(function (r) { return String(r[k]) === String(v); })[0] || null; },
        insert: function (t, o) {
          var row = {}; GR.TABLES[t].forEach(function (k) { row[k] = o[k] == null ? '' : String(o[k]); });
          data[t].push(row); persist(); return row;
        },
        update: function (t, k, v, ch) {
          var r = (data[t] || []).filter(function (x) { return String(x[k]) === String(v); })[0];
          if (!r) return null;
          Object.keys(ch).forEach(function (c) { r[c] = ch[c] == null ? '' : String(ch[c]); });
          persist(); return r;
        },
        remove: function (t, k, v) {
          var before = data[t].length;
          data[t] = data[t].filter(function (x) { return String(x[k]) !== String(v); });
          persist(); return data[t].length < before;
        }
      },
      now: function () { return new Date(); },
      uuid: function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      },
      hash: function (s) { // demo only; the real backend uses SHA-256
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return 'demo' + (h >>> 0).toString(16);
      },
      props: {
        get: function (k) { return props[k] == null ? null : props[k]; },
        set: function (k, v) { props[k] = v; save(PROPS_KEY, props); },
        del: function (k) { delete props[k]; save(PROPS_KEY, props); },
        keys: function () { return Object.keys(props); }
      },
      mail: function (to, subject, html) {
        console.info('[demo email] to: ' + to + ' | ' + subject);
        window.dispatchEvent(new CustomEvent('gr-demo-mail', { detail: { to: to, subject: subject, html: html } }));
      },
      fetchUrl: function (url) { return fakeStorePage(url); },
      saveImage: function (dataUrl) { return dataUrl; }
    };
  }

  /* A fake product page so "paste a link" and price checks work in the demo. */
  var DEMO_PRICES = {};
  function fakeStorePage(url) {
    var retailer = GR.retailerFor(url);
    var q = decodeURIComponent((url.match(/[?&]q=([^&]+)/) || [])[1] || '').replace(/\+/g, ' ');
    var title = q ? q.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : 'Sample ' + retailer + ' Product';
    if (!DEMO_PRICES[url]) {
      // Base the simulated store price on the item's own estimate, so demo sales look realistic.
      var link = (data.Links || []).filter(function (l) { return l.URL === url; })[0];
      var item = link && (data.Items || []).filter(function (i) { return i.ID === link.ItemID; })[0];
      DEMO_PRICES[url] = item && Number(item.Price) ? Number(item.Price) : 60 + (url.length * 37 % 200);
    }
    var base = DEMO_PRICES[url];
    var price = Math.round(base * (Math.random() < 0.3 ? 0.8 : 1) * 100) / 100;
    var ld = { '@context': 'https://schema.org', '@type': 'Product', name: title, brand: { '@type': 'Brand', name: retailer },
      description: 'Demo product description pulled from the store page.', offers: { '@type': 'Offer', price: price.toFixed(2), priceCurrency: 'USD' } };
    return { code: 200, body: '<html><head><title>' + title + ' | ' + retailer + '</title><script type="application/ld+json">' + JSON.stringify(ld) + '</script></head></html>' };
  }

  /* ------------------------------------------------------------- seed data */
  function seed(env) {
    var api = GR.create(env), db = env.db, now = Date.now();
    function iso(daysAgo) { return new Date(now - daysAgo * 864e5).toISOString(); }
    env.props.set('PIN_SALT', 'demo-salt');
    [['Alex', 'alex@example.com', 'admin'], ['Jordan', 'jordan@example.com', 'admin'],
      ['Maya', '', 'kid'], ['Sam', '', 'kid'],
      ['Nana & Papa', 'nana@example.com', 'giver'], ['Grandma & Grandpa', 'grandma@example.com', 'giver'],
      ['Gigi & Pops', 'gigi@example.com', 'giver'], ['Aunt Jen', 'jen@example.com', 'giver'], ['Uncle Chris', '', 'giver']
    ].forEach(function (p) {
      db.insert('People', { Name: p[0], Email: p[1], Role: p[2], PinHash: '', LinkToken: 'demo' + p[0].replace(/\W/g, '').toLowerCase(), SurpriseMode: 'FALSE', Active: 'TRUE' });
      api.setPinDirect(p[0], '1234');
    });
    var s = function (q, store) {
      var host = { REI: 'https://www.rei.com/search?q=', Scheels: 'https://www.scheels.com/search?q=', evo: 'https://www.evo.com/shop?q=',
        Backcountry: 'https://www.backcountry.com/Store/catalog/search.jsp?q=', 'Christy Sports': 'https://www.christysports.com/search?q=',
        NEMO: 'https://www.nemoequipment.com/search?q=' }[store];
      return host + encodeURIComponent(q).replace(/%20/g, '+');
    };
    var items = [
      { id: 'I1', t: 'All-mountain skis, 152 cm', b: 'Example Brand', tags: 'Maya', occ: 'Christmas', cat: 'Ski & Snow', size: '152 cm', pri: 1, group: true, price: 549.95, target: 450,
        notes: 'Maya\'s current skis are two sizes too short. Ask us about bindings before buying.', links: [['REI', 'youth all mountain skis', 549.95], ['evo', 'youth all mountain skis', 529.99]] },
      { id: 'I2', t: 'Climbing harness', b: 'Example Brand', tags: 'Sam', occ: 'Christmas', cat: 'Climbing', size: 'Youth M', pri: 1, group: false, price: 64.95,
        notes: 'Adjustable leg loops so it grows with him.', links: [['REI', 'kids climbing harness', 64.95]] },
      { id: 'I3', t: '2-person backpacking tent', b: 'NEMO', tags: 'Maya, Sam', occ: 'Anytime', cat: 'Camping', size: '', pri: 2, group: true, price: 449.95, alert: 20,
        notes: 'For the kids\' first solo overnight. Freestanding, under 4 lb.', links: [['NEMO', '2 person backpacking tent', 449.95], ['REI', '2 person backpacking tent', 449.95]] },
      { id: 'I4', t: 'Ski helmet with MIPS', b: 'Example Brand', tags: 'Sam', occ: 'Birthday', cat: 'Ski & Snow', size: 'Youth S/M', pri: 2, group: false, price: 119.95,
        links: [['Scheels', 'youth ski helmet mips', 119.95], ['Christy Sports', 'youth ski helmet', 124.99]] },
      { id: 'I5', t: 'Insulated down jacket', b: 'Example Brand', tags: 'Jordan', occ: 'Christmas', cat: 'Clothing', size: 'Women\'s M', color: 'Forest green', pri: 2, group: false, price: 229,
        links: [['REI', 'womens down jacket', 229]] },
      { id: 'I6', t: 'Fly rod, 9 ft 5 wt', b: 'Example Brand', tags: 'Alex', occ: 'Birthday', cat: 'Fishing', size: '9\' 5wt', pri: 1, group: true, price: 399,
        links: [['Scheels', 'fly rod 9ft 5wt', 399]] },
      { id: 'I7', t: 'Rock climbing shoes', b: 'Example Brand', tags: 'Maya', occ: 'Anytime', cat: 'Climbing', size: 'Youth 5', pri: 3, group: false, price: 89.95,
        links: [['REI', 'kids climbing shoes', 89.95]] },
      { id: 'I8', t: 'Sleeping bag, 20°F', b: 'Example Brand', tags: 'Sam', occ: 'Christmas', cat: 'Camping', size: 'Regular', pri: 2, group: false, price: 179.95,
        links: [['REI', '20 degree sleeping bag', 179.95]] },
      { id: 'I9', t: 'Headlamp, rechargeable', b: 'Example Brand', tags: 'Maya', occ: 'Christmas', cat: 'Hiking', size: '', pri: 3, group: false, price: 49.95, status: 'Purchased',
        links: [['REI', 'rechargeable headlamp', 49.95]] },
      { id: 'I10', t: 'Daypack, 22 L', b: 'Example Brand', tags: 'Sam', occ: 'Birthday', cat: 'Hiking', size: '', pri: 2, group: false, price: 99.95, status: 'Given',
        links: [['REI', 'kids daypack 22l', 99.95]] }
    ];
    items.forEach(function (it, i) {
      db.insert('Items', { ID: it.id, Title: it.t, Brand: it.b, Description: '', Tags: it.tags, Occasion: it.occ, Category: it.cat,
        Size: it.size, Color: it.color || '', Notes: it.notes || '', Priority: it.pri, GroupGift: it.group ? 'TRUE' : 'FALSE',
        Price: it.price, TargetPrice: it.target || '', AlertPct: it.alert || '', Status: it.status || 'Active', ImageURL: '', Photos: '',
        CreatedAt: iso(30 - i), UpdatedAt: iso(30 - i) });
      it.links.forEach(function (l, j) {
        db.insert('Links', { ID: it.id + 'L' + j, ItemID: it.id, Retailer: l[0], URL: s(l[1], l[0]), LastPrice: l[2], LowestPrice: l[2],
          LastChecked: iso(1), CheckStatus: 'ok', CheckNote: '' });
      });
    });
    function pledge(id, item, giver, amt, method, paid, days) {
      db.insert('Pledges', { ID: id, ItemID: item, Giver: giver, Amount: amt, Share: '', PayMethod: method, Paid: paid ? 'TRUE' : 'FALSE',
        Status: 'active', Note: '', CreatedAt: iso(days), CancelledAt: '', NotifiedAt: '', ThankedAt: '' });
    }
    pledge('P1', 'I1', 'Nana & Papa', 250, 'upfront', true, 6);
    pledge('P2', 'I1', 'Aunt Jen', 100, 'reimburse', false, 4);
    pledge('P3', 'I2', 'Grandma & Grandpa', 64.95, 'reimburse', false, 5);
    pledge('P4', 'I6', 'Gigi & Pops', 150, 'reimburse', false, 3);
    pledge('P5', 'I9', 'Uncle Chris', 49.95, 'reimburse', false, 12);
    pledge('P6', 'I10', 'Grandma & Grandpa', 99.95, 'upfront', true, 60);
    db.update('Items', 'ID', 'I9', { PurchasePrice: 44.95, PurchaseRetailer: 'REI', PurchaseURL: s('rechargeable headlamp', 'REI'),
      PurchasedAt: iso(3), WatchUntil: new Date(now + 11 * 864e5).toISOString() });
    db.update('Pledges', 'ID', 'P5', { Share: 44.95, NotifiedAt: iso(3) });
    db.update('Items', 'ID', 'I10', { PurchasePrice: 89.95, PurchaseRetailer: 'REI', PurchasedAt: iso(50), GivenAt: iso(20) });
    db.update('Pledges', 'ID', 'P6', { Share: 89.95 });
    db.update('Links', 'ID', 'I4L0', { LastPrice: 95.96, LowestPrice: 95.96 });
    db.insert('Alerts', { ID: 'A1', ItemID: 'I4', LinkID: 'I4L0', Type: 'sale', Retailer: 'Scheels', RefPrice: 119.95, NewPrice: 95.96,
      URL: s('youth ski helmet mips', 'Scheels'), CreatedAt: iso(1), Emailed: 'TRUE' });
    db.update('Links', 'ID', 'I3L0', { CheckStatus: 'blocked', CheckNote: 'Store returned error 403' });
    db.insert('Settings', { Key: 'AlertEmails', Value: 'alex@example.com, jordan@example.com' });
    db.insert('Settings', { Key: 'FamilyName', Value: 'The Rivera Family (demo)' });
    db.insert('Settings', { Key: 'Stores', Value: 'REI and Scheels' });
  }

  // Built on first use, so visitors on a real registry never get demo data saved in their browser.
  var api = null;
  function ready() {
    if (api) return api;
    var env = makeEnv();
    if (!env.db.all('People').length) seed(env);
    api = GR.create(env);
    return api;
  }

  window.GRMockApi = {
    call: function (req) {
      ready();
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(api.handle(JSON.parse(JSON.stringify(req)))); }, 120 + Math.random() * 120);
      });
    },
    reset: function () { localStorage.removeItem(DB_KEY); localStorage.removeItem(PROPS_KEY); }
  };
})();
