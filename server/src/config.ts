import fs from "node:fs";
import path from "node:path";

/**
 * Server config. Loaded from (in order of increasing priority):
 *   1. config.json next to the working directory
 *   2. environment variables prefixed with TE_ (e.g. TE_PORT=48321)
 *
 * Every key here is forwarded verbatim into the worker `env` object, so all
 * wrangler.toml [vars] (DOMAINS, PREFIX, PASSWORDS, ENABLE_*, ...) can be set
 * the same way. A few runtime-only keys are also understood:
 *   PORT, HOST, SMTP_PORT, SMTP_HOST, DB_PATH, FRONTEND_DIST,
 *   AI_API_KEY / AI_ACCOUNT_ID  (Cloudflare Workers AI REST access, optional)
 *   RATE_LIMIT_COUNT / RATE_LIMIT_PERIOD (in-memory limiter for RATE_LIMITER)
 */
export interface ServerConfig {
    PORT: number;
    HOST?: string;
    SMTP_PORT: number;
    SMTP_HOST?: string;
    DB_PATH: string;
    FRONTEND_DIST: string;
    [key: string]: any;
}

export function loadConfig(): ServerConfig {
    const file = process.env.CONFIG_FILE
        || path.join(process.cwd(), "config.json");
    let cfg: any = {};
    if (fs.existsSync(file)) {
        cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    for (const k of Object.keys(process.env)) {
        if (k.startsWith("TE_")) {
            cfg[k.slice(3)] = process.env[k];
        }
    }
    cfg.PORT = Number(cfg.PORT || 48321);
    cfg.HOST = cfg.HOST || "0.0.0.0";
    cfg.SMTP_PORT = Number(cfg.SMTP_PORT ?? 25);
    cfg.SMTP_HOST = cfg.SMTP_HOST || cfg.HOST;
    cfg.DB_PATH = cfg.DB_PATH || path.join(process.cwd(), "data", "temp-email.db");
    cfg.FRONTEND_DIST = path.resolve(
        cfg.FRONTEND_DIST || path.join(process.cwd(), "..", "frontend", "dist"));
    return cfg as ServerConfig;
}
