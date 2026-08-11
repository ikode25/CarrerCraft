/**
 * ============================================================================
 *  DATA BUNDLE STORE — Google Apps Script backend
 * ============================================================================
 *  A self-serve storefront where customers buy MTN / Telecel / AirtelTigo
 *  data bundles, and a private admin portal (restricted to your Google
 *  account) where you set your own selling prices, fulfill orders through
 *  Geosam's Send Bundle API, and track profit.
 *
 *  Note: Geosam's API has no endpoint to look up bundle sizes/prices — you
 *  enter your own base prices manually (see the Pricing tab), matching what
 *  you see in your Geosam dashboard/shop.
 *
 *  SETUP (see README.md for the full walkthrough):
 *   1. Create a new Google Sheet.
 *   2. Extensions > Apps Script. Delete the default code.
 *   3. Create this file as "Code.gs" and paste this content.
 *   4. Create an HTML file named "index" and paste index.html's content.
 *   5. Run `setupSheets` once from the editor (top toolbar ▶) to create
 *      the Packages / Orders tabs and seed starter pricing.
 *   6. Deploy > New deployment > Web app.
 *        Execute as:  Me
 *        Who has access: Anyone
 *   7. Open the deployed URL, go to ?page=admin, and click
 *      "Claim Admin Access" while signed into the Google account you
 *      want to be the owner. This locks the admin portal to that account.
 *   8. In the admin API Settings tab, paste your Geosam API token, flip
 *      API Mode to "Live", and click "Test connection".
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. CONFIG / CONSTANTS
// ---------------------------------------------------------------------------

var SHEET_PACKAGES = 'Packages';
var SHEET_ORDERS = 'Orders';

var PACKAGE_HEADERS = ['ID', 'Network', 'Size', 'Validity', 'AmountMB', 'BasePrice', 'SellingPrice', 'Active', 'LastUpdated'];
var ORDER_HEADERS = ['OrderID', 'Timestamp', 'CustomerName', 'RecipientPhone', 'PayerPhone', 'Network', 'Size', 'SellingPrice', 'BasePrice', 'Profit', 'MoMoRef', 'Status', 'GeosamOrderId', 'Notes', 'UpdatedAt'];

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
  OWNER_EMAIL: '',
  GEOSAM_API_BASE: 'https://www.geosams.com',
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
 * to create the Packages / Orders sheets and seed starter pricing so the
 * store isn't empty on day one. Verify/adjust base prices before going live.
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
      amountMB: Number(p.AmountMB) || 0,
      basePrice: base,
      sellingPrice: selling,
      profit: selling - base,
      active: p.Active === true || p.Active === 'TRUE',
      lastUpdated: p.LastUpdated
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

/**
 * Client-callable (admin only). Adds a package to your store.
 * Geosam's API has no endpoint to look up bundle prices or sizes — you set
 * these based on what you see in your Geosam dashboard/shop. `amountMB` is
 * the exact volume Geosam will send (e.g. 1000 for "1GB", 2000 for "2GB"),
 * used directly in the Send Bundle API call.
 */
function addManualPackage(pkg) {
  requireOwner_();
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
function deletePackage(id) {
  requireOwner_();
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

/** Client-callable (admin only). Shows current Geosam wallet balances per network. */
function getGeosamWalletBalance() {
  requireOwner_();
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

/** Client-callable (admin only). "Test Connection" button in API Settings — a safe, read-only check. */
function testGeosamConnection() {
  requireOwner_();
  var mode = getSetting_('GEOSAM_MODE') || 'mock';
  if (mode !== 'live') {
    return { success: false, message: 'API Mode is set to Mock — switch to Live to test the real Geosam connection.' };
  }
  var result = getGeosamWalletBalance();
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

/**
 * Client-callable (admin only). Sends the order to Geosam for fulfillment.
 * Success only means Geosam accepted the request (it's async) — the order
 * moves to "Processing" and you use checkOrderGeosamStatus() to confirm
 * delivery. A fresh reference is generated on every attempt so retrying a
 * failed order never collides with a previous Geosam reference.
 */
function fulfillOrder(orderId) {
  requireOwner_();
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
function checkOrderGeosamStatus(orderId) {
  requireOwner_();
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
