#!/bin/bash
# Update runtime config (AI key, account id, telegram token) on the VPS.
# Secrets are NOT stored in this file — pass them via environment variables:
#   AI_API_KEY=... AI_ACCOUNT_ID=... TELEGRAM_BOT_TOKEN=... bash update_ai_tg.sh
set -e
cd /opt/temp-email/server
node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("config.json", "utf8"));
if (process.env.AI_API_KEY) c.AI_API_KEY = process.env.AI_API_KEY;
if (process.env.AI_ACCOUNT_ID) c.AI_ACCOUNT_ID = process.env.AI_ACCOUNT_ID;
if (process.env.TELEGRAM_BOT_TOKEN) c.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (process.env.TELEGRAM_WEBHOOK_HOST) c.TELEGRAM_WEBHOOK_HOST = process.env.TELEGRAM_WEBHOOK_HOST;
fs.writeFileSync("config.json", JSON.stringify(c, null, 4));
console.log("config updated keys:", Object.keys(process.env).filter(k => k.startsWith("TE") || k.includes("AI") || k.includes("TELEGRAM")));
'
chmod 600 config.json
systemctl restart temp-email
sleep 3
echo "service: $(systemctl is-active temp-email)"
