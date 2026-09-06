import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The migration history is the thing standing between a deploy and an empty
 * History view, so it gets tested like any other load-bearing code.
 *
 * These are not style checks. Each one corresponds to a way run history could
 * be destroyed by a change that looked routine in review:
 *
 *  - `prisma migrate dev` after an edit to schema.prisma will happily emit a
 *    DROP TABLE and recreate it. The diff reads as "regenerated the migration"
 *    and it deletes every run on the next deploy.
 *  - Editing an already-applied migration file makes `migrate deploy` fail on
 *    a checksum mismatch, which on Railway means every deploy after that one
 *    boots with no tables and history silently falls back to memory.
 *  - The tables have to be named what src/lib/schema.ts and scripts/db-check.ts
 *    look for. A rename that misses those two files makes the app permanently
 *    report that migrations have not been applied.
 */

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

async function migrationFiles(): Promise<{ name: string; sql: string }[]> {
  const entries = await readdir(MIGRATIONS, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(
    dirs.map(async (name) => ({
      name,
      sql: await readFile(join(MIGRATIONS, name, "migration.sql"), "utf8"),
    })),
  );
}

/** Comments are not statements, and one of the migrations mentions a table in prose. */
function statements(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

test("no migration drops or truncates the history tables", async () => {
  const files = await migrationFiles();
  assert.ok(files.length > 0, "expected at least one migration on disk");

  for (const { name, sql } of files) {
    const body = statements(sql).toLowerCase();
    for (const table of ["runs", "run_assets"]) {
      assert.ok(
        !new RegExp(`drop\\s+table\\s+(if\\s+exists\\s+)?"?(public\\.)?"?${table}"?`).test(body),
        `${name} drops "${table}". Run history would be deleted on the next deploy. Write an ALTER instead.`,
      );
      assert.ok(
        !new RegExp(`truncate\\s+(table\\s+)?"?(public\\.)?"?${table}"?`).test(body),
        `${name} truncates "${table}". Run history would be emptied on the next deploy.`,
      );
    }
    assert.ok(
      !/drop\s+schema/.test(body),
      `${name} drops a schema, which takes run history with it.`,
    );
  }
});

test("the migration that creates the history tables still creates them", async () => {
  const files = await migrationFiles();
  const combined = files.map((file) => statements(file.sql)).join("\n").toLowerCase();

  /*
   * Names, not just existence. src/lib/schema.ts asks Postgres for
   * to_regclass('public.runs') and to_regclass('public.run_assets') by literal
   * string, and so does scripts/db-check.ts. A rename in schema.prisma with an
   * @@map change would migrate cleanly and leave both of those permanently
   * answering "missing", so the app would insist history is not durable while
   * writing rows perfectly well.
   */
  for (const table of ["runs", "run_assets"]) {
    assert.match(
      combined,
      new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?"${table}"`),
      `nothing creates the "${table}" table. src/lib/schema.ts and scripts/db-check.ts look for exactly this name.`,
    );
  }
});

test("schema.prisma maps the models to the table names the code probes for", async () => {
  const schema = await readFile(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /@@map\("runs"\)/, 'the Run model must map to "runs"');
  assert.match(schema, /@@map\("run_assets"\)/, 'the RunAsset model must map to "run_assets"');
});

test("every migration directory holds exactly one migration.sql", async () => {
  const entries = await readdir(MIGRATIONS, { withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const inner = await readdir(join(MIGRATIONS, entry.name));
    assert.deepEqual(
      inner.sort(),
      ["migration.sql"],
      `${entry.name} should contain only migration.sql. Prisma checksums the directory, and an extra file is a deploy that fails after the tables are gone.`,
    );
  }
});
