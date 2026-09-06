import { NextResponse } from "next/server";
import { ShopifyClient } from "@/lib/scrape/shopify";
import { tryScrapePage } from "@/lib/scrape/firecrawl";
import { FetchRejectedError } from "@/lib/http/safe-fetch";
import { GeminiTextClient } from "@/lib/providers/gemini-text";
import { scoreCreative } from "@/lib/pipeline/score";
import { PLACEMENTS_BY_ID } from "@/lib/pipeline/types";
import { finishRun, newRunId, startRun } from "@/lib/run";
import { assetUrl, storage } from "@/lib/storage";
import { readImageMeta } from "@/lib/image/meta";
import { env } from "@/lib/env";
import { geminiKeyForRequest } from "@/lib/runtime-key";
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
 *
 * `placementId` and `objective` are also optional, and their absence is
 * handled rather than papered over. The panel used to post a hardcoded
 * `meta_feed_4x5`, so a perfectly good 1080x1080 square was measured against a
 * 1080x1350 spec nobody had chosen, failed the deterministic ratio check, and
 * came back "blocked" with a craft failure the creative had not committed.
 * Omitting the placement now means the format and byte-cap checks still run
 * while the size and aspect checks are skipped, because there is no intended
 * shape to check against.
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

interface ParsedInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string | null;
  productUrl: string | null;
  /** null means "not stated", which is different from meta_feed_4x5. */
  placementId: string | null;
  objective: string | null;
}

const OBJECTIVES = ["awareness", "consideration", "conversion", "retargeting"];

function readObjective(value: unknown): string | null {
  return typeof value === "string" && OBJECTIVES.includes(value) ? value : null;
}

/** Empty string, "any" and "unknown" all mean the user declined to say. */
function readPlacementId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "any" || trimmed === "unknown") return null;
  return trimmed;
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
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type || "image/png",
      fileName: file.name || null,
      productUrl: typeof productUrl === "string" && productUrl.trim() ? productUrl.trim() : null,
      placementId: readPlacementId(form.get("placementId")),
      objective: readObjective(form.get("objective")),
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
    fileName: typeof body.fileName === "string" ? body.fileName : null,
    productUrl:
      typeof body.productUrl === "string" && body.productUrl.trim()
        ? body.productUrl.trim()
        : null,
    placementId: readPlacementId(body.placementId),
    objective: readObjective(body.objective),
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

  // Sniff the header rather than trusting the declared type. WebP is read and
  // scored; the placement check is what tells the user Meta will not take it.
  const meta = readImageMeta(parsed.bytes);
  if (meta.format === "unknown") {
    return NextResponse.json(
      { error: "That file does not look like a PNG, JPEG or WebP image." },
      { status: 422 },
    );
  }

  const placement = parsed.placementId
    ? (PLACEMENTS_BY_ID[parsed.placementId] ?? null)
    : null;
  if (parsed.placementId && !placement) {
    return NextResponse.json(
      {
        error: `Unknown placement "${parsed.placementId}".`,
        available: Object.keys(PLACEMENTS_BY_ID),
      },
      { status: 422 },
    );
  }

  const config = env();
  // The session override from /keys wins over the deployment's own key.
  const geminiKey = await geminiKeyForRequest(request);
  if (!geminiKey) {
    return NextResponse.json(
      {
        error:
          "No Gemini key is available. Set GEMINI_API_KEY on the deployment, or paste a key at /keys to use your own for this session.",
      },
      { status: 503 },
    );
  }

  const runId = newRunId("scoring");
  const runInputs: Record<string, unknown> = {
    placementId: placement?.id ?? null,
    objective: parsed.objective,
    productUrl: parsed.productUrl,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    bytes: parsed.bytes.byteLength,
    dimensions:
      meta.width && meta.height ? `${meta.width}x${meta.height}` : null,
  };
  await startRun({
    id: runId,
    kind: "scoring",
    subject: parsed.fileName ?? "Uploaded creative",
    productUrl: parsed.productUrl,
    inputs: runInputs,
  });

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
    const client = new GeminiTextClient(geminiKey, config.GEMINI_TEXT_MODEL);
    const result = await scoreCreative(client, {
      image: { bytes: parsed.bytes, mimeType: parsed.mimeType },
      placement,
      snapshot,
      pageMarkdown,
      objective: parsed.objective as never,
    });

    /*
     * Keep the reviewed creative, so a shared score shows the thing it is
     * about. A score without its image is a page of findings about a picture
     * nobody else can see.
     */
    const stored = await storage().put(parsed.bytes, {
      mimeType: parsed.mimeType,
      width: meta.width,
      height: meta.height,
    });

    /*
     * The note has to say which of three situations applies. It used to claim
     * "no product URL supplied" even when one was supplied and the fetch had
     * failed, which told the user to do the thing they had already done.
     */
    const note = result.productVerified
      ? null
      : parsed.productUrl
        ? "The product page could not be read, so product-specific claims could not be verified. Check the URL and score again."
        : "No product URL was supplied, so product-specific claims could not be verified. Add the product URL to check concentrations, price and packaging against the live page.";

    const payload = {
      stage: "scored" as const,
      ...result,
      placement,
      objective: parsed.objective,
      image: {
        url: stored ? assetUrl(stored.sha256) : null,
        mimeType: parsed.mimeType,
        width: meta.width,
        height: meta.height,
        bytes: parsed.bytes.byteLength,
        fileName: parsed.fileName,
      },
      product: snapshot
        ? { title: snapshot.title, url: snapshot.sourceUrl }
        : null,
      productUrlWarning,
      note,
    };

    await finishRun({
      id: runId,
      status: result.verdict === "blocked" ? "blocked" : "ok",
      summary: `${result.overall}/100, ${result.verdict.replace("_", " ")}`,
      subject: snapshot?.title ?? parsed.fileName ?? "Uploaded creative",
      productUrl: snapshot?.sourceUrl ?? parsed.productUrl,
      costUsd: result.usage.costUsd,
      inputs: runInputs,
      payload,
      assetShas: stored ? [stored.sha256] : [],
    });

    return NextResponse.json({ runId, ...payload });
  } catch (error) {
    await finishRun({
      id: runId,
      status: "failed",
      summary: "Scoring failed",
      subject: parsed.fileName ?? "Uploaded creative",
      costUsd: 0,
      inputs: runInputs,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { runId, error: error instanceof Error ? error.message : "Scoring failed" },
      { status: 502 },
    );
  }
}
