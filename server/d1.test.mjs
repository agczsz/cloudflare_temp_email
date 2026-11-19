import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const require = createRequire(import.meta.url);
const d1Source = (await readFile(new URL("./src/d1.ts", import.meta.url), "utf8"))
    .replace('import Database from "better-sqlite3";', `import Database from ${JSON.stringify(pathToFileURL(require.resolve("better-sqlite3")).href)};`);
const { code } = await transform(d1Source, { loader: "ts", format: "esm" });
const { D1Database } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("D1 batch returns result rows for upstream read queries", async () => {
    const db = new D1Database(":memory:");
    try {
        db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)");
        await db.prepare("INSERT INTO items (value) VALUES (?)").bind("first").run();

        const [rows, write] = await db.batch([
            db.prepare("SELECT id, value FROM items WHERE id = ?").bind(1),
            db.prepare("INSERT INTO items (value) VALUES (?)").bind("second"),
        ]);

        assert.deepEqual(rows.results, [{ id: 1, value: "first" }]);
        assert.equal(rows.success, true);
        assert.equal(write.success, true);
        assert.deepEqual(write.results, []);
        const countQuery = db.prepare("SELECT count(*) AS count FROM items");
        assert.equal((await countQuery.first("count")), 2);
        assert.equal((await countQuery.run()).results[0].count, 2);
    } finally {
        db.close();
    }
});
