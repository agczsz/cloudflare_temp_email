import { SMTPServer } from "smtp-server";
import crypto from "node:crypto";

/**
 * SMTP submission server (implicit TLS, default :465) for mail clients.
 * Auth = mailbox address + its password (the raw password is SHA-256 hexed and
 * compared with address.password, exactly how the frontend stores it).
 * Envelope-from must match the authenticated address; the accepted message is
 * handed to the same nodemailer transporter used by the SEND_MAIL binding, so
 * DKIM signing applies here too.
 */

const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function startSubmitServer(opts: {
    port: number;
    host: string;
    cert: string;
    key: string;
    d1: any; // D1Database (better-sqlite3 backed)
    domains: string[];
    transporter: { sendMail: (opts: any) => Promise<any> };
}): SMTPServer {
    const allowedOutbound = new Set(opts.domains.map((d) => d.toLowerCase()));

    const server = new SMTPServer({
        secure: true,
        cert: opts.cert,
        key: opts.key,
        authOptional: false, // AUTH required before MAIL FROM
        hideSTARTTLS: true,
        banner: "temp-email submission ESMTP ready",
        onAuth(auth, session, cb) {
            let user = String(auth.username || "").trim().toLowerCase();
            if (user && !user.includes("@")) {
                user = `${user}@${opts.domains[0]}`;
            }
            const row = opts.d1.db
                .prepare(`SELECT name, password FROM address WHERE name = ?`)
                .get(user) as any;
            if (!row || !row.password) {
                return cb(new Error("Invalid login or password"));
            }
            if (sha256hex(String(auth.password || "")) !== row.password) {
                return cb(new Error("Invalid login or password"));
            }
            cb(null, { user: row.name });
        },
        onMailFrom(address, session, cb) {
            const authed = (session as any)?.user;
            if (!authed) return cb(new Error("530 Authentication required"));
            const from = String(address?.address || "").toLowerCase();
            if (from !== String(authed).toLowerCase()) {
                return cb(new Error("550 envelope-from must match authenticated address"));
            }
            cb();
        },
        onRcptTo(address, session, cb) {
            const rcpt = String(address?.address || "");
            if (!rcpt.includes("@")) return cb(new Error("550 invalid recipient"));
            cb(); // outbound: any destination
        },
        onData(stream, session, cb) {
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => {
                const buf = Buffer.concat(chunks);
                const from = session.envelope.mailFrom?.address || "";
                const to = session.envelope.rcptTo.map((r) => r.address);
                opts.transporter
                    .sendMail({ from, to, raw: new Uint8Array(buf) })
                    .then(async (info) => {
                        console.log(`[submit] ${from} -> ${to.join(",")} (${info.messageId})`);
                        // mirror the web send flow: save a copy into `sendbox`
                        // so the frontend 发件箱 shows SMTP-submitted mail too
                        try {
                            const { default: PostalMime } = await import("postal-mime");
                            const parsed = await PostalMime.parse(new Uint8Array(buf));
                            const record = {
                                version: "v2",
                                from_mail: from,
                                to_mail: to.join(","),
                                subject: parsed.subject || "",
                                is_html: !parsed.text && !!parsed.html,
                                content: parsed.text || parsed.html || "",
                            };
                            opts.d1.db
                                .prepare(`INSERT INTO sendbox (address, raw, created_at) VALUES (?, ?, datetime('now'))`)
                                .run(String((session as any).user || from), JSON.stringify(record));
                        } catch (e: any) {
                            console.warn(`[submit] failed to save sendbox copy for ${from}:`, e.message);
                        }
                        cb();
                    })
                    .catch((e) => {
                        console.error("[submit] send failed:", e.message);
                        cb(new Error("451 message not accepted"));
                    });
            });
            stream.on("error", (e) => cb(e));
        },
    });

    server.on("error", (e) => console.error("[submit] server error:", e));
    server.listen(opts.port, opts.host, () => {
        console.log(`[submit] SMTPS listening on ${opts.host}:${opts.port}`);
    });
    return server;
}
