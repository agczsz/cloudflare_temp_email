# VPS Deployment (DartNode, Debian 13)

Self-hosted refactor of cloudflare_temp_email: the Cloudflare Worker code runs
unchanged on Node.js, with VPS implementations for every Cloudflare binding.

## Architecture

| Cloudflare piece | VPS replacement (server/src) | Notes |
|---|---|---|
| D1 (SQLite) | `d1.ts` — better-sqlite3 file DB, same schema from `db/schema.sql` | data at `server/data/temp-email.db` |
| KV namespace | `kv.ts` — SQLite-backed key/value table | supports expirationTtl |
| Workers AI binding | `ai.ts` — REST adapter (`AI_API_KEY` + `AI_ACCOUNT_ID` in config.json) | empty key → built-in regex extraction fallback |
| RATE_LIMITER | `ratelimit.ts` — in-memory fixed window | per process |
| Pages ASSETS | `assets.ts` — serves `frontend/dist` | SPA fallback included |
| Email Routing → email() | `smtp.ts` — SMTP server on :25 restricted to `DOMAINS` | feeds the original `email()` handler |
| Cron trigger | daily `setInterval` → original `scheduled()` | cleanup settings from admin panel |

Ports: HTTP API + frontend on **48321** (TLS/443 is handled externally),
SMTP on **25**.

## Server layout

```
/opt/temp-email/
  server/   dist/server.js (esbuild bundle), package.json, config.json, data/
  frontend/ dist/ (built locally, uploaded)
  db/       schema.sql + patches (applied on boot)
```

## Deploy / update

Local (Windows): `cd server && npm run build` and `cd frontend && npm run build`,
then upload `server/dist/server.js`, `server/package.json`, `server/config.json`,
`db/`, `frontend/dist/` to the paths above and run:

```bash
cd /opt/temp-email/server && npm install --omit=dev
systemctl restart temp-email
```

## Service

```bash
systemctl status temp-email
journalctl -u temp-email -f
cp server/temp-email.service /etc/systemd/system/ && systemctl daemon-reload
```

## Config (server/config.json)

See `config.example.json`. Keys of note:

- `PORT` 48321, `SMTP_PORT` 25, `DOMAINS` ["266666.best"]
- `JWT_SECRET`, `ADMIN_PASSWORDS` — change from defaults
- `AI_API_KEY` / `AI_ACCOUNT_ID` — reserved Cloudflare API token slot for the
  AI verification-code extraction; leave empty to use the regex fallback
- `ENABLE_AI_EMAIL_EXTRACT` toggles the feature

## Local smoke test

```bash
cd server && npm run build
CONFIG_FILE=config.test.json node dist/server.js   # HTTP 48321, SMTP 2525
python smoke_test.py
```
