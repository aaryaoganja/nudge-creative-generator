import { z } from "zod";
import {
  BRAND_VISUAL,
  BRAND_VOICE,
  POLICY_RULES,
} from "../../../config/brand.ts";
import { checkPlacement } from "../image/meta.ts";
import type { PlacementSpec } from "./types.ts";
import type { ProductSnapshot } from "../scrape/shopify.ts";
import type { GeminiTextClient, TextResult } from "../providers/gemini-text.ts";

/**
 * Ad quality scorer — the second endpoint.
 *
 * Accepts any creative, whether this tool made it or not. A product URL is
 * OPTIONAL: supplied, every product claim in the image is checked against the
 * live page; omitted, those checks are reported as `unverified` rather than
 * silently passed. Reporting "I could not check this" is materially different
 * from reporting "this is fine", and conflating the two is how a scorer becomes
 * worse than no scorer.
 *
 * Layered, cheapest and most certain first:
 *   1. deterministic  — format, dimensions, file size (pure functions, free)
 *   2. lexicon        — banned phrases over vision-extracted text (free)
 *   3. vision         — brand fit, composition, generic-ad detection
 *   4. aggregation    — weighted score, plus hard gates that cannot be averaged away
 */

export const DIMENSIONS = [
  "brand_fit",
  "compliance",
  "clarity",
  "craft",
  "stopping_power",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** Compliance carries the most weight, and also owns the hard gates. */
export const WEIGHTS: Record<Dimension, number> = {
  brand_fit: 0.25,
  compliance: 0.3,
  clarity: 0.2,
  craft: 0.15,
  stopping_power: 0.1,
};

export const FindingSchema = z.object({
  severity: z.enum(["blocking", "major", "minor"]),
  dimension: z.enum(DIMENSIONS),
  observation: z.string(),
  action: z.string(),
  /** false when no product URL was supplied and the claim cannot be checked. */
  verified: z.boolean(),
});

export const VisionScoreSchema = z.object({
  extractedText: z.array(z.string()),
  dimensionScores: z.object({
    brand_fit: z.number().min(0).max(100),
    compliance: z.number().min(0).max(100),
    clarity: z.number().min(0).max(100),
    craft: z.number().min(0).max(100),
    stopping_power: z.number().min(0).max(100),
  }),
  readsAsGenericSkincareAd: z.boolean(),
  genericMarkers: z.array(z.string()),
  competingBrandVisible: z.boolean(),
  findings: z.array(FindingSchema),
  doMore: z.array(z.string()).max(5),
  doLess: z.array(z.string()).max(5),
  summary: z.string(),
});

export type VisionScore = z.infer<typeof VisionScoreSchema>;
export type ScoreFinding = z.infer<typeof FindingSchema>;

export interface ScoreResult {
  overall: number;
  verdict: "pass" | "fix_required" | "blocked";
  dimensionScores: Record<Dimension, number>;
  findings: ScoreFinding[];
  doMore: string[];
  doLess: string[];
  summary: string;
  extractedText: string[];
  deterministic: { failures: string[]; warnings: string[] };
  productVerified: boolean;
  usage: TextResult<VisionScore>["usage"];
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    extractedText: { type: "array", items: { type: "string" } },
    dimensionScores: {
      type: "object",
      properties: Object.fromEntries(
        DIMENSIONS.map((d) => [d, { type: "number" }]),
      ),
      required: [...DIMENSIONS],
    },
    readsAsGenericSkincareAd: { type: "boolean" },
    genericMarkers: { type: "array", items: { type: "string" } },
    competingBrandVisible: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          dimension: { type: "string", enum: [...DIMENSIONS] },
          observation: { type: "string" },
          action: { type: "string" },
          verified: { type: "boolean" },
        },
        required: ["severity", "dimension", "observation", "action", "verified"],
      },
    },
    doMore: { type: "array", items: { type: "string" } },
    doLess: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: [
    "extractedText",
    "dimensionScores",
    "readsAsGenericSkincareAd",
    "genericMarkers",
    "competingBrandVisible",
    "findings",
    "doMore",
    "doLess",
    "summary",
  ],
} as const;

export function buildScorerSystemPrompt(): string {
  return [
    "# Role",
    "",
    "You are a Senior Ad Creative Specialist and compliance reviewer for",
    `${BRAND_VOICE.brand}, an Indian skincare and haircare brand. You review`,
    "creatives before they run. You are direct, specific and unsentimental. A",
    "vague note helps nobody; every finding you raise must name what you saw and",
    "what to do about it.",
    "",
    "## Brand positioning",
    BRAND_VOICE.positioning,
    "",
    "## Voice — what on-brand sounds like",
    ...BRAND_VOICE.register.map((r) => `- ${r}`),
    "",
    "The brand never does these:",
    ...BRAND_VOICE.avoids.map((a) => `- ${a}`),
    "",
    "## Visual identity — what on-brand looks like",
    "",
    "Palette:",
    ...BRAND_VISUAL.palette.map((c) => `- ${c.name} ${c.hex} — ${c.use}`),
    "",
    "Typography:",
    ...BRAND_VISUAL.typography.map((t) => `- ${t}`),
    "",
    "Photography and composition:",
    ...[...BRAND_VISUAL.photography, ...BRAND_VISUAL.composition].map(
      (p) => `- ${p}`,
    ),
    "",
    "## The generic-skincare-ad test",
    "",
    "The single most useful judgement you make. If this creative could carry any",
    "other brand's logo and look unchanged, it has failed, regardless of how",
    "polished it is. Markers of the generic register:",
    ...BRAND_VISUAL.neverDepict.map((n) => `- ${n}`),
    "",
    "Set `readsAsGenericSkincareAd` true if the creative would be at home in any",
    "drugstore brand's feed, and list what gave it away in `genericMarkers`.",
    "",
    "## Compliance — India",
    "",
    "This brand advertises in India. Under the ASCI code every objectively",
    "ascertainable claim must be capable of substantiation on demand, and under",
    "the Drugs and Cosmetics Rules 1945 a cosmetic that claims to cure or treat a",
    "disease is regulated as a drug. The brand is majority-owned by Hindustan",
    "Unilever, so claims governance is corporate rather than startup.",
    "",
    "Treat these as blocking:",
    ...POLICY_RULES.filter((r) => r.severity === "blocking").map(
      (r) => `- ${r.id}: ${r.rationale}`,
    ),
    "",
    "Treat these as major:",
    ...POLICY_RULES.filter((r) => r.severity === "major").map(
      (r) => `- ${r.id}: ${r.rationale}`,
    ),
    "",
    "## Output",
    "",
    "First transcribe every piece of visible text in the image into",
    "`extractedText`, character for character, including small print. Score each",
    "dimension 0–100 against the anchors below. Then write findings.",
    "",
    "Score anchors — apply them strictly, do not cluster around 70:",
    "- 90–100: shippable as-is; nothing you would change",
    "- 70–89:  shippable after minor edits",
    "- 50–69:  a real weakness that will cost performance",
    "- 25–49:  needs a rework",
    "- 0–24:   unusable, or non-compliant",
    "",
    "`doMore` and `doLess` are the headline actions, ordered most important",
    "first. Each must be concrete and specific to THIS creative — 'increase the",
    "headline size so the concentration is the first thing read' rather than",
    "'improve hierarchy'.",
    "",
    "Set `verified: false` on any finding you cannot check against source data.",
  ].join("\n");
}

export function buildScorerUserPrompt(
  placement: PlacementSpec,
  snapshot: ProductSnapshot | null,
  pageMarkdown?: string | null,
): string {
  const lines = [
    `## Creative under review`,
    `Intended placement: ${placement.label}, ${placement.width}×${placement.height} (${placement.platform})`,
    "",
  ];

  if (snapshot) {
    lines.push(
      "## Source of truth — the product page",
      "",
      "Every product claim in the creative must match this. A concentration,",
      "price or ingredient in the image that is absent here is an invented claim:",
      "raise it as BLOCKING with `verified: true`.",
      "",
      `Title: ${snapshot.title}`,
      `Category: ${snapshot.productType ?? "unspecified"}`,
      `Stated concentrations: ${
        snapshot.concentrations.map((c) => `${c}%`).join(", ") || "none"
      }`,
      `Price: ${snapshot.priceMinor !== null ? `₹${Math.round(snapshot.priceMinor / 100)}` : "unknown"}`,
      snapshot.compareAtPriceMinor !== null
        ? `Compare-at price: ₹${Math.round(snapshot.compareAtPriceMinor / 100)}`
        : "",
      snapshot.discountPct !== null ? `Discount: ${snapshot.discountPct}%` : "",
      snapshot.descriptionText
        ? `\nProduct description:\n${snapshot.descriptionText.slice(0, 1200)}`
        : "",
      // The full page widens what can be checked: a benefit stated in the
      // creative might be supported by an ingredient section the JSON omits.
      pageMarkdown
        ? `\nFull product page as rendered:\n${pageMarkdown}`
        : "",
    );
  } else {
    lines.push(
      "## No product page supplied",
      "",
      "You cannot verify anything product-specific: whether the packaging shown",
      "is genuine, whether stated concentrations are real, whether the price is",
      "correct, or whether ingredient claims are supported.",
      "",
      "For every such observation, set `verified: false` and begin the",
      "observation with 'Unverified —'. Do NOT assume a claim is correct because",
      "it looks plausible, and do NOT assume it is wrong. Say what would need",
      "checking and note that supplying the product URL would resolve it.",
      "",
      "Compliance, brand fit, craft, clarity and the generic-ad test can all",
      "still be judged from the image alone. Score those normally.",
    );
  }

  return lines.filter(Boolean).join("\n");
}

/**
 * Weighted score. Hard gates are applied to the VERDICT, never to the number,
 * so a policy violation cannot be averaged away by a beautiful picture.
 */
export function aggregate(
  vision: VisionScore,
  deterministicFailures: string[],
): { overall: number; verdict: ScoreResult["verdict"] } {
  const overall = Math.round(
    DIMENSIONS.reduce(
      (sum, d) => sum + vision.dimensionScores[d] * WEIGHTS[d],
      0,
    ),
  );

  const blocking =
    vision.findings.some((f) => f.severity === "blocking") ||
    vision.competingBrandVisible ||
    deterministicFailures.length > 0;

  if (blocking) return { overall, verdict: "blocked" };

  const major =
    vision.findings.some((f) => f.severity === "major") ||
    vision.readsAsGenericSkincareAd ||
    overall < 70;

  return { overall, verdict: major ? "fix_required" : "pass" };
}

export interface ScoreInput {
  image: { bytes: Uint8Array; mimeType: string };
  placement: PlacementSpec;
  snapshot: ProductSnapshot | null;
  pageMarkdown?: string | null;
}

export async function scoreCreative(
  client: GeminiTextClient,
  input: ScoreInput,
): Promise<ScoreResult> {
  const placementCheck = checkPlacement(input.image.bytes, input.placement);

  const vision = await client.generateJson<VisionScore>(
    {
      system: buildScorerSystemPrompt(),
      prompt: buildScorerUserPrompt(
        input.placement,
        input.snapshot,
        input.pageMarkdown,
      ),
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      images: [input.image],
    },
    (value) => VisionScoreSchema.parse(value),
  );

  const findings: ScoreFinding[] = [...vision.value.findings];

  // Deterministic failures are appended as blocking findings so the caller sees
  // one ordered list rather than two parallel ones.
  for (const failure of placementCheck.failures) {
    findings.push({
      severity: "blocking",
      dimension: "craft",
      observation: failure,
      action: `Re-export at ${input.placement.width}×${input.placement.height} or larger, as PNG or JPG.`,
      verified: true,
    });
  }
  for (const warning of placementCheck.warnings) {
    findings.push({
      severity: "minor",
      dimension: "craft",
      observation: warning,
      action: "Re-export at the exact placement ratio.",
      verified: true,
    });
  }

  if (vision.value.competingBrandVisible) {
    findings.push({
      severity: "blocking",
      dimension: "compliance",
      observation: "Another brand's packaging, logo or wordmark is visible.",
      action: "Remove it. This cannot run.",
      verified: true,
    });
  }

  const { overall, verdict } = aggregate(vision.value, placementCheck.failures);
  const order = { blocking: 0, major: 1, minor: 2 } as const;

  return {
    overall,
    verdict,
    dimensionScores: vision.value.dimensionScores,
    findings: findings.sort((a, b) => order[a.severity] - order[b.severity]),
    doMore: vision.value.doMore,
    doLess: vision.value.doLess,
    summary: vision.value.summary,
    extractedText: vision.value.extractedText,
    deterministic: {
      failures: placementCheck.failures,
      warnings: placementCheck.warnings,
    },
    productVerified: input.snapshot !== null,
    usage: vision.usage,
  };
}
