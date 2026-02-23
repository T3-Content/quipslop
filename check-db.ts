import { Database } from "bun:sqlite";
const dbPath = process.env.DATABASE_PATH ?? "quipslop.sqlite";
const db = new Database(dbPath);
const rows = db.query("SELECT id, num FROM rounds ORDER BY id DESC LIMIT 20").all();
console.log(rows);
