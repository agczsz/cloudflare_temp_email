# VPS Deployment (DartNode, Debian 13)

Self-hosted refactor of cloudflare_temp_email: the Cloudflare Worker code runs
unchanged on Node.js, with VPS implementations for every Cloudflare binding.

**Current production deployment: docker compose** at `/opt/temp-email-docker/`
(the earlier systemd deployment under `/opt/temp-email` was removed after
migration; its SQLite data lives on in the bind-mounted `server/data/`).

## Architecture

| Cloudflare piece | VPS replacement (server/src) | Notes |
|---|---|---|
| D1 (SQLite) | `d1.ts` — better-sqlite3 file DB, same schema from `db/schema.sql` | data at `server/data/temp-email.db` |
| KV namespace | `kv.ts` — SQLite-backed key/value table | supports expirationTtl, get(key,"json") |
| Workers AI binding | `ai.ts` — REST adapter (`AI_API_KEY` + `AI_ACCOUNT_ID` in config.json) | empty key → built-in regex extraction fallback |
| RATE_LIMITER | `ratelimit.ts` — in-memory fixed window | per process |
| Pages ASSETS | `assets.ts` — serves the built frontend | SPA fallback included |
| Email Routing → email() | `smtp.ts` — SMTP server on :25 restricted to `DOMAINS` | feeds the original `email()` handler |
| send_email binding | `sendmail.ts` — MX-routed direct delivery (nodemailer) or optional `SEND_RELAY_HOST` smarthost | requires outbound :25 for direct mode; DKIM is selected per sender domain |
| — (new capability) | `submit.ts` — SMTPS submission on :465 (AUTH = address + password) | envelope-from locked to authenticated address; supports SNI certificates |
| — (new capability) | `imap.ts` — read-only IMAPS on :993 | minimal command set, gunzips raw_blob; supports SNI certificates |
| Cron trigger | daily `setInterval` → original `scheduled()` | cleanup settings from admin panel |

Ports: HTTP API + frontend on **48321** (TLS/443 handled by Lucky reverse
proxy), SMTP receive **25**, SMTPS submission **465**, IMAPS **993**. Configure
an independent certificate/key pair for each SMTP/IMAP hostname with SNI (see
`TLS_CERTIFICATES` below). HTTP TLS remains terminated by the reverse proxy.
SPF/DKIM/DMARC must be configured for every sender domain; DKIM uses the same
`DKIM_SELECTOR` but a separate private key per domain.

## Production layout (docker compose)

```
/opt/temp-email-docker/
  docker-compose.yml
  server/config.json      (bind mount, :ro)
  server/data/            (bind mount: temp-email.db, dkim/)
  /etc/letsencrypt/       (each domain's TLS certificate/key, mounted read-only)
```

## Ops

```bash
cd /opt/temp-email-docker
docker compose pull && docker compose up -d   # update (image auto-built by GitHub Actions)
docker compose logs -f
docker compose restart
```

Config is `server/config.json` — see `config.example.json`; every key can also
be passed as a `TE_*` env var. SMTPS/IMAPS certificates are configured per SNI
hostname with `TLS_CERTIFICATES`, for example:

```json
{
  "TLS_CERTIFICATES": {
    "smtp.example.com": {
      "cert": "/etc/letsencrypt/live/example.com/fullchain.pem",
      "key": "/etc/letsencrypt/live/example.com/privkey.pem"
    },
    "smtp.example.net": {
      "cert": "/etc/letsencrypt/live/example.net/fullchain.pem",
      "key": "/etc/letsencrypt/live/example.net/privkey.pem"
    }
  }
}
```

Mount all referenced certificate directories read-only into the container.
Older single-domain `TLS_CERT_PATH` / `TLS_KEY_PATH` remains supported as a
fallback. Mail-client login = full temp address + its address password.
Outbound: `SEND_RELAY_*` empty → direct-to-MX (outbound port 25 must be open);
all sender domains in `DOMAINS`/`DEFAULT_DOMAINS` get a separate persistent DKIM
key under `server/data/dkim/`. Publish each startup-logged TXT record at
`<DKIM_SELECTOR>._domainkey.<sender-domain>`. The first configured domain
reuses the existing `<selector>.private.pem` key to avoid breaking its DKIM DNS
record; each additional domain gets its own selector-named key file.

## Local build & smoke test

```bash
cd server && npm run build            # esbuild bundle (Node.js)
cd frontend && npm run build          # vue dist (same-origin API)
cd server
CONFIG_FILE=config.test.json node dist/server.js   # HTTP 48321, SMTP 2525, SMTPS 2465, IMAPS 2993
python smoke_test.py && python smoke_features.py && python smoke_mailcli.py
```
