/**
 * ============================================================================
 *  DATA BUNDLE STORE — Google Apps Script backend
 * ============================================================================
 *  A self-serve storefront where customers buy MTN / Telecel / AirtelTigo
 *  data bundles, and a private admin portal (restricted to your Google
 *  account) where you sync base prices from Geosam, set your selling
 *  prices, and track profit.
 *
 *  SETUP (see README.md for the full walkthrough):
 *   1. Create a new Google Sheet.
 *   2. Extensions > Apps Script. Delete the default code.
 *   3. Create this file as "Code.gs" and paste this content.
 *   4. Create an HTML file named "index" and paste index.html's content.
 *   5. Run `setupSheets` once from the editor (top toolbar ▶) to create
 *      the Packages / Orders tabs and seed mock pricing.
 *   6. Deploy > New deployment > Web app.
 *        Execute as:  Me
 *        Who has access: Anyone
 *   7. Open the deployed URL, go to ?page=admin, and click
 *      "Claim Admin Access" while signed into the Google account you
 *      want to be the owner. This locks the admin portal to that account.
 *   8. In the admin Settings tab, fill in your MoMo details and (once you
 *      have them) your Geosam API base URL / key, then flip API Mode to
 *      "Live".
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. CONFIG / CONSTANTS
// ---------------------------------------------------------------------------

var SHEET_PACKAGES = 'Packages';
var SHEET_ORDERS = 'Orders';

var PACKAGE_HEADERS = ['ID', 'Network', 'Size', 'Validity', 'BasePrice', 'SellingPrice', 'GeosamCode', 'Active', 'LastSynced'];
var ORDER_HEADERS = ['OrderID', 'Timestamp', 'CustomerName', 'RecipientPhone', 'PayerPhone', 'Network', 'Size', 'SellingPrice', 'BasePrice', 'Profit', 'MoMoRef', 'Status', 'GeosamOrderId', 'Notes', 'UpdatedAt'];

var NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];

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
  OWNER_EMAIL: '',
  GEOSAM_API_BASE: '',
  GEOSAM_API_KEY: '',
  GEOSAM_MODE: 'mock' // 'mock' | 'live'
};

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

function getCurrentUserEmail_() {
  try {
    return (Session.getActiveUser().getEmail() || '').toLowerCase();
  } catch (err) {
    return '';
  }
}

function isOwner_() {
  var owner = getSetting_('OWNER_EMAIL');
  if (!owner) return false; // no owner claimed yet — nobody is admin until claimed
  var email = getCurrentUserEmail_();
  return !!email && email === owner.toLowerCase();
}

function requireOwner_() {
  if (!isOwner_()) {
    throw new Error('ACCESS_DENIED: You are not signed in as the store owner.');
  }
}

/**
 * Client-callable. Returns who the visitor is and whether admin access is
 * already claimed, so the UI can show "Claim Admin Access" on first run.
 */
function getAuthStatus() {
  var owner = getSetting_('OWNER_EMAIL');
  return {
    email: getCurrentUserEmail_(),
    ownerClaimed: !!owner,
    isOwner: isOwner_()
  };
}

/**
 * Client-callable. The very first person to click "Claim Admin Access"
 * (while signed into the Google account they want as the permanent owner)
 * becomes the admin. No-op if an owner is already set.
 */
function claimAdminAccess() {
  var owner = getSetting_('OWNER_EMAIL');
  if (owner) {
    return { success: false, message: 'Admin access has already been claimed.' };
  }
  var email = getCurrentUserEmail_();
  if (!email) {
    return { success: false, message: 'Could not detect a Google account. Make sure you are signed into Google in this browser, then reload the page.' };
  }
  setSetting_('OWNER_EMAIL', email);
  return { success: true, email: email };
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
 * to create the Packages / Orders sheets and seed sample pricing so the
 * store isn't empty before Geosam is connected.
 */
function setupSheets() {
  getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  seedMockPackagesIfEmpty_();
  return 'Sheets are ready.';
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📶 Data Bundle Store')
    .addItem('Initialize / repair sheets', 'setupSheets')
    .addItem('Re-seed mock pricing (only if Packages is empty)', 'seedMockPackagesIfEmpty_')
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

function getPublicSettings_() {
  return {
    storeName: getSetting_('STORE_NAME'),
    tagline: getSetting_('STORE_TAGLINE'),
    whatsapp: getSetting_('WHATSAPP_NUMBER'),
    momoNumber: getSetting_('MOMO_NUMBER'),
    momoName: getSetting_('MOMO_NAME'),
    currency: getSetting_('CURRENCY_SYMBOL')
  };
}

/** Client-callable (admin only). */
function getAdminSettings() {
  requireOwner_();
  return {
    storeName: getSetting_('STORE_NAME'),
    tagline: getSetting_('STORE_TAGLINE'),
    whatsapp: getSetting_('WHATSAPP_NUMBER'),
    momoNumber: getSetting_('MOMO_NUMBER'),
    momoName: getSetting_('MOMO_NAME'),
    currency: getSetting_('CURRENCY_SYMBOL'),
    ownerEmail: getSetting_('OWNER_EMAIL'),
    geosamApiBase: getSetting_('GEOSAM_API_BASE'),
    geosamApiKeySet: !!getSetting_('GEOSAM_API_KEY'),
    geosamMode: getSetting_('GEOSAM_MODE')
  };
}

/** Client-callable (admin only). `settings` is a partial object of DEFAULT_SETTINGS keys. */
function saveAdminSettings(settings) {
  requireOwner_();
  var editable = ['STORE_NAME', 'STORE_TAGLINE', 'WHATSAPP_NUMBER', 'MOMO_NUMBER', 'MOMO_NAME', 'CURRENCY_SYMBOL', 'GEOSAM_API_BASE', 'GEOSAM_MODE'];
  editable.forEach(function (key) {
    if (settings.hasOwnProperty(key)) setSetting_(key, settings[key]);
  });
  // API key only overwritten if a non-empty value was actually submitted,
  // so re-saving the settings form doesn't blank it out.
  if (settings.GEOSAM_API_KEY) setSetting_('GEOSAM_API_KEY', settings.GEOSAM_API_KEY);
  return getAdminSettings();
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
function getAdminPackages() {
  requireOwner_();
  return getAllPackages_().map(function (p) {
    var base = Number(p.BasePrice) || 0;
    var selling = Number(p.SellingPrice) || 0;
    return {
      id: p.ID,
      network: p.Network,
      size: p.Size,
      validity: p.Validity,
      basePrice: base,
      sellingPrice: selling,
      profit: selling - base,
      geosamCode: p.GeosamCode,
      active: p.Active === true || p.Active === 'TRUE',
      lastSynced: p.LastSynced
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
function savePackageSellingPrice(id, sellingPrice) {
  requireOwner_();
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
function togglePackageActive(id, active) {
  requireOwner_();
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var row = findPackageRow_(sheet, id);
  if (row === -1) throw new Error('Package not found.');
  sheet.getRange(row, PACKAGE_HEADERS.indexOf('Active') + 1).setValue(!!active);
  return { success: true };
}

/** Client-callable (admin only). Manually add a package (used before Geosam sync is wired up, or for one-offs). */
function addManualPackage(pkg) {
  requireOwner_();
  if (NETWORKS.indexOf(pkg.network) === -1) throw new Error('Unknown network.');
  if (!pkg.size) throw new Error('Size is required.');
  var basePrice = Number(pkg.basePrice) || 0;
  var sellingPrice = Number(pkg.sellingPrice) || 0;
  if (sellingPrice <= basePrice) throw new Error('Selling price must be higher than the base price.');

  var id = packageId_(pkg.network, pkg.size);
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  if (findPackageRow_(sheet, id) !== -1) throw new Error('A package with that network + size already exists.');

  sheet.appendRow([
    id, pkg.network, pkg.size, pkg.validity || '', basePrice, sellingPrice,
    pkg.geosamCode || id, true, new Date()
  ]);
  return { success: true, id: id };
}

/** Client-callable (admin only). */
function deletePackage(id) {
  requireOwner_();
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var row = findPackageRow_(sheet, id);
  if (row === -1) throw new Error('Package not found.');
  sheet.deleteRow(row);
  return { success: true };
}

/**
 * Client-callable (admin only). Pulls current base prices from Geosam
 * (or mock data, if API mode is "mock") and upserts them into the
 * Packages sheet. Existing selling prices are preserved; new packages
 * are added with selling price = base price + a starting markup so
 * the "selling > base" rule is never violated by a fresh sync.
 */
function syncGeosamPackages(network) {
  requireOwner_();
  if (NETWORKS.indexOf(network) === -1) throw new Error('Unknown network.');

  var fetched = fetchGeosamPackages_(network); // [{code, size, validity, basePrice}]
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    fetched.forEach(function (item) {
      var id = packageId_(network, item.size);
      var row = findPackageRow_(sheet, id);
      var col = {
        base: PACKAGE_HEADERS.indexOf('BasePrice') + 1,
        selling: PACKAGE_HEADERS.indexOf('SellingPrice') + 1,
        code: PACKAGE_HEADERS.indexOf('GeosamCode') + 1,
        validity: PACKAGE_HEADERS.indexOf('Validity') + 1,
        synced: PACKAGE_HEADERS.indexOf('LastSynced') + 1
      };
      if (row === -1) {
        var startingSellingPrice = Math.ceil((item.basePrice * 1.15) * 100) / 100; // +15% starting markup
        sheet.appendRow([id, network, item.size, item.validity || '', item.basePrice, startingSellingPrice, item.code, true, new Date()]);
      } else {
        sheet.getRange(row, col.base).setValue(item.basePrice);
        sheet.getRange(row, col.code).setValue(item.code);
        if (item.validity) sheet.getRange(row, col.validity).setValue(item.validity);
        sheet.getRange(row, col.synced).setValue(new Date());
      }
    });
  } finally {
    lock.releaseLock();
  }
  return getAdminPackages().filter(function (p) { return p.network === network; });
}

function seedMockPackagesIfEmpty_() {
  var sheet = getSheet_(SHEET_PACKAGES, PACKAGE_HEADERS);
  if (sheet.getLastRow() >= 2) return 'Packages already has data — skipped.';
  NETWORKS.forEach(function (network) {
    mockGeosamPackages_(network).forEach(function (item) {
      var id = packageId_(network, item.size);
      var sellingPrice = Math.ceil((item.basePrice * 1.15) * 100) / 100;
      sheet.appendRow([id, network, item.size, item.validity, item.basePrice, sellingPrice, item.code, true, new Date()]);
    });
  });
  return 'Seeded mock packages for ' + NETWORKS.join(', ') + '.';
}

// ---------------------------------------------------------------------------
// 7. GEOSAM ADAPTER
// ---------------------------------------------------------------------------
// This is intentionally isolated so it's the ONLY place you need to edit
// once you have real Geosam API docs. Everything else in this file talks
// to fetchGeosamPackages_() / buyGeosamBundle_() and doesn't care how they
// get their data.
//
// TODO once you have Geosam's docs: fix GEOSAM_ENDPOINTS, the auth header
// in geosamRequest_(), and the response-shape mapping in
// fetchGeosamPackages_() / buyGeosamBundle_() below.
// ---------------------------------------------------------------------------

var GEOSAM_ENDPOINTS = {
  packages: '/api/packages', // TODO confirm actual path with Geosam docs
  purchase: '/api/purchase'  // TODO confirm actual path with Geosam docs
};

function geosamRequest_(path, method, payload) {
  var base = getSetting_('GEOSAM_API_BASE');
  var key = getSetting_('GEOSAM_API_KEY');
  if (!base || !key) {
    throw new Error('Geosam API is not configured yet. Add your API base URL and key in Settings, or keep API Mode set to "Mock" while you test pricing.');
  }
  var options = {
    method: method || 'get',
    contentType: 'application/json',
    headers: {
      // TODO: Geosam may expect a different header, e.g. 'x-api-key': key
      'Authorization': 'Bearer ' + key
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  var response = UrlFetchApp.fetch(base.replace(/\/$/, '') + path, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Geosam API error (' + code + '): ' + body);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('Geosam API returned a non-JSON response: ' + body.substring(0, 200));
  }
}

/**
 * Returns [{ code, size, validity, basePrice }, ...] for a network.
 * In 'mock' mode returns illustrative sample pricing so you can build
 * your storefront and pricing workflow before Geosam is wired up.
 */
function fetchGeosamPackages_(network) {
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') return mockGeosamPackages_(network);

  var data = geosamRequest_(GEOSAM_ENDPOINTS.packages + '?network=' + encodeURIComponent(network), 'get');
  // TODO: adjust this mapping once you know Geosam's real response shape.
  var list = data.packages || data.data || data.results || [];
  return list.map(function (p) {
    return {
      code: p.code || p.id || p.package_id,
      size: p.size || p.name || p.bundle,
      validity: p.validity || p.expiry || '30 Days',
      basePrice: Number(p.price || p.amount || p.base_price)
    };
  });
}

/**
 * Places the actual purchase with Geosam once an order has been marked
 * Paid by the admin. Returns { success, geosamOrderId, message }.
 * In 'mock' mode, simulates success so the admin flow can be tested end
 * to end before the real API is connected.
 */
function buyGeosamBundle_(order) {
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return {
      success: true,
      geosamOrderId: 'MOCK-' + Utilities.getUuid().split('-')[0].toUpperCase(),
      message: 'Simulated fulfillment (Geosam API Mode is set to Mock).'
    };
  }
  // TODO: adjust payload field names once you know Geosam's real request shape.
  var res = geosamRequest_(GEOSAM_ENDPOINTS.purchase, 'post', {
    network: order.Network,
    package_code: order.GeosamCode,
    recipient_phone: order.RecipientPhone
  });
  return {
    success: true,
    geosamOrderId: res.orderId || res.id || res.reference || '',
    message: res.message || 'Submitted to Geosam.'
  };
}

function mockGeosamPackages_(network) {
  var tables = {
    MTN: [
      ['1GB', 4.15], ['2GB', 8.30], ['3GB', 12.45], ['4GB', 16.60], ['5GB', 20.75],
      ['6GB', 24.90], ['8GB', 33.20], ['10GB', 41.50], ['15GB', 62.25], ['20GB', 83.00],
      ['25GB', 103.75], ['30GB', 124.50]
    ],
    Telecel: [
      ['1GB', 4.50], ['2GB', 9.00], ['3GB', 13.00], ['5GB', 21.00], ['7GB', 28.50],
      ['10GB', 40.00], ['15GB', 58.00], ['20GB', 75.00], ['25GB', 92.00], ['50GB', 175.00]
    ],
    AirtelTigo: [
      ['1GB', 4.00], ['2GB', 7.80], ['3GB', 11.50], ['5GB', 19.00], ['10GB', 37.00],
      ['15GB', 54.00], ['20GB', 70.00], ['25GB', 87.00], ['50GB', 165.00]
    ]
  };
  var rows = tables[network] || [];
  return rows.map(function (row) {
    return { code: packageId_(network, row[0]), size: row[0], validity: '30 Days', basePrice: row[1] };
  });
}

/** Client-callable (admin only). "Test Connection" button in Settings. */
function testGeosamConnection() {
  requireOwner_();
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return { success: false, message: 'API Mode is set to Mock — switch to Live to test the real Geosam connection.' };
  }
  try {
    var result = fetchGeosamPackages_('MTN');
    return { success: true, message: 'Connected. Received ' + result.length + ' MTN package(s) from Geosam.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
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
    throw new Error('Enter the MoMo transaction reference from your payment.');
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
    timestamp: order.Timestamp
  };
}

function getAllOrders_() {
  var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  return sheetRowsToObjects_(sheet, ORDER_HEADERS);
}

/** Client-callable (admin only). Most recent first, optionally filtered by status. */
function getAdminOrders(statusFilter) {
  requireOwner_();
  var orders = getAllOrders_();
  if (statusFilter && statusFilter !== 'All') {
    orders = orders.filter(function (o) { return o.Status === statusFilter; });
  }
  orders.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });
  return orders.map(function (o) {
    return {
      id: o.OrderID,
      timestamp: o.Timestamp,
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
function markOrderPaid(orderId) {
  requireOwner_();
  setOrderStatus_(orderId, ORDER_STATUS.PAID);
  return { success: true };
}

/** Client-callable (admin only). Sends the order to Geosam for fulfillment. */
function fulfillOrder(orderId) {
  requireOwner_();
  var sheet = getSheet_(SHEET_ORDERS, ORDER_HEADERS);
  var row = findOrderRow_(sheet, orderId);
  if (row === -1) throw new Error('Order not found.');

  var values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0];
  var order = {};
  ORDER_HEADERS.forEach(function (h, i) { order[h] = values[i]; });

  var packages = getAllPackages_();
  var pkg = packages.filter(function (p) { return p.Network === order.Network && p.Size === order.Size; })[0];
  order.GeosamCode = pkg ? pkg.GeosamCode : '';

  setOrderStatus_(orderId, ORDER_STATUS.PROCESSING);
  var result = buyGeosamBundle_(order);

  if (result.success) {
    setOrderStatus_(orderId, ORDER_STATUS.DELIVERED, { geosamOrderId: result.geosamOrderId, notes: result.message });
  } else {
    setOrderStatus_(orderId, ORDER_STATUS.FAILED, { notes: result.message });
  }
  return result;
}

/** Client-callable (admin only). */
function markOrderDelivered(orderId) {
  requireOwner_();
  setOrderStatus_(orderId, ORDER_STATUS.DELIVERED);
  return { success: true };
}

/** Client-callable (admin only). */
function markOrderFailed(orderId, reason) {
  requireOwner_();
  setOrderStatus_(orderId, ORDER_STATUS.FAILED, { notes: reason || '' });
  return { success: true };
}

/** Client-callable (admin only). */
function cancelOrder(orderId) {
  requireOwner_();
  setOrderStatus_(orderId, ORDER_STATUS.CANCELLED);
  return { success: true };
}

// ---------------------------------------------------------------------------
// 9. DASHBOARD STATS
// ---------------------------------------------------------------------------

/** Client-callable (admin only). */
function getDashboardStats() {
  requireOwner_();
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
    settings: getPublicSettings_(),
    packagesByNetwork: getStorefrontPackages(),
    networks: NETWORKS
  };
}

/** Client-callable. Everything the admin portal needs in one call (or an access-denied flag). */
function getAdminBootstrap() {
  var auth = getAuthStatus();
  if (!auth.isOwner) {
    return { authorized: false, auth: auth };
  }
  return {
    authorized: true,
    auth: auth,
    settings: getAdminSettings(),
    packages: getAdminPackages(),
    orders: getAdminOrders(),
    stats: getDashboardStats(),
    networks: NETWORKS,
    orderStatuses: ORDER_STATUS
  };
}
