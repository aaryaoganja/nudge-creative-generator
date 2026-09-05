import { NextResponse } from "next/server";
import { ShopifyClient } from "@/lib/scrape/shopify";
import { tryScrapePage } from "@/lib/scrape/firecrawl";
import { FetchRejectedError } from "@/lib/http/safe-fetch";
import { GeminiTextClient } from "@/lib/providers/gemini-text";
import { scoreCreative } from "@/lib/pipeline/score";
import { PLACEMENTS_BY_ID } from "@/lib/pipeline/types";
import { newRunId, recordRun } from "@/lib/run";
import { readImageMeta } from "@/lib/image/meta";
import { env } from "@/lib/env";
import type { ProductSnapshot } from "@/lib/scrape/shopify";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Ad quality scorer — the standalone endpoint.
 *
 * Scores any creative, whether this tool produced it or not.
 *
 * `productUrl` is OPTIONAL. Supplied, every product claim in the image is
 * checked against the live page. Omitted, those checks come back marked
 * `verified: false` rather than silently passing — "I could not check this" and
 * "this is fine" are different answers, and conflating them makes a scorer
 * worse than useless.
 *
 * Accepts multipart/form-data with an `image` file, or JSON with a base64
 * `image` field.
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

interface ParsedInput {
  bytes: Uint8Array;
  mimeType: string;
  productUrl: string | null;
  placementId: string;
}

async function parseInput(request: Request): Promise<ParsedInput | { error: string }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return { error: "Expected an `image` file in the form data." };
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return { error: `Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit.` };
    }
    const productUrl = form.get("productUrl");
    const placementId = form.get("placementId");
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type || "image/png",
      productUrl: typeof productUrl === "string" && productUrl.trim() ? productUrl.trim() : null,
      placementId:
        typeof placementId === "string" && placementId ? placementId : "meta_feed_4x5",
    };
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { error: "Body must be multipart/form-data or valid JSON." };
  }

  const body = payload as Record<string, unknown>;
  const raw = typeof body.image === "string" ? body.image : null;
  if (!raw) {
    return { error: "Expected an `image` field containing base64 image data." };
  }

  // Accept a bare base64 string or a full data: URL.
  const match = /^data:([^;]+);base64,(.*)$/s.exec(raw);
  const base64 = match ? match[2] : raw;
  const mimeType = match ? match[1] : (body.mimeType as string) ?? "image/png";

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0) return { error: "Image data was empty or not valid base64." };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { error: `Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit.` };
  }

  return {
    bytes,
    mimeType,
    productUrl:
      typeof body.productUrl === "string" && body.productUrl.trim()
        ? body.productUrl.trim()
        : null,
    placementId:
      typeof body.placementId === "string" ? body.placementId : "meta_feed_4x5",
  };
}

export async function POST(request: Request) {
  const parsed = await parseInput(request);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 422 });
  }

  if (!ACCEPTED.includes(parsed.mimeType.toLowerCase())) {
    return NextResponse.json(
      { error: `Unsupported type "${parsed.mimeType}". Send PNG, JPEG or WebP.` },
      { status: 422 },
    );
  }

  // Sniff the header rather than trusting the declared type.
  const meta = readImageMeta(parsed.bytes);
  if (meta.format === "unknown") {
    return NextResponse.json(
      { error: "File does not appear to be a PNG or JPEG image." },
      { status: 422 },
    );
  }

  const placement = PLACEMENTS_BY_ID[parsed.placementId];
  if (!placement) {
    return NextResponse.json(
      { error: `Unknown placement "${parsed.placementId}"`, available: Object.keys(PLACEMENTS_BY_ID) },
      { status: 422 },
    );
  }

  const config = env();
  if (!config.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  let snapshot: ProductSnapshot | null = null;
  let pageMarkdown: string | null = null;
  let productUrlWarning: string | null = null;

  if (parsed.productUrl) {
    try {
      const shopify = new ShopifyClient({
        allowedHosts: config.STORE_ALLOWED_HOSTS,
        currency: config.STORE_CURRENCY,
      });
      snapshot = await shopify.fetchProduct(parsed.productUrl);

      // Widens what can actually be checked: a benefit claimed in the creative
      // may be supported by an ingredient section the product JSON omits.
      const enriched = await tryScrapePage(
        snapshot.sourceUrl,
        config.FIRECRAWL_API_KEY,
      );
      pageMarkdown = enriched.page?.markdown ?? null;
    } catch (error) {
      // A failed scrape must degrade to unverified, not fail the whole score.
      productUrlWarning =
        error instanceof FetchRejectedError || error instanceof Error
          ? `Product page could not be read (${error.message}). Product claims are unverified.`
          : "Product page could not be read. Product claims are unverified.";
    }
  }

  try {
    const client = new GeminiTextClient(
      config.GEMINI_API_KEY,
      config.GEMINI_TEXT_MODEL,
    );
    const result = await scoreCreative(client, {
      image: { bytes: parsed.bytes, mimeType: parsed.mimeType },
      placement,
      snapshot,
      pageMarkdown,
    });

    const runId = newRunId("scoring");
    recordRun({
      id: runId,
      kind: "scoring",
      startedAt: new Date().toISOString(),
      summary: `${result.overall}/100 · ${result.verdict.replace("_", " ")}`,
      subject: snapshot?.title ?? "Uploaded creative",
      costUsd: result.usage.costUsd,
      outcome: result.verdict,
      detail: {
        placementId: placement.id,
        productVerified: result.productVerified,
        dimensionScores: result.dimensionScores,
        findingCount: result.findings.length,
      },
    });

    return NextResponse.json({
      runId,
      ...result,
      placement,
      product: snapshot
        ? { title: snapshot.title, url: snapshot.sourceUrl }
        : null,
      productUrlWarning,
      note: result.productVerified
        ? null
        : "No product URL supplied, so product-specific claims could not be verified. Supply the product URL to check concentrations, price and packaging against the live page.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Scoring failed" },
      { status: 502 },
    );
  }
}
