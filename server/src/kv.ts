import type { D1Database } from "./d1";

/**
 * Cloudflare KV-compatible shim backed by the same SQLite database.
 * Supports the call shapes used by the worker: get / put(key, value, {expirationTtl}) / delete / list.
 */
export class KVNamespaceShim {
    constructor(private d1: D1Database) {
        d1.exec(`CREATE TABLE IF NOT EXISTS kv_storage (
            key TEXT PRIMARY KEY,
            value TEXT,
            expires_at INTEGER
        )`);
    }

    async get(key: string, type?: string): Promise<string | null> {
        const row = this.d1.db
            .prepare(`SELECT value, expires_at FROM kv_storage WHERE key = ?`)
            .get(key) as any;
        if (!row) return null;
        if (row.expires_at && row.expires_at < Date.now()) {
            this.d1.db.prepare(`DELETE FROM kv_storage WHERE key = ?`).run(key);
            return null;
        }
        return row.value as string;
    }

    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
        const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
        this.d1.db
            .prepare(`INSERT OR REPLACE INTO kv_storage (key, value, expires_at, created_at)
                      VALUES (?, ?, ?, COALESCE((SELECT created_at FROM kv_storage WHERE key = ?), datetime('now')))`)
            .run(key, String(value), expiresAt, key);
    }

    async delete(key: string): Promise<void> {
        this.d1.db.prepare(`DELETE FROM kv_storage WHERE key = ?`).run(key);
    }

    async list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string; expiration?: number }> }> {
        const prefix = opts?.prefix ?? "";
        const rows = this.d1.db
            .prepare(`SELECT key, expires_at FROM kv_storage WHERE key LIKE ? `)
            .all(prefix + "%") as any[];
        const now = Date.now();
        return {
            keys: rows
                .filter((r) => !r.expires_at || r.expires_at >= now)
                .map((r) => ({ name: r.key, expiration: r.expires_at ? Math.floor(r.expires_at / 1000) : undefined })),
        };
    }
}
