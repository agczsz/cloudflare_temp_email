import nodemailer from "nodemailer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Outbound mail component: replaces the Cloudflare `send_email` binding.
 *
 * - `createSendMailBinding()` returns a SEND_MAIL-compatible object; upstream
 *   code calls `SEND_MAIL.send(...)` with either a structured object
 *   ({from,to,subject,html,text,...}) or an EmailMessage instance
 *   ({from,to,raw}) — both are handled here via nodemailer.
 * - Delivery mode: direct-to-MX by default (nodemailer direct transport);
 *   set SEND_RELAY_HOST (+ optional SEND_RELAY_PORT/USER/PASS) to relay
 *   through a smarthost instead.
 * - DKIM: the RSA key is generated on first boot under
 *   `<data>/dkim/<selector>.private.pem`; publish
 *   `<selector>._domainkey.<domain>` TXT to make signatures verifiable.
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

export function createTransporter(cfg: any, dkim?: DkimInfo) {
    const dkimOpt = dkim
        ? {
              domainName: (Array.isArray(cfg.DOMAINS) ? cfg.DOMAINS[0] : "localhost"),
              keySelector: cfg.DKIM_SELECTOR || "smtp",
              privateKey: dkim.privateKey,
          }
        : undefined;
    if (cfg.SEND_RELAY_HOST) {
        const port = Number(cfg.SEND_RELAY_PORT || 587);
        return nodemailer.createTransport({
            host: cfg.SEND_RELAY_HOST,
            port,
            secure: port === 465,
            tls: cfg.SEND_RELAY_TLS_INSECURE ? { rejectUnauthorized: false } : undefined,
            auth: cfg.SEND_RELAY_USER
                ? { user: cfg.SEND_RELAY_USER, pass: cfg.SEND_RELAY_PASS || "" }
                : undefined,
            dkim: dkimOpt,
        });
    }
    return nodemailer.createTransport({
        direct: true,
        name: "smtp.266666.best",
        dkim: dkimOpt,
    });
}

export function createSendMailBinding(cfg: any, transporter: nodemailer.Transporter) {
    return {
        async send(msg: any): Promise<void> {
            if (msg && msg.raw !== undefined) {
                // EmailMessage instance: {from, to, raw}
                await transporter.sendMail({
                    from: msg.from,
                    to: msg.to,
                    raw: String(msg.raw),
                });
                return;
            }
            const attachments = Array.isArray(msg?.attachments)
                ? msg.attachments.map((a: any) => ({
                      filename: a.filename || a.name || "attachment",
                      content: a.content,
                      encoding: typeof a.content === "string" ? "base64" : undefined,
                      contentType: a.contentType || a.mimeType,
                  }))
                : undefined;
            let headers = msg?.headers;
            if (headers && typeof headers === "object" && !Array.isArray(headers)) {
                headers = Object.entries(headers).map(([k, v]) => ({ key: k, value: String(v) }));
            }
            await transporter.sendMail({
                from: msg?.from,
                to: msg?.to,
                cc: msg?.cc,
                bcc: msg?.bcc,
                replyTo: msg?.replyTo,
                subject: msg?.subject,
                text: msg?.text,
                html: msg?.html,
                headers,
                attachments,
            });
        },
    };
}
