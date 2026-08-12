# Data Bundle Store — Google Apps Script

A self-serve storefront for reselling **MTN**, **Telecel**, and **AirtelTigo** data
bundles, plus a private admin portal (username + password login) where you
set your own selling prices, fulfill orders through **Geosam or iDataGH**
(switch instantly if one is down), and track your profit per order.

- `Code.gs` — backend: Google Sheets as the database, all server logic, and
  the Geosam + iDataGH API adapters.
- `index.html` — the entire UI (storefront + admin portal) as one page.

## 1. Create the project

1. Create a new blank Google Sheet (this becomes your database).
2. **Extensions → Apps Script.**
3. Delete the default `Code.gs` boilerplate and paste in this repo's `Code.gs`.
4. Click **+ → HTML** in the file list, name it exactly `index` (Apps Script
   adds the `.html` extension itself), and paste in this repo's `index.html`.
5. Save the project (give it a name like "My Data Store").

## 2. Initialize the sheets

In the Apps Script editor toolbar, select the `setupSheets` function from the
dropdown next to ▶ **Run**, and run it once. The first run will ask you to
authorize the script (Sheets + URL Fetch access) — approve it. Uploading a
carousel photo later will prompt a second time for Google Drive access.

This creates three sheets:
- **Packages** — `ID, Network, Size, Validity, AmountMB, BasePrice, SellingPrice, Active, LastUpdated, IdataghPackageId`
- **Orders** — `OrderID, Timestamp, CustomerName, RecipientPhone, PayerPhone, Network, Size, SellingPrice, BasePrice, Profit, MoMoRef, Status, ProviderRef, Notes, UpdatedAt, Provider`
- **Carousel** — `ID, Url, Caption, Order, Active, FileId, UploadedAt`

It also locks the `RecipientPhone`/`PayerPhone` columns to plain-text
formatting — without this, Google Sheets can silently turn `"0244000000"`
into the number `244000000` (dropping the leading zero), which broke order
tracking in earlier versions. Safe to re-run `setupSheets` any time.

It also seeds **starter pricing** for all three networks so your storefront
isn't empty on day one, and sets up the **default admin login**:
`admin` / `admin123`. These are illustrative placeholder prices — verify
and correct them against your real Geosam dashboard/shop pricing before
going live (see step 5 — Geosam's API doesn't expose a price list, so this
is always a manual step).

## 3. Deploy the web app

**Deploy → New deployment → type: Web app.**
- Execute as: **Me**
- Who has access: **Anyone**

Click **Deploy** and copy the web app URL — that's your storefront link
(`.../exec`). Share that with customers.

### ⚠️ Whenever you update `Code.gs` or `index.html` later

Saving the file in the editor is **not enough** — the live `/exec` URL keeps
serving whatever was last *deployed* until you publish a new version. This is
the #1 cause of "I changed the code but nothing changed" or a blank page
after an update:

1. **Deploy → Manage deployments.**
2. Click the pencil/edit icon on your existing deployment (don't create a
   brand-new one — that gives you a different URL).
3. Version dropdown → **New version** → **Deploy**.
4. Reload the page (or click the refresh icon — see "Faster loading" below).
   Every screen (storefront footer, admin sidebar/login) shows a small
   version tag like `v1.8.0` in low-contrast text — if it doesn't match the
   version in this repo's `Code.gs` (`APP_VERSION` near the top), the
   redeploy didn't take effect yet.

If the page is still completely blank (not even the dark "Loading…" spinner,
which is plain HTML/CSS with no JavaScript dependency) after confirming the
version tag is current, that points to the browser rather than the code —
try an incognito/private window or a different browser. Google's Apps Script
hosting renders your page inside a sandboxed iframe, which some browsers'
third-party-cookie or tracking-prevention settings block.

## 4. Admin login

Open `YOUR_WEB_APP_URL?page=admin` (or tap the small person icon at the top
of your storefront) and log in with:

- **Username/email:** `admin`
- **Password:** `admin123`

**Change both immediately** from the admin **Account** tab — enter your
current password once, then set a new username/email and password. There's
no Google-account requirement; the admin portal works the same in any
browser, on any device, for whoever has the current credentials.

Login uses a session token stored in this browser's `localStorage`, valid
for 6 hours and renewed automatically while you're active — logging in again
is only needed after a long idle period or on a new device/browser.

The login screen itself doesn't display the default credentials anywhere —
they're only ever printed in the one-time `setupSheets` confirmation message
in the Apps Script editor (and here in this README), so nothing sensitive
shows on a page anyone can load.

If you ever get locked out (forgot the password), reset it from the Apps
Script editor: **Project Settings → Script properties**, delete
`ADMIN_PASSWORD_HASH` and `ADMIN_PASSWORD_SALT` (and `ADMIN_USERNAME` too, if
you also forgot the username), then reload `?page=admin` — the password
resets to `admin123` (and the username to `admin`, if you cleared it).

**If login succeeds but the dashboard itself then shows an error** ("Cannot
read properties of null" or similar): this was a real bug in earlier
versions — `google.script.run` can unreliably hand back `null` instead of a
proper error when a server function returns a raw `Date` object. All
timestamps are now converted to strings before being sent to the browser,
and `getAdminBootstrap()` is wrapped so any future server-side hiccup
reports a readable message (toast in the corner) instead of crashing the
page — as of `v1.6.0`, seeing that crash means you're still on an older
deployment (see the redeploy checklist above).

Bookmark the `?page=admin` URL — that's your private dashboard.

## 5. Connect a data provider (Geosam and/or iDataGH)

The admin **API Settings** tab has a **Data Provider** switch (Geosam /
iDataGH) plus a separate card per provider — both providers' credentials
stay saved at all times, so if one has an outage you can switch the active
provider in one click without re-entering anything. Every order records
which provider actually fulfilled it, so status checks always poll the
right one even if you switch providers afterward.

### Geosam

Wired to Geosam's actual published API
(https://geosams.com/controller/api-documentation/):

| Purpose | Endpoint |
|---|---|
| Send a bundle | `POST /controller/api/send_bundle/` |
| Check a transaction | `GET /controller/api/transaction_detail/<reference>/` |
| List your transactions | `GET /controller/api/transactions/` |
| Account status + wallet balance | `GET /controller/api/account/status/` |

Auth is `Authorization: Token <your_api_token>` (not `Bearer`). Get your
token from the Geosam dashboard once your API account is **approved** —
`account/status` tells you if it isn't.

**Important:** Geosam's API has no endpoint to look up bundle sizes or
prices — `send_bundle` just takes a network, phone number, and a data amount
in MB you already know. That means:
- **Base prices are always entered manually** in the Pricing tab, matching
  what you see in your Geosam dashboard/shop — there's no "sync" button.
- Each package needs its exact **data amount in MB** (e.g. `1000` for 1GB) —
  this is sent to Geosam byte-for-byte, so get it right.

Setup: paste your Geosam API token in its card, switch its Mode to **Live**,
make sure Geosam is the **active provider** above, then click **Test
connection** (a safe, read-only check against Account Status — it won't send
a real bundle) or **Check wallet balance**.

Everything Geosam-specific lives in the **GEOSAM ADAPTER** section of
`Code.gs` (`buyGeosamBundle_()`, `checkGeosamTransactionStatus_()`,
`getGeosamWalletBalance_()`) — if Geosam changes their API, that's the only
section to touch.

### iDataGH

Wired to iDataGH's actual published API (https://idatagh.com/api-documentation/):

| Purpose | Endpoint |
|---|---|
| Place an order | `POST /wp-json/custom/v1/place-order` |
| Check an order | `GET /wp-json/custom/v1/order-status?order_id=<id>` |
| Wallet balance | `GET /wp-json/custom/v1/wallet-balance` |
| List packages | `GET /wp-json/custom/v1/packages?network=<mtn\|telecel\|airteltigo>` |

Auth is `Authorization: Bearer <your_api_key>` + `Content-Type: application/json`.

**Unlike Geosam, iDataGH *does* expose a live package list** — each package
has its own numeric `package_id`, required to place an order (not a
data-in-MB amount). That's what **Pricing → Sync from iDataGH** is for: it
pulls iDataGH's real prices and package IDs for a network and matches them
into your existing packages by size (or creates new ones with a +15%
starting markup). Because base price is a single shared field per package,
syncing overwrites it with iDataGH's price — if you also sell through
Geosam, re-check that package's base price manually after syncing, since
the two providers' costs may differ.

iDataGH also assigns its own order ID when you place an order (there's no
client-supplied reference the way Geosam has) — that ID becomes the
order's `ProviderRef` and is what gets polled on **Check iDataGH Status**.

Setup: paste your iDataGH API key in its card, switch its Mode to **Live**,
sync pricing for each network, make sure iDataGH is the **active provider**
above, then click **Test connection** or **Check wallet balance** (a single
overall figure, unlike Geosam's per-network balances).

Everything iDataGH-specific lives in the **IDATAGH ADAPTER** section of
`Code.gs` (`buyIdataghBundle_()`, `checkIdataghTransactionStatus_()`,
`getIdataghWalletBalance_()`, `fetchIdataghPackages_()`).

## 6. How the money flow works

1. Customer picks a bundle, sees your MoMo number/name/amount, pays via
   Mobile Money, then submits the order along with the **Transaction ID**
   from their MoMo payment confirmation (required — the order can't be
   submitted without it). Order status: **Pending Payment**.
2. You check your MoMo statement for that Transaction ID. If it matches,
   click **Mark Paid** in Orders. Status: **Paid - Awaiting Fulfillment**.
3. Click **Fulfill via &lt;Provider&gt;** (labeled with whichever provider is
   currently active) — this sends the order with a freshly generated
   reference, and records on the order which provider it went to. Both
   providers' APIs are treated as **asynchronous**: a successful reply only
   means "request received and is being processed," so the order moves to
   **Processing**, not straight to Delivered.
4. Click **Check &lt;Provider&gt; Status** on a Processing order to poll that
   *same* provider — it updates the order to **Delivered** once confirmed,
   or **Failed** with the provider's reason if it didn't go through. Safe to
   click repeatedly. "Mark Delivered" is also available as a manual override
   if you confirm delivery another way.
5. Retrying a failed fulfillment generates a brand-new reference each time,
   so it never collides with a previous attempt ("Duplicate reference
   detected").
6. Profit (`SellingPrice - BasePrice`, snapshotted at order time) only counts
   toward your Dashboard totals once the order reaches Paid, Processing, or
   Delivered — never for orders still awaiting payment.

## 7. Live status banner

In **Store Setup**, there's a "Live Status Banner" card that controls a
scrolling ticker shown at the top of your storefront (below the nav) — the
same idea as Geosam's own "Network: Hi, the network is good today!" bar.

- **Network status**: Good / Delayed / Down — sets the banner's color
  (green/amber/red) and a sensible default message.
- **Per-network delivery time** (e.g. MTN defaults to "10-30 mins"): shown as
  "MTN: 10-30 mins" etc. in the banner. Leave a network blank to leave it out
  entirely.
- **Custom message**: overrides the auto-generated status text if you want to
  say something specific (e.g. "Telecel is down for maintenance until 6pm").
- A live preview updates as you type, before you save. Toggle the banner off
  entirely if you don't want it shown.

The banner text is composed server-side in `composeBanner_()` in `Code.gs` —
edit `BANNER_STATUS_DEFAULTS` there if you want different default wording. It
scrolls continuously (a CSS marquee) unless the visitor's OS has "reduce
motion" turned on, in which case it shows statically for accessibility.

## 7b. Hero carousel

The admin **Carousel** tab lets you upload photos (JPG/PNG/WebP, max 5MB
each) that rotate as a full-width banner at the top of your storefront, right
below the status banner. Each photo can have an optional caption overlay,
can be shown/hidden without deleting it, and deleting it also removes the
file from Google Drive.

- Photos are stored in a Drive folder named **"Data Bundle Store - Carousel
  Images"**, shared "anyone with the link can view" so they load on the
  public storefront.
- With 2+ visible photos, the carousel auto-advances every 4.5 seconds with
  dot navigation and (on desktop) arrow buttons; clicking a dot/arrow resets
  the auto-advance timer. With 0 photos, the carousel section is hidden
  entirely — the storefront looks the same as before you added any.
- The first upload will prompt you to re-authorize the Apps Script project
  for Google Drive access — that's expected, approve it.
- Image URLs are always derived from the stored Drive file ID at read time
  (not from a saved link), so if you're on a version before this was fixed,
  photos that showed a broken-image icon will start rendering correctly
  automatically once you're on the latest code — no re-upload needed.

## 7c. WhatsApp button & AI chat assistant

Two floating buttons sit in the bottom-right corner of the storefront:

- **WhatsApp** (green, gently bouncing) — only shown if you've set a
  WhatsApp number in Store Setup. Opens a chat with a pre-filled "I need
  help with an order" message.
- **Chat assistant** — opens an in-page chat panel. Works with **zero
  setup**: Mock mode matches keywords in the customer's question (pricing,
  delivery time, payment, tracking, "talk to a human") against your live
  store settings, so answers are always accurate even with no AI connected.

To upgrade to real generative AI: get a free API key at
https://aistudio.google.com/apikey, paste it into **API Settings → AI
Assistant**, and switch Mode to **Live**. Live mode gives the model your
store's live pricing/delivery/payment info as context and keeps it scoped to
answering store-related questions; if a live call ever fails for any reason,
it silently falls back to the same Mock-mode FAQ responder rather than
breaking the chat.

## 7d. "Why choose us" & copy-to-clipboard

A "Why choose \<your store name\>" section with four value-prop cards (Fast
Delivery, Secure Payment, Best Local Prices, Real Support) sits below the
package grid on the storefront. The copy is static in `renderStore()` in
`index.html` — edit it there if you want different wording.

In the buy modal's payment box, tapping the small copy icon next to your
MoMo number copies it straight to the customer's clipboard (with a fallback
for older browsers that don't support the Clipboard API).

## 7e. Business logo

**Store Setup → Business Logo** lets you upload an image (same 5MB limit
and Drive-backed storage as the carousel) shown next to your store name in
both the storefront nav and the admin sidebar, replacing the default icon.
Remove it any time to revert to the default.

## 7f. Dashboard sales chart

The admin **Dashboard** tab now includes a 14-day sales/profit line chart
(a hand-rolled inline SVG — no charting library) fed by `getDashboardStats_()`
in `Code.gs`, which buckets delivered/processing/paid orders by day for the
last 14 days. It fills in automatically as orders come through; a new store
just shows a flat line at zero until then.

## 8. Icons & system color

Every icon in the app (nav, buttons, stat cards, status dots) is a small
inline SVG defined in the `ICON_PATHS` object near the top of `index.html`'s
script — no emoji, no external icon font/CDN, so it renders identically on
every device instead of depending on each platform's emoji set.

In **Store Setup → System Color**, pick a **primary** and **accent** color
with the color pickers; everything else (hover states, gradients across both
the storefront and admin portal) is derived from those two automatically, so
you only ever choose two colors. Changes preview live before you save.

## 8b. Faster loading (SWR-style caching)

Every `google.script.run` call is a real network round trip to Apps
Script's servers, which is inherently slower than a normal web request —
there's no literal npm `swr` package to install here (Apps Script serves
plain HTML/JS, not a bundled app), so this app implements the same
**stale-while-revalidate** idea by hand: the last-known storefront/admin
data is cached in the browser's `localStorage` and rendered *immediately* on
your next visit, while a fresh copy quietly loads in the background and
replaces it the moment it arrives. First visit (or after clearing browser
data) still waits on the real request as before.

Click the refresh icon — top-right of the storefront nav, or "Refresh data"
in the admin sidebar — any time you want to force an immediate reload
instead of waiting for the background revalidation.

## 9. Notes & guardrails already built in

- A selling price can never be saved at or below the current base price — the
  UI and the server both enforce it.
- The admin API (settings, pricing, order actions) is rejected server-side
  for anyone without a valid session token, even if they call it directly —
  there's no client-side-only gate. Passwords are stored salted + hashed
  (SHA-256), never in plain text.
- The storefront never exposes base price or profit — only your selling
  price.
- The web app is deployed with `X-Frame-Options: ALLOWALL`, so you can embed
  either the storefront or admin URL in an `<iframe>` the same way this
  repo's root `index.html` embeds another Apps Script project, if you want a
  custom domain via GitHub Pages.

## 10. Customizing the look

All layout/spacing styling lives in the `<style>` block at the top of
`index.html`. Colors are CSS variables (`--navy`, `--gold`, `--mtn`,
`--telecel`, `--at-1`/`--at-2`, etc.) driven by the System Color picker (see
above) plus the network brand colors, which stay fixed since they're each
network's real brand identity.

Both the storefront and admin portal are mobile-responsive: the network
tabs/package grid reflow, tables scroll horizontally instead of breaking the
page, modals become bottom sheets, the admin sidebar collapses behind a menu
button below ~820px, and form inputs use 16px font on small screens to stop
iOS Safari's auto-zoom-on-focus.
