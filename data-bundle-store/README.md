# Data Bundle Store — Google Apps Script

A self-serve storefront for reselling **MTN**, **Telecel**, and **AirtelTigo** data
bundles, plus a private admin portal (locked to your Google account) where you
set your own selling prices, fulfill orders through Geosam's Send Bundle API,
and track your profit per order.

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
- **Packages** — `ID, Network, Size, Validity, AmountMB, BasePrice, SellingPrice, Active, LastUpdated`
- **Orders** — `OrderID, Timestamp, CustomerName, RecipientPhone, PayerPhone, Network, Size, SellingPrice, BasePrice, Profit, MoMoRef, Status, GeosamOrderId, Notes, UpdatedAt`

It also seeds **starter pricing** for all three networks so your storefront
isn't empty on day one. These are illustrative placeholder prices — verify
and correct them against your real Geosam dashboard/shop pricing before
going live (see step 5 — Geosam's API doesn't expose a price list, so this
is always a manual step).

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

## 5. Connect Geosam

This app is wired to Geosam's actual published API
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

Setup:
1. In the admin **API Settings** tab, paste your Geosam API token, switch
   **API Mode** to **Live**, and click **Test connection** (a safe, read-only
   check against Account Status — it won't send a real bundle).
2. Click **Check wallet balance** any time to see your live MTN/Telecel/
   AirtelTigo balances.
3. Add your real packages in the **Pricing** tab with accurate base prices
   and MB amounts (delete/edit the starter rows first — they're illustrative
   estimates, not real Geosam prices).

Everything Geosam-specific lives in the **GEOSAM ADAPTER** section of
`Code.gs` (`buyGeosamBundle_()`, `checkGeosamTransactionStatus_()`,
`getGeosamWalletBalance()`) — if Geosam changes their API, that's the only
section to touch.

## 6. How the money flow works

1. Customer picks a bundle, sees your MoMo number/name/amount, pays, then
   submits the order with their MoMo reference. Order status:
   **Pending Payment**.
2. You check your MoMo statement. If it matches, click **Mark Paid** in
   Orders. Status: **Paid - Awaiting Fulfillment**.
3. Click **Fulfill via Geosam** — this calls Send Bundle with a freshly
   generated reference. Geosam's API is **asynchronous**: a successful reply
   only means "request received and is being processed," so the order moves
   to **Processing**, not straight to Delivered.
4. Click **Check Geosam Status** on a Processing order to poll Transaction
   Detail — it updates the order to **Delivered** once Geosam confirms
   completion, or **Failed** with Geosam's reason if it didn't go through.
   Safe to click repeatedly. "Mark Delivered" is also available as a manual
   override if you confirm delivery another way.
5. Retrying a failed fulfillment generates a brand-new Geosam reference each
   time, so it never collides with a previous attempt ("Duplicate reference
   detected").
6. Profit (`SellingPrice - BasePrice`, snapshotted at order time) only counts
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
