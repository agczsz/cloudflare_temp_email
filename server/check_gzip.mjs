import Database from "better-sqlite3";
const db = new Database("data/test.db");
const row = db.prepare("SELECT raw IS NULL AS raw_null, length(raw_blob) AS blob_len FROM raw_mails WHERE message_id = ?").get(process.argv[2]);
console.log(JSON.stringify(row));
