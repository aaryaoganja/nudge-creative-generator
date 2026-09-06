/**
 * Will run history survive the next deploy?
 *
 *   railway run npm run db:check
 *
 * One command, one answer, run from inside the deployment where the answer
 * actually counts. It exists because the question is genuinely hard to answer
 * from the outside: an app whose history tables do not exist behaves exactly
 * like a healthy one until somebody redeploys and finds the History view empty.
 * Generation works, scoring works, links get minted, the health check passes.
 * The only visible difference is a warning in the logs.
 *
 * Read-only. It reports and exits non-zero; it never migrates. Fixing is a
 * separate, deliberate command, printed below when there is something to fix.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.DATABASE_URL;

function say(mark: string, line: string) {
  console.log(`  ${mark} ${line}`);
}

/** Rounding a 13KB asset table to "0MB" told the reader nothing useful. */
function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Every migration directory on disk, in the order Prisma applies them. */
async function migrationsOnDisk(): Promise<string[]> {
  try {
    const entries = await readdir(join(process.cwd(), "prisma", "migrations"), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function main() {
  console.log("\nRun history durability\n");

  if (!url) {
    say("✗", "DATABASE_URL is not set in this environment.");
    say(" ", "History is being kept in memory and is lost on every deploy.");
    say(" ", "Fix: attach the Postgres service, or set DATABASE_URL.");
    process.exit(1);
  }

  // Redacted deliberately. This output gets pasted into chat threads.
  const host = (() => {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
    } catch {
      return "unparseable DATABASE_URL";
    }
  })();
  say("·", `DATABASE_URL points at ${host}`);

  const { PrismaClient } = await import("../src/generated/prisma/client.ts");
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: [],
  });

  let applied: string[] = [];
  try {
    await prisma.$queryRaw`select 1`;
    say("✓", "Postgres is answering.");
  } catch (error) {
    say("✗", `Postgres is not answering: ${error instanceof Error ? error.message : error}`);
    say(" ", "History is being kept in memory and is lost on every deploy.");
    await prisma.$disconnect();
    process.exit(1);
  }

  const tables = await prisma.$queryRaw<{ runs: string | null; assets: string | null }[]>`
    select to_regclass('public.runs')::text as runs,
           to_regclass('public.run_assets')::text as assets`;
  const ready = Boolean(tables[0]?.runs && tables[0]?.assets);

  if (!ready) {
    say("✗", "The history tables do not exist. Migrations have not been applied here.");
    say(" ", "Everything else works, and history is silently in memory.");
    say(" ", "Fix: railway run npm run db:deploy");
    await prisma.$disconnect();
    process.exit(1);
  }
  say("✓", "runs and run_assets both exist.");

  try {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      select migration_name, finished_at from _prisma_migrations order by started_at asc`;
    applied = rows.filter((row) => row.finished_at).map((row) => row.migration_name);
  } catch {
    say("!", "No _prisma_migrations table. The tables exist but Prisma did not create them.");
  }

  const onDisk = await migrationsOnDisk();
  const pending = onDisk.filter((name) => !applied.includes(name));
  if (pending.length) {
    say("✗", `${pending.length} migration(s) on disk are not applied: ${pending.join(", ")}`);
    say(" ", "Fix: railway run npm run db:deploy");
    await prisma.$disconnect();
    process.exit(1);
  }
  say("✓", `All ${onDisk.length} migration(s) applied.`);

  const [{ count: runCount }] = await prisma.$queryRaw<{ count: bigint }[]>`
    select count(*)::bigint as count from runs`;
  const [{ count: assetCount, bytes }] = await prisma.$queryRaw<
    { count: bigint; bytes: bigint | null }[]
  >`select count(*)::bigint as count, coalesce(sum("byteSize"), 0)::bigint as bytes from run_assets`;

  say("·", `${runCount} run(s) stored, ${assetCount} image(s), ${describeSize(Number(bytes ?? 0))}.`);

  /*
   * A count of zero is worth calling out rather than passing silently. It is
   * what a deployment looks like the moment after the tables were finally
   * created, and it is also what it looks like if something is writing
   * somewhere else entirely.
   */
  if (runCount === 0n) {
    say("!", "No runs stored yet. Generate or score one, then run this again to confirm it lands.");
  }

  console.log("\n  History is durable. It survives redeploys and every replica reads the same rows.\n");
  await prisma.$disconnect();
}

await main();
