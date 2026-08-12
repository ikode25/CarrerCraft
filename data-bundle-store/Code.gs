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
var APP_VERSION = 'v1.6.0';

var SHEET_PACKAGES = 'Packages';
var SHEET_ORDERS = 'Orders';
var SHEET_CAROUSEL = 'Carousel';

var PACKAGE_HEADERS = ['ID', 'Network', 'Size', 'Validity', 'AmountMB', 'BasePrice', 'SellingPrice', 'Active', 'LastUpdated'];
var ORDER_HEADERS = ['OrderID', 'Timestamp', 'CustomerName', 'RecipientPhone', 'PayerPhone', 'Network', 'Size', 'SellingPrice', 'BasePrice', 'Profit', 'MoMoRef', 'Status', 'GeosamOrderId', 'Notes', 'UpdatedAt'];
var CAROUSEL_HEADERS = ['ID', 'Url', 'Caption', 'Order', 'Active', 'FileId', 'UploadedAt'];

var NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];

// Geosam's API refers to AirtelTigo as "AT"; MTN and Telecel match our own names.
var GEOSAM_NETWORK_CODE = { MTN: 'MTN', Telecel: 'Telecel', AirtelTigo: 'AT' };

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
  GEOSAM_API_BASE: 'https://www.geosams.com',
  GEOSAM_API_KEY: '',
  GEOSAM_MODE: 'mock', // 'mock' | 'live'

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
  getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  getSheet_(SHEET_CAROUSEL, CAROUSEL_HEADERS);
  seedMockPackagesIfEmpty_();
  ensureAdminCredentials_();
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
    themeAccent: getSetting_('THEME_ACCENT')
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
    geosamApiBase: getSetting_('GEOSAM_API_BASE'),
    geosamApiKeySet: !!getSetting_('GEOSAM_API_KEY'),
    geosamMode: getSetting_('GEOSAM_MODE'),
    bannerEnabled: banner.BANNER_ENABLED === 'true',
    bannerStatus: banner.BANNER_STATUS || 'good',
    bannerMessage: banner.BANNER_MESSAGE,
    mtnDeliveryTime: banner.MTN_DELIVERY_TIME,
    telecelDeliveryTime: banner.TELECEL_DELIVERY_TIME,
    airtelTigoDeliveryTime: banner.AIRTELTIGO_DELIVERY_TIME,
    bannerPreview: composeBanner_(banner),
    themePrimary: getSetting_('THEME_PRIMARY'),
    themeAccent: getSetting_('THEME_ACCENT')
  };
}

/** Client-callable (admin only). `settings` is a partial object of DEFAULT_SETTINGS keys. */
function saveAdminSettings(token, settings) {
  requireAdminSession_(token);
  var editable = [
    'STORE_NAME', 'STORE_TAGLINE', 'WHATSAPP_NUMBER', 'MOMO_NUMBER', 'MOMO_NAME', 'CURRENCY_SYMBOL',
    'GEOSAM_API_BASE', 'GEOSAM_MODE',
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
  // API key only overwritten if a non-empty value was actually submitted,
  // so re-saving the settings form doesn't blank it out.
  if (settings.GEOSAM_API_KEY) setSetting_('GEOSAM_API_KEY', settings.GEOSAM_API_KEY);
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
      lastUpdated: toIsoString_(p.LastUpdated)
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
    id, pkg.network, pkg.size, pkg.validity || '', amountMB, basePrice, sellingPrice, true, new Date()
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
function getCarouselImages_() {
  return getAllCarousel_()
    .filter(function (c) { return c.Active === true || c.Active === 'TRUE'; })
    .map(function (c) { return { id: c.ID, url: c.Url, caption: c.Caption }; });
}

function getAdminCarousel_() {
  return getAllCarousel_().map(function (c) {
    return { id: c.ID, url: c.Url, caption: c.Caption, active: c.Active === true || c.Active === 'TRUE' };
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
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = 'https://drive.google.com/uc?export=view&id=' + file.getId();

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
 * Returns { success, status, geosamRef, message }.
 * In 'mock' mode, simulates acceptance so the admin flow can be tested
 * end to end before the real API is connected.
 */
function buyGeosamBundle_(order) {
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return {
      success: true,
      status: 'Processing',
      geosamRef: order.Reference,
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
    return { success: true, status: 'Processing', geosamRef: order.Reference, message: res.message || 'Bundle request received and is being processed.' };
  }
  return { success: false, status: 'Failed', geosamRef: order.Reference, message: res.message || 'Geosam rejected the request.' };
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

/** Client-callable (admin only). Shows current Geosam wallet balances per network. */
function getGeosamWalletBalance(token) {
  requireAdminSession_(token);
  return getGeosamWalletBalance_();
}

/** Client-callable (admin only). "Test Connection" button in API Settings — a safe, read-only check. */
function testGeosamConnection(token) {
  requireAdminSession_(token);
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return { success: false, message: 'API Mode is set to Mock — switch to Live to test the real Geosam connection.' };
  }
  var result = getGeosamWalletBalance_();
  if (!result.success) return result;
  if (!result.isActive) {
    return { success: false, message: 'Connected, but your Geosam API account is not approved/active yet (signed in as ' + result.user + ').' };
  }
  return { success: true, message: 'Connected as ' + result.user + '. Balances — MTN: ' + result.balances.MTN + ', Telecel: ' + result.balances.Telecel + ', AirtelTigo: ' + result.balances.AirtelTigo + '.' };
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
      new Date()
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
  var order = orders.filter(function (o) {
    return o.OrderID === String(orderId).trim() && o.RecipientPhone === String(phone).trim();
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
      recipientPhone: o.RecipientPhone,
      payerPhone: o.PayerPhone,
      network: o.Network,
      size: o.Size,
      sellingPrice: Number(o.SellingPrice) || 0,
      basePrice: Number(o.BasePrice) || 0,
      profit: Number(o.Profit) || 0,
      momoRef: o.MoMoRef,
      status: o.Status,
      geosamOrderId: o.GeosamOrderId,
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
  if (extra && extra.geosamOrderId !== undefined) {
    sheet.getRange(row, ORDER_HEADERS.indexOf('GeosamOrderId') + 1).setValue(extra.geosamOrderId);
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
  order.Reference = orderId + '-F' + Utilities.getUuid().split('-')[0].toUpperCase();

  var result = buyGeosamBundle_(order);

  if (result.success) {
    setOrderStatus_(orderId, ORDER_STATUS.PROCESSING, { geosamOrderId: result.geosamRef, notes: result.message });
  } else {
    setOrderStatus_(orderId, ORDER_STATUS.FAILED, { geosamOrderId: result.geosamRef, notes: result.message });
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

  if (!order.GeosamOrderId) {
    throw new Error('This order has not been submitted to Geosam yet.');
  }

  var tx = checkGeosamTransactionStatus_(order.GeosamOrderId);
  var status = String(tx.status || '').toLowerCase();

  if (status === 'completed') {
    setOrderStatus_(orderId, ORDER_STATUS.DELIVERED, { notes: tx.message || 'Confirmed delivered by Geosam.' });
    return { status: ORDER_STATUS.DELIVERED, message: tx.message };
  }
  if (status === 'failed' || status === 'error') {
    setOrderStatus_(orderId, ORDER_STATUS.FAILED, { notes: tx.message || 'Geosam reported this transaction failed.' });
    return { status: ORDER_STATUS.FAILED, message: tx.message };
  }
  setOrderStatus_(orderId, ORDER_STATUS.PROCESSING, { notes: tx.message || ('Geosam status: ' + (tx.status || 'pending')) });
  return { status: ORDER_STATUS.PROCESSING, message: tx.message || 'Still processing at Geosam — check again shortly.' };
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

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd');
  var todayOrders = orders.filter(function (o) {
    return Utilities.formatDate(new Date(o.Timestamp), Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd') === todayStr;
  });

  return {
    totalSales: totalSales,
    totalProfit: totalProfit,
    pendingCount: pendingCount,
    deliveredCount: deliveredCount,
    totalOrders: orders.length,
    ordersToday: todayOrders.length
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
