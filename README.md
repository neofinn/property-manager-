# Property Manager CRM

A self-hosted CRM for landlords and property managers. It keeps records of
**properties, tenants, rent agreements, rent payments, bills, contacts,
verified documents and timings**, and sends **rent reminders** to tenants.

No dependencies: it runs on Node.js alone, using the built-in SQLite module.

## Features

| Section | What it tracks |
| --- | --- |
| **Dashboard** | Occupancy, rent collected vs expected this month, overdue rent, unpaid bills, and everything that needs attention |
| **Reminders** | Rent due, overdue and upcoming; bills due; agreements expiring within 60 days; documents expiring or awaiting verification; upcoming appointments. Look ahead from today up to 60 days |
| **Properties** | Name, type (PG / Hostel, Independent House, BnB, Apartment, Villa, Commercial…), address, expected rent, status, owner. PG/hostel properties also record who they're for (gents, ladies, students…), the meal plan, gate in-time, visiting hours and the warden |
| **Bed board** | One screen for each PG/BnB showing every room and bed: vacant, occupied (with the tenant's name) or reserved/under maintenance. Click a vacant bed to add a tenant to it |
| **Rooms** | Room number, floor, sharing (single/double/triple…), number of beds, rent per bed or per room, AC, attached bathroom. Beds are created automatically |
| **Beds** | Each bed in a room, with its own rent and status, and who is staying in it |
| **Tenants** | Contact details, property, room and bed (for PG/BnB) or unit, move-in and move-out dates, ID type and number, emergency contact |
| **Agreements** | Property (and room/bed for PG), tenant, start and end dates, monthly rent, security deposit, rent due day, notice period |
| **Rent payments** | Payments per rent month, with method (cash/UPI/bank/cheque/card) and transaction reference. Partial payments are supported |
| **Bills** | Electricity, water, gas, internet, maintenance, property tax, insurance, repairs. Due dates, paid by owner or tenant, paid status |
| **Documents** | Uploaded ID proofs, police verification, agreements, deeds and receipts linked to a tenant, property or agreement. Tracks who verified each one and when, and its expiry date |
| **Contacts** | Owners, plumbers, electricians, agents, lawyers and others, with their available hours |
| **Timings** | Property visits, maintenance, inspections, rent collection, move-in and move-out appointments |

### PG / hostel and BnB: room-wise and bed-wise

PG and hostel tenants are tracked bed by bed, and BnB guests room by room:

1. Add a property with type **PG / Hostel** or **BnB**.
2. Add its rooms with the number of beds and the rent per bed. Beds named *Bed 1, Bed 2…* are created for you, and you can rename them, for example to *Upper* or *Window*.
3. Assign tenants and agreements to a bed, or to a room that has no beds. In the form, the Room list shows only that property's rooms and the Bed list shows only that room's beds and who is in each. Picking a bed fills in the room and property. A new agreement takes the bed's rent unless you enter one.

The app won't put two active tenants on one bed, or give a bed two active agreements whose dates overlap. When an agreement covering today is saved, the tenant's room and bed are updated to match. Rent reminders name the exact bed, for example *"Sunrise PG, Room 101, Bed 2"*. The dashboard shows how many PG beds are filled.

### Rent reminders

For every active agreement, the app works out the rent due each month from the
agreement's due day. In the first month, rent is due on the move-in date. It
then subtracts what has been paid for that month. For anything outstanding it
prepares a ready-to-send message with one-click **WhatsApp**, **SMS** and
**Email** buttons, plus **Copy text**. Each reminder you send is logged, so you
can see when a tenant was last reminded. **Record payment** opens a payment form
already filled in with the outstanding amount.

Agreements that are about to expire get a renewal reminder in the same way.

### Accounts

Each company signs up with its **company name, manager name, phone number and
password**, then logs in with the phone number and password. Every company's
records and uploaded documents are kept separately (their own Postgres schema, or
their own SQLite file), so companies never see each other's data. A new account can load **sample data** from the
dashboard to try every feature. The **Feedback** button in the top bar sends
comments to you (see `npm run feedback`).

On a phone, open the site and choose **Add to Home Screen** (Android: *Install
app*). It then opens full-screen like a normal app.

### Developer admin (`/admin`)

Set `ADMIN_PASSWORD` and open `/admin`. It is turned off (404) when no admin
password is set.

- **Overview:** number of companies, new sign-ups this week and month, companies
  active this week, properties, tenants and PG beds across the platform, rent
  recorded this month, open feedback, and a chart of daily sign-ups.
- **Companies:** every company with its usage and last activity. Actions:
  export its data as JSON, sign it out everywhere, reset its password,
  suspend or reactivate it, and delete it (you type the name to confirm).
- **Feedback:** messages from the in-app Feedback button; mark them resolved.
- **Controls:** open or close sign-ups, set an invite code, switch on
  maintenance mode (everything read-only), and show a notice banner to every user.
- **Activity log:** every admin action, with time.

## Getting started

Requires **Node.js 22.13 or newer**.

```bash
npm install
cp .env.example .env   # optional: DATABASE_URL, ADMIN_PASSWORD, …
npm start              # http://127.0.0.1:3000, then sign up
npm run seed           # optional: demo account (phone 9999999999, password demo12345) with sample data
npm run feedback       # list sign-ups and feedback in the terminal
npm test               # SQLite; add TEST_DATABASE_URL=postgres://… to run the same tests on Postgres
```

`npm start` reads `.env` if there is one.

### Database: Supabase (Postgres) or SQLite

Without `DATABASE_URL` the app keeps everything in SQLite files under
`DATA_DIR`. That's fine on your own computer or in a codespace.

For the hosted platform, use **Supabase**:

1. Create a project at [supabase.com](https://supabase.com) (the free plan works).
2. Click **Connect** at the top of the project, choose **Session pooler**, and copy
   the connection string. Put your database password in it.
   Use the session pooler (port 5432) or the direct connection, not the
   transaction pooler (port 6543): the app sets the schema per connection.
3. Set it as `DATABASE_URL` (in `.env`, your host's settings, or a Codespaces
   secret) and restart the app.

Tables are created automatically on first start. In Supabase's **Table editor**:

| Schema | What's in it |
| --- | --- |
| `public` | `companies` (accounts), `sessions`, `feedback`, `settings`, `admin_sessions`, `admin_log` |
| `company_1`, `company_2`, … | One schema per company: `properties`, `tenants`, `rooms`, `beds`, `agreements`, `rent_payments`, `bills`, `documents`, `contacts`, `schedules`, `files` (uploaded documents), `reminder_log` |

The app connects as the database owner and enforces access itself, so keep
the connection string secret and leave Supabase's public API keys unused.

## Deploying for beta testing

The app ships as a Docker image. With `DATABASE_URL` (Supabase) all data is in
the database, so the server needs no disk and can restart freely. Without it,
data is stored under `/data`, which then needs a **persistent volume**. Serve it
over **HTTPS**, which every host below does for you.

### Live: GitHub Pages + Supabase (current hosting)

The beta runs at **https://neofinn.github.io/property-manager-/** with no server
to manage:

- **Pages** (`dist-pages/`, built by `npm run build:pages`) are published on the
  `gh-pages` branch, which GitHub Pages serves.
- **API** runs as the Supabase Edge Function `api` in the *Property Manager*
  project. `npm run build:edge` bundles `src/` into
  `supabase/functions/api/index.js`; the deployed function is a one-line loader
  that imports that file from this repository at a fixed commit.
- **Data** is in the same Supabase project's Postgres (connection provided to the
  function automatically as `SUPABASE_DB_URL`).
- **Admin page:** `https://neofinn.github.io/property-manager-/admin.html`. It works once
  the function secret `ADMIN_PASSWORD` is set (Supabase → Edge Functions → Secrets).

Because pages and API are on different sites, logins use a token in a request
header (`X-Session` / `X-Admin-Session`, kept in the browser's storage) instead
of a cookie, and the function only accepts the page origin set in
`ALLOWED_ORIGINS` (default `https://neofinn.github.io`).

To ship a change:

1. `npm run build:edge`, commit and push, then redeploy the `api` function with
   its import pointing at the new commit SHA.
2. `npm run build:pages` and replace the contents of the `gh-pages` branch with
   `dist-pages/`.

### claude.ai demo link (no server needed)

`npm install && npm run build:demo` builds `dist/property-manager-demo.html`,
one page that holds the whole app: the pages, the API and a SQLite engine.
Published as a claude.ai artifact, each tester signs up and their company's
data is saved privately in the artifact's per-person storage. Sign-ups and
feedback are saved where only the owner can read them. Share the artifact
with testers as **Contributor** so they can save. The page can only be shared
inside your claude.ai organization, or by email invitation.

### GitHub Codespaces (free, runs directly on GitHub)

The fastest way to get a link you can share. It's free for about 60 hours a
month on a personal GitHub account.

1. On the repository page, click **Code → Codespaces → Create codespace on main**.
2. Wait about 2 minutes. The app starts by itself, and the terminal prints its
   link, `https://<codespace-name>-3000.app.github.dev`.
3. Open the **Ports** tab. If port 3000 isn't marked *Public*, right-click it
   and choose **Port visibility → Public**.
4. Send that link to your testers.

Without `DATABASE_URL`, accounts and data are saved in the codespace's `data`
folder and survive the codespace stopping. To use Supabase, add `DATABASE_URL`
(and `ADMIN_PASSWORD`) as Codespaces secrets in GitHub **Settings → Codespaces →
Secrets**, or put them in a `.env` file in the codespace. GitHub stops an idle codespace after 30 minutes, and the
link stops working until you start it again from **Code → Codespaces**. You
can raise the timeout to 4 hours in GitHub **Settings → Codespaces → Default
idle timeout**. This suits a small beta. For a link that stays up around the
clock, use one of the hosts below.

### Docker image from GitHub

Every push to `main` runs the tests, then builds and publishes an image to
GitHub Container Registry. Run it on any machine with Docker:

```bash
docker run -d -p 3000:3000 -v pm-data:/data ghcr.io/neofinn/property-manager:latest
```

Then open http://localhost:3000. If the repository is private, run
`docker login ghcr.io` first, using your GitHub username and a token with
`read:packages`. To reach the app from other devices, run it on a server
or VPS and put HTTPS in front of it.

### Render (blueprint included)

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint**, pick the repository, and Render reads
   `render.yaml`.
3. Fill in `DATABASE_URL` (your Supabase session pooler string) and
   `ADMIN_PASSWORD`. `BETA_INVITE_CODE` is optional.
4. Share the `https://….onrender.com` link with your testers. Your admin area is
   at `https://….onrender.com/admin`.

The blueprint uses Render's *Free* plan: all data is in Supabase, so nothing is
lost when Render puts the app to sleep. A sleeping free app takes about a minute
to wake on the next visit.

### Any Docker host (Railway, Fly.io, a VPS…)

```bash
docker build -t property-manager .
docker run -d -p 3000:3000 \
  -e DATABASE_URL='postgresql://…' -e ADMIN_PASSWORD='…' -e TRUST_PROXY=1 property-manager
```

Without `DATABASE_URL`, mount a volume at `/data` (`-v pm-data:/data`). Set `TRUST_PROXY=1` when the app runs behind
the host's HTTPS proxy. `GET /healthz` returns `ok` for health checks.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `DATABASE_URL` | *(unset)* | Postgres connection string (Supabase session pooler). When unset, SQLite files in `DATA_DIR` are used |
| `ADMIN_PASSWORD` | *(unset)* | Turns on the developer admin area at `/admin` |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite storage when `DATABASE_URL` is unset |
| `DATABASE_POOL_SIZE` | `10` | Maximum Postgres connections |
| `BETA_INVITE_CODE` | *(unset)* | When set, signing up requires this code. Can also be set in `/admin` → Controls |
| `DEFAULT_COUNTRY_CODE` | `91` | Added to 10-digit phone numbers typed without a country code |
| `CURRENCY` | `INR` | ISO currency code used to format amounts |
| `TRUST_PROXY` | *(unset)* | Set to `1` behind a reverse proxy, so secure cookies and login rate limits use the real client details |

Passwords are stored as salted scrypt hashes. Sessions use an HttpOnly,
SameSite cookie that lasts 30 days. Logins are rate-limited.

Back up with Supabase's backups (or `pg_dump`), or by copying the `DATA_DIR`
folder when using SQLite. Every list can also be
exported to CSV. If you used the app before accounts were added, the first
account to sign up takes over the existing data.

## Project layout

```
server.js            HTTP entry point
src/schema.js        Entity definitions (fields, types, relations); the UI and API are generated from them
src/database/        SQLite and Postgres backends behind one async interface
src/db.js            Creates and migrates a company's tables
src/store.js         Validation and CRUD
src/reminders.js     Rent, bill, agreement, document and schedule reminders, plus dashboard stats
src/api.js           The company API, shared by the server and the claude.ai demo
src/app.js           HTTP server: routing, cookies, static files
src/platform.js      Companies, logins, feedback, settings, admin actions, per-company storage
src/admin.js         /api/admin routes
src/files.js         Uploaded documents, stored in the company's database
src/sample.js        Sample data
src/browser/         The in-page backend for the claude.ai demo
src/edge/            The API as a Supabase Edge Function handler
supabase/functions/  Built Edge Function (npm run build:edge)
public/api-client.js Sends /api calls to the Edge Function when hosted on static pages
public/              Single-page web app (vanilla JS, no build step), sign-in page, admin page, installable-app files
scripts/             Demo account (seed) and feedback report
Dockerfile, render.yaml  Deployment
.devcontainer/        GitHub Codespaces setup
.github/workflows/    Tests on every push, Docker image publishing
test/                API tests (node:test)
```

## API

All endpoints return JSON. They need a logged-in session cookie, except
`/api/auth/*`, and requests other than GET must send the header
`X-Requested-With: fetch`. `:resource` is one of `properties`, `tenants`,
`rooms`, `beds`, `agreements`, `rent_payments`, `bills`, `contacts`, `documents`, `schedules`.

| Method & path | Description |
| --- | --- |
| `POST /api/auth/signup` | `{company_name, manager_name, phone, password, invite_code?}`: create an account and log in |
| `POST /api/auth/login` / `POST /api/auth/logout` | `{phone, password}` |
| `GET /api/auth/me` | The logged-in company |
| `POST /api/sample-data` | Load sample data into an empty account |
| `POST /api/feedback` | `{message, page}` |
| `GET /api/:resource?q=&<field>=&sort=&dir=` | List, with search and exact-match filters |
| `POST /api/:resource` | Create a record |
| `GET /api/:resource/:id` | Get one record |
| `PATCH /api/:resource/:id` | Update the fields you send |
| `DELETE /api/:resource/:id` | Delete a record |
| `GET /api/:resource/options` | `{id, label}` pairs for dropdowns |
| `GET /api/:resource/export.csv` | CSV export |
| `GET /api/documents/:id/file` | Download an uploaded document |
| `GET /api/reminders?days=7` | Everything due within the next `days` days |
| `POST /api/reminders/log` | `{key, channel}`: record that a reminder was sent |
| `GET /api/dashboard` | Summary stats and reminders |
| `/api/admin/…` | Admin area (separate admin cookie): `login`, `logout`, `analytics`, `feedback`, `settings`, `log`, `companies/:id/{export,suspend,activate,sign-out,reset-password}`, `DELETE companies/:id` |

To upload a file, send it in the `file` field as `{ "name", "type", "data" }`,
where `data` is base64. The limit is 10 MB.
