/**
 * Family Gift Registry — Apps Script backend.
 *
 * Files in this Apps Script project:
 *   Code.gs         this file: web app entry, Google Sheet database, menu, triggers
 *   Core.gs         paste the contents of apps-script/Core.js (shared logic)
 *   appsscript.json manifest (time zone, scopes, web app settings)
 *
 * Deploy as a web app: Execute as Me, Who has access: Anyone.
 * All access control happens in Core (PIN sessions, admin checks, privacy rule).
 */

var PHOTO_FOLDER_NAME = 'Gift Registry Photos';
/** The shared registry website other families use (they don't need their own copy). */
var SHARED_SITE = 'https://aspen-elevated.github.io/family-gift-registry/';

/* =========================================================================
 * Web app
 * ========================================================================= */

function doGet() {
  return json_({ ok: true, app: 'Family Gift Registry', time: new Date().toISOString() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad request.' }); }
  return json_(api_().handle(req));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function api_() { return GR.create(env_()); }

/* =========================================================================
 * Environment for Core: database, properties, mail, fetch, photos
 * ========================================================================= */

function env_() {
  var props = PropertiesService.getScriptProperties();
  var db = sheetDb_();
  return {
    db: db,
    now: function () { return new Date(); },
    uuid: function () { return Utilities.getUuid(); },
    hash: function (s) {
      return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
        .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
    },
    props: {
      get: function (k) { return props.getProperty(k); },
      set: function (k, v) { props.setProperty(k, v); },
      del: function (k) { props.deleteProperty(k); },
      keys: function () { return props.getKeys(); }
    },
    lock: function (fn) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) throw new Error('The registry is busy saving another change. Please try again in a moment.');
      db.reset(); // re-read anything that changed while we waited for the lock
      try { return fn(); } finally { lock.releaseLock(); }
    },
    mail: function (to, subject, html) {
      var fam = db.find('Settings', 'Key', 'FamilyName');
      MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: ((fam && fam.Value) || 'Family') + ' Gift Registry' });
    },
    fetchUrl: function (url) {
      var r = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true,
        headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }
      });
      return { code: r.getResponseCode(), body: r.getContentText() };
    },
    sleep: function (ms) { Utilities.sleep(ms); },
    queue: function (fn) { ScriptApp.newTrigger(fn).timeBased().after(1000).create(); },
    saveImage: function (dataUrl, name) {
      var m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.*)$/);
      var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name);
      var file = photoFolder_().createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200';
    }
  };
}

function ss_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Run setup first.');
  return SpreadsheetApp.openById(id);
}

function photoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

/* =========================================================================
 * Database: a table layer over the Sheet with a short-term cache.
 *
 * Reading a tab from Google Sheets takes 1–5 seconds; reading the same data
 * from Apps Script's cache takes a few hundredths of a second. Each table is
 * cached under a version token. Every write saves to the Sheet first and then
 * changes the token, so the next request reads fresh data. Manual edits in
 * the Sheet also change the tokens (onSheetChange trigger, or the menu).
 * Every cell is stored as plain text; Core converts numbers and TRUE/FALSE.
 * ========================================================================= */

var CACHED_TABLES = ['Items', 'Links', 'Pledges', 'People', 'Alerts', 'Settings', 'EmailLog'];
var CACHE_TTL = 3600;        // seconds a cached table may live
var CACHE_CHUNK = 30000;     // characters per cache entry (entries are capped at 100 KB)

function sheetDb_(ssIn, cacheIn) {
  var ssObj = ssIn || null;
  var cache = cacheIn !== undefined ? cacheIn : CacheService.getScriptCache();
  var mem = {}, sheets = {}, heads = {}, vers = null;

  function ss() { return ssObj || (ssObj = ss_()); }
  function sheet(t) {
    if (!sheets[t]) {
      sheets[t] = ss().getSheetByName(t);
      if (!sheets[t]) throw new Error('Missing tab "' + t + '". Run setup from the Gift Registry menu.');
    }
    return sheets[t];
  }
  function isCached(t) { return !!cache && CACHED_TABLES.indexOf(t) >= 0; }
  function versions() {
    if (vers) return vers;
    vers = {};
    if (!cache) return vers;
    var got = {};
    try { got = cache.getAll(CACHED_TABLES.map(function (t) { return 'v:' + t; })) || {}; }
    catch (e) { cache = null; return vers; } // cache service unavailable: read straight from the Sheet
    CACHED_TABLES.forEach(function (t) { vers[t] = got['v:' + t] || ''; });
    return vers;
  }
  function newToken() { return Utilities.getUuid().slice(0, 8); }
  function bump(t) {
    if (!isCached(t)) return;
    var v = newToken();
    try { cache.put('v:' + t, v, 21600); } catch (e) { /* cache unavailable: reads fall back to the Sheet */ }
    versions()[t] = v;
  }
  function readSheet(t) {
    var values = sheet(t).getDataRange().getValues();
    var head = values.shift().map(String);
    var rows = values.map(function (r, i) {
      var o = { __row: i + 2 };
      head.forEach(function (k, j) { o[k] = r[j] === '' || r[j] == null ? '' : (r[j] instanceof Date ? r[j].toISOString() : String(r[j])); });
      return o;
    }).filter(function (o) { return head.some(function (k) { return o[k] !== ''; }); });
    return { head: head, rows: rows, fresh: true };
  }
  function load(t, force) {
    if (mem[t] && !force) return mem[t];
    var c = null;
    if (isCached(t) && !force) {
      var v = versions()[t];
      if (v) c = cacheGet_(cache, 't:' + t + ':' + v);
      if (c) c.fresh = false;
    }
    if (!c) {
      c = readSheet(t);
      if (isCached(t)) {
        var v2 = versions()[t];
        if (!v2) { v2 = newToken(); try { cache.put('v:' + t, v2, 21600); } catch (e) { /* ignore */ } vers[t] = v2; }
        cachePut_(cache, 't:' + t + ':' + v2, { head: c.head, rows: c.rows });
      }
    }
    mem[t] = c;
    return c;
  }
  function headOf(t) {
    if (mem[t]) return mem[t].head;
    if (isCached(t)) return load(t).head;
    if (!heads[t]) { var sh = sheet(t); heads[t] = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String); }
    return heads[t];
  }
  function cell(v) {
    if (v == null) return '';
    var s = String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s; // never let user text become a formula
  }
  function rowValues(head, o) { return [head.map(function (k) { return cell(o[k]); })]; }
  function findIn(c, key, val) { return c.rows.filter(function (x) { return String(x[key]) === String(val); })[0] || null; }
  /** Row numbers from the cache can be out of date after a manual edit; confirm before writing. */
  function locate(t, key, val) {
    var c = load(t), r = findIn(c, key, val);
    if (r && !c.fresh) {
      var col = c.head.indexOf(key) + 1;
      var actual = String(sheet(t).getRange(r.__row, col).getValue());
      if (actual !== String(val)) { c = load(t, true); r = findIn(c, key, val); }
    } else if (!r && !c.fresh) { c = load(t, true); r = findIn(c, key, val); }
    return { c: c, r: r };
  }

  return {
    all: function (t) { return load(t).rows.slice(); },
    find: function (t, key, val) { return findIn(load(t), key, val); },
    insert: function (t, o) {
      var head = headOf(t), sh = sheet(t);
      var row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, head.length).setNumberFormat('@').setValues(rowValues(head, o));
      var copy = {}; head.forEach(function (k) { copy[k] = o[k] == null ? '' : String(o[k]); }); copy.__row = row;
      if (mem[t]) mem[t].rows.push(copy);
      bump(t);
      return copy;
    },
    update: function (t, key, val, changes) {
      var x = locate(t, key, val);
      if (!x.r) return null;
      Object.keys(changes).forEach(function (k) { if (x.c.head.indexOf(k) >= 0) x.r[k] = changes[k] == null ? '' : String(changes[k]); });
      sheet(t).getRange(x.r.__row, 1, 1, x.c.head.length).setValues(rowValues(x.c.head, x.r));
      bump(t);
      return x.r;
    },
    remove: function (t, key, val) {
      var x = locate(t, key, val);
      if (!x.r) return false;
      sheet(t).deleteRow(x.r.__row);
      delete mem[t];
      bump(t);
      return true;
    },
    reset: function () { mem = {}; vers = null; },
    clearCache: function () { CACHED_TABLES.forEach(bump); }
  };
}

function cachePut_(cache, key, obj) {
  try {
    var s = JSON.stringify(obj), n = Math.ceil(s.length / CACHE_CHUNK) || 1;
    if (n > 20) return; // too big to cache; it will be read from the Sheet
    var map = {}; map[key] = String(n);
    for (var i = 0; i < n; i++) map[key + ':' + i] = s.substr(i * CACHE_CHUNK, CACHE_CHUNK);
    cache.putAll(map, CACHE_TTL);
  } catch (e) { /* caching is best-effort */ }
}

function cacheGet_(cache, key) {
  try {
    var n = +cache.get(key);
    if (!n) return null;
    var keys = []; for (var i = 0; i < n; i++) keys.push(key + ':' + i);
    var got = cache.getAll(keys), s = '';
    for (i = 0; i < n; i++) { if (got[keys[i]] == null) return null; s += got[keys[i]]; }
    return JSON.parse(s);
  } catch (e) { return null; }
}

/** Installed by setup: any hand edit in the Sheet makes the app re-read it. */
function onSheetChange() { sheetDb_().clearCache(); }

function menuRefreshCache() {
  sheetDb_().clearCache();
  SpreadsheetApp.getUi().alert('Done. The site will show the Sheet\'s current contents.');
}

/* =========================================================================
 * One-time setup and the Sheet menu
 * ========================================================================= */

/** Run once from the Apps Script editor. Safe to run again. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  Object.keys(GR.TABLES).forEach(function (t) {
    var head = GR.TABLES[t];
    var sh = ss.getSheetByName(t) || ss.insertSheet(t);
    var current = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    head.forEach(function (h) { if (current.indexOf(h) < 0) current.push(h); });
    sh.getRange(1, 1, 1, current.length).setValues([current]).setFontWeight('bold')
      .setBackground('#1E3A36').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), current.length).setNumberFormat('@');
  });
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  var db = sheetDb_(ss, null); // no cache during setup
  // Default settings
  var me = Session.getEffectiveUser().getEmail();
  Object.keys(GR.DEFAULT_SETTINGS).forEach(function (k) {
    if (!db.find('Settings', 'Key', k)) db.insert('Settings', { Key: k, Value: k === 'AlertEmails' ? me : GR.DEFAULT_SETTINGS[k] });
  });
  // Triggers: daily price check at ~6 AM, weekly thank-you reminder Monday ~7 AM.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['dailyPriceCheck', 'weeklyThankYous', 'onSheetChange', 'weeklySpotCheck', 'scanPriceEmails'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('weeklySpotCheck').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  ScriptApp.newTrigger('scanPriceEmails').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('dailyPriceCheck').timeBased().everyDays(1).atHour(6).create();
  ScriptApp.newTrigger('weeklyThankYous').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  photoFolder_();
  sheetDb_().clearCache();
  var hasAdmin = db.all('People').some(function (p) { return String(p.Role).toLowerCase() === 'admin'; });
  try {
    if (!hasAdmin) runFamilyWizard_();
    else SpreadsheetApp.getUi().alert('Setup complete.');
  } catch (e) {
    Logger.log('Setup complete. Next, in the Sheet: Gift Registry → Set up our family.');
  }
}

/* =========================================================================
 * "Set up our family" wizard and registry links (for families using the kit)
 * ========================================================================= */

function menuSetupFamily() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('People')) { setup(); return; } // setup runs the wizard
  runFamilyWizard_();
}

function runFamilyWizard_() {
  var ui = SpreadsheetApp.getUi();
  function ask(title, text, required) {
    while (true) {
      var r = ui.prompt(title, text, ui.ButtonSet.OK_CANCEL);
      if (r.getSelectedButton() !== ui.Button.OK) throw new Error('cancelled');
      var v = r.getResponseText().trim();
      if (v || !required) return v;
      ui.alert('This one is needed to continue.');
    }
  }
  function askPin(who, optional) {
    while (true) {
      var v = ask('PIN for ' + who, (optional ? 'Leave blank to skip. ' : '') + '4 to 6 digits. Used to sign in to the registry.', !optional);
      if (!v || /^\d{4,6}$/.test(v)) return v;
      ui.alert('A PIN is 4 to 6 digits.');
    }
  }
  try {
    var api = api_();
    ui.alert('Let\'s set up your registry', 'A few quick questions: your family name, the organizers (usually the parents), the kids, and PINs.\n\nYou can change all of it later from the registry\'s People and Settings pages.', ui.ButtonSet.OK);
    var familyName = ask('Family name', 'Shown at the top of the registry and in emails. For example: The Rivera Family', true);
    var me = Session.getEffectiveUser().getEmail();
    var you = ask('Your first name', 'You\'ll be an organizer: you see who pledged what, add items and record purchases.', true);
    var yourPin = askPin(you, false);
    var partner = ask('Second organizer (optional)', 'Usually your spouse or partner. Leave blank to skip.', false);
    var partnerEmail = partner ? ask(partner + '\'s email (optional)', 'For pledge and price-alert emails. Leave blank to skip.', false) : '';
    var partnerPin = partner ? askPin(partner, false) : '';
    var kids = ask('The kids', 'First names, separated by commas. For example: Maya, Sam', false);
    var kidPin = kids ? askPin('the kids', true) : '';
    var stores = ask('Stores you buy through (optional)', 'Where you have memberships or warranties, for example: REI and Scheels. Shown to givers. Leave blank to skip.', false);
    var parents = [{ name: you, email: me, pin: yourPin }];
    if (partner) parents.push({ name: partner, email: partnerEmail, pin: partnerPin });
    var r = api.setupFamily({ familyName: familyName, parents: parents, kids: kids.split(/\s*,\s*/).filter(String), kidPin: kidPin, stores: stores });
    ui.alert('Your registry is set up',
      'Added: ' + r.added.join(', ') + '.\n\nLast step, publish it so it gets a web address:\n' +
      '1. Extensions → Apps Script\n2. Deploy → New deployment → gear icon → Web app\n3. Execute as: Me. Who has access: Anyone\n4. Deploy, and approve the permissions\n\n' +
      'Then come back here: Gift Registry → Show our registry links.', ui.ButtonSet.OK);
  } catch (e) {
    if (e.message !== 'cancelled') ui.alert(e.message);
  }
}

/** The web app's /exec address, read automatically or asked for once. */
function webAppUrl_() {
  var props = PropertiesService.getScriptProperties();
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  if (/\/exec$/.test(url)) { props.setProperty('WEBAPP_URL', url); return url; }
  url = props.getProperty('WEBAPP_URL') || '';
  if (url) return url;
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Your web app address', 'Paste the Web app URL from Deploy → Manage deployments (it ends in /exec):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return '';
  url = r.getResponseText().trim();
  if (!/^https:\/\/script\.google\.com\/.*\/exec$/.test(url)) { ui.alert('That doesn\'t look like a web app URL. It starts with https://script.google.com and ends in /exec.'); return ''; }
  props.setProperty('WEBAPP_URL', url);
  return url;
}

/** Shows each person's link (with the registry address built in) to copy into an email. */
function menuShowLinks() {
  var url = webAppUrl_();
  if (!url) return;
  var id = (url.match(/\/s\/([^\/]+)\/exec$/) || [])[1];
  var db = sheetDb_();
  var siteRow = db.find('Settings', 'Key', 'SiteURL');
  var base = (siteRow && siteRow.Value ? String(siteRow.Value) : SHARED_SITE).replace(/[?#].*$/, '');
  var familyLink = base + '?api=' + id;
  if (!siteRow || !siteRow.Value) {
    if (siteRow) db.update('Settings', 'Key', 'SiteURL', { Value: familyLink }); else db.insert('Settings', { Key: 'SiteURL', Value: familyLink });
  }
  var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var rows = db.all('People').filter(function (p) { return String(p.Active).toUpperCase() !== 'FALSE' && p.Name; }).map(function (p) {
    var link = base + '?api=' + id + '&k=' + p.LinkToken;
    return '<tr><td style="padding:6px 10px 6px 0;white-space:nowrap"><b>' + esc(p.Name) + '</b><br><span style="color:#888;font-size:11px">' +
      esc(p.Role) + (p.PinHash ? '' : ' · no PIN yet') + '</span></td><td><input readonly onclick="this.select()" style="width:100%;font-size:12px;padding:6px" value="' + esc(link) + '"></td></tr>';
  }).join('');
  var html = '<div style="font-family:Arial,sans-serif;font-size:13px">' +
    '<p>Send each person their own link. It opens the registry with their name picked; they enter their PIN. Send PINs separately (a text works well).</p>' +
    '<p><b>Family link</b> (anyone, they pick their name):<br><input readonly onclick="this.select()" style="width:100%;font-size:12px;padding:6px" value="' + esc(familyLink) + '"></p>' +
    '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' +
    '<p style="color:#888;font-size:11px">Add people later on the registry\'s People page (it has a Copy link button) or with Gift Registry → Add a person.</p></div>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(640).setHeight(520), 'Your registry links');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Gift Registry')
    .addItem('Set up our family', 'menuSetupFamily')
    .addItem('Show our registry links', 'menuShowLinks')
    .addSeparator()
    .addItem('Set or reset a PIN', 'menuSetPin')
    .addItem('Add a person', 'menuAddPerson')
    .addSeparator()
    .addItem('Check prices now', 'menuCheckPrices')
    .addItem('Test store access', 'testStoreAccess')
    .addItem('Read price emails now', 'menuScanEmails')
    .addItem('Send the spot-check email now', 'menuSpotCheck')
    .addSeparator()
    .addItem('Refresh site data after Sheet edits', 'menuRefreshCache')
    .addItem('Sign everyone out', 'menuSignOutAll')
    .addItem('Re-run setup', 'setup')
    .addToUi();
}

function menuSetPin() {
  var ui = SpreadsheetApp.getUi();
  var n = ui.prompt('Set or reset a PIN', 'Person\'s name exactly as on the People tab:', ui.ButtonSet.OK_CANCEL);
  if (n.getSelectedButton() !== ui.Button.OK) return;
  var p = ui.prompt('PIN for ' + n.getResponseText().trim(), '4 to 6 digits:', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  try { api_().setPinDirect(n.getResponseText().trim(), p.getResponseText().trim()); ui.alert('PIN saved.'); }
  catch (e) { ui.alert(e.message); }
}

function menuAddPerson() {
  var ui = SpreadsheetApp.getUi();
  var n = ui.prompt('Add a person', 'Name as it should appear (e.g. "Grandma & Grandpa B"):', ui.ButtonSet.OK_CANCEL);
  if (n.getSelectedButton() !== ui.Button.OK) return;
  var e = ui.prompt('Email for ' + n.getResponseText().trim(), 'For pledge receipts and purchase notices (optional):', ui.ButtonSet.OK_CANCEL);
  if (e.getSelectedButton() !== ui.Button.OK) return;
  var p = ui.prompt('PIN', '4 to 6 digits. Share it with them privately:', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  try {
    api_().addPersonDirect(n.getResponseText().trim(), e.getResponseText().trim(), 'giver', p.getResponseText().trim());
    ui.alert('Added. Their personal link is on the People page in the app.');
  } catch (err) { ui.alert(err.message); }
}

function menuCheckPrices() {
  var r = api_().checkPrices();
  SpreadsheetApp.getUi().alert('Checked ' + r.checked + ' store links.\n\nPrice found: ' + r.ok +
    '\nBlocked by store: ' + r.blocked + '\nNo price on page: ' + r.noPrice + '\nNew alerts: ' + r.alerts +
    (r.skipped ? '\nLeft for the next run (time limit): ' + r.skipped : ''));
}

function menuSignOutAll() {
  api_().signOutAll();
  SpreadsheetApp.getUi().alert('Everyone is signed out.');
}

/* =========================================================================
 * Triggers
 * ========================================================================= */

function dailyPriceCheck() { api_().checkPrices(); }

/** Monday morning: list the items whose stores block automatic checks, with a link to each page. */
function weeklySpotCheck() { api_().spotCheckDigest(); }

/**
 * Hourly: read price-drop emails (Google price tracking, or anything you label "gift-registry-prices")
 * and record the prices on matching registry items. Every email it reads is logged on the EmailLog tab.
 */
function scanPriceEmails() {
  var api = api_();
  var query = api.settings().PriceEmailQuery || GR.DEFAULT_SETTINGS.PriceEmailQuery;
  var msgs = [];
  GmailApp.search(query, 0, 20).forEach(function (t) {
    t.getMessages().forEach(function (m) {
      msgs.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toISOString(), html: m.getBody(), text: m.getPlainBody() });
    });
  });
  return api.ingestPriceEmails(msgs);
}

function menuScanEmails() {
  var r = scanPriceEmails();
  SpreadsheetApp.getUi().alert('Read ' + r.emails + ' new price email' + (r.emails === 1 ? '' : 's') + '. Matched to registry items: ' + r.matched +
    '. Alerts sent: ' + r.alerts + '.\n\nDetails are on the EmailLog tab.');
}

function menuSpotCheck() {
  var n = api_().spotCheckDigest();
  SpreadsheetApp.getUi().alert(n ? 'Sent the spot-check email (' + n + ' items).' : 'Nothing to spot-check: every store link has a fresh price.');
}

/** Runs a price check started from the website ("Check prices now"), then removes its one-time trigger. */
function runQueuedPriceCheck() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runQueuedPriceCheck') ScriptApp.deleteTrigger(t);
  });
  var run = {};
  try { run = JSON.parse(PropertiesService.getScriptProperties().getProperty('PRICE_RUN') || '{}'); } catch (e) { /* ignore */ }
  api_().checkPrices({ itemId: run.itemId || '' });
}
function weeklyThankYous() { api_().thankYouDigest(); }

/* =========================================================================
 * Store access test: can Google's servers read each store?
 * Writes a StoreTest tab. Re-run any time.
 * ========================================================================= */

function testStoreAccess() {
  var env = env_();
  var targets = [
    ['REI', 'https://www.rei.com/'], ['Scheels', 'https://www.scheels.com/'],
    ['Backcountry', 'https://www.backcountry.com/'], ['evo', 'https://www.evo.com/'],
    ['Christy Sports', 'https://www.christysports.com/'], ['NEMO', 'https://www.nemoequipment.com/']
  ];
  sheetDb_().all('Links').forEach(function (l) { targets.push([l.Retailer + ' (item link)', l.URL]); });
  var ss = ss_();
  var sh = ss.getSheetByName('StoreTest') || ss.insertSheet('StoreTest');
  var head = ['Store', 'URL', 'HTTP status', 'Result', 'Price found', 'Seconds', 'Checked'];
  sh.clear();
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  var start = Date.now();
  targets.forEach(function (t, i) {
    var row = i + 2;
    if (Date.now() - start > 300000) { sh.getRange(row, 1, 1, 4).setValues([[t[0], t[1], '', 'Not tested (time limit, run again)']]); return; }
    // Written before asking the store, so if Google stops the script while a store hangs, this row says so.
    sh.getRange(row, 1, 1, 7).setValues([[t[0], t[1], '', 'No response (store hung; Google stopped the test here)', '', '', new Date().toISOString()]]);
    SpreadsheetApp.flush();
    var code = 0, result = '', price = '', t0 = Date.now();
    try {
      var r = env.fetchUrl(t[1]); code = r.code;
      if (code >= 400) result = 'Blocked';
      else {
        var p = GR.parseProduct(r.body, t[1]);
        price = p.price || '';
        result = t[0].indexOf('(item link)') > 0 ? (p.price ? 'Works' : 'Loads, no price') : 'Reachable';
      }
    } catch (e) { result = /timeout|timed out/i.test(e.message) ? 'No response (blocked)' : 'Error: ' + e.message; }
    sh.getRange(row, 1, 1, 7).setValues([[t[0], t[1], code, result, price, Math.round((Date.now() - t0) / 1000), new Date().toISOString()]]);
    SpreadsheetApp.flush();
    Utilities.sleep(400);
  });
  sh.autoResizeColumns(1, head.length);
  try { SpreadsheetApp.getUi().alert('Store test done. See the StoreTest tab.'); } catch (e) { /* run from editor */ }
}
