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
    // send_email binding does not exist on a plain VPS; the worker degrades gracefully
    env.SEND_MAIL = undefined;

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

main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
});
