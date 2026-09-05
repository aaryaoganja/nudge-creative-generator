import { NextResponse } from "next/server";
import { z } from "zod";
import { ShopifyClient, ShopifyFetchError } from "@/lib/scrape/shopify";
import { parseProductUrl } from "@/lib/scrape/product-url";
import { FetchRejectedError } from "@/lib/http/safe-fetch";
import { claimsFrom, PLACEMENTS } from "@/lib/pipeline/types";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The confirmation step — free, and the only thing standing between a bad
 * scrape and real image spend.
 *
 * Returns what we understood from the page so a human can check it before
 * anything is generated. Deliberately surfaces the claim-bearing values
 * separately, because those are the regulated numbers that will be printed.
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

  try {
    const client = new ShopifyClient({
      allowedHosts,
      currency: env().STORE_CURRENCY,
    });
    const snapshot = await client.fetchProduct(parsed.data.url);

    return NextResponse.json({
      snapshot,
      claims: claimsFrom(snapshot),
      canonical: verdict.canonical,
      placements: Object.values(PLACEMENTS),
    });
  } catch (error) {
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
