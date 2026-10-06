// Unit test for the migration runner's logic, using a fake database client so it runs without
// Postgres. Covers: files run in order, applied ones are skipped, a changed applied file is
// refused, and a failing migration is rolled back and stops the run.
//   node test/migrate-runner-test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runMigrations, listMigrationFiles, checksum } = require("../db/migrate");

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("OK  " + msg);
}

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yb-migrations-"));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

// Fake pg client: records every query, serves the schema_migrations table from memory, and
// throws when asked to run SQL containing the word BOOM.
function fakeClient(alreadyApplied = []) {
  const applied = [...alreadyApplied];
  const log = [];
  return {
    log,
    applied,
    async query(text, params) {
      log.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/FROM schema_migrations/.test(text)) return { rows: applied.map((a) => ({ ...a })) };
      if (/INSERT INTO schema_migrations/.test(text)) { applied.push({ filename: params[0], checksum: params[1] }); return { rows: [] }; }
      if (/BOOM/.test(text)) throw new Error("simulated SQL error");
      return { rows: [] };
    },
    release() {},
  };
}

async function main() {
  // Ordering + skipping
  const dir = tempDir({
    "002_second.sql": "SELECT 2;",
    "001_first.sql": "SELECT 1;",
    "notes.txt": "ignored",
    "003_third.sql": "SELECT 3;",
  });
  assert(listMigrationFiles(dir).join(",") === "001_first.sql,002_second.sql,003_third.sql", "migration files are sorted and non-.sql files ignored");

  const c1 = fakeClient([{ filename: "001_first.sql", checksum: checksum("SELECT 1;") }]);
  const r1 = await runMigrations(c1, dir, { log: () => {} });
  assert(r1.applied.join(",") === "002_second.sql,003_third.sql", "already-applied migration is skipped, the rest run in order");
  assert(c1.log.filter((q) => q === "SELECT 2;" || q === "SELECT 3;").length === 2, "pending migration SQL was executed");
  assert(c1.log.includes("BEGIN") && c1.log.filter((q) => q === "COMMIT").length === 2, "each migration runs in its own transaction");

  // Tampering with an applied file is refused
  const c2 = fakeClient([{ filename: "001_first.sql", checksum: "not-the-real-checksum" }]);
  let threw = null;
  try { await runMigrations(c2, dir, { log: () => {} }); } catch (e) { threw = e; }
  assert(threw && /001_first\.sql/.test(threw.message) && /changed/.test(threw.message), "editing an already-applied migration file is refused with a clear message");

  // A failing migration rolls back and stops before later files
  const dir2 = tempDir({ "001_ok.sql": "SELECT 1;", "002_bad.sql": "SELECT BOOM;", "003_never.sql": "SELECT 3;" });
  const c3 = fakeClient();
  threw = null;
  try { await runMigrations(c3, dir2, { log: () => {} }); } catch (e) { threw = e; }
  assert(threw && /002_bad\.sql/.test(threw.message), "a failing migration names the file in the error");
  assert(c3.log.includes("ROLLBACK"), "the failing migration was rolled back");
  assert(!c3.log.includes("SELECT 3;"), "migrations after the failure did not run");
  assert(c3.applied.length === 1 && c3.applied[0].filename === "001_ok.sql", "only the successful migration was recorded");

  console.log("\nALL MIGRATION RUNNER TESTS PASSED");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
