import { NextResponse } from "next/server";
import { z } from "zod";
import { ShopifyClient, ShopifyFetchError } from "@/lib/scrape/shopify";
import { parseProductUrl } from "@/lib/scrape/product-url";
import { tryScrapePage } from "@/lib/scrape/firecrawl";
import { safeFetchBinary, FetchRejectedError } from "@/lib/http/safe-fetch";
import { GeminiTextClient, describeSchemaFailure } from "@/lib/providers/gemini-text";
import { GeminiImageProvider } from "@/lib/providers/gemini-image";
import { ImageProviderError, type AspectRatio } from "@/lib/providers/image";
import { generateBrief, renderImagePrompt } from "@/lib/pipeline/brief";
import { claimsFrom, PLACEMENTS_BY_ID, limitsFor } from "@/lib/pipeline/types";
import { discountPct } from "@/lib/scrape/shopify";
import { finishRun, isRunId, newRunId, startRun } from "@/lib/run";
import { assetUrl, storage } from "@/lib/storage";
import { orientationOf } from "../../../../config/brand";
import { checkPolicy } from "@/lib/policy/check";
import { checkPlacement } from "@/lib/image/meta";
import { env } from "@/lib/env";
import { geminiKeyForRequest } from "@/lib/runtime-key";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Nano Banana Pro, per generated image. */
const IMAGE_COST_USD = 0.134;

/**
 * Nano Banana Pro accepts a fixed set of ratios, so a placement's exact pixel
 * spec is mapped to the nearest one it can actually generate. The deterministic
 * crop downstream takes it the rest of the way — see docs/ARCHITECTURE.md §24.1.
 */
function aspectRatioFor(placement: { width: number; height: number }): AspectRatio {
  const target = placement.width / placement.height;
  const supported: AspectRatio[] = [
    "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
  ];
  let best: AspectRatio = "1:1";
  let bestDelta = Infinity;
  for (const ratio of supported) {
    const [w, h] = ratio.split(":").map(Number);
    const delta = Math.abs(w / h - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = ratio;
    }
  }
  return best;
}

const RequestSchema = z.object({
  url: z.string().min(1).max(2000),
  /**
   * The id /api/resolve minted, so the confirmation the user already has a link
   * to becomes the finished run rather than a second, orphaned one. Optional so
   * the endpoint stays usable on its own.
   */
  runId: z.string().max(40).optional(),
  /** Multi-select: one brief, rendered for every chosen placement. */
  // Matches defaultPlacementIds() in config/placements.ts, which is what the
  // picker opens on. A schema default that disagreed with the UI meant an API
  // caller and a UI user got different creatives from the same request.
  placementIds: z
    .array(z.string())
    .min(1)
    .max(8)
    .default(["meta_feed_4x5", "meta_story_9x16"]),
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
  brandMark: z.enum(["on_pack_only", "wordmark", "none"]).default("on_pack_only"),
  priceDisplay: z.enum(["none", "price_only", "was_now"]).default("price_only"),
  /**
   * Corrections made at the confirmation step. Asking someone to confirm
   * scraped facts without letting them fix a wrong one is not a confirmation.
   */
  overrides: z
    .object({
      title: z.string().max(300).optional(),
      priceMinor: z.number().int().min(0).optional(),
      compareAtPriceMinor: z.number().int().min(0).nullable().optional(),
      concentrations: z.array(z.number()).max(12).optional(),
    })
    .optional(),
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
  const selected = input.placementIds.map((id) => PLACEMENTS_BY_ID[id]);
  const unknown = input.placementIds.filter((id) => !PLACEMENTS_BY_ID[id]);
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        error: `Unknown placement${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
        available: Object.keys(PLACEMENTS_BY_ID),
      },
      { status: 422 },
    );
  }
  /*
   * One brief per FRAME SHAPE, not one per run.
   *
   * The brief carries the frame's orientation and the archetype menu that can
   * be built in it (src/lib/pipeline/brief.ts buildUserPrompt). Writing one
   * brief for placementIds[0] and rendering every placement from it meant a
   * 1200x628 banner was built from a plan written for a 4:5 frame, and which
   * placement won was whichever the user happened to tick first: the picker
   * appends on select, so the "primary" was invisible click order.
   *
   * Grouping by orientation is the smallest correct unit. Two placements that
   * are both tall share a plan honestly; a tall one and a wide one do not.
   */
  const byOrientation = new Map<string, typeof selected>();
  for (const placement of selected) {
    const shape = orientationOf(placement.width, placement.height);
    byOrientation.set(shape, [...(byOrientation.get(shape) ?? []), placement]);
  }

  const limits = limitsFor(input.placementIds);
  // Reuse the id from the confirmation step when the client has one, so the URL
  // the user already copied is the URL of the finished run.
  const runId =
    input.runId && isRunId(input.runId) ? input.runId : newRunId("generation");
  const startedAt = new Date().toISOString();

  const config = env();

  // Verify the URL BEFORE anything else. Relying on the scrape to fail produces
  // a network-shaped error ("HTTP 404") for what is really a user mistake, and
  // it costs a round trip to say so. The verifier names the actual problem.
  const verdict = parseProductUrl(input.url, config.STORE_ALLOWED_HOSTS);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.message, reason: verdict.reason },
      { status: 422 },
    );
  }

  // The session override from /keys wins over the deployment's own key, so this
  // is "no key from either source" rather than "no key in the environment".
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

  /*
   * Everything the user chose, kept with the run.
   *
   * The old record stored the URL, objective, concept count, placements and the
   * two display switches, and dropped offer, angle, audience, which reference
   * images were picked, and every confirm-step correction. Those omissions are
   * the claim-bearing ones: a run that printed a corrected concentration had no
   * record that a human had corrected it. If it changed the output, it belongs
   * here.
   */
  const runInputs: Record<string, unknown> = {
    url: input.url,
    canonical: verdict.canonical,
    placementIds: input.placementIds,
    objective: input.objective,
    concepts: input.concepts,
    brandMark: input.brandMark,
    priceDisplay: input.priceDisplay,
    offer: input.offer ?? null,
    angleHint: input.angleHint ?? null,
    audience: input.audience ?? null,
    referenceImageIndexes: input.referenceImageIndexes,
    overrides: input.overrides ?? null,
    models: {
      text: config.GEMINI_TEXT_MODEL,
      image: config.GEMINI_IMAGE_MODEL,
    },
  };

  // Opened before any work, so a run that fails still has an identity and a
  // link. Only the success path used to be recorded, which meant the one run
  // somebody actually needed to send you was the one with no id.
  await startRun({
    id: runId,
    kind: "generation",
    productUrl: verdict.canonical,
    inputs: runInputs,
  });

  try {
    // ── resolve ───────────────────────────────────────────────────────────
    const shopify = new ShopifyClient({
      allowedHosts: config.STORE_ALLOWED_HOSTS,
      currency: config.STORE_CURRENCY,
    });
    const fetched = await shopify.fetchProduct(input.url);
    // Confirmation-step corrections win over the scrape: a human who looked at
    // the page is a better source than a parser that guessed.
    const snapshot = {
      ...fetched,
      title: input.overrides?.title ?? fetched.title,
      priceMinor: input.overrides?.priceMinor ?? fetched.priceMinor,
      compareAtPriceMinor:
        input.overrides?.compareAtPriceMinor !== undefined
          ? input.overrides.compareAtPriceMinor
          : fetched.compareAtPriceMinor,
      concentrations:
        input.overrides?.concentrations ?? fetched.concentrations,
    };
    snapshot.discountPct = discountPct(
      snapshot.priceMinor,
      snapshot.compareAtPriceMinor,
    );
    const claims = claimsFrom(snapshot);

    // ── enrich ────────────────────────────────────────────────────────────
    // Shopify's JSON gives the description field only; the rendered page also
    // carries ingredients, mechanism, usage and the FAQ copy that an
    // objection-led brief needs in order to know what the objections are.
    // Best effort: a failure here costs copy depth, never correctness, but it
    // is now REPORTED rather than silently skipped.
    const { page, warning: enrichmentWarning } = await tryScrapePage(
      snapshot.sourceUrl,
      {
        allowedHosts: config.STORE_ALLOWED_HOSTS,
        apiKey: config.FIRECRAWL_API_KEY,
      },
    );

    // ── brief, one per frame shape ────────────────────────────────────────
    const text = new GeminiTextClient(geminiKey, config.GEMINI_TEXT_MODEL);

    // Sequential, not parallel: two or three calls at a few thousand tokens
    // each are quick, and the 120s route budget is spent almost entirely on
    // image generation below. Racing them would buy a second and risk a rate
    // limit on the one call the whole run depends on.
    const briefs = new Map<string, Awaited<ReturnType<typeof generateBrief>>>();
    for (const [shape, placements] of byOrientation) {
      briefs.set(
        shape,
        await generateBrief(text, {
          snapshot,
          claims,
          placement: placements[0],
          objective: input.objective,
          conceptCount: input.concepts,
          offer: input.offer,
          angleHint: input.angleHint,
          audience: input.audience,
          pageMarkdown: page?.markdown ?? null,
          brandMark: input.brandMark,
          priceDisplay: input.priceDisplay,
          copyLimits: {
            headline: limits.headline,
            primaryText: limits.primaryText,
            description: limits.description,
          },
        }),
      );
    }

    const briefUsd = [...briefs.values()].reduce(
      (sum, b) => sum + b.usage.costUsd,
      0,
    );
    const briefTokens = [...briefs.values()].reduce(
      (acc, b) => ({
        input: acc.input + b.usage.inputTokens,
        output: acc.output + b.usage.outputTokens,
      }),
      { input: 0, output: 0 },
    );

    // ── policy gate, before any image spend ───────────────────────────────
    // The offer's own figures are authorised claims: a promotion is a fact
    // about the campaign, and the prompt is told to print it verbatim. Without
    // this the gate would block the model for obeying the instruction.
    const authorised = { offer: input.offer ?? null };
    const gated = [...briefs.entries()].flatMap(([shape, b]) =>
      b.value.concepts.map((concept) => ({
        shape,
        concept,
        policy: checkPolicy(concept, claims, authorised),
      })),
    );
    const passing = gated.filter((g) => g.policy.verdict !== "blocked");

    if (passing.length === 0) {
      await finishRun({
        id: runId,
        status: "blocked",
        summary: `Blocked before generation: ${snapshot.title}`,
        subject: snapshot.title,
        productUrl: snapshot.sourceUrl,
        costUsd: briefUsd,
        inputs: runInputs,
        payload: {
          stage: "blocked",
          snapshot,
          claims,
          concepts: gated.map((g) => ({
            name: g.concept.concept.name,
            copy: g.concept.copy,
            policy: g.policy,
          })),
          cost: { briefUsd, imageUsd: 0, totalUsd: briefUsd },
        },
      });
      return NextResponse.json(
        {
          runId,
          error:
            "Every concept was blocked by the policy gate. No image was generated, so nothing was spent on generation.",
          concepts: gated.map((g) => ({
            name: g.concept.concept.name,
            copy: g.concept.copy,
            policy: g.policy,
          })),
          cost: { briefUsd, imageUsd: 0 },
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
        const asset = await safeFetchBinary(image.src, {
          allowedHosts: config.IMAGE_CDN_HOSTS,
          accept: "image/*",
          maxBytes: 12 * 1024 * 1024,
        });
        return {
          bytes: asset.data,
          mimeType: asset.contentType?.split(";")[0] ?? "image/jpeg",
        };
      }),
    );

    // ── generate ──────────────────────────────────────────────────────────
    const imageProvider = new GeminiImageProvider(
      geminiKey,
      config.GEMINI_IMAGE_MODEL,
    );

    const results = [];
    let imageSpend = 0;

    const assets = storage();
    const assetShas: string[] = [];

    for (const { shape, concept, policy } of passing) {
      // Only the placements this concept was actually briefed for. A concept
      // written against a tall frame is not rendered into a banner.
      for (const placement of byOrientation.get(shape) ?? []) {
      const prompt = renderImagePrompt(concept, placement, {
        brandMark: input.brandMark,
        priceDisplay: input.priceDisplay,
        safeZone: placement.safeZone ?? null,
        angle: input.angleHint ?? null,
      });
      try {
        const image = await imageProvider.generate({
          prompt,
          aspectRatio: aspectRatioFor(placement),
          resolution: "2K",
          referenceImages,
        });
        imageSpend += IMAGE_COST_USD;

        const placementCheck = checkPlacement(image.bytes, placement);

        /*
         * Persisted by content hash, and referenced by URL rather than inlined.
         *
         * The response used to carry every image as a base64 data URL. At 2K
         * that is one to three megabytes per creative before base64 adds a
         * third, all of it buffered in the Node heap of the container serving
         * the UI, and none of it recoverable afterwards. A stored asset makes
         * the response small AND makes a shared run openable tomorrow.
         *
         * When there is no database the put returns null and `url` is null; the
         * data URL below is the fallback so the picture still appears for the
         * person who generated it. Degrade, never fail.
         */
        const stored = await assets.put(image.bytes, {
          mimeType: image.mimeType,
          width: placementCheck.meta.width,
          height: placementCheck.meta.height,
        });
        if (stored) assetShas.push(stored.sha256);

        results.push({
          placement,
          concept: concept.concept,
          copy: concept.copy,
          policy,
          prompt,
          image: {
            url: stored ? assetUrl(stored.sha256) : null,
            dataUrl: stored
              ? null
              : `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
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
          placement,
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
    }

    const totalUsd = briefUsd + imageSpend;
    const rendered = results.filter((r) => r.image).length;
    const textModel = [...briefs.values()][0]?.model ?? config.GEMINI_TEXT_MODEL;

    /*
     * The payload IS the response. Building the two separately is how a shared
     * link drifts from what the person who ran it saw, so the object is
     * assembled once and used for both.
     */
    const payload = {
      stage: "generated" as const,
      snapshot,
      claims,
      placements: selected,
      results,
      blocked: gated
        .filter((g) => g.policy.verdict === "blocked")
        .map((g) => ({ name: g.concept.concept.name, policy: g.policy })),
      cost: {
        briefUsd,
        imageUsd: imageSpend,
        totalUsd,
        inputTokens: briefTokens.input,
        outputTokens: briefTokens.output,
      },
      models: { text: textModel, image: config.GEMINI_IMAGE_MODEL },
      enrichment: {
        used: page !== null,
        source: page?.source ?? null,
        chars: page?.markdown.length ?? 0,
        warning: enrichmentWarning,
      },
      referenceImages: references.map((image) => image.src),
    };

    await finishRun({
      id: runId,
      status: rendered > 0 ? "ok" : "failed",
      summary: `${rendered} creative${rendered === 1 ? "" : "s"}: ${selected.map((p) => p.label).join(", ")}`,
      subject: snapshot.title,
      productUrl: snapshot.sourceUrl,
      costUsd: totalUsd,
      inputs: runInputs,
      payload,
      // Deduplicated: content addressing means two placements that produced
      // identical bytes share one row, and listing the same hash twice would
      // make the retention sweep think there is more to keep than there is.
      assetShas: [...new Set(assetShas)],
    });

    return NextResponse.json({ runId, startedAt, ...payload });
  } catch (error) {
    await finishRun({
      id: runId,
      status: "failed",
      summary: "Generation failed",
      costUsd: 0,
      inputs: runInputs,
      error: error instanceof Error ? error.message : String(error),
    });

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
