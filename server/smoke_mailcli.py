#!/usr/bin/env python3
"""Smoke for the new mail-client components: SEND_MAIL shim, SMTPS 465 submission, IMAPS 993."""
import json, ssl, sys, time, smtplib, imaplib, urllib.request

BASE = "http://127.0.0.1:48321"
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
        with urllib.request.urlopen(r, data=data, timeout=25) as resp:
            code, txt = resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        code, txt = e.code, e.read().decode()
    try:
        return code, json.loads(txt)
    except Exception:
        return code, txt

INSECURE = ssl._create_unverified_context()

# 0. create address with password
st, r = req("POST", "/api/new_address", {"name": "mailcli1", "domain": "266666.best"})
check("create address", st == 200 and r.get("password"), (st, r))
addr, pwd = r["address"], r["password"]

# 1. SEND_MAIL shim via admin binding send (structured shape -> relay sink)
st, r = req("POST", "/admin/send_mail_by_binding", {
    "from": "mailcli1@266666.best", "to": "victim@relay-dest.test",
    "subject": "SHIM structured test", "text": "hello from shim",
}, {"x-admin-auth": "test-admin"})
check("admin binding structured send", st == 200 and r == {"status": "ok"}, (st, r))
time.sleep(1)
sink = open("sink_capture.eml", "rb").read()
check("shim mail reached sink", b"hello from shim" in sink, sink[:120])
check("DKIM-Signature present", b"DKIM-Signature" in sink, sink[:80])

# 2. SMTPS submission with auth
with smtplib.SMTP_SSL("127.0.0.1", 2465, context=INSECURE, timeout=15) as S:
    code, resp = S.login(addr, pwd)
    check("submission AUTH", code == 235, (code, resp))
    m = ("From: %s\r\nTo: victim2@relay-dest.test\r\nSubject: SUBMIT test 979799\r\n\r\nsubmit body 979799" % addr)
    S.sendmail(addr, ["victim2@relay-dest.test"], m)
check("submission mail", True)
time.sleep(1)
sink = open("sink_capture.eml", "rb").read()
check("submission delivered to sink", b"979799" in sink, len(sink))
check("submission DKIM signed", b"DKIM-Signature" in sink)

# 2b. wrong password must fail
try:
    with smtplib.SMTP_SSL("127.0.0.1", 2465, context=INSECURE, timeout=15) as S:
        S.login(addr, "wrong-password")
    check("submission wrong pw rejected", False)
except smtplib.SMTPAuthenticationError:
    check("submission wrong pw rejected", True)

# 2c. envelope-from mismatch must fail
try:
    with smtplib.SMTP_SSL("127.0.0.1", 2465, context=INSECURE, timeout=15) as S:
        S.login(addr, pwd)
        S.sendmail("other@266666.best", ["x@y.test"], "Subject: spoof\r\n\r\nx")
    check("from-mismatch rejected", False)
except Exception:
    check("from-mismatch rejected", True)

# 3. IMAPS read (inject an inbound mail first via the :2525 receiver)
import smtplib as _smtp
msg_in = ("From: sender@example.com\r\nTo: %s\r\nSubject: IMAP inbound 889911\r\n\r\nimap body 889911" % addr)
with _smtp.SMTP("127.0.0.1", 2525, timeout=15) as S:
    S.sendmail("sender@example.com", [addr], msg_in)
time.sleep(1)
try:
    I = imaplib.IMAP4_SSL("127.0.0.1", 2993, ssl_context=INSECURE)
    typ, _ = I.login(addr, pwd)
    check("imap login", typ == "OK", typ)
    typ, data = I.select("INBOX")
    check("imap select", typ == "OK" and int(data[0]) >= 1, (typ, data))
    typ, data = I.search(None, "ALL")
    ids = data[0].split()
    check("imap search", typ == "OK" and ids, data)
    typ, d2 = I.fetch(ids[-1].decode(), "(UID RFC822.SIZE BODY.PEEK[])")
    blob = b"".join(x[1] for x in d2 if isinstance(x, tuple))
    check("imap fetch body", b"889911" in blob, blob[:120])
    typ, d3 = I.fetch("1", "(BODY.PEEK[HEADER])")
    check("imap fetch header", typ == "OK", typ)
    I.logout()
    check("imap logout", True)
except Exception as e:
    check("imap flow", False, repr(e))

print()
if fails:
    print("FAILED:", fails)
    sys.exit(1)
print("ALL CLIENT-PORT SMOKE TESTS PASSED")
