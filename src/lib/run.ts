import { randomUUID } from "node:crypto";
import { getPrisma } from "./db.ts";
import { hasDatabase } from "./env.ts";
import {
  noteForSchemaState,
  noteQueryFailure,
  schemaState,
  type SchemaState,
} from "./schema.ts";
import { storage } from "./storage.ts";

/**
 * Run identity, history, and the record behind a shareable link.
 *
 * Every resolve, generation and score gets an id. That id goes into the browser
 * address bar the moment it exists, so the URL a person copies is the URL that
 * re-renders what they were looking at. Two things follow from that, and they
 * are the whole design:
 *
 *  1. The id in the URL is the primary key. No second identifier, no lookup
 *     table, no cuid alongside the gen_/scr_ value on screen.
 *  2. A record has to hold enough to REDRAW the page, not merely to describe
 *     it. The previous version stored a one-line summary and a cost, which is a
 *     diagnostic aid; a link built on that would open an empty page.
 *
 * ── Durability, stated plainly ────────────────────────────────────────────
 * With Postgres reachable, runs are rows and a link works from any replica,
 * after any redeploy, for anyone who can sign in. Without Postgres the app
 * still runs and history falls back to a process-local array that dies with the
 * container. `durable` reports which of the two actually served the request,
 * not whether a connection string happens to be set. It used to report the
 * latter, which meant it said `true` on every Railway deploy while the storage
 * was still an array in memory.
 *
 * Sharing is team-scoped by design. Every route here is behind the password
 * gate in src/middleware.ts, so "shareable" means shareable with people who can
 * sign in. That is the right default for a tool whose links carry product
 * strategy and spend.
 */

export type RunKind = "generation" | "scoring";
export type RunStatus = "running" | "ok" | "blocked" | "failed";

export interface RunRecord {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** One line for a history row. */
  summary: string;
  /** The product title, or the uploaded filename. */
  subject: string | null;
  productUrl: string | null;
  costUsd: number;
  /** What the user asked for. Small enough to show in a list. */
  inputs: Record<string, unknown>;
  /** The full response. Absent from list queries, present on a detail read. */
  payload?: Record<string, unknown> | null;
  error?: string | null;
}

/**
 * Prefixed so an id is self-describing in a log line, a support message or a
 * pasted URL: gen_ came from the generator, scr_ from the scorer.
 *
 * Twenty hex characters is 80 bits. That matters more than it used to: the id
 * is now a capability in a URL, and it should not be guessable.
 */
export function newRunId(kind: RunKind): string {
  const prefix = kind === "generation" ? "gen" : "scr";
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** True only for a string this module could have minted. */
export function isRunId(value: string): boolean {
  return /^(gen|scr)_[0-9a-f]{20}$/.test(value);
}

export function kindOfRunId(value: string): RunKind | null {
  if (!isRunId(value)) return null;
  return value.startsWith("gen_") ? "generation" : "scoring";
}

/**
 * How many runs keep their images.
 *
 * The rows are small and kept; the bytes are not. A 2K render is 1 to 3 MB and
 * a run can hold several, so an unbounded asset table is the one part of this
 * that would grow without limit on a small Postgres volume. Older runs keep
 * their copy, prompts, policy verdicts and cost, and say plainly that the
 * pictures have been cleared.
 */
const RUNS_KEEPING_ASSETS = 60;

/** Memory fallback bound. Same reasoning as before: an aid, not a store. */
const MAX_MEMORY_RUNS = 100;

const globalForRuns = globalThis as unknown as {
  memoryRuns: RunRecord[] | undefined;
};

function memory(): RunRecord[] {
  globalForRuns.memoryRuns ??= [];
  return globalForRuns.memoryRuns;
}

const KIND_TO_DB = { generation: "GENERATION", scoring: "SCORING" } as const;
const KIND_FROM_DB: Record<string, RunKind> = {
  GENERATION: "generation",
  SCORING: "scoring",
};
const STATUS_TO_DB = {
  running: "RUNNING",
  ok: "OK",
  blocked: "BLOCKED",
  failed: "FAILED",
} as const;
const STATUS_FROM_DB: Record<string, RunStatus> = {
  RUNNING: "running",
  OK: "ok",
  BLOCKED: "blocked",
  FAILED: "failed",
};

/* eslint-disable @typescript-eslint/no-explicit-any -- the row shape is Prisma's,
   and naming it here would couple this module to generated types that change
   whenever the schema does. Every field read below is checked. */
function fromRow(row: any): RunRecord {
  return {
    id: row.id,
    kind: KIND_FROM_DB[row.kind] ?? "generation",
    status: STATUS_FROM_DB[row.status] ?? "ok",
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    summary: row.summary ?? "",
    subject: row.subject ?? null,
    productUrl: row.productUrl ?? null,
    costUsd: row.costUsd === null || row.costUsd === undefined ? 0 : Number(row.costUsd),
    inputs: (row.inputs ?? {}) as Record<string, unknown>,
    ...(row.payload !== undefined ? { payload: row.payload } : {}),
    error: row.error ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface StartRunInput {
  id: string;
  kind: RunKind;
  subject?: string | null;
  productUrl?: string | null;
  inputs?: Record<string, unknown>;
}

/**
 * Open a run before the work starts.
 *
 * Called the moment a request is accepted, not when it succeeds. A run that
 * failed is exactly the one somebody needs a link to, and the previous code
 * minted an id for it and then recorded nothing.
 */
export async function startRun(input: StartRunInput): Promise<void> {
  const record: RunRecord = {
    id: input.id,
    kind: input.kind,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    summary: "",
    subject: input.subject ?? null,
    productUrl: input.productUrl ?? null,
    costUsd: 0,
    inputs: input.inputs ?? {},
  };

  if (!hasDatabase()) {
    remember(record);
    return;
  }

  try {
    await (await getPrisma()).run.create({
      data: {
        id: record.id,
        kind: KIND_TO_DB[record.kind],
        status: "RUNNING",
        subject: record.subject,
        productUrl: record.productUrl,
        inputs: record.inputs as never,
      },
    });
  } catch (error) {
    warnOnce("startRun", error);
    // A write that failed because the table is not there has just disproved a
    // cached "ready". Say so now rather than letting the History view keep
    // promising durability until the cache expires.
    noteQueryFailure(error);
    remember(record);
  }
}

export interface FinishRunInput {
  id: string;
  status: RunStatus;
  summary: string;
  subject?: string | null;
  productUrl?: string | null;
  costUsd?: number;
  inputs?: Record<string, unknown>;
  payload?: Record<string, unknown> | null;
  assetShas?: string[];
  error?: string | null;
}

/** Close a run with everything needed to redraw it. */
export async function finishRun(input: FinishRunInput): Promise<void> {
  if (!hasDatabase()) {
    const existing = memory().find((run) => run.id === input.id);
    const record: RunRecord = {
      id: input.id,
      kind: kindOfRunId(input.id) ?? "generation",
      status: input.status,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary: input.summary,
      subject: input.subject ?? existing?.subject ?? null,
      productUrl: input.productUrl ?? existing?.productUrl ?? null,
      costUsd: input.costUsd ?? 0,
      inputs: input.inputs ?? existing?.inputs ?? {},
      payload: input.payload ?? null,
      error: input.error ?? null,
    };
    remember(record);
    return;
  }

  try {
    const data = {
      status: STATUS_TO_DB[input.status],
      finishedAt: new Date(),
      summary: input.summary,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.productUrl !== undefined ? { productUrl: input.productUrl } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.inputs !== undefined ? { inputs: input.inputs as never } : {}),
      ...(input.payload !== undefined ? { payload: input.payload as never } : {}),
      ...(input.assetShas !== undefined ? { assetShas: input.assetShas } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };

    // upsert, not update: startRun may have fallen back to memory while the
    // database was briefly unreachable, and a finish that 404s would lose the
    // whole run rather than the opening row.
    await (await getPrisma()).run.upsert({
      where: { id: input.id },
      update: data,
      create: {
        id: input.id,
        kind: KIND_TO_DB[kindOfRunId(input.id) ?? "generation"],
        ...data,
      },
    });

    await pruneAssets();
  } catch (error) {
    warnOnce("finishRun", error);
    noteQueryFailure(error);
    /*
     * The memory copy is the point of this branch. Without it a run whose
     * startRun succeeded against Postgres and whose finishRun did not was lost
     * from both stores: the row stayed RUNNING with no payload, and nothing
     * held the result the user was looking at. Now the link still opens, from
     * this container, for as long as it lives.
     */
    remember({
      id: input.id,
      kind: kindOfRunId(input.id) ?? "generation",
      status: input.status,
      startedAt: memory().find((run) => run.id === input.id)?.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary: input.summary,
      subject: input.subject ?? null,
      productUrl: input.productUrl ?? null,
      costUsd: input.costUsd ?? 0,
      inputs: input.inputs ?? {},
      payload: input.payload ?? null,
      error: input.error ?? null,
    });
  }
}

function remember(record: RunRecord): void {
  const runs = memory();
  const at = runs.findIndex((run) => run.id === record.id);
  if (at >= 0) runs.splice(at, 1);
  runs.unshift(record);
  if (runs.length > MAX_MEMORY_RUNS) runs.length = MAX_MEMORY_RUNS;
}

/**
 * Drop image bytes belonging to runs outside the retention window.
 *
 * Runs are cheap and kept forever; pictures are not. Best effort on purpose:
 * a failed prune must never fail the generation that triggered it.
 */
async function pruneAssets(): Promise<void> {
  try {
    const recent = await (await getPrisma()).run.findMany({
      orderBy: { startedAt: "desc" },
      take: RUNS_KEEPING_ASSETS,
      select: { assetShas: true },
    });
    const keep = [...new Set(recent.flatMap((run) => run.assetShas))];
    await storage().prune(keep);
  } catch (error) {
    warnOnce("pruneAssets", error);
  }
}

export interface RunHistory {
  runs: RunRecord[];
  /** True only when the rows came from Postgres. */
  durable: boolean;
  /**
   * Why history is not durable, when it is not. The three answers need three
   * different fixes and used to share one sentence: no database configured,
   * a database that is not answering, and a database whose tables were never
   * created because the migration step did not run.
   */
  storage: SchemaState;
  note: string;
}

export async function listRuns(kind?: RunKind, limit = 50): Promise<RunHistory> {
  if (hasDatabase()) {
    try {
      const rows = await (await getPrisma()).run.findMany({
        where: kind ? { kind: KIND_TO_DB[kind] } : undefined,
        orderBy: { startedAt: "desc" },
        take: limit,
        // payload is deliberately absent. It is the large column, and a history
        // list that selected it would pull the whole result set into memory.
        select: {
          id: true,
          kind: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          summary: true,
          subject: true,
          productUrl: true,
          costUsd: true,
          inputs: true,
          error: true,
        },
      });
      return {
        runs: rows.map(fromRow),
        durable: true,
        storage: "ready",
        note: noteForSchemaState("ready"),
      };
    } catch (error) {
      warnOnce("listRuns", error);
      noteQueryFailure(error);
    }
  }

  // One query, and only on the path that has already failed, to say which of
  // the three reasons applies. Reporting "no database is reachable" for a
  // reachable database with no tables sent at least one person looking at the
  // wrong variable.
  const { state, note } = await schemaState();

  return {
    runs: memory()
      .filter((run) => (kind ? run.kind === kind : true))
      .slice(0, limit)
      // Strip payloads here too, so the memory path and the Postgres path
      // return the same shape and the UI cannot come to depend on one of them.
      .map((run) => {
        const listed = { ...run };
        delete listed.payload;
        return listed;
      }),
    durable: false,
    storage: state,
    note,
  };
}

export interface RunLookup {
  run: RunRecord | null;
  durable: boolean;
}

export async function getRun(id: string): Promise<RunLookup> {
  if (!isRunId(id)) return { run: null, durable: hasDatabase() };

  if (hasDatabase()) {
    try {
      const row = await (await getPrisma()).run.findUnique({ where: { id } });
      if (row) return { run: fromRow(row), durable: true };
      // Not found in Postgres, but this container may still hold it from a
      // window when the database was unavailable. Falling through rather than
      // returning null is what makes a link minted during an outage still open.
      const remembered = memory().find((run) => run.id === id);
      if (remembered) return { run: remembered, durable: false };
      return { run: null, durable: true };
    } catch (error) {
      warnOnce("getRun", error);
      noteQueryFailure(error);
    }
  }

  return { run: memory().find((run) => run.id === id) ?? null, durable: false };
}

const warned = new Set<string>();

function warnOnce(operation: string, error: unknown): void {
  if (warned.has(operation)) return;
  warned.add(operation);
  console.warn(
    `[run] ${operation} failed, falling back to in-memory history:`,
    error instanceof Error ? error.message : error,
  );
}

/** Test seam. */
export function resetRunWarnings(): void {
  warned.clear();
}
