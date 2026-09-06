import { NextResponse } from "next/server";
import { z } from "zod";
import { ShopifyClient, ShopifyFetchError } from "@/lib/scrape/shopify";
import { parseProductUrl } from "@/lib/scrape/product-url";
import { FetchRejectedError } from "@/lib/http/safe-fetch";
import { claimsFrom, PLACEMENTS } from "@/lib/pipeline/types";
import { finishRun, newRunId, startRun } from "@/lib/run";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The confirmation step — free, and the only thing standing between a bad
 * scrape and real image spend.
 *
 * Returns what we understood from the page so a human can check it before
 * anything is generated. Deliberately surfaces the claim-bearing values
 * separately, because those are the regulated numbers that will be printed.
 *
 * This is also where a run gets its identity. The id is minted here, on the
 * free step, rather than at generation, because that is the moment the user has
 * something on screen worth sending to somebody: the address bar carries
 * ?run=gen_... from the first click, and generating fills that same run in
 * rather than opening a second one. Minting at generation would mean the link
 * only appeared after the money was spent.
 */

const RequestSchema = z.object({ url: z.string().min(1).max(2000) });

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { url: string }" },
      { status: 422 },
    );
  }

  const allowedHosts = env().STORE_ALLOWED_HOSTS;

  // Cheap client-side-shaped rejection first: a collection URL should never
  // reach the network, and the message should say what to do about it.
  const verdict = parseProductUrl(parsed.data.url, allowedHosts);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.message, reason: verdict.reason },
      { status: 422 },
    );
  }

  const runId = newRunId("generation");

  try {
    const client = new ShopifyClient({
      allowedHosts,
      currency: env().STORE_CURRENCY,
    });
    const snapshot = await client.fetchProduct(parsed.data.url);
    const claims = claimsFrom(snapshot);

    await startRun({
      id: runId,
      kind: "generation",
      subject: snapshot.title,
      productUrl: snapshot.sourceUrl,
      // `stage` is carried in inputs rather than payload because the history
      // list deliberately does not select payload, and a run that was only read
      // must not be labelled "generated" in that list.
      inputs: { stage: "resolved", url: parsed.data.url, canonical: verdict.canonical },
    });

    // Recorded as a finished run in its own right, so a link copied at the
    // confirmation step opens on the confirmation step rather than on nothing.
    // Generating later overwrites this payload with the full result.
    await finishRun({
      id: runId,
      status: "ok",
      summary: `Read ${snapshot.title}`,
      costUsd: 0,
      payload: {
        stage: "resolved",
        snapshot,
        claims,
        canonical: verdict.canonical,
      },
    });

    return NextResponse.json({
      runId,
      snapshot,
      claims,
      canonical: verdict.canonical,
      placements: Object.values(PLACEMENTS),
    });
  } catch (error) {
    /*
     * A failed read still gets a run.
     *
     * The id was minted above and then only recorded on success, so the one run
     * somebody actually needs to send you, the one where the page would not
     * read, had no identity at all. Generate and score both open their run
     * before doing any work for exactly this reason; this was the last path
     * that did not.
     */
    await finishRun({
      id: runId,
      status: "failed",
      summary: "Could not read the product page",
      productUrl: verdict.canonical,
      costUsd: 0,
      inputs: { stage: "resolved", url: parsed.data.url, canonical: verdict.canonical },
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof FetchRejectedError) {
      return NextResponse.json(
        { error: error.message, reason: error.reason },
        { status: 422 },
      );
    }
    if (error instanceof ShopifyFetchError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status === 404 ? 404 : 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Resolve failed" },
      { status: 500 },
    );
  }
}
