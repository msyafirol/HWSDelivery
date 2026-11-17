# HWOTG Delivery Tracking: developer guide

Spare-part delivery tracking for HWS (Hardware Support): a request goes from a warehouse to a store or site, through vendor and driver, with proof of collection and delivery, SLA tracking and costing. HWS, vendors, drivers and regional stores share it.

- Live site: https://hwotg-delivery-tracking.onrender.com (Render, deployed from `main`)
- History: pull requests #1 to #10 each explain one change and how it was tested. Read them in order to see how the app grew.

## Run it

Requires Node.js 22.5 or newer. There are no npm dependencies.

```
npm start                 # http://localhost:3000, data in ./data
PORT=3456 DATA_DIR=/tmp/hw npm start
npm run build:offline     # rebuilds dist/hwotg-offline.html
```

First run creates the Administrator `msyafirol` with password `admin123`, or `ADMIN_PASSWORD` if set. It also creates the Central Warehouse Shah Alam, the Northern Hub Bayan Lepas and 16 state service points, with no other data. Delete the data folder to start again.

## Files

| File | What it is |
|---|---|
| `server.js` | The whole backend: HTTP server, sign-in, SQLite database (`node:sqlite`), permission checks, email. About 400 lines. |
| `public/index.html` | The whole user interface: one page, plain JavaScript, no framework or build step. |
| `offline/local-backend.js` | The same API as `server.js`, running in the browser on IndexedDB, for the offline edition. |
| `offline/vendor/` | Fonts and the Excel/PDF libraries (SheetJS 0.18.5, jsPDF 2.5.1, jspdf-autotable 3.8.2) that the offline file embeds. |
| `build-offline.js` | Inlines the page, the libraries and `local-backend.js` into `dist/hwotg-offline.html`. |
| `dist/hwotg-offline.html` | The offline edition: one file, no server, data stays in that browser. Committed so it can be downloaded. |
| `Dockerfile`, `render.yaml` | Deployment: Node 22 Alpine, data on a disk mounted at `/data`. |

**Rule:** a change to permissions, data scoping or sync rules goes in **both** `server.js` and `offline/local-backend.js`. Then run `npm run build:offline` and commit `dist/` too.

## How the page talks to the server

The page keeps a full copy of the data this user may see in memory (`DB`), and renders everything from it.

1. **Load:** on sign-in, `GET /api/data` returns a snapshot scoped to the user (see *Roles and data scoping*). It has no password hashes, and routes and audit are only included when allowed.
2. **Change:** UI code edits `DB` directly and calls `save()`. `save()` compares `DB` with the last snapshot and posts only the changed records to `POST /api/sync` as `{upserts:{coll:[...]}, deletes:{coll:[ids]}, settings:{...}}`. Deletes are only sent for `users`, `drivers`, `bases`, `routes` and `reqs`.
3. **Check:** the server validates every record against the user's role and permissions, inside one transaction. A refusal returns 403, and the page reloads the latest data.
4. **Refresh:** every page polls `GET /api/version` every 10 s and reloads `/api/data` when it changes. Open forms are not re-rendered while someone is typing (`busy()`).
5. **Request numbers** come from `POST /api/seq`, so two people never get the same number. The format is `HWOTG-YYMM-<id>`.
6. **Photos, signatures and attachments** arrive as data URLs. The server moves them into the `blobs` table and replaces them with `/api/blob/<id>`, which is only served to signed-in users.

Other endpoints:

| Endpoint | Purpose |
|---|---|
| `/api/login`, `/api/logout` | Sign in and out |
| `/api/password` | Change your own password |
| `/api/mail` | Email setup status and log |
| `/api/mail/test` | Send a test email |
| `/api/health` | Render health check |

### Database (SQLite, `DATA_DIR/hwotg.db`)

| Table | Contents |
|---|---|
| `records` | Every record as `(coll, id, JSON)`. Collections: `users`, `vendors`, `drivers`, `bases`, `routes`, `reqs`, `notifs`, `audit`. |
| `meta` | `settings` (SLA, surcharges, notification channels, role permissions), `seq`, `version`, `maillog`, `seeded` |
| `secrets` | scrypt password hashes |
| `sessions` | session tokens, sent as an HttpOnly cookie that lasts 14 days |
| `blobs` | file contents |

New fields are optional, and old records without them keep working. That is how every update so far has shipped without a data migration. Keep it that way: read new fields with a default.

## The job workflow

```
Request created --HWS validates, picks vendor--> Pending Vendor Assignment
  --vendor PIC assigns driver + slot--> Driver Assigned
  --driver: job no., GPS, photo--> Collected from Warehouse --driver--> In Transit
  --driver: GPS, photo, receiver name + signature-->
       store destination:        Completed  (the receiver's signature completes the job)
       HWS-received destination: Delivered --HWS accepts--> Completed
                                           --HWS rejects--> Rejected --HWS re-dispatches--> back to start
```

Each step is a timestamp in `r.t`: `created`, `validated`, `assigned`, `collected`, `transit`, `delivered`, `decided`, `vconfirm` and `completed`. Each step also records who did it in `r.who` and a note in `r.notes`. `statusOf(r)` works the status out from those timestamps, so there is no status field.

- **How a job finishes:** `r.done` is `'signed'` (completed on the receiver's signature) or `'accepted'` (completed when HWS accepts). Jobs from before this change have no `done` and keep the old store-accept, vendor-confirm and HWS-close steps (`flowOf(r)` returns `'old'`).
- **HWS-received bases**, such as Mapletree Warehouse, have a `hwsAccept` tick on the base. If it is not set, Warehouse and Hub bases count as HWS-received (`hwsRecv(b)`).
- **Multi-stop jobs:** `from2` (2 collection points → 1 destination) or `to2` (1 collection point → 2 destinations). The stop order is collection points, then destinations (`stopsOf(r)`). Proof and acceptance happen once per job.
- **Other request fields:** `ref` is the requester's own Request No. (required). `day` is Weekday, Weekend or Public holiday (it picks the rates). There are also `prio`, `qty`, `item` and `files` (pickup and drop attachments).
- **Admin undo:** `undoStep` removes the newest step and what it captured, such as proof or cost. Undoing a signed completion goes back to In Transit. Undoing an HWS acceptance goes back to Delivered.
- **Notifications:** `notify(r, kind)` adds a record to `notifs` with target roles. The server emails new ones (see *Email*). The page shows a pop-up, plays a chime and speaks a role-specific voice line (`VOICE`, using the browser's speech synthesis).

## Roles, permissions and data scoping

Roles are `admin`, `manager`, `hws` (the HWS group), `vendor` (Vendor Admin), `vendorco` (Vendor Co-admin / Assistant), `driver` and `user` (Regional User).

**What a role can do** comes from tick-box permissions: `PERM_DEFAULTS` in `server.js` and `local-backend.js`, edited by the Administrator under *Users, bases, rates → Role permissions* and stored in `settings.perms`.

- On the page, `can(key)` decides which menus, tabs, buttons and actions appear.
- On the server, `can(u, key)` enforces the permissions for users, bases, vendors and drivers, routes, deletes, settings and request creation.
- `vendorco` defaults to the same ticks as `vendor`.
- Only the Administrator can change permissions.

**What a role can see** is fixed by role, in `inScope` and `snapshot` on the server and `scope()` on the page:

| Role | Sees |
|---|---|
| HWS roles | everything |
| `vendor` / `vendorco` | jobs with their vendor |
| `driver` | jobs assigned to them |
| `user` | jobs they requested, or jobs going to their store (`to` or `to2`) |

## Pricing (`costOf`)

1. **Main pair** (first collection point → first destination). If a route rate exists for that pair and vendor (or for any vendor), use its price, or its weekend/public holiday price on such days. Otherwise use the vendor formula: base fee + per km × km + toll × km, or air freight for East Malaysia. Each formula rate has a weekday value and an optional weekend/PH value.
2. **Distance:** a manual km on the rate card wins over the calculated distance (haversine × 1.3 + 6 km).
3. **Extra stop:** the extra km at per-km + toll rate, plus the vendor's extra stop fee.
4. **On top of that:** the priority surcharge (Urgent, Critical) and re-dispatch legs.

The cost is fixed on completion or rejection. Open jobs are priced at current rates.

## Email

Email is set with environment variables on Render. It uses SMTP (STARTTLS on 587, or TLS on 465, for example Gmail or Microsoft 365), or the Resend API.

| Variable | Purpose |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP server and login |
| `SMTP_SECURE=1` | Direct TLS on a port other than 465 |
| `MAIL_FROM` | Sender address |
| `RESEND_API_KEY` | Use Resend instead of SMTP |
| `APP_URL` | Base for links in emails |

When the Email channel is on, each new notification is emailed to the active users it targets who have an email address, leaving out the person who acted. Results are logged in `meta.maillog` and shown under *Notifications → Email delivery*.

## Configuration and deploying

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DATA_DIR` | `./data` (Docker: `/data`) | database folder; needs a persistent disk |
| `ADMIN_PASSWORD` | `admin123` | first run only |
| `COOKIE_SECURE` | off | set `1` behind HTTPS (set in `render.yaml`) |

Render redeploys when `main` changes. The data lives on the 1 GB disk at `/data`, so redeploys keep it. To back it up, copy `/data/hwotg.db` (plus the `-wal` file) or use Render disk snapshots. Never commit secrets: they live only in Render's Environment settings.

## How to make and check a change

The work so far has followed this routine:

1. Branch from `main`, make the change, and add it to `local-backend.js` too if it touches rules.
2. Syntax check:
   ```
   node --check server.js
   node --check offline/local-backend.js
   sed -n '/<script>/,/<\/script>/p' public/index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
   ```
3. **Upgrade test:** start the version on `main` (`git worktree add ../live origin/main`) on an empty `DATA_DIR`, create users, vendors and jobs through `/api/login` and `/api/sync`, stop it, then start your branch on the same `DATA_DIR`. All data must load and work.
4. **Browser test** with Playwright (Chromium): sign in as each role in separate contexts and walk the workflow. Check for `pageerror` events. Driver GPS falls back to a simulated position after 9 s when location is unavailable.
5. `npm run build:offline`, open `dist/hwotg-offline.html` from disk with the network blocked, and smoke-test it.
6. Open a pull request into `main` that says what changed and how you tested it. Merging deploys.

## Code map of `public/index.html`

Search for these section comments:

| Section | Contents |
|---|---|
| `store` | `api()`, `save()` / `diff()`, `loadData()`, `refresh()` |
| `reference data` | states, regions, zones, `ROLE`, `isHWS` / `isV` / `can` |
| `geo, SLA, cost` | `kmFor`, `routeKm`, `costOf`, `slaOf` |
| `notifications` | `NOTE`, `notify`, `notifFor`, voice, pop-ups |
| `HWS dashboards` | dashboards, state map, costing, vendor performance |
| `requests` | lists, `viewNew` / `nrSync` / `submitNew` |
| `administration` | users, bases, rate card, vendors, drivers, notifications and email, role permissions, backup (offline only) |
| `job board` | New / Current / Completed per role |
| `navigation` | `NAV()` built from permissions; `#/view/tab/r/<id>` addresses |
| `drawer` | request details, `actions(r)` per role, proof, admin undo |
| `workflow` | `doAction`, `submit*`, `delRecord` |
| `type-to-search for every dropdown` | the searchable `<select>` picker |

## Known limits and ideas

- One collection proof and one delivery proof per job, even with two stops. Per-stop proof would be the next step.
- Teams and SMS channels are listed but not connected.
- Microsoft Entra ID single sign-on is not set up. Sign-in is username and password.
- There is no automated test suite in the repository yet. The checks above were run by hand for each pull request. Turning them into a committed Playwright suite would be a good first task.
