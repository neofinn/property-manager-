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
records and uploaded documents are kept in a separate database, so beta testers
never see each other's data. A new account can load **sample data** from the
dashboard to try every feature. The **Feedback** button in the top bar sends
comments to you (see `npm run feedback`).

On a phone, open the site and choose **Add to Home Screen** (Android: *Install
app*). It then opens full-screen like a normal app.

## Getting started

Requires **Node.js 22.13 or newer**.

```bash
npm start          # http://127.0.0.1:3000, then sign up
npm run seed       # optional: demo account (phone 9999999999, password demo12345) with sample data
npm run feedback   # list beta sign-ups and feedback
npm test
```

## Deploying for beta testing

The app ships as a Docker image. Accounts, data and uploaded documents are all
stored under `/data`, so give it a **persistent volume** there. Without one,
everything is lost when the server restarts. Serve it over **HTTPS**, which
every host below does for you.

### GitHub Codespaces (free, runs directly on GitHub)

The fastest way to get a link you can share. It's free for about 60 hours a
month on a personal GitHub account.

1. On the repository page, click **Code → Codespaces → Create codespace on main**.
2. Wait about 2 minutes. The app starts by itself, and the terminal prints its
   link, `https://<codespace-name>-3000.app.github.dev`.
3. Open the **Ports** tab. If port 3000 isn't marked *Public*, right-click it
   and choose **Port visibility → Public**.
4. Send that link to your testers.

Accounts and data are saved in the codespace's `data` folder and survive the
codespace stopping. GitHub stops an idle codespace after 30 minutes, and the
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
3. When asked for `BETA_INVITE_CODE`, enter a code you'll give your testers.
4. Share the `https://….onrender.com` link and the invite code with them.

The blueprint uses the *Starter* plan, because Render only attaches a
persistent disk to paid instances.

### Any Docker host (Railway, Fly.io, a VPS…)

```bash
docker build -t property-manager .
docker run -d -p 3000:3000 -v pm-data:/data \
  -e BETA_INVITE_CODE=choose-a-code -e TRUST_PROXY=1 property-manager
```

Mount a volume at `/data`, and set `TRUST_PROXY=1` when the app runs behind
the host's HTTPS proxy. `GET /healthz` returns `ok` for health checks.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where accounts, each company's database and uploaded files are stored |
| `BETA_INVITE_CODE` | *(unset)* | When set, signing up requires this code. Strongly recommended for a public beta |
| `DEFAULT_COUNTRY_CODE` | `91` | Added to 10-digit phone numbers typed without a country code |
| `CURRENCY` | `INR` | ISO currency code used to format amounts |
| `TRUST_PROXY` | *(unset)* | Set to `1` behind a reverse proxy, so secure cookies and login rate limits use the real client details |

Passwords are stored as salted scrypt hashes. Sessions use an HttpOnly,
SameSite cookie that lasts 30 days. Logins are rate-limited.

Back up the app by copying the `DATA_DIR` folder. Every list can also be
exported to CSV. If you used the app before accounts were added, the first
account to sign up takes over the existing data.

## Project layout

```
server.js            HTTP entry point
src/schema.js        Entity definitions (fields, types, relations); the UI and API are generated from them
src/db.js            SQLite setup and migrations
src/store.js         Validation and CRUD
src/reminders.js     Rent, bill, agreement, document and schedule reminders, plus dashboard stats
src/app.js           REST API, sessions, per-company databases, file uploads and static files
src/accounts.js      Sign-up, login, sessions and beta feedback
src/sample.js        Sample data
public/              Single-page web app (vanilla JS, no build step), sign-in page, installable-app files
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

To upload a file, send it in the `file` field as `{ "name", "type", "data" }`,
where `data` is base64. The limit is 10 MB.
