import { NextResponse } from "next/server";
import { getRun, isRunId, listRuns, type RunKind } from "@/lib/run";

export const dynamic = "force-dynamic";

/**
 * Run history, and the record behind a shared link.
 *
 *   GET /api/runs                  every run, newest first
 *   GET /api/runs?kind=generation  generations only
 *   GET /api/runs?id=gen_...       one run, with the full payload to redraw it
 *
 * The list never carries payloads; the single-id read always does. That split
 * is the reason the history view stays fast while a shared URL can rebuild the
 * whole page.
 *
 * `durable` is reported honestly and reflects where the answer actually came
 * from. When it is false the link the user is about to copy will not open for
 * anybody else, and the UI says so rather than implying otherwise.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    if (!isRunId(id)) {
      return NextResponse.json(
        { error: `"${id}" is not a run id. Run ids look like gen_1a2b... or scr_1a2b...` },
        { status: 400 },
      );
    }

    const { run, durable } = await getRun(id);
    if (!run) {
      return NextResponse.json(
        {
          error: durable
            ? "No run with that id. Check the link, or open History to find it."
            : "No run with that id on this server. History is not being stored, so a link only opens in the session that created it.",
          durable,
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ run, durable });
  }

  const kindParam = url.searchParams.get("kind");
  const kind =
    kindParam === "generation" || kindParam === "scoring"
      ? (kindParam as RunKind)
      : undefined;

  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 100);

  return NextResponse.json(await listRuns(kind, limit));
}
