/**
 * Node entry point for cloudflare_temp_email on a VPS.
 *
 * Reuses the worker code unchanged (HTTP app, email handler, scheduled
 * cleanup) and provides VPS implementations for the Cloudflare bindings:
 *   DB            -> SQLite file (D1-compatible adapter, better-sqlite3)
 *   KV            -> SQLite-backed key/value store
 *   AI            -> Workers AI REST API (reserved key slot in config.json)
 *   RATE_LIMITER  -> in-memory fixed window
 *   ASSETS        -> static files from the built frontend dist
 *
 * Listens on:
 *   PORT      (HTTP API + frontend, default 48321)
 *   SMTP_PORT (SMTP ingestion, default 25, restricted to DOMAINS)
 */
import path from "node:path";
import fs from "node:fs";
import { serve } from "@hono/node-server";

import worker from "../../worker/src/worker";
import { loadConfig } from "./config";
import { D1Database } from "./d1";
import { KVNamespaceShim } from "./kv";
import { createAiBinding } from "./ai";
import { createRateLimiter } from "./ratelimit";
import { createAssets } from "./assets";
import { startSmtpServer } from "./smtp";
import { ensureDkimKey, createTransporter, createSendMailBinding } from "./sendmail";
import { startSubmitServer } from "./submit";
import { startImapServer } from "./imap";
import { execSync } from "node:child_process";
import type { ServerConfig } from "./config";

function migrate(db: D1Database, dbFile: string): void {
    const repoRoot = path.resolve(import.meta.dirname ?? ".", "..", "..");
    const schemaFile = path.join(repoRoot, "db", "schema.sql");
    if (fs.existsSync(schemaFile)) {
        db.exec(fs.readFileSync(schemaFile, "utf8"));
        console.log(`[db] schema applied from db/schema.sql`);
    } else {
        console.warn(`[db] schema.sql not found at ${schemaFile}`);
    }
    // apply dated migration patches best-effort (fresh DBs already have everything)
    const dbDir = path.join(repoRoot, "db");
    if (fs.existsSync(dbDir)) {
        for (const f of fs.readdirSync(dbDir).sort()) {
            if (!f.endsWith(".sql") || f === "schema.sql") continue;
            try {
                db.exec(fs.readFileSync(path.join(dbDir, f), "utf8"));
            } catch (e: any) {
                console.warn(`[db] patch ${f} skipped: ${String(e.message).split("\n")[0]}`);
            }
        }
    }
    void dbFile;
}

async function main() {
    const cfg: ServerConfig = loadConfig();
    fs.mkdirSync(path.dirname(cfg.DB_PATH), { recursive: true });

    const d1 = new D1Database(cfg.DB_PATH);
    migrate(d1, cfg.DB_PATH);

    const domains: string[] = Array.isArray(cfg.DOMAINS)
        ? cfg.DOMAINS
        : typeof cfg.DOMAINS === "string" ? JSON.parse(cfg.DOMAINS) : [];
    const defaultDomains: string[] = Array.isArray(cfg.DEFAULT_DOMAINS)
        ? cfg.DEFAULT_DOMAINS
        : typeof cfg.DEFAULT_DOMAINS === "string" ? JSON.parse(cfg.DEFAULT_DOMAINS) : domains;
    const allDomains = [...new Set([...domains, ...defaultDomains])];

    const env: any = {
        ...cfg,
        DB: d1,
        KV: new KVNamespaceShim(d1),
        AI: createAiBinding(cfg),
        RATE_LIMITER: createRateLimiter(cfg),
        ASSETS: createAssets(cfg.FRONTEND_DIST),
    };
    // outbound sending: SEND_MAIL-compatible binding over nodemailer
    // (direct-to-MX by default, or relay via SEND_RELAY_HOST); addy-style
    // scoping via SEND_MAIL_DOMAINS applies inside the worker
    const dkim = ensureDkimKey(cfg);
    const transporter = createTransporter(cfg, dkim);
    env.SEND_MAIL = createSendMailBinding(cfg, transporter);
    env.SEND_MAIL_DOMAINS = allDomains;

    // @hono/node-server calls fetch(request) without env — inject ours here.
    const nodeFetch = (request: Request) =>
        worker.fetch(request, env, { waitUntil: () => { } } as any);

    const httpServer = serve({ fetch: nodeFetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => {
        console.log(`[http] listening on http://${info.address}:${info.port} (frontend: ${cfg.FRONTEND_DIST})`);
        console.log(`[http] domains: ${allDomains.join(", ")}`);
        console.log(`[http] ai binding: ${env.AI ? "REST (key configured)" : "not configured -> regex fallback"}`);
    });

    startSmtpServer({
        port: cfg.SMTP_PORT,
        host: cfg.SMTP_HOST || "0.0.0.0",
        allowedDomains: allDomains,
        onMessage: (message) => worker.email(message as any, env, { waitUntil: () => { } } as any),
    });

    // optional mail-client ports: SMTPS submission (:465) + IMAPS (:993)
    const tls = resolveTls(cfg);
    if (Number(cfg.SMTP_SSL_PORT ?? 465) > 0 && tls) {
        startSubmitServer({
            port: Number(cfg.SMTP_SSL_PORT ?? 465),
            host: cfg.HOST || "0.0.0.0",
            cert: tls.cert,
            key: tls.key,
            d1,
            domains: allDomains,
            transporter,
        });
    } else {
        console.log("[submit] SMTPS disabled (SMTP_SSL_PORT=0 or no TLS cert)");
    }
    if (Number(cfg.IMAP_SSL_PORT ?? 993) > 0 && tls) {
        startImapServer({
            port: Number(cfg.IMAP_SSL_PORT ?? 993),
            host: cfg.HOST || "0.0.0.0",
            cert: tls.cert,
            key: tls.key,
            d1,
            domains: allDomains,
        });
    } else {
        console.log("[imap] IMAPS disabled (IMAP_SSL_PORT=0 or no TLS cert)");
    }

    // daily scheduled cleanup (same handler the Workers cron triggered)
    const timer = setInterval(() => {
        worker.scheduled({ cron: "0 0 * * *" } as any, env, { waitUntil: () => { } } as any)
            .catch((e: any) => console.error("[cron] scheduled cleanup error:", e));
    }, 24 * 3600 * 1000);
    timer.unref();

    const shutdown = () => {
        console.log("[shutdown] closing...");
        httpServer.close();
        d1.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

function resolveTls(cfg: ServerConfig): { cert: string; key: string } | null {
    const certFile = cfg.TLS_CERT_PATH;
    const keyFile = cfg.TLS_KEY_PATH;
    if (certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
        return { cert: fs.readFileSync(certFile, "utf8"), key: fs.readFileSync(keyFile, "utf8") };
    }
    // fall back to a generated self-signed cert so the ports still work
    const dir = path.join(path.dirname(cfg.DB_PATH), "certs");
    const cFile = path.join(dir, "selfsigned.crt");
    const kFile = path.join(dir, "selfsigned.key");
    if (fs.existsSync(cFile) && fs.existsSync(kFile)) {
        console.warn("[tls] using existing self-signed certificate (client-side warning expected)");
        return { cert: fs.readFileSync(cFile, "utf8"), key: fs.readFileSync(kFile, "utf8") };
    }
    try {
        fs.mkdirSync(dir, { recursive: true });
        execSync(
            `openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes ` +
                `-subj "/CN=mail.266666.best" -keyout "${kFile}" -out "${cFile}"`,
            { stdio: "ignore" },
        );
        console.warn("[tls] generated self-signed certificate (set TLS_CERT_PATH/TLS_KEY_PATH to use a real one)");
        return { cert: fs.readFileSync(cFile, "utf8"), key: fs.readFileSync(kFile, "utf8") };
    } catch (e) {
        console.error("[tls] no certificate available, mail-client ports disabled:", e);
        return null;
    }
}

main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
});
