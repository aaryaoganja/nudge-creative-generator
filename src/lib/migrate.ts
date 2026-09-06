import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasDatabase } from "./env.ts";
import { forgetSchemaState, schemaState } from "./schema.ts";

/**
 * Apply pending migrations at boot, if nothing else has.
 *
 * The requirement is blunt: history has to survive every deploy. There is
 * already a mechanism for that, `preDeploy` in .railway/railway.ts, and it is
 * the right one. It has a single weakness that is invisible until it bites.
 *
 * .railway/railway.ts is Infrastructure as Code, which Railway reads through
 * the CLI when somebody runs `railway config apply`, not on every deploy. So
 * the line that creates the tables lives in git, reviewed and correct, and does
 * nothing at all on a service where that command has never been run. The deploy
 * still succeeds. The health check still passes. Every write to history throws,
 * src/lib/run.ts catches it, and the app keeps working with an array in memory
 * that is thrown away the next time the container is replaced.
 *
 * This is the backstop. It runs the same command preDeploy runs, from inside
 * the server, and only when a check has already established that the tables are
 * absent. When preDeploy did its job this costs one query and exits.
 *
 * ── Why running migrations from the app is safe here ──────────────────────
 * The usual objection is two replicas racing. Prisma takes a Postgres advisory
 * lock for the duration of `migrate deploy`, so concurrent invocations
 * serialise rather than collide. Verified rather than assumed: three
 * simultaneous runs against a virgin database produced one that applied both
 * migrations and two that waited and then reported nothing pending, all exiting
 * zero, with each table created exactly once.
 *
 * The second objection is surprise DDL on somebody else's schedule. That is a
 * real preference and AUTO_MIGRATE=off turns this off completely, leaving
 * preDeploy as the only path. What is not offered is the silent version, where
 * the tables are missing and nothing says so.
 */

export interface MigrationOutcome {
  /** Whether `migrate deploy` was actually spawned. */
  attempted: boolean;
  /** True when the schema is ready afterwards, however it got that way. */
  ready: boolean;
  /** Why nothing was attempted. Null when it was. */
  skipped: string | null;
  error: string | null;
  durationMs: number;
}

/** Long enough for a cold Railway Postgres to finish accepting connections. */
const REACHABILITY_ATTEMPTS = 4;
const REACHABILITY_BACKOFF_MS = [500, 1500, 3000];

/** A migration that has not finished in this long is not going to save the boot. */
const MIGRATE_TIMEOUT_MS = 60_000;

function cliPath(): string {
  // The Dockerfile copies the CLI into the runtime image explicitly, because
  // Next's standalone output prunes node_modules to what the app imports and
  // nothing imports the CLI. If this path is missing, that copy was removed.
  return join(process.cwd(), "node_modules", "prisma", "build", "index.js");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give Postgres a few seconds to come up before concluding anything.
 *
 * A web container and a database container start at the same time on a
 * redeploy. Reading "unreachable" once, half a second in, and giving up would
 * turn an ordinary startup ordering into a deployment with no history.
 */
async function settledSchemaState() {
  let report = await schemaState();
  for (let attempt = 1; report.state === "unreachable" && attempt < REACHABILITY_ATTEMPTS; attempt++) {
    await sleep(REACHABILITY_BACKOFF_MS[attempt - 1]);
    forgetSchemaState();
    report = await schemaState();
  }
  return report;
}

function runMigrateDeploy(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(), "migrate", "deploy"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const collect = (chunk: Buffer) => {
      // Bounded: a runaway CLI must not be able to grow the server's heap.
      if (output.length < 8000) output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output += `\nTimed out after ${MIGRATE_TIMEOUT_MS}ms.`;
    }, MIGRATE_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function apply(): Promise<MigrationOutcome> {
  const startedAt = Date.now();
  const done = (partial: Omit<MigrationOutcome, "durationMs">): MigrationOutcome => ({
    ...partial,
    durationMs: Date.now() - startedAt,
  });

  if (!hasDatabase()) {
    return done({ attempted: false, ready: false, skipped: "no DATABASE_URL", error: null });
  }
  if ((process.env.AUTO_MIGRATE ?? "").toLowerCase() === "off") {
    return done({ attempted: false, ready: false, skipped: "AUTO_MIGRATE=off", error: null });
  }

  const before = await settledSchemaState();
  if (before.state === "ready") {
    return done({ attempted: false, ready: true, skipped: "schema already applied", error: null });
  }
  if (before.state === "unreachable") {
    // Deliberately not attempted. `migrate deploy` against a database that is
    // not answering just fails more slowly and less legibly than this does.
    console.error(
      "[migrate] Postgres is not answering, so migrations were not attempted. History will be kept in memory and lost on the next deploy.",
      before.error,
    );
    return done({ attempted: false, ready: false, skipped: "database unreachable", error: before.error });
  }

  if (!existsSync(cliPath())) {
    const error = `Prisma CLI not found at ${cliPath()}. The runtime image must copy node_modules/prisma (see Dockerfile).`;
    console.error(`[migrate] ${error}`);
    return done({ attempted: false, ready: false, skipped: "prisma CLI missing", error });
  }

  console.warn(
    "[migrate] The history tables are missing, so migrations are being applied at boot. This is a backstop for preDeploy, not a replacement: run `railway config apply` so .railway/railway.ts takes effect.",
  );

  const { code, output } = await runMigrateDeploy();
  forgetSchemaState();
  const after = await schemaState();

  if (after.state === "ready") {
    console.warn(`[migrate] Applied. History is durable from here on. Took ${Date.now() - startedAt}ms.`);
    return done({ attempted: true, ready: true, skipped: null, error: null });
  }

  // Loud on purpose. This is the case where history is about to be silently
  // lost on every deploy, and one log line is the only warning anybody gets
  // before they open the History view and find it empty.
  const error = `migrate deploy exited ${code}. ${output.trim().slice(-1200)}`;
  console.error(`[migrate] FAILED. History will NOT survive this deploy. ${error}`);
  return done({ attempted: true, ready: false, skipped: null, error });
}

const globalForMigrate = globalThis as unknown as {
  migrationOutcome: Promise<MigrationOutcome> | undefined;
  migrationResolved: MigrationOutcome | undefined;
};

/**
 * Runs at most once per process, however many callers ask, and never rejects.
 *
 * The never-rejects part is load-bearing rather than defensive habit.
 * instrumentation.ts awaits this before the server accepts its first request,
 * so a throw from anywhere below, a malformed DATABASE_URL that fails env
 * validation being the easy one, would stop the deployment from booting at all.
 * That is the opposite of what this code is for: it exists to keep history from
 * being lost, and taking the whole application down to protect history is not a
 * trade this project makes anywhere else.
 */
export function ensureSchema(): Promise<MigrationOutcome> {
  globalForMigrate.migrationOutcome ??= apply()
    .catch((error): MigrationOutcome => {
      console.error("[migrate] The migration check itself failed. History may not be durable.", error);
      return {
        attempted: false,
        ready: false,
        skipped: "migration check threw",
        error: error instanceof Error ? error.message : String(error),
        durationMs: 0,
      };
    })
    .then((outcome) => {
      globalForMigrate.migrationResolved = outcome;
      return outcome;
    });
  return globalForMigrate.migrationOutcome;
}

/** What ensureSchema concluded, if it has concluded. For the health check. */
export function lastMigrationOutcome(): MigrationOutcome | null {
  return globalForMigrate.migrationResolved ?? null;
}

/**
 * Boot never waits indefinitely.
 *
 * `register()` in instrumentation.ts must finish before the server accepts
 * requests, so an unbounded await here would let a slow or wedged migration
 * hold the whole deployment below its health check until Railway gives up and
 * takes it out of rotation. Past this budget the server starts serving; the
 * migration keeps running and the History view and health check pick up the
 * result whenever it lands.
 */
export async function ensureSchemaWithin(budgetMs: number): Promise<MigrationOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([ensureSchema(), expired]);
  } finally {
    clearTimeout(timer);
  }
}
