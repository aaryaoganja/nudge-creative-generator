"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GeneratePanel } from "./generate-panel";
import { ScorePanel } from "./score-panel";
import { HistoryPanel } from "./history-panel";
import { Nav } from "./nav";
import { readViewState, viewHref, type View } from "./view";

/**
 * The studio.
 *
 * View and run id both live in the URL rather than in component state, which is
 * what makes a result shareable at all: the address bar is the whole feature.
 * `router.replace` with `scroll: false` writes the run id in without adding a
 * history entry per keystroke of progress, so the back button still means
 * "the page before this one" rather than "before the run id appeared".
 */
function Studio() {
  const router = useRouter();
  const params = useSearchParams();
  const { view, runId } = readViewState(params);

  /**
   * Called by a panel the moment the server hands it a run id, which is at the
   * end of "Read product" rather than after generation. That is the point of
   * minting the id on the free step: there is something to send somebody before
   * any money is spent.
   */
  const adoptRunId = useCallback(
    (id: string) => {
      router.replace(viewHref({ view, runId: id }), { scroll: false });
    },
    [router, view],
  );

  /** Clearing it, e.g. when a different product URL is read. */
  const clearRunId = useCallback(() => {
    router.replace(viewHref({ view, runId: null }), { scroll: false });
  }, [router, view]);

  return (
    <>
      <Nav view={view} />
      <div className="shell">
        {view === "generate" && (
          <GeneratePanel
            runId={runId}
            onRunId={adoptRunId}
            onClearRunId={clearRunId}
          />
        )}
        {view === "score" && <ScorePanel runId={runId} onRunId={adoptRunId} />}
        {view === "history" && <HistoryPanel />}
      </div>
    </>
  );
}

/**
 * useSearchParams needs a Suspense boundary, or Next refuses to prerender the
 * page at build time. The fallback is the empty shell rather than a spinner:
 * it is on screen for one frame, and a flash of "Loading" is worse than a
 * frame of the chrome that is about to be there anyway.
 */
export default function Home() {
  return (
    <Suspense fallback={<Shell />}>
      <Studio />
    </Suspense>
  );
}

function Shell({ view }: { view?: View }) {
  return (
    <>
      <Nav view={view ?? "generate"} />
      <div className="shell" />
    </>
  );
}
