# Swagtopia backend

This project includes a small Node.js backend for shared fan wall posts and update signups. It stores records in `data/store.json` on the server and exposes the API under `/api`.

## Run locally

1. Install the project dependencies with `npm install`.
2. Run `npm run dev` once. This starts the API and React development server together.
3. Open the Vite URL shown in the terminal. Vite forwards `/api` requests to the Node server.

The backend validates names, messages, and email addresses, limits request sizes, rate limits all requests and API requests, applies a stricter per-client submission limit, and prevents duplicate email signups. Posts and signups are kept in separate arrays in the server's JSON store. The API does not expose the signup list. Development requests use the direct client address; behind a production proxy, set `TRUST_PROXY=1` only when that proxy overwrites `X-Forwarded-For` with the real client address.

## Production

Run `npm run build`, then start the app with `npm start`. The Node server serves the generated `dist` site and handles API requests on the same origin. Set `PORT` to the port assigned by your host. Static files are held in memory after first access, while data is cached in memory between writes to avoid per-request disk reads. The server accepts up to 20,000 sockets and uses a 10,000 connection listen backlog. Keep one instance for the JSON store; running multiple replicas against local JSON files does not safely share writes. For sustained traffic across multiple instances, use a shared database.

Use a Node host with a persistent disk or volume mounted at the project `data` directory. The JSON store is local to the server and will not be shared across multiple server instances unless they share that persistent volume. Hosts with ephemeral filesystems will lose new records when they restart.

## Netlify deployment

The root `netlify.toml` builds the React app to `dist`, publishes it, routes `/api/*` to a Netlify Function, and sends other page paths to the React app. On Netlify, the API uses Netlify Database/Postgres instead of the local JSON file. Netlify applies the schema migration in `netlify/database/migrations/` during deployment. The Database product is available on Netlify Credit-based plans; make sure it is enabled for the site.

The local JSON store is not automatically copied to the hosted database. Local signups and posts remain in `data/store.json`; the Netlify database starts with the schema and collects hosted entries separately.

For a private CSV export of the hosted mailing list, set `MAILING_LIST_EXPORT_TOKEN` as a secret environment variable with the **Functions** scope in the Netlify UI. Then request `/api/signups.csv` with an `Authorization: Bearer <token>` header. The CSV is generated from the database when requested and is never published as a static site file. The ordinary site signup endpoint does not expose the list.

The existing `npm run dev` continues to run the local Node backend. To exercise Netlify Functions and the local Netlify Database emulator, install the Netlify CLI with `npm install -g netlify-cli`, then run `netlify dev`.

## Data

- Fan posts are public, the latest 50 visible posts are returned by `GET /api/posts`, and open pages refresh the wall every 10 seconds.
- `POST /api/posts` accepts `{ "n": "Name", "t": "Message" }`.
- `POST /api/signups` accepts `{ "n": "Name", "e": "email@example.com" }`.
- Signups are saved privately in `data/store.json`; duplicate email addresses are ignored.
- `data/zen-mailing-list.csv` is regenerated on startup and updated after each new signup. It contains only the `Name` and `Email` columns, with quoted values and formula-safe cells, so it is ready to import into an email service. The CSV and source store are private and excluded from Git.
- Do not commit `data/store.json`; it contains fan signup information and is excluded by `.gitignore`.
