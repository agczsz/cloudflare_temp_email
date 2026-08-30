import { SMTPServer } from "smtp-server";

/**
 * SMTP ingestion: listens on port 25 and feeds incoming messages into the
 * worker's `email()` handler (the same one Cloudflare Email Routing called).
 * The handler only needs a ForwardableEmailMessage-shaped object, which we
 * build from the smtp-server session. RCPT is restricted to the configured
 * DOMAINS, everything is accepted for those (temp-mail semantics).
 */

export interface SmtpAcceptedMessage {
    from: string;
    to: string;
    raw: Uint8Array;
    rawSize: number;
    headers: Headers;
    setReject: (reason: string) => void;
    forward: (rcptTo: string, headers?: Headers) => Promise<void>;
}

export interface SmtpSessionLike {
    envelope: {
        mailFrom: { address: string } | null;
        rcptTo: Array<{ address: string }>;
    };
}

export function parseTopHeaders(buf: Uint8Array): Headers {
    const text = new TextDecoder("latin1").decode(buf.subarray(0, Math.min(buf.length, 1 << 20)));
    const end = text.indexOf("\r\n\r\n");
    const headerBlock = end === -1 ? text : text.slice(0, end);
    const headers = new Headers();
    const lines = headerBlock.split(/\r\n|\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        // unfold folded header lines
        while (i + 1 < lines.length && (lines[i + 1].startsWith(" ") || lines[i + 1].startsWith("\t"))) {
            line += " " + lines[i + 1].trim();
            i++;
        }
        const idx = line.indexOf(":");
        if (idx > 0) {
            const name = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            try { headers.append(name, value); } catch { /* invalid header name, skip */ }
        }
    }
    return headers;
}

export function startSmtpServer(opts: {
    port: number;
    host: string;
    allowedDomains: string[];
    onMessage: (message: SmtpAcceptedMessage, session: SmtpSessionLike) => Promise<void>;
}): SMTPServer {
    const allowed = new Set(opts.allowedDomains.map((d) => d.toLowerCase()));

    const server = new SMTPServer({
        authOptional: true,
        banner: "temp-email ESMTP ready",
        disabledCommands: ["AUTH"],
        onRcptTo(address, session, cb) {
            const addr = String(address?.address || "").toLowerCase();
            const domain = addr.split("@")[1];
            if (!addr.includes("@") || !domain || !allowed.has(domain)) {
                return cb(new Error("550 relay denied: unknown recipient domain"));
            }
            cb();
        },
        onData(stream, session, cb) {
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", async () => {
                const buf = Buffer.concat(chunks);
                try {
                    const rcpts = session.envelope.rcptTo.map((r) => r.address);
                    for (const rcpt of rcpts) {
                        let rejectReason: string | null = null;
                        const message: SmtpAcceptedMessage = {
                            from: session.envelope.mailFrom?.address || "",
                            to: rcpt,
                            raw: new Uint8Array(buf),
                            rawSize: buf.length,
                            headers: parseTopHeaders(buf),
                            setReject(reason: string) { rejectReason = reason; },
                            async forward() { /* CF send_email binding not available on VPS */ },
                        };
                        await opts.onMessage(message, session as SmtpSessionLike);
                        if (rejectReason) {
                            return cb(new Error(`550 ${rejectReason}`));
                        }
                    }
                    cb();
                } catch (e) {
                    console.error("[smtp] handler error:", e);
                    cb(new Error("451 internal error processing message"));
                }
            });
            stream.on("error", (e: Error) => {
                console.error("[smtp] data stream error:", e);
                cb(e);
            });
        },
    });

    server.on("error", (e) => console.error("[smtp] server error:", e));
    server.listen(opts.port, opts.host, () => {
        console.log(`[smtp] listening on ${opts.host}:${opts.port} for domains: ${[...allowed].join(", ")}`);
    });
    return server;
}
