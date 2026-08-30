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
| send_email binding | `sendmail.ts` — MX-routed direct delivery (nodemailer) or `SEND_RELAY_HOST` smarthost, DKIM signed | requires outbound :25 for direct mode |
| — (new capability) | `submit.ts` — SMTPS submission on :465 (AUTH = address + password) | envelope-from locked to authenticated address |
| — (new capability) | `imap.ts` — read-only IMAPS on :993 | minimal command set, gunzips raw_blob |
| Cron trigger | daily `setInterval` → original `scheduled()` | cleanup settings from admin panel |

Ports: HTTP API + frontend on **48321** (TLS/443 handled by Lucky reverse
proxy), SMTP receive **25**, SMTPS submission **465**, IMAPS **993**
(TLS: ZeroSSL cert at `/root/ssl/`, mounted read-only into the container).
DMARC: upstream default `_dmarc` (p=none, Cloudflare reports).
SPF: `v=spf1 mx ~all`; PTR: `108.165.12.111 → smtp.266666.best`.

## Production layout (docker compose)

```
/opt/temp-email-docker/
  docker-compose.yml
  server/config.json      (bind mount, :ro)
  server/data/            (bind mount: temp-email.db, dkim/, certs/)
  /root/ssl -> /ssl       (TLS certs, :ro)
```

## Ops

```bash
cd /opt/temp-email-docker
docker compose pull && docker compose up -d   # update (image auto-built by GitHub Actions)
docker compose logs -f
docker compose restart
```

Config is `server/config.json` — see `config.example.json`; every key can also
be passed as a `TE_*` env var. SMTP/IMAP/SMTPS host name: `smtp.266666.best`
(cert SAN `*.266666.best`); mail-client login = full temp address + its address
password. Outbound: `SEND_RELAY_*` empty → direct-to-MX (port 25 must be open,
DartNode unblocked 2026-08-30).

## Local build & smoke test

```bash
cd server && npm run build            # esbuild bundle (node20)
cd frontend && npm run build          # vue dist (same-origin API)
cd server
CONFIG_FILE=config.test.json node dist/server.js   # HTTP 48321, SMTP 2525, SMTPS 2465, IMAPS 2993
python smoke_test.py && python smoke_features.py && python smoke_mailcli.py
```
