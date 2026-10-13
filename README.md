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
| **Properties** | Name, type, address, units, expected rent, status (vacant/occupied/maintenance), owner |
| **Tenants** | Contact details, property and unit, move-in and move-out dates, ID type and number, emergency contact |
| **Agreements** | Property and tenant, start and end dates, monthly rent, security deposit, rent due day, notice period |
| **Rent payments** | Payments per rent month, with method (cash/UPI/bank/cheque/card) and transaction reference. Partial payments are supported |
| **Bills** | Electricity, water, gas, internet, maintenance, property tax, insurance, repairs. Due dates, paid by owner or tenant, paid status |
| **Documents** | Uploaded ID proofs, police verification, agreements, deeds and receipts linked to a tenant, property or agreement. Tracks who verified each one and when, and its expiry date |
| **Contacts** | Owners, plumbers, electricians, agents, lawyers and others, with their available hours |
| **Timings** | Property visits, maintenance, inspections, rent collection, move-in and move-out appointments |

### Rent reminders

For every active agreement, the app works out the rent due each month from the
agreement's due day. In the first month, rent is due on the move-in date. It
then subtracts what has been paid for that month. For anything outstanding it
prepares a ready-to-send message with one-click **WhatsApp**, **SMS** and
**Email** buttons, plus **Copy text**. Each reminder you send is logged, so you
can see when a tenant was last reminded. **Record payment** opens a payment form
already filled in with the outstanding amount.

Agreements that are about to expire get a renewal reminder in the same way.

## Getting started

Requires **Node.js 22.13 or newer**.

```bash
npm start          # http://127.0.0.1:3000
npm run seed       # optional: load sample data into an empty database
npm test
```

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to allow access from other devices |
| `DATA_DIR` | `./data` | Where the SQLite database and uploaded files are stored |
| `CURRENCY` | `INR` | ISO currency code used to format amounts |
| `APP_USER` / `APP_PASSWORD` | `admin` / *(unset)* | When `APP_PASSWORD` is set, every request requires HTTP Basic login |

> The app stores tenants' ID documents. **Set `APP_PASSWORD`** before exposing
> it beyond your own machine, and put it behind HTTPS (for example with a
> reverse proxy).

Back up the app by copying the `DATA_DIR` folder. Every list can also be
exported to CSV.

## Project layout

```
server.js            HTTP entry point
src/schema.js        Entity definitions (fields, types, relations); the UI and API are generated from them
src/db.js            SQLite setup and migrations
src/store.js         Validation and CRUD
src/reminders.js     Rent, bill, agreement, document and schedule reminders, plus dashboard stats
src/app.js           REST API, file uploads and static files
public/              Single-page web app (vanilla JS, no build step)
scripts/seed.js      Sample data
test/                API tests (node:test)
```

## API

All endpoints return JSON. `:resource` is one of `properties`, `tenants`,
`agreements`, `rent_payments`, `bills`, `contacts`, `documents`, `schedules`.

| Method & path | Description |
| --- | --- |
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
