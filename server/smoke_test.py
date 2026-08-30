#!/usr/bin/env python3
"""Smoke test for the VPS temp-email server: create address, SMTP-inject mail, read it back."""
import json, sys, time, urllib.request, smtplib
from email.message import EmailMessage

BASE = "http://127.0.0.1:48321"
SMTP = ("127.0.0.1", 2525)
DOMAIN = "266666.best"

def req(method, path, body=None, headers=None):
    r = urllib.request.Request(BASE + path, method=method)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
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

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("  " + str(extra) if extra else ""))
    if not cond:
        fails.append(name)

# 1. open settings
st, settings = req("GET", "/open_api/settings")
check("open_api/settings", st == 200 and isinstance(settings, dict), st)
check("domains in settings", DOMAIN in json.dumps(settings), settings.get("domains"))

# 2. create address
name = "tester%d" % (int(time.time()) % 100000)
st, created = req("POST", "/api/new_address", {"name": name, "domain": DOMAIN})
check("new_address", st == 200 and created.get("jwt"), (st, created))
jwt = created["jwt"]
addr = created.get("address") or (name + "@" + DOMAIN)
auth = {"Authorization": "Bearer " + jwt}
print("address:", addr)

# 3. SMTP inject
msg = EmailMessage()
msg["From"] = "sender@example.com"
msg["To"] = addr
msg["Subject"] = "SMOKE-1 verify code 884422"
msg["Message-ID"] = "<smoke-%d@example.com>" % int(time.time())
msg.set_content("Your code is 884422. http://example.com/verify?token=abc")
with smtplib.SMTP(*SMTP, timeout=15) as s:
    s.send_message(msg)
time.sleep(0.6)

# 4. list mails
st, mails = req("GET", "/api/mails?limit=10&offset=0", headers=auth)
check("api/mails 200", st == 200, st)
results = mails.get("results") if isinstance(mails, dict) else mails
check("mail received", results and len(results) >= 1, results[:1] if results else "none")
mail_id = results[0]["id"] if results else None

# 5. raw mail fetch
if mail_id:
    st, raw = req("GET", "/api/mail/%s" % mail_id, headers=auth)
    check("api/mail/:id", st == 200 and "884422" in str(raw), st)

# 6. parsed mail fetch (postal-mime path)
if mail_id:
    st, parsed = req("GET", "/api/parsed_mail/%s" % mail_id, headers=auth)
    check("api/parsed_mail/:id", st == 200, (st, str(parsed)[:80]))

# 7. admin stats
st, stats = req("GET", "/admin/statistics", headers={"x-admin-auth": "test-admin"})
check("admin/statistics", st == 200, st)

# 8. static assets (no dist yet -> 404 acceptable, must not 500)
st, body = req("GET", "/")
check("GET / (assets shim)", st in (200, 404), st)

print()
if fails:
    print("FAILED:", fails)
    sys.exit(1)
print("ALL SMOKE TESTS PASSED")
