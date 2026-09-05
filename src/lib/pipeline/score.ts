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
 *   3. vision         — brand identity, brand fit, composition, generic-ad detection
 *   4. aggregation    — weighted score, plus hard gates that cannot be averaged away
 *
 * One of those gates zeroes the number rather than only the verdict: a creative
 * that belongs to a different company is not a weak ad for this brand, it is not
 * an ad for this brand at all. See `aggregate`.
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

/**
 * Whose creative is this?
 *
 * Answered before anything is scored, because it decides whether the rest of the
 * review means anything. `confidence` is nominally 0–1; see
 * `normalisedConfidence` for why it is not constrained here.
 */
export const BrandIdentitySchema = z.object({
  isThisBrand: z.boolean(),
  /** Named only when a wordmark is legible — a guess here is worse than null. */
  detectedBrand: z.string().nullable(),
  confidence: z.number(),
  evidence: z.string(),
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
  /**
   * Optional in the parse but required on the wire (see SCORER_RESPONSE_SCHEMA). A
   * model that omits the field has told us nothing, and "nothing" must fall
   * through to a normal review rather than either crashing the whole score or
   * being read as an accusation that the upload is someone else's.
   */
  brandIdentity: BrandIdentitySchema.optional(),
  /**
   * A DIFFERENT failure from `brandIdentity.isThisBrand: false` — this is our
   * creative with someone else's pack or logo somewhere in the frame.
   */
  competingBrandVisible: z.boolean(),
  findings: z.array(FindingSchema),
  doMore: z.array(z.string()).max(5),
  doLess: z.array(z.string()).max(5),
  summary: z.string(),
});

export type VisionScore = z.infer<typeof VisionScoreSchema>;
export type BrandIdentity = z.infer<typeof BrandIdentitySchema>;
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

/*
 * Field order is load-bearing, not cosmetic.
 *
 * The model writes this object one field at a time, and each field it has
 * already written conditions the next. The system prompt tells it to decide
 * whose creative this is FIRST, because every judgement below depends on the
 * answer — but brandIdentity used to sit fifth in the schema, after the
 * dimension scores. The model was therefore scoring brand fit, clarity and
 * craft against Minimalist's identity BEFORE it had decided the ad was The
 * Ordinary's, and then had to contradict its own numbers.
 *
 * brandIdentity is first here, and `propertyOrdering` states the sequence
 * explicitly because JSON object key order is not something to leave to
 * chance across model versions.
 */
export const SCORER_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    brandIdentity: {
      type: "object",
      properties: {
        isThisBrand: { type: "boolean" },
        detectedBrand: { type: "string", nullable: true },
        confidence: {
          type: "number",
          // Stated in the schema as well as the prompt. A model that answers on
          // a 0–100 scale here trips the wrong-brand gate at a hundredth of the
          // confidence it meant; normalisedConfidence() is the net, but the net
          // should not be the only thing holding the scale.
          minimum: 0,
          maximum: 1,
        },
        evidence: { type: "string" },
      },
      required: ["isThisBrand", "detectedBrand", "confidence", "evidence"],
      propertyOrdering: ["isThisBrand", "detectedBrand", "confidence", "evidence"],
    },
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
    "brandIdentity",
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
  propertyOrdering: [
    "brandIdentity",
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
    `## What ${BRAND_VOICE.brand} packaging looks like`,
    "",
    "You cannot tell whose creative you are looking at without knowing the pack:",
    "- White or amber-glass dropper bottles, and plain white tubes. Nothing",
    "  colour-blocked, nothing metallic, no ornament on the pack itself",
    `- A lowercase \`${BRAND_VOICE.brand.toLowerCase()}\` wordmark, set small and quiet — never a`,
    "  monogram, never a serif logotype, never inside a badge or roundel",
    "- A thin coloured rule directly under the product name, colour-coded to the",
    "  range the product belongs to",
    "- The active and its concentration printed on the front, at the largest size",
    "  on the label: '10% Niacinamide', '2% Salicylic Acid', '15.6% hair actives'",
    "- A clinical spec-sheet block on the label — actives and their percentages,",
    "  pH, net volume — set like a datasheet rather than like beauty copy",
    "",
    "## Whose creative is this?",
    "",
    "Decide this FIRST, before you score anything. Packaging, wordmark,",
    "typography and palette together tell you whether the creative is",
    `${BRAND_VOICE.brand}'s. If it is plainly another company's ad — their pack,`,
    "their logotype, their type and colour — say so plainly: set",
    "`brandIdentity.isThisBrand` false, name the company in `detectedBrand` when",
    "its wordmark or pack is legible, and quote what you saw in `evidence`.",
    "`confidence` is 0–1 and refers to that judgement, not to the ad's quality.",
    "",
    "Set `isThisBrand` false only on positive evidence of another brand. A",
    "creative with no pack, no wordmark and nothing else to go on is not another",
    "brand's — it is unattributed. Leave `isThisBrand` true there, set",
    "`confidence` at or below 0.3, and say in `evidence` that there was no signal.",
    "`detectedBrand` is null unless you can actually read the name.",
    "",
    "Three judgements that look alike and are not:",
    "- WRONG BRAND — the whole creative belongs to another company. It scores 0",
    "  outright. There is no partial credit for reviewing someone else's ad.",
    `- CONTAMINATION — a ${BRAND_VOICE.brand} creative with a competitor's pack,`,
    "  logo or wordmark somewhere in the frame. That is `competingBrandVisible`:",
    "  it blocks the creative but keeps its score, because it is one fixable",
    "  defect in an otherwise real creative.",
    `- GENERIC — ours, but so interchangeable it could carry anyone's logo. That`,
    "  is `readsAsGenericSkincareAd`, below: a weakness, not a block.",
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
 * Below this the model is guessing, and a guess must not zero a real creative.
 * Wrong on the cautious side costs a reviewer one confusing finding; wrong on
 * the eager side tells a marketer their own ad is a competitor's.
 */
export const WRONG_BRAND_CONFIDENCE = 0.6;

/**
 * Confidence is asked for on a 0–1 scale, in both the prompt and the response
 * schema, but models answer in percent often enough to matter. Normalising
 * means an "85" slip still reads as high confidence instead of nonsense;
 * rejecting the value outright would throw away an entire paid review over one
 * field.
 *
 * The value exactly 1 is genuinely ambiguous — "certain" on the requested scale,
 * or "1% sure" on a percent scale — and it is read here as CERTAIN. That is a
 * decision, not an oversight. `confidence` is only ever consulted alongside an
 * affirmative `isThisBrand: false`, and a model that names a competitor, writes
 * evidence for it, and then rates itself 1% sure is incoherent; a model asked
 * for 0–1 that answers 1 when it means certain is routine. Everything in (1,100]
 * divides, so a genuinely uncertain 2–59 still falls below the gate.
 */
function normalisedConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw > 1 ? raw / 100 : raw));
}

/**
 * True when the upload is another company's ad rather than ours.
 *
 * Deliberately narrow: it fires only on an affirmative `isThisBrand: false`
 * held with real confidence. A missing assessment, an unattributed creative or
 * a low-confidence hunch all fall through to a normal review.
 */
export function isWrongBrandUpload(vision: VisionScore): boolean {
  const identity = vision.brandIdentity;
  if (!identity || identity.isThisBrand) return false;
  return normalisedConfidence(identity.confidence) >= WRONG_BRAND_CONFIDENCE;
}

/**
 * Weighted score. Hard gates are applied to the VERDICT, never to the number,
 * so a policy violation cannot be averaged away by a beautiful picture.
 *
 * The wrong-brand gate is the one exception, and it zeroes the number too. A
 * competitor's ad has no partial credit to award: its craft and clarity are
 * real but they are not this brand's, so averaging them into 62 would read as
 * "nearly there" about a creative that can never run. Note the contrast with
 * `competingBrandVisible` below, which blocks but keeps its score — that is our
 * creative with a fixable defect, not somebody else's creative.
 */
export function aggregate(
  vision: VisionScore,
  deterministicFailures: string[],
): { overall: number; verdict: ScoreResult["verdict"] } {
  if (isWrongBrandUpload(vision)) return { overall: 0, verdict: "blocked" };

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

/** A named brand reads very differently from "some other brand" — only use one we can read. */
function namedBrand(identity: BrandIdentity): string | null {
  const name = identity.detectedBrand?.trim();
  return name ? name : null;
}

/**
 * The finding that explains a 0. It leads the report, so it says what the
 * creative is, why that is not fixable, and what to upload instead — a reviewer
 * who reads only the first finding should already know what to do next.
 */
function wrongBrandFinding(identity: BrandIdentity): ScoreFinding {
  const other = namedBrand(identity);
  return {
    severity: "blocking",
    dimension: "brand_fit",
    observation: [
      other
        ? `This is not a ${BRAND_VOICE.brand} creative — it is an ad for ${other}.`
        : // Deliberately does NOT enumerate "the packaging, wordmark and type",
          // as it once did. When detectedBrand is null the model could not read
          // a name, and asserting which specific elements are another brand's is
          // a fact we do not have. The evidence line that follows says what it
          // actually saw; the finding should not add to it.
          `This is not a ${BRAND_VOICE.brand} creative — the brand cues in it are somebody else's.`,
      identity.evidence.trim(),
    ]
      .filter(Boolean)
      .join(" "),
    action:
      `Upload the ${BRAND_VOICE.brand} creative you meant to review. Nothing here ` +
      `can be fixed into an on-brand ad: this reviewer checks ${BRAND_VOICE.brand} ` +
      `advertising against ${BRAND_VOICE.brand}'s identity and India's ad rules, and ` +
      `has no useful verdict to give on another company's creative.`,
    verified: true,
  };
}

function wrongBrandSummary(identity: BrandIdentity): string {
  const other = namedBrand(identity);
  return [
    other
      ? `0/100 — this creative is not ${BRAND_VOICE.brand}'s. It is ${other}'s.`
      : `0/100 — this creative is not ${BRAND_VOICE.brand}'s.`,
    identity.evidence.trim(),
    `Nothing else in this report applies until a ${BRAND_VOICE.brand} creative is uploaded.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function zeroedDimensions(): Record<Dimension, number> {
  return Object.fromEntries(DIMENSIONS.map((d) => [d, 0])) as Record<
    Dimension,
    number
  >;
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
      responseSchema: SCORER_RESPONSE_SCHEMA,
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

  // Contamination, not a wrong upload: OUR creative with someone else's mark in
  // the frame. It blocks but keeps its number, because removing the mark leaves
  // a creative that still deserves the 84 it earned. Contrast the gate below.
  if (vision.value.competingBrandVisible) {
    findings.push({
      severity: "blocking",
      dimension: "compliance",
      observation: "Another brand's packaging, logo or wordmark is visible.",
      action: "Remove it. This cannot run.",
      verified: true,
    });
  }

  const identity = vision.value.brandIdentity;
  const wrongBrand =
    identity && isWrongBrandUpload(vision.value) ? identity : null;

  if (wrongBrand) {
    // Unshifted, not pushed: sort() is stable, so this stays the first thing
    // read. Every other finding is advice about a creative that will never run.
    findings.unshift(wrongBrandFinding(wrongBrand));
  }

  const { overall, verdict } = aggregate(vision.value, placementCheck.failures);
  const order = { blocking: 0, major: 1, minor: 2 } as const;

  return {
    overall,
    verdict,
    // The bars are zeroed with the overall for the same reason it is: a 0/100
    // headline beside an 85 brand-fit bar reads as a bug, and those marks were
    // a judgement of someone else's creative in the first place.
    dimensionScores: wrongBrand
      ? zeroedDimensions()
      : vision.value.dimensionScores,
    findings: findings.sort((a, b) => order[a.severity] - order[b.severity]),
    // Replaced, not passed through. These render as "Do more of / Do less of"
    // next to a 0, and the model wrote them about a creative that is not this
    // brand's — "lean further into the amber-glass packaging" is advice to a
    // competitor's art director. There is exactly one action available here.
    doMore: wrongBrand
      ? [`Upload the ${BRAND_VOICE.brand} creative you meant to review.`]
      : vision.value.doMore,
    doLess: wrongBrand ? [] : vision.value.doLess,
    // The summary is the one line most people read. It must not say "on-brand
    // and compliant" about a competitor's ad.
    summary: wrongBrand
      ? wrongBrandSummary(wrongBrand)
      : vision.value.summary,
    extractedText: vision.value.extractedText,
    deterministic: {
      failures: placementCheck.failures,
      warnings: placementCheck.warnings,
    },
    productVerified: input.snapshot !== null,
    usage: vision.usage,
  };
}
