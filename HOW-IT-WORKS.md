# How Treklin works

Treklin (https://treklin.com) is this repository. The GitHub repository is `pchamuczynski/treklin`, and the laptop checkout is `~/git/treklin`. On the VM the app runs as the user `treklin` from `/opt/treklin`. The Google Cloud project id is still `map-runner-v2`. The VM and its boot disk are still named `map-runner`. Those three Google names cannot be renamed in place.

This file is the map of the system: where it is registered, where it runs, how a request is served, and how to change it without guessing. Secrets are named here and stored only in git-ignored env files. They are not written in this document.

Checked against the running VM on 6 November 2026.

## Where everything lives

| What | Where |
| --- | --- |
| Product | Treklin, https://treklin.com |
| Source | https://github.com/pchamuczynski/treklin — `git@github.com:pchamuczynski/treklin.git`. The old repository name `pchamuczynski/map_runner` redirects here. |
| Laptop checkout | `~/git/treklin` |
| Git and the running build | `develop` is commit `0f68e72`, which includes this document. The VM is not a git checkout. The build that is running is the privacy-page deploy from before this document. Copying this file to the VM is not required for the site to run. |
| Domain registrar | Cloudflare Registrar. Registered as treklin.com. |
| DNS | Cloudflare. Nameservers `magnolia.ns.cloudflare.com` and `dexter.ns.cloudflare.com`. The `A` record for `@` is `35.231.154.30` and is grey-cloud (DNS only, not proxied). Leave it grey-cloud so Caddy can renew the certificate. |
| Google account that owns the VM | `p.chamuczynski@gmail.com` |
| Google Cloud project | Id `map-runner-v2` (permanent). Display name Treklin. Every `gcloud` command and console URL still uses the id. |
| Compute VM | Name `map-runner` (permanent), zone `us-east1-b`, machine type `e2-micro`. SSH and `gcloud compute scp` still use this name. |
| Public IP | `35.231.154.30` |
| Boot disk | Persistent disk `map-runner` (permanent name) in `us-east1-b`, mounted as `/`. About 29 GB. Automatic restart is on. |
| Also served | https://35.231.154.30.sslip.io (same VM, same app). Cookies are host-only, so a login on treklin.com is not a login on the sslip.io host. |
| TLS | Caddy on the VM, Let's Encrypt. Certificate for `CN=treklin.com`, issued 6 November 2026, expires 4 February 2027. Caddy renews it. |
| Process | systemd unit `treklin.service`, user `treklin`, group `treklin`. There is no `map-runner.service`. |
| App directory on the VM | `/opt/treklin`. This is not a git checkout. Deploys copy a tarball over it. |
| Node on the VM | `/usr/local/bin/node`, v22.23.4 when last checked. Local development uses Node 24 (`.nvmrc`). |
| Database | `/var/lib/treklin/treklin.sqlite` on the boot disk. The service user's home is that same directory. There is no automated backup. |
| Env file on the VM | `/opt/treklin/server/.env`. Never overwrite this during a deploy. |
| `gcloud` on the laptop | `~/google-cloud-sdk/bin/gcloud` (not on `PATH`) |
| Google sign-in client | OAuth client id `519589243494-g6dbmdvd3a4cfla96i6i92h6p2cqge36.apps.googleusercontent.com` in [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials?project=map-runner-v2). The id in `server/.env.example` is a different, unused example. |
| Strava application | https://www.strava.com/settings/api — client id `294551`. Authorization Callback Domain is the host `treklin.com` only, not a full URL. The client secret is only in the VM's `server/.env`. |
| Garmin | Connect Developer Program app. Client ID and Client Secret are `GARMIN_CONSUMER_KEY` and `GARMIN_CONSUMER_SECRET` in the VM's `server/.env`. OAuth redirect is `https://treklin.com/api/integrations/garmin/callback`. Push URLs for Activities and Deregistrations are registered at https://apis.garmin.com/tools/endpoints and point at `https://treklin.com/api/integrations/garmin/push`. A personal Garmin key may exist in the laptop's `server/.env`. Do not copy that file to the VM and do not commit it. |
| Privacy policy | https://treklin.com/privacy |

Console links that still work a year later:

- Cloudflare dashboard: https://dash.cloudflare.com
- VM: https://console.cloud.google.com/compute/instances?project=map-runner-v2
- Google OAuth client: https://console.cloud.google.com/apis/credentials?project=map-runner-v2
- Strava API settings: https://www.strava.com/settings/api
- Garmin developer portal, if a real app is created later: https://developerportal.garmin.com/

These names were left as they are when the directories were renamed on 6 November 2026:

- npm packages `map_runner_v2` and `map-runner-server`
- CSRF header `X-Requested-With: map-runner`
- session cookies `__Host-mr_session` and `mr_session`
- `localStorage` keys beginning with `mapRunner:`
- the local default database path `./data/map-runner.sqlite` in `server/src/config.js` (production uses `DATABASE_PATH` instead)

## What the app does

A person picks two places. The app draws a driving route between them and treats workouts as distance along that line. When the covered distance reaches the route length, the route is finished. The workout that crosses the finish line is the last one that counts.

Workouts are manual, or imported from Strava or Garmin. Each route has checkboxes for the connected services it should keep importing from. Importing starts from the moment that choice is turned on. Older workouts are added only through "Import past workouts", which asks which service to read.

Guests can use the app with routes stored in that browser. An account stores the same routes on the server.

## How a request reaches the app

```
browser
  → DNS A record 35.231.154.30 (Cloudflare DNS only)
  → Caddy on the VM, ports 80 and 443
  → Node on 127.0.0.1:3001
       /api/*   Express
       anything else   the built React app in /opt/treklin/dist
```

Caddy's config is `/etc/caddy/Caddyfile` on the VM (it is not in git):

```
35.231.154.30.sslip.io {
	reverse_proxy 127.0.0.1:3001
}

treklin.com {
	reverse_proxy 127.0.0.1:3001
}
```

systemd unit `/etc/systemd/system/treklin.service`:

```
[Service]
User=treklin
Group=treklin
WorkingDirectory=/opt/treklin/server
EnvironmentFile=/opt/treklin/server/.env
ExecStart=/usr/local/bin/node src/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
```

Production `server/.env` (names only):

| Variable | Live value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `DATABASE_PATH` | `/var/lib/treklin/treklin.sqlite` |
| `APP_ORIGIN` | `https://treklin.com,https://35.231.154.30.sslip.io` |
| `TRUST_PROXY` | `1` |
| `CLIENT_DIST` | `../dist` |
| `GOOGLE_CLIENT_ID` | the client id in the table above |
| `SESSION_TTL_DAYS` | `30` |
| `STRAVA_CLIENT_ID` | `294551` |
| `STRAVA_CLIENT_SECRET` | set, 40 characters, not recorded here |
| `ADMIN_EMAILS` | unset until configured. Comma-separated account emails that may open `/admin` |

`APP_ORIGIN`'s first origin is the one used in OAuth callbacks. That is `https://treklin.com`. The second origin is allowed to call the API, but Strava and Garmin redirect back to the first one.

The Node process serves both the API and the built frontend. Any path that does not start with `/api/` returns `dist/index.html`, so `/privacy` works without a separate web server rule.

## Repository layout

```
src/                         React 19 + Vite 6
  config/env.js              build-time public config
  config/mapServices.js      tile, routing and search URLs (also used for CSP)
  domain/                    pure logic, shared with the server
    route.js, workout.js     models, validation, progress
    activities.js            the activity list
    autoImport.js            which workouts a route accepts
    schema.js                sanitises anything read from storage or a provider
    overlap.js               keep old / keep new / keep both
  services/
    api/                     cookie session, CSRF header
    auth/                    email/password and Google sign-in
    storage/                 localStorage for guests, /api/routes when signed in
    geo/                     Photon search + OSRM routing
    integrations/            Strava and Garmin clients in the browser
  state/                     AuthProvider, RoutesProvider, auto-import sync
  pages/HomePage.jsx         the map
  pages/PrivacyPage.jsx      /privacy
  pages/AdminPage.jsx        /admin
server/                      Express 5 API
  src/index.js               opens SQLite and listens
  src/app.js                 headers, CSRF, routers, static files
  src/routes/auth.js
  src/routes/admin.js
  src/routes/routeSets.js
  src/routes/integrations.js
  src/integrations/          Strava OAuth, Garmin OAuth, Garmin personal key
  src/security/              Argon2id, session tokens, CSRF
  src/db.js                  schema migrations
```

`src/domain` and `src/lib` are imported by the server as plain Node modules, so those imports use explicit `.js` extensions.

Components never write routes directly. They call `useRoutes().actions`, the reducer in `src/state/routesReducer.js` updates memory, and `RoutesProvider` saves. Progress is calculated from workouts every time. It is not stored.

## Accounts and sessions

Two ways to sign in, both ending in the same session cookie:

- Email and password. Passwords are Argon2id (`memoryCost` 19456, `timeCost` 2, `parallelism` 1). Login errors do not reveal whether the email exists. Auth routes allow 20 attempts per IP per 15 minutes.
- Google. The browser uses Google Identity Services. The server checks the ID token (signature, issuer, audience, expiry) and accepts only a verified Google email. There is no Google client secret. The client id is public and must match in the frontend bundle and in `server/.env`.

Authorized JavaScript origins on that Google client must include:

- `http://localhost:5173`
- `https://treklin.com`
- `https://35.231.154.30.sslip.io`

No Google redirect URI is required. The app uses the popup flow.

If a Google account's verified email matches a password account that was never email-verified, Google takes the account over: the password is removed and other sessions are signed out. There is still no email verification and no password reset, because there is no mail sender.

The session token is 256 random bits. The database stores its SHA-256 hash in `sessions`. The browser gets it in an `HttpOnly`, `SameSite=Lax` cookie. In production the cookie is `Secure` and named `__Host-mr_session`, which means it is pinned to that exact host. Signing in on treklin.com does not sign you in on the sslip.io hostname. Sessions last 30 days. A new token is issued on every sign-in. Sign-out deletes the server row. Expired rows are purged hourly.

State-changing API calls must send `X-Requested-With: map-runner` and an `Origin` that is in `APP_ORIGIN`. The header value, the cookie names (`__Host-mr_session` in production, `mr_session` locally), and the `mapRunner:` keys in `localStorage` still use the old name. They were left in place so existing sessions and guest routes keep working.

Guest routes live in `localStorage` under `mapRunner:v2:guest:routes`. Signing in copies them onto the account once.

There is no account-deletion screen.

## What is stored

SQLite, via Node's built-in `node:sqlite`. Migrations are the ordered SQL strings in `server/src/db.js` and run at startup. Tables:

| Table | Contents |
| --- | --- |
| `users` | id, email, name, avatar, Argon2 hash, Google subject |
| `sessions` | hash of the cookie token, user, expiry |
| `route_sets` | one JSON document per user: all of their routes and workouts, plus a version number |
| `integrations` | Strava or Garmin tokens for a user. `token` and `token_secret` are credentials. Strava's expiry is `expires_at`. |
| `oauth_requests` | one-time OAuth state while a connect is in progress |
| `strava_activities` | activities pulled from Strava |
| `garmin_activities` | activities pulled from Garmin |

Route writes use that version number. A save from another tab or device with a stale version gets HTTP 409 instead of a silent overwrite.

The file is owned by `treklin` and lives outside `/opt/treklin`, so a deploy does not touch it. It survives reboots. It disappears only if the boot disk `map-runner` is deleted. Copy it yourself if you want a backup. Nothing else copies it.

Read it from the laptop:

```bash
~/google-cloud-sdk/bin/gcloud compute ssh map-runner --project=map-runner-v2 --zone=us-east1-b
```

On the VM:

```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/var/lib/treklin/treklin.sqlite', { readOnly: true });
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all());
"
```

`PRAGMA table_info(users);` lists columns. `SELECT *` on `users` includes `password_hash`. `SELECT *` on `integrations` or `oauth_requests` includes tokens. Do not paste those into chat or tickets.

The `sqlite3` shell is not installed on the laptop or required on the VM. Node is enough. Opening the file read-only is safe while the service is running.

## Routes, workouts, and import

A route has a name, two endpoints, a list of activity types, a geometry, and workouts. Covered distance is the sum of workout distances. The route is complete when that sum reaches the route distance.

Auto-import settings on a route:

- `sources`: `strava`, `garmin`, or both. Empty means off.
- `activities`: which of the route's activity types to accept.
- `since`: the timestamp when import was switched on. The browser cannot set this. The server-side domain code stamps it, and stamps a new one if import is turned fully off and on again.
- A workout is imported only when its source is selected, its activity is selected, and it was recorded after `since`.
- The same provider id is an update, not a second workout. A different provider with the same external id is a different workout.

The browser asks the server for new activities every 15 minutes while any unfinished route is importing (`src/state/useAutoImportSync.js`).

Older workouts use "Import past workouts" on the route, or the dialog that opens after connecting a service. The person chooses the service and the dates. Those workouts ignore `since` and go onto the routes they picked.

If an imported workout overlaps one already on a route and no choice has been saved yet, the dialog asks keep old, keep new, or keep both. The choice is stored in `localStorage` under `mapRunner:v2:overlap-policy` and reused. It is not an account setting. Back-to-back workouts (one ends when the next starts) are not an overlap.

Strava in the browser maps `sport_type` / `type`, `start_date_local`, `elapsed_time`, and the activity id. Garmin maps the first positive value among `elapsedDuration`, `durationInSeconds`, and `duration`.

## Strava

OAuth is entirely on the server (`server/src/integrations/strava.js`).

1. The browser opens `/api/integrations/strava/connect`.
2. The server stores a random `state` and redirects to `https://www.strava.com/oauth/authorize`.
3. Strava returns to `https://treklin.com/api/integrations/strava/callback`.
4. The granted scope must include `activity:read` or `activity:read_all`. The requested scope is `read,activity:read_all`.
5. The server exchanges the code at `https://www.strava.com/oauth/token`. The client secret is only in that server-to-server request.
6. Access token, refresh token, and expiry are stored in `integrations`. Activities are fetched from `https://www.strava.com/api/v3/athlete/activities` (200 per page, at most 5 pages) and stored in `strava_activities`.

The access token is refreshed if it expires within 120 seconds. A revoked or rejected refresh deletes the integration row and the API returns 404 with "Reconnect Strava". That 404 does not log the user out.

Strava's "Authorization Callback Domain" is the host only: `treklin.com`. A new Strava app can only be used by the athlete who created it until Strava approves more athletes.

Local Strava connect does not work with the current Strava app. The local server's `APP_ORIGIN` is `http://localhost:5173`, so the callback would be `http://localhost:5173/api/integrations/strava/callback`, and the Strava app only allows `treklin.com`.

Disconnect calls Strava's deauthorize endpoint and deletes the local row.

## Garmin

Connect uses OAuth 2 with PKCE (`server/src/integrations/garmin.js`). The browser opens `/api/integrations/garmin/connect`. The server sends the person to `https://connect.garmin.com/oauth2Confirm` and Garmin returns to `https://treklin.com/api/integrations/garmin/callback`. The code is exchanged at Garmin's token service. The access token, refresh token, expiry, and Garmin user id are stored in `integrations`. The refresh token rotates on every refresh.

New workouts are posted by Garmin to `/api/integrations/garmin/push`. That URL is registered in API Tools (https://apis.garmin.com/tools/endpoints), not on the app page, for **ACTIVITY → Activities** and **COMMON → Deregistrations**. The push is matched to a user by the Garmin user id. The server answers 200.

The Starter tier only pushes workouts synced after the person connects. It does not provide history. "Import past workouts" therefore stays empty on that tier. A refused pull is treated as no data, and workouts already pushed are still returned.

`GARMIN_PERSONAL_KEY` is a separate one-account key. It is used only when the Client ID and Client Secret are both empty. Do not deploy the laptop's `server/.env` to fill any of these in. Add `GARMIN_CONSUMER_KEY` and `GARMIN_CONSUMER_SECRET` on the VM in `/opt/treklin/server/.env` and restart `treklin`.

## Maps

No map API key. `src/config/mapServices.js`:

| Job | Service |
| --- | --- |
| Tiles | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| Place search and geocoding | Photon, `https://photon.komoot.io/api/` |
| Routing | OSRM demo server, driving profile, `https://router.project-osrm.org/route/v1/driving` |

Those are public servers with no uptime guarantee. Changing the URL in that file is the whole switch. The Content-Security-Policy is generated from the same file at build time.

Drawing a route sends the typed place names to Photon and the coordinates to OSRM. It does not send the account or the workouts.

## Local development

```bash
nvm use                                          # Node 24, from .nvmrc
npm install && npm --prefix server install
cp .env.example .env
cp server/.env.example server/.env
npm run dev                                      # API :3001, Vite :5173
```

Vite proxies `/api` to `http://localhost:3001`. Frontend env is `.env` (`VITE_*` values are public and baked into the bundle). Server env is `server/.env`.

On this laptop, file watching needs `CHOKIDAR_USEPOLLING=1 npm run dev:web` if the Vite watcher goes quiet.

`VITE_ENABLE_STRAVA` and `VITE_ENABLE_GARMIN` do nothing. Both services are offered whenever `VITE_API_BASE_URL` is set.

Tests: `npm test`. Lint: `npm run lint`.

## Deploy

The VM has no git remote. A deploy is a tarball of the laptop checkout, copied over `/opt/treklin`, then a build and a restart. Do not copy `.env` files or the database. The `gcloud` target is still the VM name `map-runner`. The systemd unit to restart is `treklin`.

From the laptop, in a way that does not include secrets:

```bash
tar -C "$HOME/git" -czf /tmp/treklin-src.tgz \
  --exclude=treklin/node_modules \
  --exclude=treklin/server/node_modules \
  --exclude=treklin/.git \
  --exclude=treklin/dist \
  --exclude=treklin/.env \
  --exclude=treklin/.env.production \
  --exclude=treklin/server/.env \
  --exclude=treklin/server/data \
  treklin

# Confirm the archive has example env files only, never server/.env:
tar -tzf /tmp/treklin-src.tgz | grep -E '(^|/)(\.env|credentials)'

~/google-cloud-sdk/bin/gcloud compute scp /tmp/treklin-src.tgz \
  map-runner:/tmp/treklin-src.tgz \
  --project=map-runner-v2 --zone=us-east1-b
```

On the VM:

```bash
rm -rf /tmp/treklin-src
mkdir -p /tmp/treklin-src
tar -xzf /tmp/treklin-src.tgz -C /tmp/treklin-src
sudo rsync -a --delete \
  --exclude .env \
  --exclude .env.production \
  --exclude server/.env \
  --exclude server/node_modules \
  --exclude node_modules \
  --exclude dist \
  --exclude server/data \
  /tmp/treklin-src/treklin/ /opt/treklin/
sudo chown -R treklin:treklin /opt/treklin
sudo bash -lc 'cd /opt/treklin && npm run build'
sudo chown -R treklin:treklin /opt/treklin
sudo systemctl restart treklin
```

`--delete` removes files in `/opt/treklin` that are not in the tarball. The excludes keep the env file, `node_modules`, and any `server/data` directory. The real database is not inside that tree.

After restart, `systemctl is-active treklin` should be `active`. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/` should be `200`. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/auth/me` should be `401`. The public check is https://treklin.com and https://treklin.com/privacy, both `200`.

Node listens a second or two after systemd reports the unit active. A curl in that window returns "connection refused" even though the unit is fine.

If `package.json` dependencies change, `npm install` on the VM is required before the build. The deploys so far have not needed a new install. Run it as `treklin` inside `/opt/treklin` and `/opt/treklin/server`.

Logs: `sudo journalctl -u treklin -n 50 --no-pager`.

## SSH and the Cloud SDK

`gcloud` is not on `PATH`. Use the full path:

```bash
~/google-cloud-sdk/bin/gcloud compute ssh map-runner \
  --project=map-runner-v2 --zone=us-east1-b
```

The logged-in account is `p.chamuczynski@gmail.com`, project id `map-runner-v2`. The instance argument stays `map-runner` even though the app user and the systemd unit are `treklin`. Do not install a second copy with `snap`.

## Domain, DNS, and the certificate

1. The name treklin.com was registered at Cloudflare Registrar.
2. Cloudflare DNS serves it. Nameservers are `magnolia.ns.cloudflare.com` and `dexter.ns.cloudflare.com`.
3. The apex `A` record points at `35.231.154.30` and must stay grey-cloud. An orange-cloud proxy would hide the VM from Let's Encrypt and break Caddy's HTTP-01 renewal.
4. Caddy answers for both `treklin.com` and `35.231.154.30.sslip.io` and obtains the certificate. Reload Caddy with `sudo systemctl reload caddy` after editing `/etc/caddy/Caddyfile`.

To see the current certificate:

```bash
echo | openssl s_client -connect treklin.com:443 -servername treklin.com 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

## Brand

The mark is `public/treklin-logo.png` (a green square with a white route-shaped T). The word next to it is the letters `reklin`, so the lockup reads Treklin. The accessible name is Treklin. Favicons are `public/favicon.ico` and `public/favicon-32.png`. The page title is Treklin.

On a phone the mark floats at the top-left of the map and hides while the routes sheet is open. The desktop sidebar header shows the same lockup.

## Things that are easy to break

- Copying the laptop's `server/.env` onto the VM replaces production origins, the live Google client id, and the Strava secret, and may install a Garmin personal key that was never meant to be there.
- `rsync --delete` without the excludes removes `/opt/treklin/server/.env`.
- Putting the database inside `/opt/treklin` would put it in the deploy path. It is deliberately in `/var/lib/treklin`.
- Restarting `map-runner` does nothing. That unit is gone. The running unit is `treklin`.
- Moving the app with `mv` when `/opt/treklin` already exists nests it at `/opt/treklin/treklin` (or whatever the source directory is named). The service then fails because `WorkingDirectory` is `/opt/treklin/server`.
- Turning Cloudflare's proxy on (orange cloud) for the `A` record.
- Changing `APP_ORIGIN` so that `https://treklin.com` is no longer first. OAuth callbacks use the first origin.
- Forgetting a Google JavaScript origin after adding a hostname. Sign-in then fails only in the browser.
- Strava's callback domain is the host, not `https://treklin.com/api/...`.
- The README section "Roadmap: automatic workout import" is older than the code. Strava's server flow exists. Garmin's code exists and the live server has no Garmin credentials.
