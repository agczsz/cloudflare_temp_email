import tls from "node:tls";
import crypto from "node:crypto";
import zlib from "node:zlib";

/**
 * Minimal IMAP server (implicit TLS, default :993) so mail clients can read a
 * temp mailbox. npm has no maintained general-purpose IMAP *server* package,
 * so this implements the read-only command subset real clients use:
 *   CAPABILITY LOGIN AUTHENTICATE=PLAIN LIST/LSUB SELECT/EXAMINE STATUS
 *   SEARCH ALL FETCH (UID FLAGS RFC822.SIZE INTERNALDATE BODY[..] RFC822)
 *   NOOP CHECK CLOSE EXPUNGE STORE(\Seen, memory-only) IDLE LOGOUT
 * Auth = mailbox address + raw password (SHA-256 hex compared to
 * address.password, same as the frontend).
 */
const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const CRLF = "\r\n";

export function startImapServer(opts: {
    port: number;
    host: string;
    cert: string;
    key: string;
    d1: any;
    domains: string[];
}): tls.Server {
    const server = tls.createServer({ cert: opts.cert, key: opts.key }, (sock) => runSession(sock, opts));
    server.on("error", (e) => console.error("[imap] server error:", e));
    server.listen(opts.port, opts.host, () => {
        console.log(`[imap] IMAPS listening on ${opts.host}:${opts.port}`);
    });
    return server;
}

function runSession(sock: tls.TLSSocket, opts: { d1: any; domains: string[] }): void {
    let authed: string | null = null;
    let selected = false;
    let lastCount = -1;
    let buffer = "";
    let awaitingSasl: string | null = null;
    let idling = false;

    sock.write(`* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] temp-email IMAP ready${CRLF}`);

    sock.on("data", (d) => {
        buffer += d.toString("binary");
        let idx: number;
        while ((idx = buffer.indexOf(CRLF)) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            void handleLine(line).catch((e) => {
                console.error("[imap] handler error:", e);
                sock.write(`* BAD internal error${CRLF}`);
            });
        }
    });
    sock.on("error", () => { /* client aborted */ });

    const write = (s: string) => sock.write(s);
    const ok = (tag: string, text: string) => write(`${tag} OK ${text}${CRLF}`);
    const no = (tag: string, text: string) => write(`${tag} NO ${text}${CRLF}`);
    const bad = (tag: string, text: string) => write(`${tag} BAD ${text}${CRLF}`);

    function rowsFor(address: string): any[] {
        return opts.d1.db
            .prepare(`SELECT id, message_id, source, address, raw, raw_blob, created_at FROM raw_mails WHERE address = ? ORDER BY id ASC`)
            .all(address.toLowerCase()) as any[];
    }
    const seqRows = () => (authed ? rowsFor(authed) : []);

    async function handleLine(line: string): Promise<void> {
        if (awaitingSasl) {
            const tag = awaitingSasl;
            awaitingSasl = null;
            const okSasl = await saslPlain(line.trim());
            okSasl ? ok(tag, "AUTHENTICATE completed") : no(tag, "AUTHENTICATIONFAILED");
            return;
        }
        if (idling) {
            if (line.trim().toUpperCase() === "DONE") {
                idling = false;
                write(`* OK IDLE terminated${CRLF}`);
            }
            return;
        }
        const m = /^(\S+)\s+(\S+)(?:\s(.*))?$/.exec(line);
        if (!m) return;
        const tag = m[1];
        const cmd = m[2].toUpperCase();
        const rest = (m[3] || "").trim();

        switch (cmd) {
            case "CAPABILITY":
                write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE${CRLF}`);
                ok(tag, "CAPABILITY completed");
                return;
            case "NOOP": {
                maybeExists();
                ok(tag, "NOOP completed");
                return;
            }
            case "IDLE":
                idling = true;
                write(`+ idling${CRLF}`);
                return;
            case "LOGOUT":
                write(`* BYE temp-email IMAP closing${CRLF}`);
                ok(tag, "LOGOUT completed");
                sock.end();
                return;
            case "LOGIN": {
                const parts = splitArgs(rest);
                const u = strip(parts[0]);
                let p = strip(parts[1]);
                const user = u.includes("@") ? u : `${u}@${opts.domains[0]}`;
                authed = (await tryLogin(user, p)) ? user.toLowerCase() : null;
                if (authed) {
                    selected = false;
                    ok(tag, "LOGIN completed");
                } else {
                    no(tag, "AUTHENTICATIONFAILED invalid credentials");
                }
                return;
            }
            case "AUTHENTICATE": {
                const mech = rest.split(/\s+/)[0]?.toUpperCase();
                if (mech !== "PLAIN") {
                    no(tag, "AUTHENTICATIONFAILED only PLAIN supported");
                    return;
                }
                const b64 = rest.split(/\s+/)[1];
                if (!b64) {
                    awaitingSasl = tag;
                    write(`+ ${CRLF}`);
                    return;
                }
                const okSasl = await saslPlain(b64);
                okSasl ? ok(tag, "AUTHENTICATE completed") : no(tag, "AUTHENTICATIONFAILED");
                return;
            }
            case "LIST":
            case "LSUB":
                write(`* LIST (\\HasNoChildren) "/" "INBOX"${CRLF}`);
                ok(tag, `${cmd} completed`);
                return;
            case "STATUS": {
                const rows = authed ? seqRows() : [];
                write(`* STATUS "INBOX" (MESSAGES ${rows.length} UIDNEXT ${rows.length + 1} UIDVALIDITY 1 UNSEEN 0)${CRLF}`);
                ok(tag, "STATUS completed");
                return;
            }
            case "SELECT":
            case "EXAMINE": {
                if (!authed) return no(tag, "AUTHENTICATIONFAILED please login first");
                const rows = seqRows();
                lastCount = rows.length;
                selected = true;
                write(`* ${rows.length} EXISTS${CRLF}`);
                write(`* 0 RECENT${CRLF}`);
                write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)${CRLF}`);
                write(`* OK [PERMANENTFLAGS (\\Seen)] limited flags${CRLF}`);
                write(`* OK [UIDVALIDITY 1] UIDs valid${CRLF}`);
                write(`* OK [UIDNEXT ${rows.length + 1}] Predicted next UID${CRLF}`);
                ok(tag, `[READ-WRITE] ${cmd} completed`);
                return;
            }
            case "SEARCH": {
                if (!authed || !selected) return no(tag, "No mailbox selected");
                const rows = seqRows();
                const set = rows.map((_, i) => i + 1).join(" ");
                write(`* SEARCH ${set}${CRLF}`);
                ok(tag, "SEARCH completed");
                return;
            }
            case "FETCH":
            case "UID": {
                if (!authed || !selected) return no(tag, "No mailbox selected");
                let useUid = false;
                let argRest = rest;
                if (cmd === "UID") {
                    useUid = true;
                    const sp = rest.indexOf(" ");
                    if (sp === -1) return bad(tag, "UID needs FETCH");
                    if (rest.slice(0, sp).toUpperCase() !== "FETCH") return bad(tag, "Only UID FETCH supported");
                    argRest = rest.slice(sp + 1);
                }
                const sp2 = argRest.indexOf(" ");
                const setStr = sp2 === -1 ? argRest : argRest.slice(0, sp2);
                const itemsStr = sp2 === -1 ? "ALL" : argRest.slice(sp2 + 1).trim();
                const rows = seqRows();
                for (const seq of expandSet(setStr, rows.length, useUid ? rows : null)) {
                    const row = rows[seq - 1];
                    if (!row) continue;
                    write(`* ${seq} FETCH (${fetchItems(itemsStr, row, useUid ? Number(row.id) : seq, useUid)})${CRLF}`);
                }
                ok(tag, "FETCH completed");
                return;
            }
            case "STORE":
                no(tag, "Mailbox is read-only");
                return;
            case "CLOSE":
            case "CHECK":
            case "EXPUNGE":
                selected = false;
                ok(tag, `${cmd} completed`);
                return;
            case "APPEND":
                no(tag, "[TRYCREATE] Mailbox is read-only");
                return;
            default:
                bad(tag, `Unknown command ${cmd}`);
        }
    }

    function maybeExists(): void {
        if (!authed || !selected) return;
        const n = seqRows().length;
        if (n !== lastCount) {
            lastCount = n;
            write(`* ${n} EXISTS${CRLF}`);
        }
    }

    async function tryLogin(user: string, rawPassword: string): Promise<boolean> {
        const row = opts.d1.db
            .prepare(`SELECT password FROM address WHERE name = ?`)
            .get(user.toLowerCase()) as any;
        if (!row || !row.password) return false;
        return sha256hex(rawPassword) === row.password;
    }

    async function saslPlain(b64: string): Promise<boolean> {
        try {
            const decoded = Buffer.from(b64, "base64").toString("binary");
            const parts = decoded.split("\u0000");
            const user = (parts[1] || parts[2] || "").trim();
            const pass = (parts[2] || "").trim();
            let u = user.toLowerCase();
            if (!u.includes("@")) u = `${u}@${opts.domains[0]}`;
            authed = (await tryLogin(u, pass)) ? u : null;
            if (authed) selected = false;
            return !!authed;
        } catch {
            return false;
        }
    }
}

function strip(s: string | undefined): string {
    if (!s) return "";
    if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("{")))) {
        return s.slice(1, -1);
    }
    return s;
}

function splitArgs(rest: string): string[] {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of rest) {
        if (ch === '"') { q = !q; continue; }
        if (ch === " " && !q) { if (cur) out.push(cur); cur = ""; continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

function expandSet(setStr: string, count: number, rows: any[] | null): number[] {
    const out: number[] = [];
    if (setStr === "*" && rows) {
        // UID *
        if (rows.length) out.push(rows.length);
        return out;
    }
    for (const part of setStr.split(",")) {
        const r = /^(\d+)(?::(\d+|\*))?$/.exec(part);
        if (!r) continue;
        let a = parseInt(r[1]);
        let b = r[2] === undefined ? a : r[2] === "*" ? count : parseInt(r[2]);
        if (isNaN(a) || isNaN(b)) continue;
        if (a > b) [a, b] = [b, a];
        for (let i = a; i <= b; i++) if (i >= 1 && i <= count) out.push(i);
    }
    return [...new Set(out)].sort((x, y) => x - y);
}

function mailBytes(row: any): Buffer {
    // ENABLE_MAIL_GZIP stores gzip bytes in raw_blob (magic 1f 8b)
    if (row.raw_blob) {
        const b = Buffer.from(row.raw_blob);
        if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
            try { return zlib.gunzipSync(b); } catch { return b; }
        }
        return b;
    }
    return Buffer.from(row.raw || "", "utf8");
}

function headerBytes(row: any): Buffer {
    const b = mailBytes(row);
    const idx = b.indexOf("\r\n\r\n");
    if (idx >= 0) return b.subarray(0, idx + 4);
    const idx2 = b.indexOf("\n\n");
    if (idx2 >= 0) return b.subarray(0, idx2 + 2);
    return b;
}

function envelope(row: any): string {
    const hdr = headerBytes(row).toString("utf8");
    const get = (name: string): string => {
        const m = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(hdr);
        return m ? m[1].trim() : "";
    };
    const addr = (v: string): string => {
        if (!v) return "NIL";
        const em = /<([^>]+)>/.exec(v);
        const address = em ? em[1] : v;
        const nm = /^[^<]+(?=\s*<)/.exec(v);
        const name = nm ? nm[0].trim().replace(/"/g, "") : "";
        return name
            ? `((? "${name.replace(/"/g, '\\"')}" NIL "${address.split("@")[0]}" "${address.split("@")[1] || ""}"))`
            : `((NIL NIL "${address.split("@")[0]}" "${address.split("@")[1] || ""}"))`;
    };
    const esc = (s: string) => (s ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : "NIL");
    return [
        esc(get("Date") || row.created_at || ""),
        esc(get("Subject")),
        addr(get("From")),
        addr(get("Sender") || get("From")),
        addr(get("Reply-To") || get("From")),
        addr(get("To")),
        addr(get("Cc")),
        addr(get("Bcc")),
        esc(get("In-Reply-To")),
        esc(get("Message-ID") || row.message_id || ""),
    ].join(" ");
}

function fetchItems(itemsStr: string, row: any, seqOrUid: number, useUid: boolean): string {
    const upper = itemsStr.toUpperCase();
    const items = upper.includes("(")
        ? upper.slice(upper.indexOf("(") + 1, upper.lastIndexOf(")")).split(/\s+/).filter(Boolean)
        : upper === "ALL" ? ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"] : [upper.replace(/^\s+|\s+$/g, "")];
    const bytes = mailBytes(row);
    const parts: string[] = [];
    if (useUid) parts.push(`UID ${seqOrUid}`);
    for (const it of items) {
        if (it === "UID") parts.push(`UID ${row.id}`);
        else if (it === "FLAGS") parts.push(`FLAGS (\\Seen)`);
        else if (it === "RFC822.SIZE") parts.push(`RFC822.SIZE ${bytes.length}`);
        else if (it === "INTERNALDATE") {
            const d = new Date((row.created_at || "").replace(" ", "T") + "Z");
            const valid = !isNaN(d.getTime()) ? d : new Date();
            const fmt = valid.toUTCString().replace("GMT", "+0000");
            parts.push(`INTERNALDATE "${fmt}"`);
        } else if (it === "ENVELOPE") parts.push(`ENVELOPE (${envelope(row)})`);
        else if (it === "RFC822" || it === "BODY[]") parts.push(`RFC822 {${bytes.length}}${CRLF}${bytes.toString("binary")}`);
        else if (it.startsWith("RFC822.HEADER") || it === "BODY.PEEK[HEADER]" || it === "BODY[HEADER]") {
            const h = headerBytes(row);
            parts.push(`${it.startsWith("RFC822") ? "RFC822.HEADER" : "BODY[HEADER]"} {${h.length}}${CRLF}${h.toString("binary")}`);
        } else if (it === "RFC822.TEXT" || it === "BODY[TEXT]" || it === "BODY.PEEK[TEXT]") {
            const h = headerBytes(row);
            const t = mailBytes(row).subarray(h.length);
            parts.push(`RFC822.TEXT {${t.length}}${CRLF}${t.toString("binary")}`);
        } else if (it.startsWith("BODY.PEEK[") || it.startsWith("BODY[")) {
            const body = bytes.toString("binary");
            parts.push(`${it} {${body.length}}${CRLF}${body}`);
        } else if (it === "BODYSTRUCTURE" || it === "BODY") {
            parts.push(`BODY ("text" "plain" ("charset" "utf-8") NIL NIL "7BIT" ${bytes.length})`);
        }
    }
    if (!parts.length) parts.push(`UID ${row.id}`);
    return parts.join(" ");
}
