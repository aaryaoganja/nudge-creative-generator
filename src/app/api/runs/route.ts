import { NextResponse } from "next/server";
import { listRuns, getRun, type RunKind } from "@/lib/run";

export const dynamic = "force-dynamic";

/**
 * Run history — every generation and score, newest first.
 *
 *   GET /api/runs                 all runs
 *   GET /api/runs?kind=generation only generations
 *   GET /api/runs?id=gen_…        one run in full
 *
 * The response reports `durable` honestly: history currently lives in the
 * running container's memory and is lost on redeploy. Saying so is better than
 * a UI that implies a permanence the storage does not have.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    const run = getRun(id);
    if (!run) {
      return NextResponse.json(
        {
          error: `No run "${id}" in this container's history. It may predate the last deploy.`,
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ run });
  }

  const kindParam = url.searchParams.get("kind");
  const kind =
    kindParam === "generation" || kindParam === "scoring"
      ? (kindParam as RunKind)
      : undefined;

  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 100);

  return NextResponse.json(listRuns(kind, limit));
}
