// Creates the next numbered migration file so nobody has to count by hand.
//   npm run migrate:new add_ticket_status
// -> migrations/002_add_ticket_status.sql, opened with a short header explaining the rules.
const fs = require("fs");
const path = require("path");
const { MIGRATIONS_DIR, listMigrationFiles } = require("./migrate");

const rawName = process.argv[2];
if (!rawName) {
  console.error("Usage: npm run migrate:new <short_description_in_snake_case>");
  process.exit(1);
}
const name = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const existing = listMigrationFiles(MIGRATIONS_DIR);
const last = existing.length ? parseInt(existing[existing.length - 1].slice(0, 3), 10) : 0;
const next = String(last + 1).padStart(3, "0");
const file = path.join(MIGRATIONS_DIR, `${next}_${name}.sql`);

fs.writeFileSync(
  file,
  `-- Migration ${next}: ${rawName}
-- Applied once, in order, inside a transaction, by \`npm run migrate\` (which runs on every deploy).
-- Once this file has been applied anywhere (especially production) do NOT edit it — the runner
-- checks a checksum and will refuse to start. Write a new migration instead.

`
);
console.log(`Created ${path.relative(process.cwd(), file)}`);
