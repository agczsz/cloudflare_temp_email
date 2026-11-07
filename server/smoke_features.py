#!/usr/bin/env python3
"""Extended smoke: wasm parse, gzip storage, webhook callback, addy(Bitwarden) endpoint."""
import json, sys, time, threading, http.server, urllib.request, smtplib, socketserver
from email.message import EmailMessage

BASE = "http://127.0.0.1:48321"
SMTP = ("127.0.0.1", 2525)
ADDY_TOKEN = "local-test-addy-token"
ADMIN = {"x-admin-auth": "test-admin"}
HOOK_PORT = 9911
hook_hits = []

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("  " + str(extra) if extra and not cond else ""))
    if not cond:
        fails.append(name)

def req(method, path, body=None, headers=None):
    r = urllib.request.Request(BASE + path, method=method)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    data = json.dumps(body).encode() if body is not None else None
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, data=data, timeout=20) as resp:
            code, txt = resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        code, txt = e.code, e.read().decode()
    try:
        return code, json.loads(txt)
    except Exception:
        return code, txt

# --- webhook capture server ---
class Hook(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = self.rfile.read(n)
        hook_hits.append(body.decode(errors="replace"))
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass

httpd = socketserver.TCPServer(("127.0.0.1", HOOK_PORT), Hook)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

# --- enable global admin mail webhook (full template like the UI would save) ---
HOOK_SETTINGS = {
    "enabled": True,
    "url": f"http://127.0.0.1:{HOOK_PORT}/hook",
    "method": "POST",
    "headers": json.dumps({"Content-Type": "application/json"}),
    "body": json.dumps({"id": "${id}", "url": "${url}", "from": "${from}", "to": "${to}",
                        "subject": "${subject}", "parsedText": "${parsedText}"}),
}
st, r = req("POST", "/admin/mail_webhook/settings", HOOK_SETTINGS, ADMIN)
check("admin mail_webhook save", st == 200 and (r == {"success": True} if isinstance(r, dict) else True), (st, r))

# --- addy (Bitwarden) endpoint ---
st, r = req("POST", "/api/v1/aliases", {"domain": "266666.best", "description": "bw-test"},
            {"Authorization": "Bearer " + ADDY_TOKEN})
check("addy create alias", st == 200 and r.get("data", {}).get("email", "").endswith("@266666.best"), (st, r))
addy_addr = r.get("data", {}).get("email") if isinstance(r, dict) else ""
st, r = req("POST", "/api/v1/aliases", {}, {"Authorization": "Bearer wrong"})
check("addy bad token 401", st == 401, st)
st, r = req("POST", "/api/v1/aliases", {}, {})
check("addy no token 401", st == 401, st)

# --- send mail to addy address (also covers gzip + wasm parse + webhook) ---
msg = EmailMessage()
msg["From"] = "sender@example.com"
msg["To"] = addy_addr
msg["Subject"] = "FEATURE-TEST wasm/gzip/webhook code 135711"
msg["Message-ID"] = "<feature-test-1@example.com>"
msg.set_content("Your code is 135711.")
with smtplib.SMTP(*SMTP, timeout=15) as s:
    s.send_message(msg)
time.sleep(2)

# --- gzip check via sqlite (better-sqlite3 from server node_modules) ---
import subprocess
out = subprocess.run(["node", "check_gzip.mjs", "<feature-test-1@example.com>"],
                     capture_output=True, text=True).stdout
print("gzip row:", out.strip())
check("gzip raw_blob stored (raw is NULL)", '"raw_null":1' in out and "blob_len" in out, out)

# --- parsed mail works (wasm path, no parse error in server log) ---
jwt_created = None
st, mails = req("GET", "/api/mails?limit=5&offset=0", headers={}) # need jwt; create via addy address login? use admin mails
st, r = req("GET", "/admin/mails?limit=5&offset=0", headers=ADMIN)
check("admin mails list", st == 200 and isinstance(r, dict) and r.get("results"), (st, str(r)[:100]))
mid = r["results"][0]["id"] if isinstance(r, dict) and r.get("results") else None
if mid:
    st, parsed = req("GET", f"/admin/mails/{mid}", headers=ADMIN)
    ok = st == 200 and (isinstance(parsed, dict) and ("135711" in str(parsed.get("text", "")) or "135711" in str(parsed)))
    check("parsed mail (wasm parser)", ok, (st, str(parsed)[:150]))

# --- webhook received ---
time.sleep(1)
check("webhook POST received", len(hook_hits) >= 1, hook_hits[:1])
if hook_hits:
    check("webhook body has mail content", "135711" in hook_hits[0] or "FEATURE-TEST" in hook_hits[0], hook_hits[0][:150])

# --- server log must NOT contain wasm failure ---
log = open("server_test.log", encoding="utf-8", errors="replace").read()
check("no wasm parse failure logged", "Failed use mail-parser-wasm-worker" not in log)

print()
if fails:
    print("FAILED:", fails)
    sys.exit(1)
print("ALL FEATURE SMOKE TESTS PASSED")
