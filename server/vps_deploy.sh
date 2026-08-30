#!/bin/bash
set -e
cd /opt/temp-email
tar xf deploy.tar

mkdir -p server/dist frontend/dist
mv -f dist/server.js server/dist/ 2>/dev/null || true
mv -f dist/* frontend/dist/ 2>/dev/null || true
rmdir dist 2>/dev/null || true
mv -f package.json config.example.json temp-email.service server/ 2>/dev/null || true
ls server frontend

cd /opt/temp-email/server
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1

JWT_SECRET=$(openssl rand -hex 24)
ADMIN_PW=$(openssl rand -hex 6)
cat > /opt/temp-email/server/config.json <<EOF
{
    "PORT": 48321,
    "SMTP_PORT": 25,
    "DB_PATH": "/opt/temp-email/server/data/temp-email.db",
    "FRONTEND_DIST": "/opt/temp-email/frontend/dist",
    "TITLE": "266666 Temp Mail",
    "DEFAULT_LANG": "zh",
    "PREFIX": "",
    "DOMAINS": ["266666.best"],
    "DEFAULT_DOMAINS": ["266666.best"],
    "JWT_SECRET": "$JWT_SECRET",
    "ADMIN_PASSWORDS": ["$ADMIN_PW"],
    "ENABLE_USER_CREATE_EMAIL": true,
    "ENABLE_USER_DELETE_EMAIL": true,
    "ENABLE_ADDRESS_PASSWORD": true,
    "ENABLE_AI_EMAIL_EXTRACT": true,
    "AI_EXTRACT_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast",
    "AI_API_KEY": "",
    "AI_ACCOUNT_ID": "",
    "RATE_LIMIT_COUNT": 60,
    "RATE_LIMIT_PERIOD": 60,
    "ENABLE_WEBHOOK": false,
    "ENABLE_AUTO_REPLY": false
}
EOF
chmod 600 config.json

cp /opt/temp-email/server/temp-email.service /etc/systemd/system/temp-email.service
systemctl daemon-reload
systemctl enable --now temp-email
sleep 3
echo "=== service status ==="
systemctl is-active temp-email || journalctl -u temp-email -n 30 --no-pager
echo "=== listeners ==="
ss -tlnp | grep -E ':(25|48321) ' || true
echo "=== health ==="
curl -s http://127.0.0.1:48321/open_api/settings | head -c 300; echo
curl -s -o /dev/null -w "frontend GET / -> %{http_code}\n" http://127.0.0.1:48321/
echo "=== credentials ==="
echo "JWT_SECRET=$JWT_SECRET"
echo "ADMIN_PASSWORD=$ADMIN_PW"
