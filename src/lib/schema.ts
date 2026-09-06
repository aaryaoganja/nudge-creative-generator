import { getPrisma } from "./db.ts";
import { hasDatabase } from "./env.ts";

/**
 * Is run history actually durable right now, and if not, why?
 *
 * This module exists because "durable" had two failure modes that looked
 * identical from the outside and needed different fixes:
 *
 *   1. No DATABASE_URL. The app is running without a database at all.
 *   2. DATABASE_URL is set, Postgres answers, and the tables are not there.
 *
 * The second is the dangerous one, and it is what a deploy gets when the
 * migration step never ran. Every write throws, src/lib/run.ts catches it,
 * logs once and falls back to an array in memory. The app looks completely
 * healthy: the health check passes, generation works, scoring works, links get
 * minted. History then vanishes on the next deploy, and nothing on screen ever
 * said the words "your migrations have not been applied".
 *
 * Telling those two apart takes one cheap query, so this module runs it and
 * everything that reports on durability reads the answer from here.
 */

export type SchemaState =
  /** runs and run_assets both exist. History survives a redeploy. */
  | "ready"
  /** Postgres answers and the tables are absent. Migrations have not run. */
  | "missing"
  /** DATABASE_URL is set and Postgres did not answer. */
  | "unreachable"
  /** No DATABASE_URL. Nothing is wrong; there is simply no database. */
  | "not_configured";

export interface SchemaReport {
  state: SchemaState;
  /** The database error, when there was one. Never a connection string. */
  error: string | null;
  /** Plain English, written for whoever has to fix it. */
  note: string;
}

const NOTES: Record<SchemaState, string> = {
  ready:
    "History is stored in Postgres. Links open from any replica and survive every redeploy.",
  missing:
    "Postgres is reachable but the history tables have not been created, so history is being kept in this container's memory and is lost on the next deploy. Apply the migrations: `railway run npm run db:deploy`.",
  unreachable:
    "Postgres is configured but not answering, so history is being kept in this container's memory and is lost on the next deploy. Check the DATABASE_URL variable and that the Postgres service is up.",
  not_configured:
    "No database is configured, so history is being kept in this container's memory. It is lost on redeploy, each replica keeps its own, and links will not open for anyone else.",
};

/*
 * Cached, with deliberately lopsided lifetimes.
 *
 * "ready" cannot become false without somebody dropping a table, so it is held
 * for a long time and costs one query per process in practice. Every other
 * answer is held briefly, because the whole point is that the interface starts
 * telling the truth again within seconds of the migration landing rather than
 * insisting the deployment is broken until it restarts.
 */
const READY_TTL_MS = 10 * 60 * 1000;
const NOT_READY_TTL_MS = 5 * 1000;

const globalForSchema = globalThis as unknown as {
  schemaReport: { report: SchemaReport; expiresAt: number } | undefined;
};

function cache(report: SchemaReport): SchemaReport {
  globalForSchema.schemaReport = {
    report,
    expiresAt:
      Date.now() + (report.state === "ready" ? READY_TTL_MS : NOT_READY_TTL_MS),
  };
  return report;
}

/** Force the next read to hit the database. Called after a migration runs. */
export function forgetSchemaState(): void {
  globalForSchema.schemaReport = undefined;
}

/**
 * Prisma's code for "the table does not exist".
 *
 * Worth special-casing rather than waiting for the next scheduled check: a
 * query that fails this way has just proved the schema is missing, and the
 * cached "ready" it contradicts would otherwise keep the UI claiming
 * durability for the rest of the TTL.
 */
export function noteQueryFailure(error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2021" || code === "P2022") forgetSchemaState();
}

export async function schemaState(): Promise<SchemaReport> {
  if (!hasDatabase()) {
    return { state: "not_configured", error: null, note: NOTES.not_configured };
  }

  const cached = globalForSchema.schemaReport;
  if (cached && cached.expiresAt > Date.now()) return cached.report;

  try {
    /*
     * to_regclass rather than a SELECT against the table itself. It returns
     * NULL instead of raising for a table that is not there, so one round trip
     * distinguishes "absent" from "unreachable" without an error to classify,
     * and it needs no read permission on the tables to answer.
     */
    const rows = await (await getPrisma()).$queryRaw<
      { runs: string | null; assets: string | null }[]
    >`select to_regclass('public.runs')::text as runs,
             to_regclass('public.run_assets')::text as assets`;

    const row = rows[0];
    const state: SchemaState = row?.runs && row?.assets ? "ready" : "missing";
    return cache({ state, error: null, note: NOTES[state] });
  } catch (error) {
    return cache({
      state: "unreachable",
      error: error instanceof Error ? error.message : String(error),
      note: NOTES.unreachable,
    });
  }
}

/** The note for a state, without a database round trip. */
export function noteForSchemaState(state: SchemaState): string {
  return NOTES[state];
}
