# Run the UK POS pilot on your own machine (Windows)

Test everything locally — including offline — then deploy online when you are happy.
No database to install, no Docker, no cloud account needed for local runs.
The API uses built-in PGlite (in-memory by default) and the demo seed.

## 1. Install once

1. **Git for Windows** — https://git-scm.com/download/win — install with the
   defaults. This also gives you **Git Bash**, which the commands below use.
2. **Node.js 20 or newer** — https://nodejs.org — install the current LTS.
   Check it: `node -v` (must print v20 or higher).
3. **pnpm** — in Git Bash or PowerShell:
   `npm install -g pnpm@12.18.0`
   Check it: `pnpm -v` (must print 12.18.0).

## 2. Get the code

The glassmorphism design lives on the `glassmorphism` branch (not on `main`,
so nothing goes live until you say so):

```sh
git clone -b glassmorphism https://github.com/salarkhan-seo/uk-pos-pilot.git
cd uk-pos-pilot
```

To get the latest of that branch later: `git pull origin glassmorphism`.

## 3. Install and build

```sh
pnpm install
pnpm build
```

(`pnpm build` compiles shared-kernel -> db -> api -> register-app ->
admin-web, in that order. If a build ever fails oddly, run
`rm -rf node_modules && pnpm install` and build again.)

## 4. Run the three servers (three Git Bash windows, all from the repo root)

Start the API FIRST, then the register, then the admin. The register only
checks the API once, when it starts — so the API must already be up.

**Window 1 — API (port 3127):**

```sh
DEMO_SEED_ON_BOOT=true PORT=3127 pnpm start:api
```

Wait for `UK POS pilot API listening on port 3127`. It runs all 19 migrations
on boot and seeds the demo shop, catalogue and users.

**Window 2 — Register till (port 3130):**

```sh
DEMO_SEED_ON_BOOT=true REGISTER_API_BASE_URL=http://localhost:3127 REGISTER_UI_PORT=3130 node apps/register-app/dist/apps/register-app/src/ui/server.js
```

**Window 3 — Admin back office (port 3131):**

```sh
DEMO_SEED_ON_BOOT=true ADMIN_API_BASE_URL=http://localhost:3127 ADMIN_WEB_PORT=3131 node apps/admin-web/dist/ui/server.js
```

## 5. Open and test

- Register: http://localhost:3130
- Admin: http://localhost:3131
- API check: http://localhost:3127/sales/status (should answer 200)

Demo PINs: **manager 2468**, cashier / owner / admin **1234**.

Try a full sale: tap a quick key (e.g. Demo Widget £12.00), then
**Checkout — online**. Check the stock drops, and check the sale in the admin.

## 6. Test offline (the important part)

1. Do one normal online sale first, so you know online works.
2. Stop ONLY the API: click into Window 1 and press `Ctrl+C`.
3. Refresh the register. It shows the amber **"Offline — cash only"** banner
   and keeps working from its local demo catalogue.
4. Do a **cash** sale (Checkout — offline cash). It queues locally —
   the **Flush queue** button shows 1.
5. Restart the API with the same Window 1 command, then RESTART THE
   REGISTER too (Ctrl+C in Window 2, same command again). The register only
   probes the API when it starts, so it needs a restart to see the API is
   back. This is a known gap, not a mistake in your test.
6. On the register, press **Flush queue**. The queued sale goes through.
7. Check the admin — the offline sale is there, and stock is correct.

Notes:
- The register shows a warning that local storage is NOT encrypted. That is
  demo data on your own machine — fine for testing. To silence it, add
  `REGISTER_APP_DEVICE_SECRET=any-random-text` to the Window 2 command.
- By default the API database is in-memory: stopping the API wipes your
  test sales, and the demo seed re-runs on the next boot. To keep data
  across restarts, add `PGLITE_DATA_DIR=./data/api` to the Window 1 command.

## 7. Deploy online when you are happy

Tell me you are happy with it and I will merge the `glassmorphism` branch
into `main`. Render watches `main` and deploys automatically — the register
and admin go live with the new design within a couple of minutes, and I will
verify both screens for you. The API is not redeployed (it did not change).

If you would rather do the merge yourself:

```sh
git checkout main
git merge glassmorphism
git push origin main
```

(Pushing from your machine needs a GitHub token. The merge-from-here route
needs nothing from you.)

## Troubleshooting

- **Port already in use** — another copy is still running. Close its window,
  or change the port (e.g. `PORT=3128` for the API, and match
  `REGISTER_API_BASE_URL` / `ADMIN_API_BASE_URL` to it).
- **Register shows offline even though the API is up** — the register was
  started before the API. Restart the register (Window 2).
- **A page takes a few seconds on first load** — normal on first boot while
  the API runs migrations. Refresh once if needed.
- **Nothing on localhost:3130/3131** — check the matching window for an error
  and that `pnpm build` finished cleanly.
