import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Minimal Cloudflare D1-compatible adapter over better-sqlite3.
 * Implements the subset the worker code actually uses:
 *   prepare(sql).bind(...).first(col?) / .all() / .run() / .raw()
 *   batch([stmt, ...])
 *   exec(sql)
 */

type BindValue = null | string | number | bigint | ArrayBuffer | Uint8Array;

function toSqlite(v: BindValue): any {
    if (v instanceof ArrayBuffer) return Buffer.from(v);
    if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (v === undefined) return null;
    return v;
}

export class D1PreparedStatement {
    constructor(
        private db: Database.Database,
        private sql: string,
        private params: BindValue[] = [],
    ) { }

    bind(...params: BindValue[]): D1PreparedStatement {
        return new D1PreparedStatement(this.db, this.sql, params);
    }

    private stmt() {
        return this.db.prepare(this.sql);
    }

    async first<T = any>(colName?: string): Promise<T | null> {
        const row = this.stmt().get(...this.params.map(toSqlite)) as any;
        if (row === undefined || row === null) return null;
        if (colName !== undefined) {
            return (row[colName] ?? null) as T;
        }
        return row as T;
    }

    async all<T = any>(): Promise<{ results: T[]; success: boolean; meta: any }> {
        const t0 = Date.now();
        const rows = this.stmt().all(...this.params.map(toSqlite)) as T[];
        return {
            results: rows,
            success: true,
            meta: { changes: 0, duration: Date.now() - t0, rows_read: rows.length },
        };
    }

    async run(): Promise<{ success: boolean; meta: any }> {
        const t0 = Date.now();
        const info = this.stmt().run(...this.params.map(toSqlite));
        return {
            success: true,
            meta: {
                changes: info.changes,
                last_row_id: Number(info.lastInsertRowid),
                duration: Date.now() - t0,
            },
        };
    }

    async raw<T = any[]>(): Promise<T[]> {
        return this.stmt().raw().all(...this.params.map(toSqlite)) as T[];
    }
}

export class D1Database {
    public db: Database.Database;

    constructor(file: string) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("busy_timeout = 5000");
    }

    prepare(sql: string): D1PreparedStatement {
        return new D1PreparedStatement(this.db, sql);
    }

    async batch(statements: D1PreparedStatement[]): Promise<Array<{ success: boolean; meta: any }>> {
        const runAll = this.db.transaction((stmts: D1PreparedStatement[]) =>
            stmts.map((s) => {
                const st = (s as any).stmt();
                const params = (s as any).params.map(toSqlite);
                const info = params.length ? st.run(...params) : st.run();
                return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
            }));
        return runAll(statements);
    }

    exec(sql: string): void {
        this.db.exec(sql);
    }

    close(): void {
        this.db.close();
    }
}
