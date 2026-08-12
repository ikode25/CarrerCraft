/**
 * ============================================================================
 *  DATA BUNDLE STORE — Google Apps Script backend
 * ============================================================================
 *  A self-serve storefront where customers buy MTN / Telecel / AirtelTigo
 *  data bundles, and a private admin portal (username + password login,
 *  default admin / admin123 — change it immediately) where you set your own
 *  selling prices, fulfill orders through Geosam's Send Bundle API, and
 *  track profit.
 *
 *  Note: Geosam's API has no endpoint to look up bundle sizes/prices — you
 *  enter your own base prices manually (see the Pricing tab), matching what
 *  you see in your Geosam dashboard/shop.
 *
 *  Note: the storefront hero carousel stores uploaded images in a Google
 *  Drive folder ("Data Bundle Store - Carousel Images") — the first upload
 *  will prompt you to re-authorize the project for Drive access.
 *
 *  SETUP (see README.md for the full walkthrough):
 *   1. Create a new Google Sheet.
 *   2. Extensions > Apps Script. Delete the default code.
 *   3. Create this file as "Code.gs" and paste this content.
 *   4. Create an HTML file named "index" and paste index.html's content.
 *   5. Run `setupSheets` once from the editor (top toolbar ▶) to create
 *      the Packages / Orders tabs, seed starter pricing, and set up the
 *      default admin login (admin / admin123).
 *   6. Deploy > New deployment > Web app.
 *        Execute as:  Me
 *        Who has access: Anyone
 *   7. Open the deployed URL, go to ?page=admin, and log in with
 *      admin / admin123. Go straight to the Account tab and change both.
 *   8. In the admin API Settings tab, paste your Geosam API token, flip
 *      API Mode to "Live", and click "Test connection".
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. CONFIG / CONSTANTS
// ---------------------------------------------------------------------------

// Bump this string with every release. It's shown in the storefront footer
// and the admin sidebar so you can tell, at a glance, whether a redeploy
// actually picked up the latest code (Apps Script only serves new code to
// the live /exec URL after Deploy > Manage deployments > Edit > New version
// > Deploy — saving the file alone is not enough).
var APP_VERSION = 'v1.8.0';

var SHEET_PACKAGES = 'Packages';
var SHEET_ORDERS = 'Orders';
var SHEET_CAROUSEL = 'Carousel';

// 'IdataghPackageId' is iDataGH's own numeric package identifier (from their
// GET /packages endpoint) — required to place an order through iDataGH,
// separate from AmountMB (which is all Geosam needs). Populated by
// "Sync from iDataGH" in the Pricing tab, or set manually.
var PACKAGE_HEADERS = ['ID', 'Network', 'Size', 'Validity', 'AmountMB', 'BasePrice', 'SellingPrice', 'Active', 'LastUpdated', 'IdataghPackageId'];
// 'Provider' records which data provider (geosam/idatagh) actually
// fulfilled the order, so a status check always polls the right one even
// if you switch providers afterward. Blank on old rows written before
// multi-provider support — treated as 'geosam' (the original default).
var ORDER_HEADERS = ['OrderID', 'Timestamp', 'CustomerName', 'RecipientPhone', 'PayerPhone', 'Network', 'Size', 'SellingPrice', 'BasePrice', 'Profit', 'MoMoRef', 'Status', 'ProviderRef', 'Notes', 'UpdatedAt', 'Provider'];
var CAROUSEL_HEADERS = ['ID', 'Url', 'Caption', 'Order', 'Active', 'FileId', 'UploadedAt'];

var NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];

// Geosam's API refers to AirtelTigo as "AT"; MTN and Telecel match our own names.
var GEOSAM_NETWORK_CODE = { MTN: 'MTN', Telecel: 'Telecel', AirtelTigo: 'AT' };
// iDataGH uses lowercase network names ("mtn", "telecel", "airteltigo").
var IDATAGH_NETWORK_CODE = { MTN: 'mtn', Telecel: 'telecel', AirtelTigo: 'airteltigo' };

var ORDER_STATUS = {
  PENDING: 'Pending Payment',
  PAID: 'Paid - Awaiting Fulfillment',
  PROCESSING: 'Processing',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled'
};

var DEFAULT_SETTINGS = {
  STORE_NAME: 'My Data Store',
  STORE_TAGLINE: 'Fast, affordable data bundles — delivered in minutes.',
  WHATSAPP_NUMBER: '',
  MOMO_NUMBER: '',
  MOMO_NAME: '',
  CURRENCY_SYMBOL: 'GH₵',

  // Which data provider fulfills orders right now. Both providers' credentials
  // are kept saved at all times, so switching is instant if one is down.
  DATA_PROVIDER: 'geosam', // 'geosam' | 'idatagh'

  GEOSAM_API_BASE: 'https://www.geosams.com',
  GEOSAM_API_KEY: '',
  GEOSAM_MODE: 'mock', // 'mock' | 'live'

  // iDataGH adapter is a placeholder until real API docs are provided —
  // see the IDATAGH ADAPTER section below.
  IDATAGH_API_BASE: 'https://idatagh.com',
  IDATAGH_API_KEY: '',
  IDATAGH_MODE: 'mock', // 'mock' | 'live'

  // Customer-facing chat assistant. Works out of the box in 'mock' mode
  // (rule-based FAQ answers built from your live store settings); 'live'
  // mode calls Google's Gemini API with an API key you provide.
  AI_MODE: 'mock', // 'mock' | 'live'
  AI_API_KEY: '',

  // Live status banner shown as a scrolling ticker on the storefront.
  BANNER_ENABLED: 'true',
  BANNER_STATUS: 'good',   // 'good' | 'delayed' | 'down'
  BANNER_MESSAGE: '',      // custom text; blank = auto-generated from BANNER_STATUS
  MTN_DELIVERY_TIME: '10-30 mins',
  TELECEL_DELIVERY_TIME: '',
  AIRTELTIGO_DELIVERY_TIME: '',

  // System color — the rest of the palette (hover/dark shades) is derived
  // from these two on the client, so the admin only picks two colors.
  THEME_PRIMARY: '#0f2747',
  THEME_ACCENT: '#ffc93c'
};

var BANNER_STATUS_DEFAULTS = {
  good: 'Network is good — orders are going through smoothly!',
  delayed: 'Network is a bit slow right now — deliveries may take longer than usual.',
  down: 'Network issues right now — deliveries may be delayed. Sorry for the inconvenience!'
};

/** Builds the final banner text + status shown on the storefront. */
function composeBanner_(s) {
  if (s.BANNER_ENABLED !== 'true') return { enabled: false };
  var status = ['good', 'delayed', 'down'].indexOf(s.BANNER_STATUS) === -1 ? 'good' : s.BANNER_STATUS;
  var message = (s.BANNER_MESSAGE || '').trim() || BANNER_STATUS_DEFAULTS[status];

  var etas = [];
  if (s.MTN_DELIVERY_TIME) etas.push('MTN: ' + s.MTN_DELIVERY_TIME);
  if (s.TELECEL_DELIVERY_TIME) etas.push('Telecel: ' + s.TELECEL_DELIVERY_TIME);
  if (s.AIRTELTIGO_DELIVERY_TIME) etas.push('AirtelTigo: ' + s.AIRTELTIGO_DELIVERY_TIME);

  var text = message + (etas.length ? '  ·  Delivery time — ' + etas.join('  ·  ') : '');
  return { enabled: true, status: status, text: text };
}

// ---------------------------------------------------------------------------
// 2. WEB APP ENTRY POINT
// ---------------------------------------------------------------------------

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'store';
  var tmpl = HtmlService.createTemplateFromFile('index');
  tmpl.initialPage = page === 'admin' ? 'admin' : 'store';
  tmpl.appUrl = ScriptApp.getService().getUrl();

  return tmpl.evaluate()
    .setTitle(getSetting_('STORE_NAME') || DEFAULT_SETTINGS.STORE_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------------------
// 3. AUTH HELPERS
// ---------------------------------------------------------------------------
// Admin login is a classic username + password form (not tied to a Google
// account), so the admin portal works the same for anyone with the
// credentials, in any browser. Default credentials are admin / admin123 —
// change them immediately from the admin Account tab.
//
// Sessions are opaque tokens the client stores (localStorage) and sends
// back as the first argument to every admin-only function. Tokens live in
// CacheService (sliding 6-hour expiry, renewed on each authenticated call).
// ---------------------------------------------------------------------------

var SESSION_TTL_SECONDS = 21600; // 6 hours — CacheService's own maximum

function ensureAdminCredentials_() {
  if (getSetting_('ADMIN_USERNAME') && getSetting_('ADMIN_PASSWORD_HASH')) return;
  var salt = Utilities.getUuid();
  setSetting_('ADMIN_USERNAME', getSetting_('ADMIN_USERNAME') || 'admin');
  setSetting_('ADMIN_PASSWORD_SALT', salt);
  setSetting_('ADMIN_PASSWORD_HASH', hashPassword_('admin123', salt));
}

function hashPassword_(password, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b).toString(16)).padStart(2, '0'); }).join('');
}

/** Client-callable (public). Logs in with the admin username/email + password, returns a session token. */
function adminLogin(identifier, password) {
  ensureAdminCredentials_();
  Utilities.sleep(300); // small fixed delay to blunt brute-force guessing
  var username = getSetting_('ADMIN_USERNAME');
  var salt = getSetting_('ADMIN_PASSWORD_SALT');
  var hash = getSetting_('ADMIN_PASSWORD_HASH');

  if (String(identifier || '').trim().toLowerCase() !== username.toLowerCase() || hashPassword_(String(password || ''), salt) !== hash) {
    return { success: false, message: 'Incorrect username/email or password.' };
  }

  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('session_' + token, '1', SESSION_TTL_SECONDS);
  return { success: true, token: token, username: username };
}

function isValidAdminSession_(token) {
  if (!token) return false;
  var cache = CacheService.getScriptCache();
  var key = 'session_' + token;
  if (!cache.get(key)) return false;
  cache.put(key, '1', SESSION_TTL_SECONDS); // sliding expiry
  return true;
}

function requireAdminSession_(token) {
  if (!isValidAdminSession_(token)) {
    throw new Error('ACCESS_DENIED: Your session has expired. Please log in again.');
  }
}

/** Client-callable. */
function adminLogout(token) {
  if (token) CacheService.getScriptCache().remove('session_' + token);
  return { success: true };
}

/**
 * Client-callable (admin only). Changes the admin username and/or password.
 * Requires the current password to confirm the change.
 */
function changeAdminCredentials(token, payload) {
  requireAdminSession_(token);
  payload = payload || {};
  var salt = getSetting_('ADMIN_PASSWORD_SALT');
  var hash = getSetting_('ADMIN_PASSWORD_HASH');
  if (hashPassword_(String(payload.currentPassword || ''), salt) !== hash) {
    throw new Error('Current password is incorrect.');
  }

  var newUsername = String(payload.newUsername || '').trim();
  if (newUsername) setSetting_('ADMIN_USERNAME', newUsername);

  var newPassword = String(payload.newPassword || '');
  if (newPassword) {
    if (newPassword.length < 6) throw new Error('New password must be at least 6 characters.');
    var newSalt = Utilities.getUuid();
    setSetting_('ADMIN_PASSWORD_SALT', newSalt);
    setSetting_('ADMIN_PASSWORD_HASH', hashPassword_(newPassword, newSalt));
  }
  return { success: true, username: getSetting_('ADMIN_USERNAME') };
}

// ---------------------------------------------------------------------------
// 4. SETUP / SHEET HELPERS
// ---------------------------------------------------------------------------

function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function sheetRowsToObjects_(sheet, headers) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue; // skip blank rows
    var obj = { _row: i + 2 };
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
    out.push(obj);
  }
  return out;
}

/**
 * Run this once from the Apps Script editor (or via the spreadsheet menu)
 * to create the Packages / Orders sheets and seed starter pricing so the
 * store isn't empty on day one. Verify/adjust base prices before going live.
 */
function setupSheets() {
  getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var ordersSheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  getSheet_(SHEET_CAROUSEL, CAROUSEL_HEADERS);
  seedMockPackagesIfEmpty_();
  ensureAdminCredentials_();

  // Force the phone columns to stay plain text so Sheets never silently
  // reinterprets "0244000000" as the number 244000000 (dropping the
  // leading zero, which breaks order tracking). Safe to re-run any time.
  ['RecipientPhone', 'PayerPhone'].forEach(function (col) {
    var idx = ORDER_HEADERS.indexOf(col) + 1;
    ordersSheet.getRange(1, idx, 2000, 1).setNumberFormat('@');
  });

  return 'Sheets are ready. Admin login: admin / admin123 (change it in the Account tab).';
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Data Bundle Store')
    .addItem('Initialize / repair sheets', 'setupSheets')
    .addItem('Re-seed starter pricing (only if Packages is empty)', 'seedMockPackagesIfEmpty_')
    .addToUi();
}

// ---------------------------------------------------------------------------
// 5. SETTINGS
// ---------------------------------------------------------------------------

function getSetting_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null ? (DEFAULT_SETTINGS[key] || '') : v;
}

function setSetting_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value === undefined || value === null ? '' : String(value));
}

function getRawBannerSettings_() {
  return {
    BANNER_ENABLED: getSetting_('BANNER_ENABLED'),
    BANNER_STATUS: getSetting_('BANNER_STATUS'),
    BANNER_MESSAGE: getSetting_('BANNER_MESSAGE'),
    MTN_DELIVERY_TIME: getSetting_('MTN_DELIVERY_TIME'),
    TELECEL_DELIVERY_TIME: getSetting_('TELECEL_DELIVERY_TIME'),
    AIRTELTIGO_DELIVERY_TIME: getSetting_('AIRTELTIGO_DELIVERY_TIME')
  };
}

function getPublicSettings_() {
  return {
    storeName: getSetting_('STORE_NAME'),
    tagline: getSetting_('STORE_TAGLINE'),
    whatsapp: getSetting_('WHATSAPP_NUMBER'),
    momoNumber: getSetting_('MOMO_NUMBER'),
    momoName: getSetting_('MOMO_NAME'),
    currency: getSetting_('CURRENCY_SYMBOL'),
    banner: composeBanner_(getRawBannerSettings_()),
    themePrimary: getSetting_('THEME_PRIMARY'),
    themeAccent: getSetting_('THEME_ACCENT'),
    logoUrl: getLogoUrl_()
  };
}

/** Client-callable (admin only). */
function getAdminSettings(token) {
  requireAdminSession_(token);
  return getAdminSettings_();
}

function getAdminSettings_() {
  var banner = getRawBannerSettings_();
  return {
    storeName: getSetting_('STORE_NAME'),
    tagline: getSetting_('STORE_TAGLINE'),
    whatsapp: getSetting_('WHATSAPP_NUMBER'),
    momoNumber: getSetting_('MOMO_NUMBER'),
    momoName: getSetting_('MOMO_NAME'),
    currency: getSetting_('CURRENCY_SYMBOL'),
    adminUsername: getSetting_('ADMIN_USERNAME'),
    dataProvider: getSetting_('DATA_PROVIDER') || 'geosam',
    geosamApiBase: getSetting_('GEOSAM_API_BASE'),
    geosamApiKeySet: !!getSetting_('GEOSAM_API_KEY'),
    geosamMode: getSetting_('GEOSAM_MODE'),
    idataghApiBase: getSetting_('IDATAGH_API_BASE'),
    idataghApiKeySet: !!getSetting_('IDATAGH_API_KEY'),
    idataghMode: getSetting_('IDATAGH_MODE'),
    aiMode: getSetting_('AI_MODE'),
    aiApiKeySet: !!getSetting_('AI_API_KEY'),
    bannerEnabled: banner.BANNER_ENABLED === 'true',
    bannerStatus: banner.BANNER_STATUS || 'good',
    bannerMessage: banner.BANNER_MESSAGE,
    mtnDeliveryTime: banner.MTN_DELIVERY_TIME,
    telecelDeliveryTime: banner.TELECEL_DELIVERY_TIME,
    airtelTigoDeliveryTime: banner.AIRTELTIGO_DELIVERY_TIME,
    bannerPreview: composeBanner_(banner),
    themePrimary: getSetting_('THEME_PRIMARY'),
    themeAccent: getSetting_('THEME_ACCENT'),
    logoUrl: getLogoUrl_()
  };
}

/** Client-callable (admin only). `settings` is a partial object of DEFAULT_SETTINGS keys. */
function saveAdminSettings(token, settings) {
  requireAdminSession_(token);
  var editable = [
    'STORE_NAME', 'STORE_TAGLINE', 'WHATSAPP_NUMBER', 'MOMO_NUMBER', 'MOMO_NAME', 'CURRENCY_SYMBOL',
    'DATA_PROVIDER', 'GEOSAM_API_BASE', 'GEOSAM_MODE', 'IDATAGH_API_BASE', 'IDATAGH_MODE', 'AI_MODE',
    'BANNER_ENABLED', 'BANNER_STATUS', 'BANNER_MESSAGE',
    'MTN_DELIVERY_TIME', 'TELECEL_DELIVERY_TIME', 'AIRTELTIGO_DELIVERY_TIME',
    'THEME_PRIMARY', 'THEME_ACCENT'
  ];
  editable.forEach(function (key) {
    if (settings.hasOwnProperty(key)) setSetting_(key, settings[key]);
  });
  // Checkbox fields aren't submitted at all when unchecked, so treat a
  // missing BANNER_ENABLED as explicitly "off" rather than leaving the
  // previous value in place.
  setSetting_('BANNER_ENABLED', settings.BANNER_ENABLED === 'true' ? 'true' : 'false');
  // API keys only overwritten if a non-empty value was actually submitted,
  // so re-saving a settings form doesn't blank out an already-saved key.
  if (settings.GEOSAM_API_KEY) setSetting_('GEOSAM_API_KEY', settings.GEOSAM_API_KEY);
  if (settings.IDATAGH_API_KEY) setSetting_('IDATAGH_API_KEY', settings.IDATAGH_API_KEY);
  if (settings.AI_API_KEY) setSetting_('AI_API_KEY', settings.AI_API_KEY);
  return getAdminSettings_();
}

// ---------------------------------------------------------------------------
// 6. PACKAGES
// ---------------------------------------------------------------------------

function packageId_(network, size) {
  return (network + '-' + size).toUpperCase().replace(/\s+/g, '');
}

function getAllPackages_() {
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  return sheetRowsToObjects_(sheet, PACKAGE_HEADERS);
}

/** Client-callable (public). Only active packages, no base price / profit exposed. */
function getStorefrontPackages() {
  var packages = getAllPackages_().filter(function (p) { return p.Active === true || p.Active === 'TRUE'; });
  var byNetwork = {};
  NETWORKS.forEach(function (n) { byNetwork[n] = []; });
  packages.forEach(function (p) {
    if (!byNetwork[p.Network]) byNetwork[p.Network] = [];
    byNetwork[p.Network].push({
      id: p.ID,
      size: p.Size,
      validity: p.Validity,
      price: Number(p.SellingPrice) || 0
    });
  });
  Object.keys(byNetwork).forEach(function (n) {
    byNetwork[n].sort(function (a, b) { return a.price - b.price; });
  });
  return byNetwork;
}

/** Client-callable (admin only). Full data including base price / profit. */
function getAdminPackages(token) {
  requireAdminSession_(token);
  return getAdminPackages_();
}

// google.script.run has been unreliable about returning raw Date objects
// from server functions — in some cases the whole response silently comes
// back as null on the client instead of a catchable error. Every
// client-facing function converts dates to ISO strings before returning.
function toIsoString_(v) {
  if (!v) return '';
  try {
    var d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  } catch (e) {
    return '';
  }
}

function getAdminPackages_() {
  return getAllPackages_().map(function (p) {
    var base = Number(p.BasePrice) || 0;
    var selling = Number(p.SellingPrice) || 0;
    return {
      id: p.ID,
      network: p.Network,
      size: p.Size,
      validity: p.Validity,
      amountMB: Number(p.AmountMB) || 0,
      basePrice: base,
      sellingPrice: selling,
      profit: selling - base,
      active: p.Active === true || p.Active === 'TRUE',
      lastUpdated: toIsoString_(p.LastUpdated),
      idataghPackageId: p.IdataghPackageId || ''
    };
  });
}

function findPackageRow_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return -1;
}

/** Client-callable (admin only). Update the selling price for one package. */
function savePackageSellingPrice(token, id, sellingPrice) {
  requireAdminSession_(token);
  var price = Number(sellingPrice);
  if (isNaN(price) || price <= 0) throw new Error('Enter a valid selling price.');

  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var row = findPackageRow_(sheet, id);
  if (row === -1) throw new Error('Package not found.');

  var basePrice = Number(sheet.getRange(row, PACKAGE_HEADERS.indexOf('BasePrice') + 1).getValue()) || 0;
  if (price <= basePrice) {
    throw new Error('Selling price must be higher than the base price (GH₵' + basePrice.toFixed(2) + ').');
  }
  sheet.getRange(row, PACKAGE_HEADERS.indexOf('SellingPrice') + 1).setValue(price);
  return { success: true };
}

/** Client-callable (admin only). Show/hide a package on the storefront. */
function togglePackageActive(token, id, active) {
  requireAdminSession_(token);
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var row = findPackageRow_(sheet, id);
  if (row === -1) throw new Error('Package not found.');
  sheet.getRange(row, PACKAGE_HEADERS.indexOf('Active') + 1).setValue(!!active);
  return { success: true };
}

/**
 * Client-callable (admin only). Adds a package to your store.
 * Geosam's API has no endpoint to look up bundle prices or sizes — you set
 * these based on what you see in your Geosam dashboard/shop. `amountMB` is
 * the exact volume Geosam will send (e.g. 1000 for "1GB", 2000 for "2GB"),
 * used directly in the Send Bundle API call.
 */
function addManualPackage(token, pkg) {
  requireAdminSession_(token);
  if (NETWORKS.indexOf(pkg.network) === -1) throw new Error('Unknown network.');
  if (!pkg.size) throw new Error('Size is required.');
  var amountMB = Number(pkg.amountMB) || 0;
  if (amountMB <= 0) throw new Error('Enter the data amount in MB (e.g. 1000 for 1GB) — this is sent to Geosam exactly as entered.');
  var basePrice = Number(pkg.basePrice) || 0;
  var sellingPrice = Number(pkg.sellingPrice) || 0;
  if (sellingPrice <= basePrice) throw new Error('Selling price must be higher than the base price.');

  var id = packageId_(pkg.network, pkg.size);
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  if (findPackageRow_(sheet, id) !== -1) throw new Error('A package with that network + size already exists.');

  sheet.appendRow([
    id, pkg.network, pkg.size, pkg.validity || '', amountMB, basePrice, sellingPrice, true, new Date(), pkg.idataghPackageId || ''
  ]);
  return { success: true, id: id };
}

/** Client-callable (admin only). */
function deletePackage(token, id) {
  requireAdminSession_(token);
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var row = findPackageRow_(sheet, id);
  if (row === -1) throw new Error('Package not found.');
  sheet.deleteRow(row);
  return { success: true };
}

/**
 * Geosam's API does not expose a bundle price list (it only sends bundles
 * and reports status/balance — see the GEOSAM ADAPTER section below), so
 * there is no "sync pricing from Geosam" feature. STARTER_PACKAGES below is
 * just a template of common bundle sizes to seed your sheet with on first
 * run, with base prices you MUST verify against your actual Geosam
 * dashboard/shop pricing before going live — edit or delete rows in the
 * Pricing tab (or the Packages sheet directly) as needed.
 */
var STARTER_PACKAGES = {
  MTN: [
    ['1GB', 1000, 4.15], ['2GB', 2000, 8.30], ['3GB', 3000, 12.45], ['4GB', 4000, 16.60], ['5GB', 5000, 20.75],
    ['6GB', 6000, 24.90], ['8GB', 8000, 33.20], ['10GB', 10000, 41.50], ['15GB', 15000, 62.25], ['20GB', 20000, 83.00]
  ],
  Telecel: [
    ['1GB', 1000, 4.50], ['2GB', 2000, 9.00], ['3GB', 3000, 13.00], ['5GB', 5000, 21.00], ['7GB', 7000, 28.50],
    ['10GB', 10000, 40.00], ['15GB', 15000, 58.00], ['20GB', 20000, 75.00]
  ],
  AirtelTigo: [
    ['1GB', 1000, 4.00], ['2GB', 2000, 7.80], ['3GB', 3000, 11.50], ['5GB', 5000, 19.00], ['10GB', 10000, 37.00],
    ['15GB', 15000, 54.00], ['20GB', 20000, 70.00]
  ]
};

function seedMockPackagesIfEmpty_() {
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  if (sheet.getLastRow() >= 2) return 'Packages already has data — skipped.';
  NETWORKS.forEach(function (network) {
    (STARTER_PACKAGES[network] || []).forEach(function (row) {
      var size = row[0], amountMB = row[1], basePrice = row[2];
      var id = packageId_(network, size);
      var sellingPrice = Math.ceil((basePrice * 1.15) * 100) / 100; // +15% starting markup
      sheet.appendRow([id, network, size, '30 Days', amountMB, basePrice, sellingPrice, true, new Date()]);
    });
  });
  return 'Seeded starter pricing for ' + NETWORKS.join(', ') + '. Verify base prices against your real Geosam pricing before going live.';
}

// ---------------------------------------------------------------------------
// 6b. CAROUSEL (storefront hero images)
// ---------------------------------------------------------------------------
// Uploaded images are stored in a Google Drive folder ("Data Bundle Store -
// Carousel Images"), shared "anyone with the link can view", and referenced
// by URL from the Carousel sheet. The first time you upload an image, Apps
// Script will prompt you to re-authorize the project for Drive access.
// ---------------------------------------------------------------------------

var CAROUSEL_FOLDER_NAME = 'Data Bundle Store - Carousel Images';
var MAX_CAROUSEL_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

function getCarouselFolder_() {
  var it = DriveApp.getFoldersByName(CAROUSEL_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CAROUSEL_FOLDER_NAME);
}

function getAllCarousel_() {
  var sheet = getSheet_(SHEET_CAROUSEL, CAROUSEL_HEADERS);
  var rows = sheetRowsToObjects_(sheet, CAROUSEL_HEADERS);
  rows.sort(function (a, b) { return (Number(a.Order) || 0) - (Number(b.Order) || 0); });
  return rows;
}

/** Client-callable (public). Active images only, in display order. */
// Always derive the URL from the stored Drive file ID rather than trusting
// whatever was saved at upload time — this means fixing the URL format
// here instantly repairs images uploaded before that fix, no re-upload
// needed.
function carouselImageUrl_(c) {
  return c.FileId ? ('https://drive.google.com/thumbnail?id=' + c.FileId + '&sz=w1600') : c.Url;
}

function getCarouselImages_() {
  return getAllCarousel_()
    .filter(function (c) { return c.Active === true || c.Active === 'TRUE'; })
    .map(function (c) { return { id: c.ID, url: carouselImageUrl_(c), caption: c.Caption }; });
}

function getAdminCarousel_() {
  return getAllCarousel_().map(function (c) {
    return { id: c.ID, url: carouselImageUrl_(c), caption: c.Caption, active: c.Active === true || c.Active === 'TRUE' };
  });
}

/** Client-callable (admin only). */
function getAdminCarouselImages(token) {
  requireAdminSession_(token);
  return getAdminCarousel_();
}

/**
 * Client-callable (admin only). payload: { dataUrl, caption, fileName }
 * dataUrl is a base64 data: URL from a <input type="file"> read via
 * FileReader.readAsDataURL() on the client.
 */
function uploadCarouselImage(token, payload) {
  requireAdminSession_(token);
  payload = payload || {};
  var match = /^data:(image\/[a-zA-Z0-9+.\-]+);base64,(.+)$/.exec(payload.dataUrl || '');
  if (!match) throw new Error('That doesn\'t look like an image file. Please choose a JPG, PNG, or WebP image.');

  var mimeType = match[1];
  var bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_CAROUSEL_IMAGE_BYTES) {
    throw new Error('Image is too large (max 5MB). Please compress it and try again.');
  }

  var blob = Utilities.newBlob(bytes, mimeType, payload.fileName || 'carousel-image');
  var folder = getCarouselFolder_();
  var file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    file.setTrashed(true);
    throw new Error('Could not make this photo publicly viewable (your Drive/Workspace sharing policy may block "anyone with the link"). Ask your Google Workspace admin to allow external link sharing, or use a personal Google account for this project.');
  }
  // drive.google.com/uc?export=view frequently fails to render inline (shows
  // a "can't preview" page instead) — the /thumbnail endpoint is the
  // reliable way to hotlink a Drive image directly into an <img> tag.
  var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1600';

  var sheet = getSheet_(SHEET_CAROUSEL, CAROUSEL_HEADERS);
  var existing = getAllCarousel_();
  var nextOrder = existing.reduce(function (max, c) { return Math.max(max, Number(c.Order) || 0); }, 0) + 1;
  var id = 'CAR-' + Utilities.getUuid().split('-')[0].toUpperCase();

  sheet.appendRow([id, url, String(payload.caption || '').trim(), nextOrder, true, file.getId(), new Date()]);
  return { success: true, id: id, url: url };
}

/** Client-callable (admin only). Show/hide an image on the storefront carousel. */
function toggleCarouselActive(token, id, active) {
  requireAdminSession_(token);
  var sheet = getSheet_(SHEET_CAROUSEL, CAROUSEL_HEADERS);
  var row = findRowById_(sheet, CAROUSEL_HEADERS, id);
  if (row === -1) throw new Error('Image not found.');
  sheet.getRange(row, CAROUSEL_HEADERS.indexOf('Active') + 1).setValue(!!active);
  return { success: true };
}

/** Client-callable (admin only). Removes the image from the carousel and trashes the Drive file. */
function deleteCarouselImage(token, id) {
  requireAdminSession_(token);
  var sheet = getSheet_(SHEET_CAROUSEL, CAROUSEL_HEADERS);
  var row = findRowById_(sheet, CAROUSEL_HEADERS, id);
  if (row === -1) throw new Error('Image not found.');
  var fileId = sheet.getRange(row, CAROUSEL_HEADERS.indexOf('FileId') + 1).getValue();
  sheet.deleteRow(row);
  if (fileId) {
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* file already gone — fine */ }
  }
  return { success: true };
}

function findRowById_(sheet, headers, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 6c. BUSINESS LOGO
// ---------------------------------------------------------------------------
// Same Drive-backed pattern as the carousel, but a single image rather than
// a list — replacing it trashes the old file.
// ---------------------------------------------------------------------------

/**
 * Client-callable (admin only). payload: { dataUrl, fileName } — same
 * base64 data: URL shape as uploadCarouselImage().
 */
function uploadLogo(token, payload) {
  requireAdminSession_(token);
  payload = payload || {};
  var match = /^data:(image\/[a-zA-Z0-9+.\-]+);base64,(.+)$/.exec(payload.dataUrl || '');
  if (!match) throw new Error('That doesn\'t look like an image file. Please choose a JPG, PNG, or WebP image.');

  var mimeType = match[1];
  var bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_CAROUSEL_IMAGE_BYTES) {
    throw new Error('Image is too large (max 5MB). Please compress it and try again.');
  }

  var blob = Utilities.newBlob(bytes, mimeType, payload.fileName || 'store-logo');
  var folder = getCarouselFolder_();
  var file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    file.setTrashed(true);
    throw new Error('Could not make this logo publicly viewable (your Drive/Workspace sharing policy may block "anyone with the link").');
  }

  var oldFileId = getSetting_('LOGO_FILE_ID');
  if (oldFileId) {
    try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) { /* already gone — fine */ }
  }

  setSetting_('LOGO_FILE_ID', file.getId());
  return { success: true, url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w300' };
}

/** Client-callable (admin only). Reverts to the default icon logo. */
function removeLogo(token) {
  requireAdminSession_(token);
  var oldFileId = getSetting_('LOGO_FILE_ID');
  if (oldFileId) {
    try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) { /* already gone — fine */ }
  }
  setSetting_('LOGO_FILE_ID', '');
  return { success: true };
}

function getLogoUrl_() {
  var fileId = getSetting_('LOGO_FILE_ID');
  return fileId ? ('https://drive.google.com/thumbnail?id=' + fileId + '&sz=w300') : '';
}

// ---------------------------------------------------------------------------
// 7. GEOSAM ADAPTER
// ---------------------------------------------------------------------------
// Based on Geosam's published API docs (https://geosams.com/controller/api-documentation/):
//  - Auth header is "Authorization: Token <api_token>" (NOT "Bearer").
//  - There is no endpoint to list bundle sizes/prices — Send Bundle just
//    takes a network + phone number + a data amount in MB you already know.
//    That's why base prices in the Pricing tab are entered manually.
//  - Send Bundle is asynchronous: HTTP 200 + code "200" only means the
//    request was accepted ("...is being processed"), not that it delivered.
//    We move the order to "Processing" and you (or "Check Geosam Status")
//    poll Transaction Detail to confirm it completed.
//  - Geosam always replies HTTP 200, even for logical errors — the real
//    result is in the JSON body's "code"/"message" fields, so we check
//    those rather than the HTTP status for business logic.
// ---------------------------------------------------------------------------

var GEOSAM_ENDPOINTS = {
  sendBundle: '/controller/api/send_bundle/',
  transactionDetail: '/controller/api/transaction_detail/', // + <reference>/
  transactions: '/controller/api/transactions/',
  accountStatus: '/controller/api/account/status/'
};

function geosamRequest_(path, method, payload) {
  var base = getSetting_('GEOSAM_API_BASE') || 'https://www.geosams.com';
  var key = getSetting_('GEOSAM_API_KEY');
  if (!key) {
    throw new Error('Geosam API key is not set yet. Add it in API Settings, or keep API Mode set to "Mock" while you test the store.');
  }
  var options = {
    method: method || 'get',
    contentType: 'application/json',
    headers: { 'Authorization': 'Token ' + key },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  var response = UrlFetchApp.fetch(base.replace(/\/$/, '') + path, options);
  var httpCode = response.getResponseCode();
  var body = response.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { /* leave null */ }

  if (httpCode < 200 || httpCode >= 300) {
    throw new Error('Geosam API error (HTTP ' + httpCode + '): ' + (parsed && parsed.message ? parsed.message : body));
  }
  if (parsed === null) {
    throw new Error('Geosam API returned a non-JSON response: ' + body.substring(0, 200));
  }
  return parsed;
}

/**
 * Places the actual bundle purchase with Geosam once an order has been
 * marked Paid by the admin. `order` needs Network, RecipientPhone,
 * AmountMB, and a Reference (unique per attempt — see fulfillOrder()).
 * Returns { success, status, providerRef, message }.
 * In 'mock' mode, simulates acceptance so the admin flow can be tested
 * end to end before the real API is connected.
 */
function buyGeosamBundle_(order) {
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return {
      success: true,
      status: 'Processing',
      providerRef: order.Reference,
      message: 'Simulated: bundle request accepted (Geosam API Mode is set to Mock).'
    };
  }

  var networkCode = GEOSAM_NETWORK_CODE[order.Network] || order.Network;
  var res = geosamRequest_(GEOSAM_ENDPOINTS.sendBundle, 'post', {
    phone_number: order.RecipientPhone,
    amount: Number(order.AmountMB),
    reference: order.Reference,
    network: networkCode
  });

  if (String(res.code) === '200') {
    return { success: true, status: 'Processing', providerRef: order.Reference, message: res.message || 'Bundle request received and is being processed.' };
  }
  return { success: false, status: 'Failed', providerRef: order.Reference, message: res.message || 'Geosam rejected the request.' };
}

/**
 * Polls Geosam for the current status of a previously-submitted bundle
 * request. In 'mock' mode, simulates immediate completion.
 * Returns Geosam's raw transaction object: { status, message, ... }.
 */
function checkGeosamTransactionStatus_(reference) {
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return { status: 'Completed', message: 'Simulated: bundle delivered (Mock mode).' };
  }
  return geosamRequest_(GEOSAM_ENDPOINTS.transactionDetail + encodeURIComponent(reference) + '/', 'get');
}

function getGeosamWalletBalance_() {
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return { success: false, message: 'API Mode is set to Mock — switch to Live to check your real Geosam wallet balance.' };
  }
  try {
    var res = geosamRequest_(GEOSAM_ENDPOINTS.accountStatus, 'get');
    return {
      success: true,
      isActive: !!res.is_account_active,
      user: res.user,
      balances: {
        MTN: (res.balances && res.balances.mtn_bundle_balance) || '0',
        Telecel: (res.balances && res.balances.telecel_bundle_balance) || '0',
        AirtelTigo: (res.balances && res.balances.at_bundle_balance) || '0'
      }
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function testGeosamConnection_() {
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return { success: false, message: 'Geosam API Mode is set to Mock — switch to Live to test the real connection.' };
  }
  var result = getGeosamWalletBalance_();
  if (!result.success) return result;
  if (!result.isActive) {
    return { success: false, message: 'Connected, but your Geosam API account is not approved/active yet (signed in as ' + result.user + ').' };
  }
  return { success: true, message: 'Connected as ' + result.user + '. Balances — MTN: ' + result.balances.MTN + ', Telecel: ' + result.balances.Telecel + ', AirtelTigo: ' + result.balances.AirtelTigo + '.' };
}

// ---------------------------------------------------------------------------
// 7b. IDATAGH ADAPTER
// ---------------------------------------------------------------------------
// Based on iDataGH's published API docs (https://idatagh.com/api-documentation/):
//  - Auth: "Authorization: Bearer <api_key>" + "Content-Type: application/json".
//  - Unlike Geosam, iDataGH DOES expose a package list per network (GET
//    /packages) — each package has its own numeric package_id, which is
//    required (not a data-in-MB amount) to place an order. That ID is
//    stored per package as IdataghPackageId, filled in by "Sync from
//    iDataGH" in the Pricing tab.
//  - Place Order returns iDataGH's own order_id — that becomes this order's
//    ProviderRef for later status checks (iDataGH doesn't accept a
//    client-supplied idempotency reference the way Geosam does).
//  - iDataGH's wallet balance is a single overall figure, not split by
//    network like Geosam's.
// ---------------------------------------------------------------------------

var IDATAGH_ENDPOINTS = {
  placeOrder: '/wp-json/custom/v1/place-order',
  orderStatus: '/wp-json/custom/v1/order-status', // ?order_id=
  walletBalance: '/wp-json/custom/v1/wallet-balance',
  packages: '/wp-json/custom/v1/packages' // ?network=mtn|telecel|airteltigo
};

function idataghRequest_(path, method, payload) {
  var base = getSetting_('IDATAGH_API_BASE') || 'https://idatagh.com';
  var key = getSetting_('IDATAGH_API_KEY');
  if (!key) {
    throw new Error('iDataGH API key is not set yet. Add it in API Settings, or keep iDataGH Mode set to "Mock" while you test the store.');
  }
  var options = {
    method: method || 'get',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + key },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  var response = UrlFetchApp.fetch(base.replace(/\/$/, '') + path, options);
  var httpCode = response.getResponseCode();
  var body = response.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { /* leave null */ }

  if (httpCode < 200 || httpCode >= 300) {
    throw new Error('iDataGH API error (HTTP ' + httpCode + '): ' + (parsed && parsed.message ? parsed.message : body));
  }
  if (parsed === null) {
    throw new Error('iDataGH API returned a non-JSON response: ' + body.substring(0, 200));
  }
  return parsed;
}

function buyIdataghBundle_(order) {
  var mode = getSetting_('IDATAGH_MODE') || 'mock';
  if (mode !== 'live') {
    return {
      success: true,
      status: 'Processing',
      providerRef: order.Reference,
      message: 'Simulated: bundle request accepted (iDataGH Mode is set to Mock).'
    };
  }
  if (!order.IdataghPackageId) {
    return {
      success: false,
      status: 'Failed',
      providerRef: '',
      message: 'This package has no iDataGH package ID. Go to Pricing and click "Sync from iDataGH" for ' + order.Network + ' (or set the ID manually).'
    };
  }
  var networkCode = IDATAGH_NETWORK_CODE[order.Network] || String(order.Network).toLowerCase();
  var res = idataghRequest_(IDATAGH_ENDPOINTS.placeOrder, 'post', {
    network: networkCode,
    beneficiary: order.RecipientPhone,
    'pa_data-bundle-packages': Number(order.IdataghPackageId)
  });
  var ok = res.status === 'success';
  return {
    success: ok,
    status: ok ? 'Processing' : 'Failed',
    // iDataGH assigns its own order_id — that's what we poll later, not our locally-generated reference.
    providerRef: ok ? String(res.order_id) : '',
    message: ok ? ('Order placed (iDataGH order #' + res.order_id + ').') : (res.message || 'iDataGH rejected the request.')
  };
}

function checkIdataghTransactionStatus_(reference) {
  var mode = getSetting_('IDATAGH_MODE') || 'mock';
  if (mode !== 'live') {
    return { status: 'Completed', message: 'Simulated: bundle delivered (Mock mode).' };
  }
  var res = idataghRequest_(IDATAGH_ENDPOINTS.orderStatus + '?order_id=' + encodeURIComponent(reference), 'get');
  if (res.status !== 'success') {
    return { status: 'Failed', message: res.message || 'iDataGH could not find this order.' };
  }
  // order_status seen in their docs: "Completed" — other values (Pending/Processing/Failed
  // etc.) aren't documented; anything not "Completed" is treated as still processing
  // by the caller, so this is safe either way.
  return { status: res.order_status || 'Processing', message: 'iDataGH order #' + res.order_id + ' — ' + (res.order_status || 'Processing') + (res.amount != null ? ' (GH₵' + res.amount + ')' : '') + '.' };
}

function getIdataghWalletBalance_() {
  var mode = getSetting_('IDATAGH_MODE') || 'mock';
  if (mode !== 'live') {
    return { success: false, message: 'iDataGH Mode is set to Mock — switch to Live to check your real wallet balance.' };
  }
  try {
    var res = idataghRequest_(IDATAGH_ENDPOINTS.walletBalance, 'get');
    if (res.status !== 'success') return { success: false, message: 'Could not retrieve balance.' };
    // Single overall balance (not split by network like Geosam's) — the
    // admin UI renders whatever keys are present in `balances` generically.
    return { success: true, balances: { Overall: 'GH₵' + Number(res.balance).toFixed(2) } };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function testIdataghConnection_() {
  var result = getIdataghWalletBalance_();
  if (!result.success) return result;
  return { success: true, message: 'Connected. Wallet balance: ' + result.balances.Overall + '.' };
}

/**
 * Returns [{ packageId, size, amountMB, basePrice }, ...] for a network,
 * straight from iDataGH's live package list.
 */
function fetchIdataghPackages_(network) {
  var networkCode = IDATAGH_NETWORK_CODE[network] || String(network).toLowerCase();
  var res = idataghRequest_(IDATAGH_ENDPOINTS.packages + '?network=' + encodeURIComponent(networkCode), 'get');
  // iDataGH's own docs show this response oddly double-wrapped (an object
  // nested inside another set of braces) — handle both shapes defensively.
  var payload = Array.isArray(res) ? res[0] : res;
  var list = (payload && payload.packages) || [];
  return list.map(function (p) {
    var sizeGb = Number(p.data_size) || 0;
    return {
      packageId: p.package_id,
      size: sizeGb + 'GB',
      amountMB: Math.round(sizeGb * 1000),
      basePrice: Number(p.price) || 0
    };
  });
}

/**
 * Client-callable (admin only). Pulls iDataGH's real package list + prices
 * for a network and upserts them into your Packages sheet (matched by
 * network + size). Unlike Geosam, iDataGH DOES expose live pricing, so this
 * overwrites BasePrice for matched packages — if you also sell through
 * Geosam, re-check prices there after syncing since the two providers may
 * cost differently. New packages get a starting +15% markup, same as the
 * initial starter pricing.
 */
function syncIdataghPackages(token, network) {
  requireAdminSession_(token);
  if (NETWORKS.indexOf(network) === -1) throw new Error('Unknown network.');

  var fetched = fetchIdataghPackages_(network);
  if (!fetched.length) throw new Error('iDataGH returned no packages for ' + network + '.');

  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var existing = getAllPackages_();
  var col = {
    base: PACKAGE_HEADERS.indexOf('BasePrice') + 1,
    mb: PACKAGE_HEADERS.indexOf('AmountMB') + 1,
    idatagh: PACKAGE_HEADERS.indexOf('IdataghPackageId') + 1,
    updated: PACKAGE_HEADERS.indexOf('LastUpdated') + 1
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    fetched.forEach(function (item) {
      var id = packageId_(network, item.size);
      var match = existing.filter(function (p) { return p.ID === id; })[0];
      if (match) {
        sheet.getRange(match._row, col.base).setValue(item.basePrice);
        sheet.getRange(match._row, col.mb).setValue(item.amountMB);
        sheet.getRange(match._row, col.idatagh).setValue(item.packageId);
        sheet.getRange(match._row, col.updated).setValue(new Date());
      } else {
        var sellingPrice = Math.ceil((item.basePrice * 1.15) * 100) / 100;
        sheet.appendRow([id, network, item.size, '30 Days', item.amountMB, item.basePrice, sellingPrice, true, new Date(), item.packageId]);
      }
    });
  } finally {
    lock.releaseLock();
  }
  return getAdminPackages_().filter(function (p) { return p.network === network; });
}

// ---------------------------------------------------------------------------
// 7c. PROVIDER DISPATCH — routes to whichever provider is currently
// selected (or, for status checks, whichever provider actually fulfilled
// that specific order — see Provider column on the Orders sheet).
// ---------------------------------------------------------------------------

function buyBundle_(provider, order) {
  return provider === 'idatagh' ? buyIdataghBundle_(order) : buyGeosamBundle_(order);
}

function checkTransactionStatus_(provider, reference) {
  return provider === 'idatagh' ? checkIdataghTransactionStatus_(reference) : checkGeosamTransactionStatus_(reference);
}

function getProviderWalletBalance_(provider) {
  return provider === 'idatagh' ? getIdataghWalletBalance_() : getGeosamWalletBalance_();
}

/** Client-callable (admin only). Wallet balance for whichever provider is currently selected. */
function getProviderWalletBalance(token) {
  requireAdminSession_(token);
  return getProviderWalletBalance_(getSetting_('DATA_PROVIDER') || 'geosam');
}

/** Client-callable (admin only). "Test connection" — a safe, read-only check against the currently selected provider. */
function testProviderConnection(token) {
  requireAdminSession_(token);
  var provider = getSetting_('DATA_PROVIDER') || 'geosam';
  return provider === 'idatagh' ? testIdataghConnection_() : testGeosamConnection_();
}

// ---------------------------------------------------------------------------
// 8. ORDERS
// ---------------------------------------------------------------------------

function generateOrderId_() {
  var datePart = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'yyMMdd');
  var randPart = Utilities.getUuid().split('-')[0].substring(0, 4).toUpperCase();
  return 'DBS-' + datePart + '-' + randPart;
}

function isValidGhPhone_(phone) {
  return /^0\d{9}$/.test(String(phone || '').trim());
}

// Google Sheets can silently reinterpret a digit string like "0244000000"
// as the NUMBER 244000000 (dropping the leading zero) if a cell isn't
// explicitly formatted as text. That broke order tracking — a customer's
// correctly-typed phone number would never match the corrupted stored
// value. This recovers a stripped leading zero on read, so tracking works
// regardless of how the cell got formatted.
function normalizePhone_(v) {
  var digits = String(v == null ? '' : v).replace(/\D/g, '');
  if (digits.length === 9) digits = '0' + digits;
  return digits;
}

/**
 * Client-callable (public). Creates a new order in "Pending Payment"
 * status. Price and network are always re-derived server-side from the
 * Packages sheet — the client's submitted price is never trusted.
 */
function submitOrder(payload) {
  payload = payload || {};
  if (!payload.customerName || String(payload.customerName).trim().length < 2) {
    throw new Error('Enter your name.');
  }
  if (!isValidGhPhone_(payload.recipientPhone)) {
    throw new Error('Enter a valid recipient phone number, e.g. 0244000000.');
  }
  if (!isValidGhPhone_(payload.payerPhone)) {
    throw new Error('Enter a valid MoMo number you paid from, e.g. 0244000000.');
  }
  if (!payload.momoRef || String(payload.momoRef).trim().length < 3) {
    throw new Error('Enter the Transaction ID from your Mobile Money payment confirmation.');
  }
  if (!payload.packageId) {
    throw new Error('Choose a data bundle.');
  }

  var packages = getAllPackages_();
  var pkg = packages.filter(function (p) { return p.ID === payload.packageId; })[0];
  if (!pkg || !(pkg.Active === true || pkg.Active === 'TRUE')) {
    throw new Error('That package is no longer available. Please refresh and choose again.');
  }

  var basePrice = Number(pkg.BasePrice) || 0;
  var sellingPrice = Number(pkg.SellingPrice) || 0;
  var orderId = generateOrderId_();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
    sheet.appendRow([
      orderId,
      new Date(),
      String(payload.customerName).trim(),
      String(payload.recipientPhone).trim(),
      String(payload.payerPhone).trim(),
      pkg.Network,
      pkg.Size,
      sellingPrice,
      basePrice,
      sellingPrice - basePrice,
      String(payload.momoRef).trim(),
      ORDER_STATUS.PENDING,
      '',
      '',
      new Date(),
      ''
    ]);
  } finally {
    lock.releaseLock();
  }

  return {
    success: true,
    orderId: orderId,
    network: pkg.Network,
    size: pkg.Size,
    amount: sellingPrice
  };
}

/** Client-callable (public). Lets a customer look up their own order. */
function getOrderStatusForCustomer(orderId, phone) {
  var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  var orders = sheetRowsToObjects_(sheet, ORDER_HEADERS);
  var wantedId = String(orderId || '').trim().toUpperCase();
  var wantedPhone = normalizePhone_(phone);
  var order = orders.filter(function (o) {
    return String(o.OrderID || '').trim().toUpperCase() === wantedId && normalizePhone_(o.RecipientPhone) === wantedPhone;
  })[0];
  if (!order) throw new Error('No order found with that reference and phone number.');
  return {
    orderId: order.OrderID,
    network: order.Network,
    size: order.Size,
    amount: order.SellingPrice,
    status: order.Status,
    timestamp: toIsoString_(order.Timestamp)
  };
}

function getAllOrders_() {
  var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  return sheetRowsToObjects_(sheet, ORDER_HEADERS);
}

/** Client-callable (admin only). Most recent first, optionally filtered by status. */
function getAdminOrders(token, statusFilter) {
  requireAdminSession_(token);
  return getAdminOrders_(statusFilter);
}

function getAdminOrders_(statusFilter) {
  var orders = getAllOrders_();
  if (statusFilter && statusFilter !== 'All') {
    orders = orders.filter(function (o) { return o.Status === statusFilter; });
  }
  orders.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });
  return orders.map(function (o) {
    return {
      id: o.OrderID,
      timestamp: toIsoString_(o.Timestamp),
      customerName: o.CustomerName,
      recipientPhone: normalizePhone_(o.RecipientPhone),
      payerPhone: normalizePhone_(o.PayerPhone),
      network: o.Network,
      size: o.Size,
      sellingPrice: Number(o.SellingPrice) || 0,
      basePrice: Number(o.BasePrice) || 0,
      profit: Number(o.Profit) || 0,
      momoRef: o.MoMoRef,
      status: o.Status,
      geosamOrderId: o.ProviderRef,
      provider: o.Provider || 'geosam',
      notes: o.Notes
    };
  });
}

function findOrderRow_(sheet, orderId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === orderId) return i + 2;
  }
  return -1;
}

function setOrderStatus_(orderId, status, extra) {
  var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  var row = findOrderRow_(sheet, orderId);
  if (row === -1) throw new Error('Order not found.');
  sheet.getRange(row, ORDER_HEADERS.indexOf('Status') + 1).setValue(status);
  sheet.getRange(row, ORDER_HEADERS.indexOf('UpdatedAt') + 1).setValue(new Date());
  if (extra && extra.providerRef !== undefined) {
    sheet.getRange(row, ORDER_HEADERS.indexOf('ProviderRef') + 1).setValue(extra.providerRef);
  }
  if (extra && extra.provider !== undefined) {
    sheet.getRange(row, ORDER_HEADERS.indexOf('Provider') + 1).setValue(extra.provider);
  }
  if (extra && extra.notes !== undefined) {
    sheet.getRange(row, ORDER_HEADERS.indexOf('Notes') + 1).setValue(extra.notes);
  }
  return row;
}

/** Client-callable (admin only). Mark payment as confirmed after checking your MoMo statement. */
function markOrderPaid(token, orderId) {
  requireAdminSession_(token);
  setOrderStatus_(orderId, ORDER_STATUS.PAID);
  return { success: true };
}

/**
 * Client-callable (admin only). Sends the order to Geosam for fulfillment.
 * Success only means Geosam accepted the request (it's async) — the order
 * moves to "Processing" and you use checkOrderGeosamStatus() to confirm
 * delivery. A fresh reference is generated on every attempt so retrying a
 * failed order never collides with a previous Geosam reference.
 */
function fulfillOrder(token, orderId) {
  requireAdminSession_(token);
  var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  var row = findOrderRow_(sheet, orderId);
  if (row === -1) throw new Error('Order not found.');

  var values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0];
  var order = {};
  ORDER_HEADERS.forEach(function (h, i) { order[h] = values[i]; });

  var pkg = getAllPackages_().filter(function (p) { return p.Network === order.Network && p.Size === order.Size; })[0];
  if (!pkg || !(Number(pkg.AmountMB) > 0)) {
    throw new Error('No matching package with a data amount (MB) found for ' + order.Network + ' ' + order.Size + '. Check the Pricing tab.');
  }
  order.AmountMB = pkg.AmountMB;
  order.IdataghPackageId = pkg.IdataghPackageId;
  order.Reference = orderId + '-F' + Utilities.getUuid().split('-')[0].toUpperCase();

  var provider = getSetting_('DATA_PROVIDER') || 'geosam';
  var result = buyBundle_(provider, order);

  if (result.success) {
    setOrderStatus_(orderId, ORDER_STATUS.PROCESSING, { providerRef: result.providerRef, notes: result.message, provider: provider });
  } else {
    setOrderStatus_(orderId, ORDER_STATUS.FAILED, { providerRef: result.providerRef, notes: result.message, provider: provider });
  }
  return result;
}

/**
 * Client-callable (admin only). Polls Geosam for an order that's been sent
 * (status "Processing") and updates it to Delivered/Failed based on the
 * real transaction status. Safe to click more than once.
 */
function checkOrderGeosamStatus(token, orderId) {
  requireAdminSession_(token);
  var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  var row = findOrderRow_(sheet, orderId);
  if (row === -1) throw new Error('Order not found.');

  var values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0];
  var order = {};
  ORDER_HEADERS.forEach(function (h, i) { order[h] = values[i]; });

  if (!order.ProviderRef) {
    throw new Error('This order has not been submitted to a data provider yet.');
  }
  var provider = order.Provider || 'geosam'; // orders fulfilled before multi-provider support default to geosam

  var tx = checkTransactionStatus_(provider, order.ProviderRef);
  var status = String(tx.status || '').toLowerCase();

  if (status === 'completed') {
    setOrderStatus_(orderId, ORDER_STATUS.DELIVERED, { notes: tx.message || 'Confirmed delivered.' });
    return { status: ORDER_STATUS.DELIVERED, message: tx.message };
  }
  if (status === 'failed' || status === 'error') {
    setOrderStatus_(orderId, ORDER_STATUS.FAILED, { notes: tx.message || 'Provider reported this transaction failed.' });
    return { status: ORDER_STATUS.FAILED, message: tx.message };
  }
  setOrderStatus_(orderId, ORDER_STATUS.PROCESSING, { notes: tx.message || ('Provider status: ' + (tx.status || 'pending')) });
  return { status: ORDER_STATUS.PROCESSING, message: tx.message || 'Still processing — check again shortly.' };
}

/** Client-callable (admin only). */
function markOrderDelivered(token, orderId) {
  requireAdminSession_(token);
  setOrderStatus_(orderId, ORDER_STATUS.DELIVERED);
  return { success: true };
}

/** Client-callable (admin only). */
function markOrderFailed(token, orderId, reason) {
  requireAdminSession_(token);
  setOrderStatus_(orderId, ORDER_STATUS.FAILED, { notes: reason || '' });
  return { success: true };
}

/** Client-callable (admin only). */
function cancelOrder(token, orderId) {
  requireAdminSession_(token);
  setOrderStatus_(orderId, ORDER_STATUS.CANCELLED);
  return { success: true };
}

// ---------------------------------------------------------------------------
// 8b. AI ASSISTANT (customer-facing chat widget)
// ---------------------------------------------------------------------------
// Works out of the box with zero setup: 'mock' mode uses simple keyword
// matching against your live store settings (pricing, delivery times,
// payment, WhatsApp contact) so answers are always accurate even without
// any AI configured. Optionally switch to 'live' mode with a free Gemini
// API key (https://aistudio.google.com/apikey) for real generative replies.
// ---------------------------------------------------------------------------

function buildAssistantContext_() {
  var s = getPublicSettings_();
  var lines = [];
  lines.push('Store name: ' + s.storeName);
  if (s.tagline) lines.push('Tagline: ' + s.tagline);
  if (s.whatsapp) lines.push('WhatsApp contact: ' + s.whatsapp);
  if (s.momoNumber) lines.push('Mobile Money payments accepted to: ' + s.momoNumber + (s.momoName ? ' (' + s.momoName + ')' : ''));
  if (s.banner && s.banner.text) lines.push('Current network/delivery status: ' + s.banner.text);
  var packages = getStorefrontPackages();
  NETWORKS.forEach(function (n) {
    var list = packages[n] || [];
    if (list.length) {
      lines.push(n + ' bundles available from ' + s.currency + list[0].price.toFixed(2) + ' (' + list[0].size + ') up to ' + list[list.length - 1].size + '.');
    }
  });
  return lines.join('\n');
}

var ASSISTANT_FAQ = [
  { keywords: ['price', 'cost', 'how much', 'rate', 'ghc', 'ghs'], reply: function (ctx) { return 'Here\'s our current pricing:\n' + ctx; } },
  { keywords: ['deliver', 'how long', 'time', 'fast', 'slow', 'wait'], reply: function (ctx, s) { return (s.banner && s.banner.text) ? s.banner.text : 'Delivery is usually quick after your payment is confirmed.'; } },
  { keywords: ['pay', 'momo', 'mobile money', 'transaction id'], reply: function (ctx, s) { return s.momoNumber ? ('Send payment to ' + s.momoNumber + (s.momoName ? ' (' + s.momoName + ')' : '') + ', then submit your order with the Transaction ID from your MoMo confirmation SMS.') : 'Choose a bundle on the store and follow the on-screen payment instructions.'; } },
  { keywords: ['track', 'status of my order', 'where is my order', 'order status'], reply: function () { return 'Tap the search icon at the top of the store to track your order using your order reference and phone number.'; } },
  { keywords: ['human', 'agent', 'support', 'talk to', 'complain', 'problem', 'issue', 'not working'], reply: function (ctx, s) { return s.whatsapp ? ('I\'ll connect you with a real person — message us on WhatsApp: https://wa.me/' + s.whatsapp) : 'Please use the contact options on the store page to reach us directly.'; } },
  { keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon'], reply: function (ctx, s) { return 'Hi! I\'m the ' + s.storeName + ' assistant. Ask me about pricing, delivery times, payment, or tracking an order.'; } }
];

function ruleBasedAssistantReply_(message) {
  var s = getPublicSettings_();
  var ctx = buildAssistantContext_();
  var lower = String(message || '').toLowerCase();
  for (var i = 0; i < ASSISTANT_FAQ.length; i++) {
    var faq = ASSISTANT_FAQ[i];
    for (var k = 0; k < faq.keywords.length; k++) {
      if (lower.indexOf(faq.keywords[k]) !== -1) return faq.reply(ctx, s);
    }
  }
  return 'I can help with pricing, delivery times, payment instructions, and order tracking.' +
    (s.whatsapp ? (' For anything else, message us on WhatsApp: https://wa.me/' + s.whatsapp) : ' For anything else, please use the contact options on the store.');
}

function geminiRequest_(systemPrompt, turns) {
  var key = getSetting_('AI_API_KEY');
  if (!key) throw new Error('AI API key is not set.');
  var model = 'gemini-2.0-flash'; // adjust here if Google renames/retires this model
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
  var options = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: turns
    })
  };
  var response = UrlFetchApp.fetch(url, options);
  var httpCode = response.getResponseCode();
  var body = response.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { /* leave null */ }
  if (httpCode < 200 || httpCode >= 300 || !parsed) {
    throw new Error('AI request failed (HTTP ' + httpCode + '): ' + body.substring(0, 200));
  }
  var text = parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content &&
    parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text;
  if (!text) throw new Error('AI returned an empty response.');
  return text.trim();
}

/**
 * Client-callable (public). `history` is [{role:'user'|'assistant', text}],
 * most recent last, used only in Live mode for conversational context.
 * Always falls back to the rule-based FAQ responder if AI Mode isn't Live
 * with a valid key, or if the live call fails for any reason — the chat
 * widget should never just break.
 */
function askAssistant(message, history) {
  message = String(message || '').trim();
  if (!message) throw new Error('Type a question first.');
  if (message.length > 500) message = message.substring(0, 500);

  var mode = getSetting_('AI_MODE') || 'mock';
  if (mode === 'live' && getSetting_('AI_API_KEY')) {
    try {
      var systemPrompt =
        'You are a friendly, concise customer support assistant for "' + getSetting_('STORE_NAME') + '", a Ghanaian data bundle reselling store. ' +
        'Only answer questions about this store — its bundles, pricing, delivery, and payment. Keep replies under 80 words, no markdown. ' +
        'Store facts:\n' + buildAssistantContext_();
      var turns = (history || []).slice(-8).map(function (h) {
        return { role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(h.text || '').substring(0, 500) }] };
      });
      turns.push({ role: 'user', parts: [{ text: message }] });
      return { reply: geminiRequest_(systemPrompt, turns), ai: true };
    } catch (err) {
      return { reply: ruleBasedAssistantReply_(message), ai: false, fallbackReason: err.message };
    }
  }
  return { reply: ruleBasedAssistantReply_(message), ai: false };
}

/** Client-callable (admin only). "Test connection" for the AI assistant. */
function testAiConnection(token) {
  requireAdminSession_(token);
  var mode = getSetting_('AI_MODE') || 'mock';
  if (mode !== 'live') {
    return { success: false, message: 'AI Mode is set to Mock — the assistant is using the built-in FAQ responder. Switch to Live and add a Gemini API key to test it.' };
  }
  try {
    var reply = geminiRequest_('You are a connection test. Reply with exactly: OK', [{ role: 'user', parts: [{ text: 'ping' }] }]);
    return { success: true, message: 'Connected. Gemini replied: "' + reply + '"' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// 9. DASHBOARD STATS
// ---------------------------------------------------------------------------

/** Client-callable (admin only). */
function getDashboardStats(token) {
  requireAdminSession_(token);
  return getDashboardStats_();
}

function getDashboardStats_() {
  var orders = getAllOrders_();
  var counted = orders.filter(function (o) {
    return o.Status === ORDER_STATUS.PAID || o.Status === ORDER_STATUS.PROCESSING || o.Status === ORDER_STATUS.DELIVERED;
  });

  var totalSales = counted.reduce(function (sum, o) { return sum + (Number(o.SellingPrice) || 0); }, 0);
  var totalProfit = counted.reduce(function (sum, o) { return sum + (Number(o.Profit) || 0); }, 0);
  var pendingCount = orders.filter(function (o) { return o.Status === ORDER_STATUS.PENDING; }).length;
  var deliveredCount = orders.filter(function (o) { return o.Status === ORDER_STATUS.DELIVERED; }).length;

  var tz = Session.getScriptTimeZone() || 'GMT';
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var todayOrders = orders.filter(function (o) {
    return Utilities.formatDate(new Date(o.Timestamp), tz, 'yyyy-MM-dd') === todayStr;
  });

  // Last 14 days of sales/profit, oldest first, for the dashboard trend chart.
  var days = [];
  for (var i = 13; i >= 0; i--) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    days.push(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
  }
  var byDay = {};
  days.forEach(function (d) { byDay[d] = { date: d, sales: 0, profit: 0 }; });
  counted.forEach(function (o) {
    var d = Utilities.formatDate(new Date(o.Timestamp), tz, 'yyyy-MM-dd');
    if (byDay[d]) {
      byDay[d].sales += Number(o.SellingPrice) || 0;
      byDay[d].profit += Number(o.Profit) || 0;
    }
  });
  var salesTrend = days.map(function (d) { return byDay[d]; });

  return {
    totalSales: totalSales,
    totalProfit: totalProfit,
    pendingCount: pendingCount,
    deliveredCount: deliveredCount,
    totalOrders: orders.length,
    ordersToday: todayOrders.length,
    salesTrend: salesTrend
  };
}

// ---------------------------------------------------------------------------
// 10. BOOTSTRAP APIS (single round-trip payloads for each view)
// ---------------------------------------------------------------------------

/** Client-callable (public). Everything the storefront needs in one call. */
function getStoreBootstrap() {
  return {
    appVersion: APP_VERSION,
    settings: getPublicSettings_(),
    packagesByNetwork: getStorefrontPackages(),
    carousel: getCarouselImages_(),
    networks: NETWORKS
  };
}

/**
 * Client-callable (public — deliberately does not throw on a bad/missing
 * token, so the client can tell "not logged in" apart from a real error and
 * show the login form instead of an error screen).
 */
function getAdminBootstrap(token) {
  ensureAdminCredentials_();
  if (!isValidAdminSession_(token)) {
    return { authorized: false, appVersion: APP_VERSION };
  }
  // Wrapped defensively: google.script.run has been known to hand the
  // client a bare `null` instead of a catchable error if anything in this
  // payload fails to serialize cleanly. Returning a real object with a
  // readable `bootstrapError` here — instead of letting an exception
  // propagate — means the admin UI always has something to react to.
  try {
    return {
      authorized: true,
      appVersion: APP_VERSION,
      settings: getAdminSettings_(),
      packages: getAdminPackages_(),
      orders: getAdminOrders_(),
      stats: getDashboardStats_(),
      carousel: getAdminCarousel_(),
      networks: NETWORKS,
      orderStatuses: ORDER_STATUS
    };
  } catch (err) {
    return { authorized: false, appVersion: APP_VERSION, bootstrapError: err.message };
  }
}
