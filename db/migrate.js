// Applies db/schema.sql to whatever DATABASE_URL points at. Idempotent (CREATE TABLE/TYPE IF NOT
// EXISTS everywhere), so it's safe to run again on every deploy — this is the "migrations" step
// until the schema is mature enough to need real incremental migration files.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(sql);
    console.log("Schema applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
