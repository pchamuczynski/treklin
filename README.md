# Map Runner v2

Turn your workouts into a journey: pick a real-world route (e.g. Warsaw → Barcelona), log runs, rides and
hikes against it, and watch your progress marker move along the map.

The app is a React + Vite frontend (repository root) with a small Node API in [`server/`](server/) for
accounts and storing routes. Without the API it still works as a browser-only app (guest mode).

## Getting started

Requires **Node.js 22+** (the project pins 24 in `.nvmrc`; run `nvm use`).

```bash
nvm use
npm install && npm --prefix server install
cp .env.example .env                   # frontend settings (public)
cp server/.env.example server/.env     # server settings (private)

npm run dev   # API on :3001 + app on http://localhost:5173 (Ctrl+C stops both)
```

`npm run dev` checks the Node version and server dependencies first, then runs both processes with prefixed
output (`[api]`, `[web]`); the app proxies `/api` to the server.

| Script                 | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `npm run dev`          | API server + frontend together (watch mode / HMR)              |
| `npm run dev:web`      | Frontend only (Vite)                                           |
| `npm run server`       | API server only (watch mode)                                   |
| `npm run build`        | Production build of the frontend (injects the CSP)             |
| `npm run server:start` | API server without watch (production)                          |
| `npm run lint`         | ESLint (frontend and server)                                   |
| `npm test`             | Unit and API tests (Vitest)                                    |

### Accounts

Users can register with **email + password** or **sign in with Google**; guests keep using the app without an
account. Signing in moves the routes created as a guest in that browser into the account, and from then on
routes are stored on the server, so they are available on any device.

**Enabling Google sign-in**

1. In [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application** (configure the OAuth consent screen first if asked).
2. Under **Authorized JavaScript origins** add `http://localhost:5173` and your production origin.
   No redirect URIs are needed (the popup flow is used).
3. Put the client ID in both `.env` (`VITE_GOOGLE_CLIENT_ID`) and `server/.env` (`GOOGLE_CLIENT_ID`) and restart
   both processes. The client ID is public; there is no client secret in this flow.

Not included yet: email verification and password reset (they need an email-sending service). Until then, a
Google sign-in with the same email takes over an existing password account and removes its password - see
Security.

**Admin panel.** Set `ADMIN_EMAILS` in `server/.env` to a comma-separated list of account emails, then restart
the API. Those accounts can open `/admin` to browse accounts and routes, edit a name, email or verification
flag, replace someone's routes, and sign them out everywhere. Password hashes and Strava/Garmin tokens are
not shown. The account menu shows an Admin link only for those accounts.

### Production

Build the frontend and let the API serve it from the same origin (first-party cookies, no CORS):

```bash
npm run build
# server/.env: NODE_ENV=production, APP_ORIGIN=https://your.domain, CLIENT_DIST=../dist,
#              TRUST_PROXY=1 when behind a reverse proxy / PaaS router
npm run server:start
```

Serve it over HTTPS (session cookies are `Secure` and `__Host-` prefixed in production). Back up
`DATABASE_PATH` (SQLite).

### Maps

Maps need no API key or configuration. The app uses OpenStreetMap-based services, all defined in
[`src/config/mapServices.js`](src/config/mapServices.js):

| Purpose              | Default (free, public)     | Production options                               |
| -------------------- | -------------------------- | ------------------------------------------------ |
| Map tiles            | tile.openstreetmap.org     | MapTiler, Stadia Maps, self-hosted               |
| Routing              | OSRM demo server (driving) | OpenRouteService, GraphHopper (also foot/bike), self-hosted OSRM |
| Search / autocomplete| Photon (komoot)            | self-hosted Photon, OpenRouteService geocoding   |

The public servers are fine for development and light use but have fair-use policies and no uptime guarantee.
Switching is a URL change in that one file; the Content-Security-Policy follows automatically.

### Activities

Supported: Running, Walking, Hiking, Cycling, Swimming, Kayaking, Rollerski, Cross-country skiing
(`src/domain/activities.js`). A route selects which of them it counts; its workouts and auto-import types are
limited to that selection. Legacy free-text tags are mapped onto the list (e.g. "xc ski" → Cross-country skiing).
Each activity's pictogram and colour live in `src/components/activityStyles.js` (Material Design Icons) and are
used for the map's progress marker and throughout the UI. To add an activity, extend both files and the
Strava/Garmin mappings in `src/services/integrations/`.

## Architecture

```
src/                       Frontend
  config/                  env.js (build-time config, feature flags), mapServices.js (map service URLs)
  domain/                  Pure business logic - no React, no I/O; also used by the server
    route.js, workout.js     models, validation, progress
    activities.js            supported activities
    autoImport.js            per-route automatic import rules
    schema.js                sanitises/migrates untrusted data (storage, API, providers)
  lib/                     Generic helpers (geo math, formatting, ids, fetch with timeout)
  services/
    api/                     API client (cookie session, CSRF header, session-expiry events)
    auth/                    email/password + Google sign-in (Google Identity Services)
    storage/                 route repositories: localStorage (guest) or API (signed in)
    geo/                     routing (OSRM) + place search (Photon)
    integrations/            Strava / Garmin activity mappers and sync client
  state/                   React contexts: AuthProvider -> RoutesProvider (useReducer)
  hooks/, components/, pages/
server/                    API (Express 5, SQLite via node:sqlite)
  src/app.js               app factory (security headers, CSRF, sessions, routers)
  src/routes/              /api/auth (register, login, google, logout, me), /api/routes
  src/security/            Argon2id passwords, session tokens, CSRF check
  src/repositories/        users, route sets
  test/                    API tests (supertest, in-memory database)
```

Data flow: components call `useRoutes().actions.*` → pure `routesReducer` → `RoutesProvider` persists every
change through the repository for the current user (browser storage for guests, the API for accounts).
Progress is always derived from workouts, never stored.

Code in `src/domain` and `src/lib` runs in the browser and on the server, so its relative imports use explicit
`.js` extensions (plain Node requires them; a test guards this).

## Security

- **Passwords** are hashed with Argon2id (OWASP parameters). Login errors are generic and take the same time
  whether or not the account exists. Auth endpoints are rate-limited per IP (20 attempts / 15 minutes).
- **Sessions** are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` and `__Host-` prefixed
  in production); the database stores only their SHA-256 hash. A new token is issued on every sign-in; sign-out
  deletes it server-side. Nothing auth-related is stored in `localStorage`.
- **Google sign-in**: the ID token is verified on the server (signature, issuer, audience, expiry) and only a
  verified Google email is accepted. If the email belongs to a password account whose email was never verified,
  the Google owner takes the account over: its password is removed and its other sessions are signed out. This
  prevents "pre-hijacking" (someone registering your email with their password before you sign up).
- **CSRF**: state-changing API requests require the `X-Requested-With: map-runner` header and an allowed
  `Origin`, on top of `SameSite` cookies.
- **Route data** sent to the server is validated with the same `src/domain/schema.js` as in the browser; writes
  use optimistic versioning so another tab or device cannot silently overwrite changes.
- **Headers**: Helmet (HSTS, `nosniff`, referrer policy, ...), `frame-ancestors 'none'`, `Cache-Control: no-store`
  on API responses. The page's Content-Security-Policy is generated at build time from
  `src/config/mapServices.js` (plus Google sign-in hosts when configured).
- **Secrets**: `.env` files are git-ignored. `VITE_*` values are public (embedded in the bundle); server secrets
  belong in `server/.env` only.
- **Untrusted data** from storage, the API or Strava/Garmin goes through `domain/schema.js`; malformed entries are
  dropped instead of crashing the app.

## Roadmap: automatic workout import

Strava/Garmin need server endpoints next (OAuth and secrets live only on the server):

| Endpoint                                       | Used by                                      |
| ---------------------------------------------- | -------------------------------------------- |
| `GET /api/integrations/{strava,garmin}/connect`  | `integrations.connectUrl` - starts OAuth     |
| `GET /api/integrations/{id}/activities?since=ISO`| `integrations.fetchNewWorkouts`              |

Each route has **automatic import** settings (edit the route → "Automatically import workouts"): an on/off
switch and the workout types it accepts (a subset of the route's activities). Rules, enforced in
`src/domain/autoImport.js`:

- Only workouts recorded **after auto-import was switched on** are imported (compared by the provider's exact
  start time); switching it off and on again starts a new window. Past workouts are never pulled in.
- A **completed** route stops importing; the workout that crosses the finish line is the last one.
- Imported workouts carry `source` and `externalId`, so syncing repeatedly never duplicates them.

While any uncompleted route has auto-import on, `useAutoImportSync` polls the enabled providers every 15 minutes
(`since` = the earliest switch-on time) and `actions.importWorkouts` distributes the workouts.
