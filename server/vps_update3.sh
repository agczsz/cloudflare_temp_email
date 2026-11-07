#!/bin/bash
set -e
cd /opt/temp-email/server
if [ ! -f /opt/temp-email/server/dist/server.js.new ]; then echo "server.js.new missing" >&2; exit 1; fi
mv -f dist/server.js.new dist/server.js

ADDY_TOKEN=$(openssl rand -hex 16)
node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("config.json", "utf8"));
c.ENABLE_WEBHOOK = true;
c.FRONTEND_URL = "https://mail.266666.best";
c.ENABLE_MAIL_GZIP = true;
c.ADDY_AUTH_TOKEN = process.env.ADDY_TOKEN;
fs.writeFileSync("config.json", JSON.stringify(c, null, 4));
'
chmod 600 config.json
systemctl restart temp-email
sleep 3
echo "service: $(systemctl is-active temp-email)"

echo "=== addy endpoint via public https ==="
curl -s -X POST "https://mail.266666.best/api/v1/aliases" \
  -H "Authorization: Bearer $ADDY_TOKEN" -H "Content-Type: application/json" \
  -d '{"domain":"266666.best","description":"deploy-check"}'
echo
echo "=== addy endpoint wrong token (expect 401) ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://mail.266666.best/api/v1/aliases" \
  -H "Authorization: Bearer wrong" -H "Content-Type: application/json" -d "{}"

echo "=== local webhook capture server ==="
cat > /tmp/hook.js <<'EOS'
const http = require("http");
const fs = require("fs");
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => b += c);
  req.on("end", () => { fs.appendFileSync("/tmp/hook_capture.json", b + "\n"); res.end("ok"); });
}).listen(9911, "127.0.0.1", () => console.log("hook capture on 9911"));
EOS
rm -f /tmp/hook_capture.json
nohup node /tmp/hook.js >/tmp/hook.log 2>&1 &
sleep 1
PW=$(node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).ADMIN_PASSWORDS[0])")
curl -s -X POST http://127.0.0.1:48321/admin/mail_webhook/settings -H "x-admin-auth: $PW" -H "Content-Type: application/json" \
  -d '{"enabled":true,"url":"http://127.0.0.1:9911/hook","method":"POST","headers":"{\"Content-Type\":\"application/json\"}","body":"{\"id\":\"${id}\",\"from\":\"${from}\",\"to\":\"${to}\",\"subject\":\"${subject}\",\"parsedText\":\"${parsedText}\"}"}'
echo
echo "=== credentials ==="
echo "ADDY_AUTH_TOKEN=$ADDY_TOKEN"
