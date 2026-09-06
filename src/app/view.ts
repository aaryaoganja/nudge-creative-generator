/**
 * Which view is on screen, and which run it is showing, held in the URL.
 *
 * This used to be `useState` inside page.tsx, which made two things impossible.
 * A person could not send anybody what they were looking at, and switching tabs
 * destroyed the results because the panel unmounted. Both are the same bug:
 * state that only exists in one browser's memory.
 *
 *   /                      the generator, empty
 *   /?view=score           the scorer
 *   /?view=history         past runs
 *   /?run=gen_1a2b...      that run, in whichever view its id implies
 *
 * `run` wins over `view` when both are present, because a link someone pasted
 * is a stronger statement of intent than a tab they last had open. The kind is
 * read from the id's own prefix, so a run link never needs a second parameter
 * to say what it is.
 */

export const VIEWS = ["generate", "score", "history"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<View, string> = {
  generate: "Generate",
  score: "Score a creative",
  history: "History",
};

function isView(value: string | null): value is View {
  return value !== null && (VIEWS as readonly string[]).includes(value);
}

/** Same shape as src/lib/run.ts isRunId, duplicated so this stays client-safe. */
export function looksLikeRunId(value: string | null | undefined): boolean {
  return typeof value === "string" && /^(gen|scr)_[0-9a-f]{20}$/.test(value);
}

export interface ViewState {
  view: View;
  runId: string | null;
}

export function readViewState(params: URLSearchParams): ViewState {
  const runId = params.get("run");
  if (looksLikeRunId(runId)) {
    return {
      view: runId!.startsWith("scr_") ? "score" : "generate",
      runId: runId!,
    };
  }

  const view = params.get("view");
  return { view: isView(view) ? view : "generate", runId: null };
}

/**
 * The address bar for a given state.
 *
 * The default view writes no parameter at all, so the URL of a fresh session is
 * "/" rather than "/?view=generate". A link should not carry the absence of a
 * choice.
 */
export function viewHref(state: ViewState): string {
  if (state.runId) return `/?run=${state.runId}`;
  return state.view === "generate" ? "/" : `/?view=${state.view}`;
}
