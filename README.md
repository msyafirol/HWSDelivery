# HWOTG Delivery Tracking

A web app for spare-part deliveries from warehouse to store, shared by HWS, vendors, drivers and regional stores. It is one Node.js server with a built-in SQLite database and needs no npm packages.

## Run locally

Requires Node.js 22.5 or newer.

```
npm start
```

Open http://localhost:3000 and sign in as `msyafirol` with password `admin123`, or with `ADMIN_PASSWORD` if you set it. Change the password straight away: open the account menu (top right) and choose **Change password**.

## Fresh start

On first run the database holds only:

- the administrator account `msyafirol`
- the Central Warehouse Shah Alam, the Northern Hub Bayan Lepas and the 16 state service points
- the SLA targets, priority surcharges and notification channels

There are no other users and no vendors, drivers, route rates, jobs, notifications or audit history. To start setting up, go to **Users, bases, rates**:

1. **Vendors**: register each vendor. Tick "Also create a vendor admin login".
2. **Drivers**: register each driver under a vendor. Each driver gets a login.
3. **Users**: register HWS staff, managers and regional users. A regional user needs a store.
4. **Rate card**: add route rates. Jobs with no route rate use each vendor's formula.

New accounts start with the temporary password `welcome123`, unless you type another one. The Administrator can reset any account's password to `welcome123` from the Users table.

To wipe everything and start over, stop the server and delete the data folder.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Folder for the database file `hwotg.db` (photos and attachments included) |
| `ADMIN_PASSWORD` | `admin123` | Administrator password set on first run only |
| `COOKIE_SECURE` | off | Set to `1` when the site is served over HTTPS |

Back up the database by copying `DATA_DIR/hwotg.db` (and the `-wal` file if it exists) while the server is stopped.

## Deploy

The database is a file, so the host must give it **persistent storage**. If it doesn't, data is lost on every redeploy.

### Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New > Blueprint** and pick the repository. `render.yaml` creates a web service with a 1 GB disk mounted at `/data`. Disks need a paid plan (Starter).
3. Set `ADMIN_PASSWORD` when Render asks for it.

### Railway, Fly.io or any Docker host

Build with the included `Dockerfile` and mount a volume at `/data`:

```
docker build -t hwotg .
docker run -d -p 80:3000 -v hwotg-data:/data -e ADMIN_PASSWORD='choose-one' hwotg
```

Put HTTPS in front of it (most hosts do this for you) and set `COOKIE_SECURE=1`.

### A plain VPS

Install Node 22, copy the folder, then run `npm start` under a process manager such as systemd or pm2, behind Nginx or Caddy for HTTPS.

## How it works

- `public/index.html` is the whole user interface.
- `server.js` handles sign-in (scrypt password hashes, HttpOnly session cookies, throttling of failed attempts) and serves each role only the data it may see.
- When someone makes a change, the page sends only the changed records. The server checks the role's permissions before saving.
- Open pages check for updates every 10 seconds, so everyone sees new jobs and status changes without reloading.
- Each role's home page has a **My jobs** board with New, Current and Completed tabs.
- When a transaction reaches you (a new request, an assignment, a delivery, an acceptance and so on), a pop-up appears with a sound. Turn the sound off, or allow desktop alerts for when the tab is in the background, from the account menu.
- The Administrator can undo any workflow step from the request drawer, one step at a time and newest first, or delete a request. Each undo is logged with an optional reason, and the people on the job are notified.
- Photos, signatures and attachments are kept in the database and served only to signed-in users.
