# Data Bundle Store — Google Apps Script

A self-serve storefront for reselling **MTN**, **Telecel**, and **AirtelTigo** data
bundles, plus a private admin portal (locked to your Google account) where you
sync base prices from Geosam, set your own selling prices, and track your
profit per order.

- `Code.gs` — backend: Google Sheets as the database, all server logic, and the
  Geosam API adapter.
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
authorize the script (Sheets + URL Fetch access) — approve it.

This creates two sheets:
- **Packages** — `ID, Network, Size, Validity, BasePrice, SellingPrice, GeosamCode, Active, LastSynced`
- **Orders** — `OrderID, Timestamp, CustomerName, RecipientPhone, PayerPhone, Network, Size, SellingPrice, BasePrice, Profit, MoMoRef, Status, GeosamOrderId, Notes, UpdatedAt`

It also seeds **mock pricing** for all three networks so your storefront isn't
empty while you finalize your Geosam integration. Mock prices are clearly
illustrative — replace them with real Geosam base prices once you're synced
(see step 5).

## 3. Deploy the web app

**Deploy → New deployment → type: Web app.**
- Execute as: **Me**
- Who has access: **Anyone**

Click **Deploy** and copy the web app URL — that's your storefront link
(`.../exec`). Share that with customers.

## 4. Claim admin access

Open `YOUR_WEB_APP_URL?page=admin` while signed into the Google account you
want as the store owner, and click **Claim Admin Access**. This is a one-time
action — whichever Google account claims it first is permanently the only
account that can manage pricing, orders, and settings. (If you ever need to
change the owner, edit the `OWNER_EMAIL` script property directly in
**Project Settings → Script properties**.)

Bookmark the `?page=admin` URL — that's your private dashboard.

## 5. Connect Geosam (when you're ready)

The app ships with **API Mode = Mock**, so pricing and order fulfillment are
simulated with sample data — enough to build your storefront and test the
whole order flow end-to-end before touching the real API.

When you have Geosam's real API docs:

1. Open `Code.gs`, find the **GEOSAM ADAPTER** section (clearly marked).
2. Fix `GEOSAM_ENDPOINTS` (the real path for listing packages / placing a
   purchase), the auth header in `geosamRequest_()` (Geosam may use
   `x-api-key` instead of `Authorization: Bearer`), and the response-shape
   mapping inside `fetchGeosamPackages_()` / `buyGeosamBundle_()`.
3. In the admin **API Settings** tab, paste your Geosam API base URL and key,
   switch **API Mode** to **Live**, and click **Test connection**.
4. Go to **Pricing → Sync from Geosam** for each network to pull real base
   prices. Your selling prices you've already set are preserved; only base
   prices/codes update.

Everything else in the app (orders, pricing UI, dashboard) talks only to
`fetchGeosamPackages_()` / `buyGeosamBundle_()` — you never need to touch
anything else to wire up the real API.

## 6. How the money flow works

1. Customer picks a bundle, sees your MoMo number/name/amount, pays, then
   submits the order with their MoMo reference. Order status:
   **Pending Payment**.
2. You check your MoMo statement. If it matches, click **Mark Paid** in
   Orders. Status: **Paid - Awaiting Fulfillment**.
3. Click **Fulfill via Geosam** — this calls `buyGeosamBundle_()` (mock or
   live) and moves the order to **Processing** then **Delivered** (or
   **Failed** with a reason, if Geosam rejects it).
4. Profit (`SellingPrice - BasePrice`, snapshotted at order time) only counts
   toward your Dashboard totals once the order reaches Paid, Processing, or
   Delivered — never for orders still awaiting payment.

## 7. Notes & guardrails already built in

- A selling price can never be saved at or below the current base price — the
  UI and the server both enforce it.
- The admin API (settings, pricing, order actions) is rejected server-side
  for anyone who isn't the claimed owner, even if they load `?page=admin`
  directly — there's no client-side-only gate.
- The storefront never exposes base price or profit — only your selling
  price.
- The web app is deployed with `X-Frame-Options: ALLOWALL`, so you can embed
  either the storefront or admin URL in an `<iframe>` the same way this
  repo's root `index.html` embeds another Apps Script project, if you want a
  custom domain via GitHub Pages.

## 8. Customizing the look

All styling lives in the `<style>` block at the top of `index.html` as CSS
variables (`--navy`, `--gold`, `--mtn`, `--telecel`, `--at-1`/`--at-2`, etc.) —
change those to re-theme the whole app without touching layout markup.
