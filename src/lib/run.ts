import { randomUUID } from "node:crypto";
import { hasDatabase } from "@/lib/env";

/**
 * Run identity and history.
 *
 * Every generation and every score gets an id, returned in the response and
 * shown in the UI, so a creative can be traced back to the exact inputs,
 * prompt, models and cost that produced it. Without one, "why did this ad say
 * that?" is unanswerable a week later.
 *
 * ── Durability, stated plainly ────────────────────────────────────────────
 * History currently lives in memory, scoped to the running container. It
 * survives navigation and page reloads; it does NOT survive a redeploy, and on
 * more than one replica each container keeps its own. That is a real limit, not
 * a detail — `durable: false` is reported on every response so the UI can say
 * so rather than implying a permanence that is not there.
 *
 * Making it durable is a Postgres table and this module's two functions, which
 * is why the interface is already shaped for it. See docs/PLAN.md §6.
 */

export type RunKind = "generation" | "scoring";

export interface RunRecord {
  id: string;
  kind: RunKind;
  startedAt: string;
  /** Short, human-readable label for a history list. */
  summary: string;
  /** Whatever identifies the subject: a product URL, an uploaded filename. */
  subject: string | null;
  costUsd: number;
  outcome: string;
  detail: Record<string, unknown>;
}

/**
 * Prefixed so an id is self-describing in a log line or a support message:
 * gen_… came from the generator, scr_… from the scorer.
 */
export function newRunId(kind: RunKind): string {
  const prefix = kind === "generation" ? "gen" : "scr";
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

const MAX_RUNS = 100;
const globalForRuns = globalThis as unknown as { runs: RunRecord[] | undefined };

function store(): RunRecord[] {
  globalForRuns.runs ??= [];
  return globalForRuns.runs;
}

export function recordRun(record: RunRecord): void {
  const runs = store();
  runs.unshift(record);
  // Bounded: this is a diagnostic aid, not a data store, and an unbounded array
  // in a long-lived container is a memory leak with extra steps.
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
}

export interface RunHistory {
  runs: RunRecord[];
  durable: boolean;
  /** Says exactly what the current storage does and does not guarantee. */
  note: string;
}

export function listRuns(kind?: RunKind, limit = 50): RunHistory {
  const runs = store()
    .filter((run) => (kind ? run.kind === kind : true))
    .slice(0, limit);

  return {
    runs,
    durable: hasDatabase(),
    note: hasDatabase()
      ? "History is kept in memory for this container. Connect the Postgres schema to persist it across deploys."
      : "History is kept in memory for this container only. It is lost on redeploy, and each replica keeps its own. Provision Postgres for durable history.",
  };
}

export function getRun(id: string): RunRecord | null {
  return store().find((run) => run.id === id) ?? null;
}
