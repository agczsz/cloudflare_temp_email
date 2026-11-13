import nodemailer from "nodemailer";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Outbound mail component: replaces the Cloudflare `send_email` binding.
 *
 * Delivery modes:
 *  - direct (default): per-recipient-domain MX routing over port 25.
 *  - relay: set SEND_RELAY_HOST (+ optional SEND_RELAY_PORT/USER/PASS/
 *    SEND_RELAY_TLS_INSECURE) to hand everything to a smarthost instead.
 *
 * Each configured sender domain gets its own persistent DKIM key. Both the
 * direct and relay paths choose the DKIM identity from the message's From.
 */

export interface DkimInfo {
    domain: string;
    privateKey: string;
    publicKey: string;
    dnsRecord: string;
}

export type DkimInfoMap = Map<string, DkimInfo>;

const configuredDomains = (domains: unknown): string[] => {
    const values = Array.isArray(domains) ? domains : String(domains || "").split(",");
    return [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
};

export function ensureDkimKeys(cfg: { DB_PATH: string; DKIM_SELECTOR?: string; DOMAINS?: string[] | string; DEFAULT_DOMAINS?: string[] | string }): DkimInfoMap {
    const selector = cfg.DKIM_SELECTOR || "smtp";
    const domains = [...new Set([...configuredDomains(cfg.DOMAINS), ...configuredDomains(cfg.DEFAULT_DOMAINS)])];
    const dir = path.join(path.dirname(cfg.DB_PATH), "dkim");
    fs.mkdirSync(dir, { recursive: true });

    const result: DkimInfoMap = new Map();
    for (const domain of domains) {
        // Keep the existing key for the first configured domain, so upgrades
        // retain its current DNS identity. Additional domains have separate keys.
        const legacyFirstDomain = domain === domains[0];
        const keyName = legacyFirstDomain ? selector : `${selector}.${domain}`;
        const privFile = path.join(dir, `${keyName}.private.pem`);
        const pubFile = path.join(dir, `${keyName}.public.pem`);
        if (!fs.existsSync(privFile)) {
            const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
            fs.writeFileSync(privFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
            fs.writeFileSync(pubFile, publicKey.export({ type: "spki", format: "pem" }).toString(), { mode: 0o644 });
            console.log(`[dkim] generated key pair for ${domain}: ${privFile}`);
        }
        const privateKey = fs.readFileSync(privFile, "utf8");
        const publicKey = fs.readFileSync(pubFile, "utf8");
        const dnsRecord = `${selector}._domainkey.${domain} TXT "v=DKIM1; k=rsa; p=${publicKey
            .split("\n")
            .filter((line) => line && !line.includes("-----"))
            .join("")}"`;
        result.set(domain, { domain, privateKey, publicKey, dnsRecord });
    }
    return result;
}

const normalizeAddresses = (vals: any): string[] => {
    const out: string[] = [];
    const walk = (value: any) => {
        if (!value) return;
        if (typeof value === "string") out.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (typeof value === "object" && value.address) out.push(value.address);
    };
    walk(vals);
    return out;
};

const addressValue = (value: any): string => {
    if (typeof value === "string") return value;
    if (value && typeof value.address === "string") return value.address;
    if (value && typeof value.email === "string") return value.email;
    return "";
};

export const normalizeFrom = (from: any): any => {
    if (!from || typeof from !== "object" || Array.isArray(from)) return from;
    if (typeof from.address === "string") return from;
    if (typeof from.email === "string") {
        const { email, ...rest } = from;
        return { ...rest, address: email };
    }
    return from;
};

export const renderStructuredMessage = async (renderer: nodemailer.Transporter, opts: any): Promise<Buffer> => {
    const info: any = await new Promise((resolve, reject) => {
        renderer.sendMail({ ...opts, from: normalizeFrom(opts?.from) }, (err: any, res: any) =>
            err ? reject(err) : resolve(res));
    });
    return info.message;
};

const domainOf = (addr: string): string => (addr.split("@").pop() || "").trim().toLowerCase();

export function createMailer(
    cfg: any,
    dkimByDomain?: DkimInfoMap,
    transportFactory: typeof nodemailer.createTransport = nodemailer.createTransport,
) {
    const firstDomain = [...new Set([...configuredDomains(cfg.DOMAINS), ...configuredDomains(cfg.DEFAULT_DOMAINS)])][0] || "localhost";
    const helloName = cfg.HELLO_NAME || `smtp.${firstDomain}`;
    const selector = cfg.DKIM_SELECTOR || "smtp";
    const dkimFor = (from: any) => {
        const domain = domainOf(addressValue(from));
        const info = dkimByDomain?.get(domain);
        return info ? { domainName: info.domain, keySelector: selector, privateKey: info.privateKey } : undefined;
    };

    const relayTransports = new Map<string, nodemailer.Transporter>();
    function relayTransportFor(from: any): nodemailer.Transporter {
        const domain = domainOf(addressValue(from));
        let transport = relayTransports.get(domain);
        if (!transport) {
            transport = transportFactory({
                host: cfg.SEND_RELAY_HOST,
                port: Number(cfg.SEND_RELAY_PORT || 587),
                secure: Number(cfg.SEND_RELAY_PORT || 587) === 465,
                tls: cfg.SEND_RELAY_TLS_INSECURE ? { rejectUnauthorized: false } : undefined,
                auth: cfg.SEND_RELAY_USER
                    ? { user: cfg.SEND_RELAY_USER, pass: cfg.SEND_RELAY_PASS || "" }
                    : undefined,
                dkim: dkimFor(from),
            });
            relayTransports.set(domain, transport);
        }
        return transport;
    }

    // direct mode: render structured messages to raw bytes and cache MX transports
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

    function directTransportFor(host: string, from: any): nodemailer.Transporter {
        const senderDomain = domainOf(addressValue(from));
        const cacheKey = `${host}|${senderDomain}`;
        let transport = directTransports.get(cacheKey);
        if (!transport) {
            transport = transportFactory({
                host,
                port: 25,
                name: helloName,
                connectionTimeout: 30_000,
                socketTimeout: 60_000,
                family: 4,
                dkim: dkimFor(from),
            });
            directTransports.set(cacheKey, transport);
        }
        return transport;
    }

    async function sendMail(opts: any): Promise<any> {
        const from = opts?.from;
        const dkim = dkimFor(from);
        if (cfg.SEND_RELAY_HOST) {
            return relayTransportFor(from).sendMail({ ...opts, from: normalizeFrom(from), dkim });
        }
        let raw: Buffer;
        let recipients: string[];
        if (opts?.raw !== undefined) {
            raw = Buffer.from(opts.raw);
            recipients = normalizeAddresses(opts?.to);
        } else {
            raw = await renderStructuredMessage(renderer, { ...opts, dkim: undefined });
            recipients = normalizeAddresses([opts?.to, opts?.cc, opts?.bcc]);
        }
        if (!recipients.length) throw new Error("no recipients");

        const byDomain = new Map<string, string[]>();
        for (const rcpt of recipients) {
            const recipientDomain = domainOf(rcpt);
            if (!recipientDomain) throw new Error(`invalid recipient: ${rcpt}`);
            byDomain.set(recipientDomain, [...(byDomain.get(recipientDomain) || []), rcpt]);
        }

        const failures: string[] = [];
        for (const [recipientDomain, rcpts] of byDomain) {
            try {
                const host = await pickMxHost(recipientDomain);
                if (!host) throw new Error("no MX/A host");
                await directTransportFor(host, from).sendMail({ from, to: rcpts, raw });
                console.log(`[direct] ${from?.address || from?.email || from} -> ${rcpts.join(",")} via ${host}`);
            } catch (e: any) {
                console.error(`[direct] delivery to ${recipientDomain} failed: ${e.message}`);
                failures.push(`${recipientDomain}: ${e.message}`);
            }
        }
        if (failures.length) {
            throw new Error(
                `direct delivery failed (${failures.join("; ")})` +
                    " — if outbound port 25 is blocked by the provider, configure SEND_RELAY_HOST");
        }
        return { accepted: recipients };
    }

    async function send(msg: any): Promise<void> {
        await sendMail(msg);
    }

    return { sendMail, send };
}
