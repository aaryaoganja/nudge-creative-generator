import { NextResponse } from "next/server";
import { z } from "zod";
import { ShopifyClient, ShopifyFetchError } from "@/lib/scrape/shopify";
import { tryScrapePage } from "@/lib/scrape/firecrawl";
import { safeFetchBinary, FetchRejectedError } from "@/lib/http/safe-fetch";
import { GeminiTextClient, describeSchemaFailure } from "@/lib/providers/gemini-text";
import { GeminiImageProvider } from "@/lib/providers/gemini-image";
import { ImageProviderError } from "@/lib/providers/image";
import { generateBrief, renderImagePrompt } from "@/lib/pipeline/brief";
import { claimsFrom, PLACEMENTS } from "@/lib/pipeline/types";
import { checkPolicy } from "@/lib/policy/check";
import { checkPlacement } from "@/lib/image/meta";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Nano Banana Pro, per generated image. */
const IMAGE_COST_USD = 0.134;

const RequestSchema = z.object({
  url: z.string().min(1).max(2000),
  placementId: z.string().default("meta_feed_4x5"),
  objective: z
    .enum(["awareness", "consideration", "conversion", "retargeting"])
    .default("conversion"),
  concepts: z.number().int().min(1).max(4).default(2),
  offer: z.string().max(120).optional(),
  angleHint: z.string().max(300).optional(),
  audience: z.string().max(200).optional(),
  /**
   * Indexes into the product's own images, chosen at the confirmation step.
   * Capped at two: more reference images dilute what the model anchors on, and
   * the first image is the packshot in practically every case.
   */
  referenceImageIndexes: z.array(z.number().int().min(0).max(20)).min(1).max(2).default([0]),
});

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(payload);
  if (!parsed.success) {
    // Raw Zod issue JSON is not an error message a person can act on.
    return NextResponse.json(
      { error: describeSchemaFailure(parsed.error, "request") },
      { status: 422 },
    );
  }

  const input = parsed.data;
  const placement = PLACEMENTS[input.placementId];
  if (!placement) {
    return NextResponse.json(
      {
        error: `Unknown placement "${input.placementId}"`,
        available: Object.keys(PLACEMENTS),
      },
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

  try {
    // ── resolve ───────────────────────────────────────────────────────────
    const shopify = new ShopifyClient({
      allowedHosts: config.STORE_ALLOWED_HOSTS,
      currency: config.STORE_CURRENCY,
    });
    const snapshot = await shopify.fetchProduct(input.url);
    const claims = claimsFrom(snapshot);

    // ── enrich (optional) ─────────────────────────────────────────────────
    // Shopify's JSON gives the description field only; the rendered page also
    // carries ingredients, mechanism and usage. Best-effort — a failure here
    // costs copy depth, never correctness.
    const { page, warning: enrichmentWarning } = await tryScrapePage(
      snapshot.sourceUrl,
      config.FIRECRAWL_API_KEY,
    );

    // ── brief ─────────────────────────────────────────────────────────────
    const text = new GeminiTextClient(
      config.GEMINI_API_KEY,
      config.GEMINI_TEXT_MODEL,
    );
    const brief = await generateBrief(text, {
      snapshot,
      claims,
      placement,
      objective: input.objective,
      conceptCount: input.concepts,
      offer: input.offer,
      angleHint: input.angleHint,
      audience: input.audience,
      pageMarkdown: page?.markdown ?? null,
    });

    // ── policy gate, before any image spend ───────────────────────────────
    const gated = brief.value.concepts.map((concept) => ({
      concept,
      policy: checkPolicy(concept, claims),
    }));
    const passing = gated.filter((g) => g.policy.verdict !== "blocked");

    if (passing.length === 0) {
      return NextResponse.json(
        {
          error:
            "Every concept was blocked by the policy gate. No image was generated and nothing was spent on generation.",
          concepts: gated.map((g) => ({
            name: g.concept.concept.name,
            copy: g.concept.copy,
            policy: g.policy,
          })),
          cost: { briefUsd: brief.usage.costUsd, imageUsd: 0 },
        },
        { status: 422 },
      );
    }

    // ── reference photographs, from the product page ──────────────────────
    // The first product image is the packshot on practically every Shopify
    // storefront, so an empty selection defaults to it rather than erroring.
    const chosen = input.referenceImageIndexes
      .map((index) => snapshot.images[index])
      .filter((image): image is NonNullable<typeof image> => Boolean(image));
    const references = chosen.length > 0 ? chosen : snapshot.images.slice(0, 1);

    if (references.length === 0) {
      return NextResponse.json(
        { error: "This product page has no images to use as a reference." },
        { status: 422 },
      );
    }

    const referenceImages = await Promise.all(
      references.map(async (image) => {
        const fetched = await safeFetchBinary(image.src, {
          allowedHosts: config.IMAGE_CDN_HOSTS,
          accept: "image/*",
          maxBytes: 12 * 1024 * 1024,
        });
        return {
          bytes: fetched.data,
          mimeType: fetched.contentType?.split(";")[0] ?? "image/jpeg",
        };
      }),
    );

    // ── generate ──────────────────────────────────────────────────────────
    const imageProvider = new GeminiImageProvider(
      config.GEMINI_API_KEY,
      config.GEMINI_IMAGE_MODEL,
    );

    const results = [];
    let imageSpend = 0;

    for (const { concept, policy } of passing) {
      const prompt = renderImagePrompt(concept, placement);
      try {
        const image = await imageProvider.generate({
          prompt,
          aspectRatio: "4:5",
          resolution: "2K",
          referenceImages,
        });
        imageSpend += IMAGE_COST_USD;

        const placementCheck = checkPlacement(image.bytes, placement);

        results.push({
          concept: concept.concept,
          copy: concept.copy,
          policy,
          prompt,
          image: {
            dataUrl: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
            mimeType: image.mimeType,
            bytes: image.bytes.byteLength,
            width: placementCheck.meta.width,
            height: placementCheck.meta.height,
          },
          placementCheck: {
            ok: placementCheck.ok,
            failures: placementCheck.failures,
            warnings: placementCheck.warnings,
          },
        });
      } catch (error) {
        results.push({
          concept: concept.concept,
          copy: concept.copy,
          policy,
          prompt,
          image: null,
          error:
            error instanceof ImageProviderError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
    }

    return NextResponse.json({
      snapshot,
      claims,
      placement,
      results,
      blocked: gated
        .filter((g) => g.policy.verdict === "blocked")
        .map((g) => ({ name: g.concept.concept.name, policy: g.policy })),
      cost: {
        briefUsd: brief.usage.costUsd,
        imageUsd: imageSpend,
        totalUsd: brief.usage.costUsd + imageSpend,
        inputTokens: brief.usage.inputTokens,
        outputTokens: brief.usage.outputTokens,
      },
      models: { text: brief.model, image: config.GEMINI_IMAGE_MODEL },
      enrichment: {
        used: page !== null,
        chars: page?.markdown.length ?? 0,
        warning: enrichmentWarning,
      },
      referenceImages: references.map((image) => image.src),
    });
  } catch (error) {
    if (error instanceof FetchRejectedError) {
      return NextResponse.json(
        { error: error.message, reason: error.reason },
        { status: 422 },
      );
    }
    if (error instanceof ShopifyFetchError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Generation failed" },
      { status: 500 },
    );
  }
}
