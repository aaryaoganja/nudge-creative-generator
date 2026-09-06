"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { VIEW_LABELS } from "./view";

/**
 * Everything this studio has made, newest first.
 *
 * The point of the list is the link. Each row opens the run it names, and that
 * URL is the one to send to somebody: the studio reads `?run=` on load and
 * redraws the result from the stored payload.
 *
 * Durability is reported rather than assumed. Without Postgres the rows come
 * from one container's memory, which means the links in this list will not open
 * for anybody else and will not survive the next deploy. Saying so is the
 * difference between a limitation and a broken promise.
 */

interface HistoryRow {
  id: string;
  kind: "generation" | "scoring";
  status: "running" | "ok" | "blocked" | "failed";
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  subject: string | null;
  productUrl: string | null;
  costUsd: number;
  inputs: Record<string, unknown>;
  error?: string | null;
}

interface HistoryResponse {
  runs: HistoryRow[];
  durable: boolean;
  note: string;
}

type Filter = "all" | "generation" | "scoring";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "generation", label: VIEW_LABELS.generate },
  { id: "scoring", label: "Scores" },
];

const STATUS_CLASS: Record<HistoryRow["status"], string> = {
  ok: "pass",
  blocked: "blocked",
  failed: "blocked",
  running: "unverified",
};

/**
 * Local time, short.
 *
 * Formatted during render rather than in an effect, with the mismatch declared
 * instead of worked around: the server and the browser are in different time
 * zones, so this node legitimately renders differently on each side, and
 * suppressHydrationWarning is exactly the tool for a node where that is true by
 * design. The effect-and-setState version cost a second render of the whole
 * list and flashed an empty column on the way.
 */
function When({ iso }: { iso: string }) {
  const at = new Date(iso);
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {at.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}

/**
 * What actually happened, not merely whether it succeeded.
 *
 * A run that was read and never generated is `ok` and `generation`, which
 * naively reads as "generated" and would tell somebody a creative exists when
 * none does. The resolve step records `stage: "resolved"` in its inputs, and
 * generating overwrites those inputs with the full set, so the absence of the
 * marker is itself the signal.
 */
function label(run: HistoryRow): string {
  if (run.status !== "ok") return run.status;
  if (run.inputs?.stage === "resolved") return "read only";
  return run.kind === "scoring" ? "scored" : "generated";
}

export function HistoryPanel() {
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const query = filter === "all" ? "" : `?kind=${filter}`;
    fetch(`/api/runs${query}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load history.");
        return body as HistoryResponse;
      })
      .then((body) => {
        if (!live) return;
        setData(body);
        setError(null);
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    // Cancelled on unmount and on a filter change, so a slow first request
    // cannot land after a faster second one and show the wrong list.
    return () => {
      live = false;
    };
  }, [filter]);

  return (
    <>
      <div className="masthead">
        <h1>History</h1>
        <p className="sub">
          Every run this studio has made. Open one to see it again, or copy its
          link to send it to somebody.
        </p>
      </div>

      <div className="chips" style={{ marginBottom: "1rem" }}>
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`chip${filter === option.id ? " on" : ""}`}
            aria-pressed={filter === option.id}
            onClick={() => {
              // Loading is raised here rather than in the effect, so the
              // effect body stays free of synchronous state updates and React
              // does not cascade a second render before the fetch even starts.
              setLoading(true);
              setFilter(option.id);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {data && !data.durable && (
        <div className="notice">
          <span className="badge unverified">not stored</span> {data.note}
        </div>
      )}

      {loading && !data && (
        <p className="sub">
          <span className="spin" />
          Loading history
        </p>
      )}

      {data && data.runs.length === 0 && (
        <section className="card">
          <p className="sub" style={{ margin: 0 }}>
            Nothing yet. Generate a creative or score one, and it will appear
            here with a link you can share.
          </p>
        </section>
      )}

      {data && data.runs.length > 0 && (
        <section className="card">
          <ul className="runlist">
            {data.runs.map((run) => (
              <li className="runrow" key={run.id}>
                <Link className="runrow-open" href={`/?run=${run.id}`}>
                  <span className="runrow-head">
                    <span className="runrow-subject">
                      {run.subject ?? "Untitled run"}
                    </span>
                    <span
                      className={`badge ${
                        run.status === "ok" && run.inputs?.stage === "resolved"
                          ? "unverified"
                          : STATUS_CLASS[run.status]
                      }`}
                    >
                      {label(run)}
                    </span>
                  </span>
                  <span className="runrow-summary">
                    {run.error ?? run.summary ?? ""}
                  </span>
                  <span className="runrow-meta">
                    <span className="runid">{run.id}</span>
                    <When iso={run.startedAt} />
                    <span className="cost">${run.costUsd.toFixed(3)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
