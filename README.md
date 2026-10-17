# PG Manager

A simple app for running **PGs and hostels**, made from the Property Manager
CRM (which stays on its own branch). There are **no rooms**: each PG has its
**total beds** and its **bed prices** as qty × rate lines, the beds are created
for you, and every occupied bed has a **guest record** with all their details.

Live beta: **https://neofinn.github.io/property-manager-/pg/**

## Features

| Section | What it does |
| --- | --- |
| **Dashboard** | Beds occupied / vacant / booked, active guests, rent collected vs expected this month, overdue rent, deposits held, unpaid expenses, and everything that needs attention |
| **Bed board** | Every bed of every PG, grouped by bed type: vacant (with its rate), occupied (guest's name), booked, or under maintenance. Tap a vacant bed to check a guest in; tap an occupied bed to open the guest |
| **Reminders** | Rent due, overdue and upcoming, with one-click WhatsApp / SMS / Email; guests checking out and bookings arriving in the next 7 days; expenses due; documents expiring or awaiting verification |
| **Guests** | The CRM: name, phone, PG and bed, status (Active / Booked / Checked out), check-in and check-out dates, monthly rent, deposit, rent due day, email, gender, date of birth, occupation, college / company, food preference, permanent address, ID type and number, ID proof and photo uploads, police verification, emergency contact, vehicle number and notes. **Check in**, **Check out** (frees the bed) and **+ Payment** buttons |
| **PGs** | Name, address, city, who it's for, **total beds**, **bed prices** (bed type · qty · rate / bed = amount, with a monthly total, added with **+ Add line**), default bed rate, rent due day, meals, gate in-time, visiting hours, warden and owner |
| **Beds** | Created from the PG's price lines (B1, B2, …) with their type and rate; each can be edited or marked under maintenance / blocked |
| **Payments** | Rent, deposit, electricity, food or other payments per guest and month, with method and transaction reference. Partial payments are supported |
| **Expenses** | Electricity, water, groceries, salaries, rent to owner, repairs… with due dates and paid status |
| **Documents** | ID proofs, police verification, agreements and licences for a guest or PG, with who verified them and expiry dates |
| **Staff & contacts** | Owner, warden, cook, cleaner, security, plumber, electrician, grocery… with their available hours |

### Beds and prices

- Fill **Bed prices** with one line per bed type, e.g. `3-sharing · 6 × ₹6,500`
  and `Single AC · 2 × ₹14,000`. Leave **Total beds** empty and it becomes the
  sum of the quantities (8 here); set it higher and the extra beds use the
  **Default bed rate**.
- Beds are added, never removed, when you raise the numbers. Changing a line's
  rate updates the beds of that type. A guest keeps the rent agreed at check-in.
- A bed holds one guest at a time (an active guest or a booking). Checking a
  guest out (status **Checked out**) frees the bed and fills in the check-out date.

### Rent reminders

For every active guest, rent is due each month on their due day (or the PG's).
The first month's rent is due on the check-in date, and nothing is due after
the check-out month. Rent payments for that month are subtracted; anything
outstanding gets a ready-to-send message with **WhatsApp**, **SMS**, **Email**
and **Copy text** buttons. Each reminder you send is logged. **Record payment**
opens a payment form already filled in.

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
  active this week, PGs, guests and beds across the platform, rent
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
| `pgm` | `companies` (accounts), `sessions`, `feedback`, `settings`, `admin_sessions`, `admin_log` |
| `pgm_company_1`, `pgm_company_2`, … | One schema per company: `pgs`, `beds`, `guests`, `payments`, `bills` (expenses), `documents`, `contacts`, `files` (uploads), `reminder_log` |

Nothing goes in `public`, so PG Manager can share a Supabase project with the
Property Manager app (which uses `public` and `company_<id>`).

The app connects as the database owner and enforces access itself, so keep
the connection string secret and leave Supabase's public API keys unused.

## Deploying for beta testing

The app ships as a Docker image. With `DATABASE_URL` (Supabase) all data is in
the database, so the server needs no disk and can restart freely. Without it,
data is stored under `/data`, which then needs a **persistent volume**. Serve it
over **HTTPS**, which every host below does for you.

### Live: GitHub Pages + Supabase (current hosting)

The beta runs at **https://neofinn.github.io/property-manager-/pg/** with no
server to manage, next to Property Manager (which is at the site root):

- **Pages** (`dist-pages/`, built by `npm run build:pages`) are published in the
  `pg/` folder of the `gh-pages` branch.
- **API** runs as the Supabase Edge Function `pg-manager` in the *Property
  Manager* Supabase project, at `/functions/v1/pg-manager/api/…`.
  `npm run build:edge` bundles `src/` into `supabase/functions/pg-manager/index.js`;
  the deployed function is a one-line loader that imports that file from this
  branch at a fixed commit.
- **Data** is in the same project's Postgres, in the `pgm` schemas.
- **Admin page:** `https://neofinn.github.io/property-manager-/pg/admin.html`. It
  works once the function secret `PGM_ADMIN_PASSWORD` (or `ADMIN_PASSWORD`,
  shared with Property Manager) is set (Supabase → Edge Functions → Secrets).

Logins use a token in a request header (`X-Session` / `X-Admin-Session`, kept in
the browser's storage under `pgm-…` keys, separate from Property Manager's).

To ship a change:

1. `npm run build:edge`, commit and push, then redeploy the `pg-manager`
   function with its import pointing at the new commit SHA.
2. `npm run build:pages` and replace the `pg/` folder of the `gh-pages` branch
   with `dist-pages/`.

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

Every push to the `pg-manager` branch runs the tests, then builds and publishes an image to
GitHub Container Registry. Run it on any machine with Docker:

```bash
docker run -d -p 3000:3000 -v pgm-data:/data ghcr.io/neofinn/property-manager-pg-manager:latest
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
docker build -t pg-manager .
docker run -d -p 3000:3000 \
  -e DATABASE_URL='postgresql://…' -e ADMIN_PASSWORD='…' -e TRUST_PROXY=1 pg-manager
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
src/reminders.js     Rent, expense, check-out/arrival and document reminders, plus dashboard stats
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
`X-Requested-With: fetch`. `:resource` is one of `pgs`, `beds`, `guests`,
`payments`, `bills` (expenses), `documents`, `contacts`.

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
