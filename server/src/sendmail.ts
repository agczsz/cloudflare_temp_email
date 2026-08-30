import nodemailer from "nodemailer";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Outbound mail component: replaces the Cloudflare `send_email` binding.
 *
 * Delivery modes:
 *  - direct (default): per-recipient-domain MX routing (dns.resolveMx), each
 *    domain is delivered by a plain nodemailer SMTP client on port 25 with our
 *    EHLO name and DKIM signature. Requires the VPS provider to allow outbound
 *    port 25.
 *  - relay: set SEND_RELAY_HOST (+ optional SEND_RELAY_PORT/USER/PASS/
 *    SEND_RELAY_TLS_INSECURE) to hand everything to a smarthost instead.
 *
 * `SEND_MAIL.send(msg)` accepts both shapes upstream uses:
 *  - structured: {from, to, subject, html?, text?, cc?, bcc?, replyTo?,
 *    attachments?, headers?}
 *  - EmailMessage instance: {from, to, raw}
 * `mailer.sendMail(opts)` (same options) is shared with the 465 submission
 * server so client-submitted mail gets identical treatment.
 */

export interface DkimInfo {
    privateKey: string;
    publicKey: string;
    dnsRecord: string;
}

export function ensureDkimKey(cfg: { DB_PATH: string; DKIM_SELECTOR?: string; DOMAINS: string[] }): DkimInfo {
    const selector = cfg.DKIM_SELECTOR || "smtp";
    const domain = (Array.isArray(cfg.DOMAINS) ? cfg.DOMAINS[0] : String(cfg.DOMAINS || "").split(",")[0]) || "localhost";
    const dir = path.join(path.dirname(cfg.DB_PATH), "dkim");
    fs.mkdirSync(dir, { recursive: true });
    const privFile = path.join(dir, `${selector}.private.pem`);
    const pubFile = path.join(dir, `${selector}.public.pem`);
    if (!fs.existsSync(privFile)) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
        fs.writeFileSync(privFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
        fs.writeFileSync(pubFile, publicKey.export({ type: "spki", format: "pem" }).toString());
        console.log(`[dkim] generated key pair: ${privFile}`);
    }
    const privateKey = fs.readFileSync(privFile, "utf8");
    const publicKey = fs.readFileSync(pubFile, "utf8");
    const dnsRecord = `${selector}._domainkey.${domain} TXT "v=DKIM1; k=rsa; p=${publicKey
        .split("\n")
        .filter((l) => l && !l.includes("-----"))
        .join("")}"`;
    return { privateKey, publicKey, dnsRecord };
}

const normalizeAddresses = (vals: any): string[] => {
    const out: string[] = [];
    const walk = (v: any) => {
        if (!v) return;
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === "object" && v.address) out.push(v.address);
    };
    walk(vals);
    return out;
};

const domainOf = (addr: string): string => (addr.split("@")[1] || "").toLowerCase();

export function createMailer(cfg: any, dkim?: DkimInfo) {
    const firstDomain = Array.isArray(cfg.DOMAINS) ? cfg.DOMAINS[0] : String(cfg.DOMAINS || "").split(",")[0];
    const helloName = cfg.HELLO_NAME || `smtp.${firstDomain || "localhost"}`;
    const dkimOpt = dkim
        ? { domainName: firstDomain || "localhost", keySelector: cfg.DKIM_SELECTOR || "smtp", privateKey: dkim.privateKey }
        : undefined;

    // relay mode: one fixed smarthost
    const relayTransport = cfg.SEND_RELAY_HOST
        ? nodemailer.createTransport({
              host: cfg.SEND_RELAY_HOST,
              port: Number(cfg.SEND_RELAY_PORT || 587),
              secure: Number(cfg.SEND_RELAY_PORT || 587) === 465,
              tls: cfg.SEND_RELAY_TLS_INSECURE ? { rejectUnauthorized: false } : undefined,
              auth: cfg.SEND_RELAY_USER
                  ? { user: cfg.SEND_RELAY_USER, pass: cfg.SEND_RELAY_PASS || "" }
                  : undefined,
              dkim: dkimOpt,
          })
        : null;

    // direct mode: stream-transport to render structured messages to raw bytes,
    // per-domain MX transports (created lazily, cached) for delivery
    const renderer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "normalize" });
    const mxCache = new Map<string, string>();
    const directTransports = new Map<string, nodemailer.Transporter>();

    async function pickMxHost(domain: string): Promise<string> {
        if (mxCache.has(domain)) return mxCache.get(domain)!;
        let host = domain;
        try {
            const records = await dns.promises.resolveMx(domain);
            if (records && records.length) {
                records.sort((a, b) => a.priority - b.priority);
                host = records[0].exchange;
            }
        } catch {
            /* no MX -> fall back to the A record of the domain itself */
        }
        mxCache.set(domain, host);
        return host;
    }

    function directTransportFor(host: string): nodemailer.Transporter {
        let t = directTransports.get(host);
        if (!t) {
            t = nodemailer.createTransport({
                host,
                port: 25,
                name: helloName,
                connectionTimeout: 30_000,
                socketTimeout: 60_000,
                dkim: dkimOpt,
            });
            directTransports.set(host, t);
        }
        return t;
    }

    async function sendMail(opts: any): Promise<any> {
        if (relayTransport) {
            return relayTransport.sendMail(opts);
        }
        let raw: Buffer;
        let from = opts?.from;
        let recipients: string[];
        if (opts?.raw !== undefined) {
            raw = Buffer.from(opts.raw);
            recipients = normalizeAddresses(opts?.to);
        } else {
            const info: any = await new Promise((resolve, reject) => {
                renderer.sendMail({ ...opts, dkim: undefined }, (err: any, res: any) =>
                    err ? reject(err) : resolve(res));
            });
            raw = info.message;
            recipients = normalizeAddresses([opts?.to, opts?.cc, opts?.bcc]);
        }
        if (!recipients.length) throw new Error("no recipients");

        const byDomain = new Map<string, string[]>();
        for (const rcpt of recipients) {
            const dom = domainOf(rcpt);
            if (!dom) throw new Error(`invalid recipient: ${rcpt}`);
            byDomain.set(dom, [...(byDomain.get(dom) || []), rcpt]);
        }

        const failures: string[] = [];
        for (const [dom, rcpts] of byDomain) {
            try {
                const host = await pickMxHost(dom);
                if (!host) throw new Error("no MX/A host");
                await directTransportFor(host).sendMail({ from, to: rcpts, raw });
                console.log(`[direct] ${from} -> ${rcpts.join(",")} via ${host}`);
            } catch (e: any) {
                console.error(`[direct] delivery to ${dom} failed: ${e.message}`);
                failures.push(`${dom}: ${e.message}`);
            }
        }
        if (failures.length) {
            throw new Error(
                `direct delivery failed (${failures.join("; ")})` +
                    (cfg.SEND_RELAY_HOST ? "" : " — if outbound port 25 is blocked by the provider, configure SEND_RELAY_HOST"));
        }
        return { accepted: recipients };
    }

    async function send(msg: any): Promise<void> {
        await sendMail(msg);
    }

    return { sendMail, send };
}
