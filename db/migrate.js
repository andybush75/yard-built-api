// Migration runner. Applies every migrations/NNN_*.sql file that hasn't been applied yet, in
// filename order, each inside its own transaction, and records it in schema_migrations. Runs on
// every deploy (railway.json: "npm run migrate && npm start") and locally via `npm run migrate`.
//
// Rules this enforces:
//   - A migration runs exactly once per database. Re-running the command is always safe.
//   - An applied file must never change: its checksum is stored, and a mismatch refuses to start
//     (so a change meant for production is written as a NEW file, not an edit to an old one).
//   - A failing migration is rolled back and stops the run, which fails the deploy loudly instead
//     of starting the app against a half-changed database.
// `npm run migrate:new <name>` creates the next numbered file.
require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
// Arbitrary constant; pg_advisory_lock on it stops two instances deploying at once from both
// trying to apply the same file.
const LOCK_KEY = 727_301;

function listMigrationFiles(dir) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

async function runMigrations(client, dir, { log = console.log } = {}) {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query("SELECT filename, checksum FROM schema_migrations");
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    const result = { applied: [], skipped: [] };
    for (const file of listMigrationFiles(dir)) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      const sum = checksum(sql);
      if (applied.has(file)) {
        if (applied.get(file) !== sum) {
          throw new Error(
            `Migration ${file} has changed since it was applied to this database. ` +
            `Applied migrations are frozen — put the change in a new file (npm run migrate:new <name>).`
          );
        }
        result.skipped.push(file);
        continue;
      }
      log(`Applying ${file}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [file, sum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        err.message = `Migration ${file} failed and was rolled back: ${err.message}`;
        throw err;
      }
      result.applied.push(file);
    }
    log(`Migrations complete: ${result.applied.length} applied, ${result.skipped.length} already up to date.`);
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — see .env.example.");
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await runMigrations(client, MIGRATIONS_DIR);
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { MIGRATIONS_DIR, listMigrationFiles, checksum, runMigrations };

if (require.main === module) {
  main().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  });
}
