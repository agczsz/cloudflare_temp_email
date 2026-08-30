#!/bin/bash
# Migrate temp-email from systemd deployment to docker compose.
set -e
OLD=/opt/temp-email
NEW=/opt/temp-email-docker

echo "=== 1. stop systemd service (free ports) ==="
systemctl stop temp-email || true
sleep 1
ss -tlnp | grep -E ":(25|465|993|48321) " && { echo "ports still busy!"; exit 1; } || echo "ports free"

echo "=== 2. copy data + config ==="
mkdir -p $NEW/server/data
cp -a $OLD/server/data/. $NEW/server/data/
cp $OLD/server/config.json $NEW/server/config.json
node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
c.DB_PATH = "/app/server/data/temp-email.db";
c.FRONTEND_DIST = "/app/frontend/dist";
c.TLS_CERT_PATH = "/ssl/zerossl.crt";
c.TLS_KEY_PATH = "/ssl/zerossl.key";
fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 4));
console.log("config rewritten for container paths");
' $NEW/server/config.json
chmod 600 $NEW/server/config.json
ls -la $NEW/server/data/ | head -5

echo "=== 3. compose file ==="
cat > $NEW/docker-compose.yml <<'EOF'
services:
  temp-email:
    image: ghcr.io/agczsz/cloudflare_temp_email:latest
    container_name: temp-email
    ports:
      - "25:25"
      - "465:465"
      - "993:993"
      - "48321:48321"
    volumes:
      - ./server/config.json:/app/server/config.json:ro
      - ./server/data:/app/server/data
      - /root/ssl:/ssl:ro
    restart: unless-stopped
EOF

echo "=== 4. pull + up ==="
cd $NEW
docker pull ghcr.io/agczsz/cloudflare_temp_email:latest
docker compose up -d 2>/dev/null || docker-compose up -d
sleep 5
docker ps --filter name=temp-email --format "{{.Names}} {{.Status}} {{.Image}}"

echo "=== 5. verify ==="
echo "--- listeners ---"
ss -tlnp | grep -E ":(25|465|993|48321) " | awk '{print $4}' | sort
echo "--- api ---"
curl -s http://127.0.0.1:48321/open_api/settings | head -c 120; echo
curl -s -o /dev/null -w "frontend / -> %{http_code}\n" http://127.0.0.1:48321/
echo "--- logs ---"
docker logs temp-email 2>&1 | grep -E "listening|imap|submit|dkim|error" | tail -8
