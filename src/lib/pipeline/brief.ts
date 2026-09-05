import {
  BRAND_VOICE,
  COPY_LIMITS,
  CTA_OPTIONS,
  OBJECTIVE_GUIDANCE,
  POLICY_RULES,
  type Objective,
} from "../../../config/brand.ts";
import { BriefResponseSchema, type BriefResponse, type Claims, type PlacementSpec } from "./types.ts";
import type { ProductSnapshot } from "../scrape/shopify.ts";
import type { GeminiTextClient, TextResult } from "../providers/gemini-text.ts";

/**
 * Stage 3 — creative brief and copy.
 *
 * The prompt is built from the seeded config rather than hardcoded, so tuning
 * the brand voice or the policy list changes behaviour without touching this
 * file. Once the schema lands, `config/brand.ts` becomes versioned rows and the
 * only change here is where the values are read from.
 *
 * The single most important instruction in this prompt is the claim lock: the
 * model is handed the exact concentration and price strings and told it may not
 * produce any other numeric claim. The deterministic gate in policy/check.ts
 * then verifies it complied, because an instruction is not an enforcement.
 */

export interface BriefInput {
  snapshot: ProductSnapshot;
  claims: Claims;
  placement: PlacementSpec;
  objective: Objective;
  conceptCount: number;
  offer?: string;
  angleHint?: string;
  audience?: string;
}

/** OpenAPI-subset schema for structured output. */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          concept: {
            type: "object",
            properties: {
              name: { type: "string" },
              angle: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["name", "angle", "rationale"],
          },
          copy: {
            type: "object",
            properties: {
              headline: { type: "string" },
              subhead: { type: "string" },
              primaryText: { type: "string" },
              cta: { type: "string", enum: [...CTA_OPTIONS] },
            },
            required: ["headline", "subhead", "primaryText", "cta"],
          },
          imagePrompt: {
            type: "object",
            properties: {
              scene: { type: "string" },
              composition: { type: "string" },
              lighting: { type: "string" },
              palette: { type: "string" },
              productPlacement: { type: "string" },
              textToRender: { type: "array", items: { type: "string" } },
              typography: { type: "string" },
              avoid: { type: "array", items: { type: "string" } },
            },
            required: [
              "scene",
              "composition",
              "lighting",
              "palette",
              "productPlacement",
              "textToRender",
              "typography",
              "avoid",
            ],
          },
        },
        required: ["concept", "copy", "imagePrompt"],
      },
    },
  },
  required: ["concepts"],
} as const;

export function buildSystemPrompt(): string {
  const blocking = POLICY_RULES.filter((r) => r.severity === "blocking");
  const major = POLICY_RULES.filter((r) => r.severity === "major");

  return [
    `You are a senior direct-response art director and copywriter for ${BRAND_VOICE.brand}, an Indian skincare and haircare brand.`,
    "",
    "## Brand positioning",
    BRAND_VOICE.positioning,
    "",
    "## Register",
    ...BRAND_VOICE.register.map((r) => `- ${r}`),
    "",
    "## Always",
    ...BRAND_VOICE.does.map((d) => `- ${d}`),
    "",
    "## Never",
    ...BRAND_VOICE.avoids.map((a) => `- ${a}`),
    "",
    `Prefer this vocabulary: ${BRAND_VOICE.vocabulary.prefer.join(", ")}.`,
    `Never use: ${BRAND_VOICE.vocabulary.avoid.join(", ")}.`,
    "",
    "## Regulatory constraints — non-negotiable",
    "",
    "This brand advertises in India. Every objectively ascertainable claim must",
    "be capable of substantiation on demand under the ASCI code, and a cosmetic",
    "that claims to cure or treat a disease becomes a regulated drug under the",
    "Drugs and Cosmetics Rules 1945. The brand is majority-owned by Hindustan",
    "Unilever, so claims governance is corporate, not startup.",
    "",
    "Copy containing any of the following will be rejected outright:",
    ...blocking.map((r) => `- ${r.id}: ${r.rationale}`),
    "",
    "Copy containing any of the following will be sent back for revision:",
    ...major.map((r) => `- ${r.id}: ${r.rationale}`),
    "",
    "## The claim lock — read twice",
    "",
    "You will be given the product's exact concentration figures, price and",
    "discount. These are the ONLY numeric claims you may make.",
    "",
    "- Do not invent, round, restate or recompute any percentage or price.",
    "- Do not write a percentage that is not in the permitted list.",
    "- Do not write a rupee figure that is not in the permitted list.",
    "- If a concept needs a number you were not given, write the concept",
    "  without that number.",
    "",
    "A concentration is printed on this brand's packaging and is a regulated",
    "claim. Getting it wrong is a compliance incident, not a typo.",
  ].join("\n");
}

export function buildUserPrompt(input: BriefInput): string {
  const { snapshot, claims, placement, objective } = input;

  const permittedPercents = [
    ...claims.concentrations,
    ...(claims.discountPct !== null ? [`${claims.discountPct}%`] : []),
  ];
  const permittedMoney = [claims.priceDisplay, claims.compareAtDisplay].filter(
    Boolean,
  ) as string[];

  return [
    "## Product",
    `Title: ${snapshot.title}`,
    `Category: ${snapshot.productType ?? "unspecified"}`,
    snapshot.descriptionText
      ? `Description: ${snapshot.descriptionText.slice(0, 900)}`
      : "",
    snapshot.tags.length > 0 ? `Tags: ${snapshot.tags.join(", ")}` : "",
    "",
    "## Permitted numeric claims — the complete list",
    `Percentages you may use: ${permittedPercents.join(", ") || "NONE — use no percentage at all"}`,
    `Money you may use: ${permittedMoney.join(", ") || "NONE — do not mention price"}`,
    claims.discountPct !== null
      ? `Discount: ${claims.discountPct}% off`
      : "No discount — do not imply one",
    input.offer ? `Offer to feature verbatim: "${input.offer}"` : "",
    "",
    "## Brief",
    `Objective: ${objective} — ${OBJECTIVE_GUIDANCE[objective]}`,
    `Placement: ${placement.label}, ${placement.width}×${placement.height}px (${placement.platform})`,
    input.audience ? `Audience: ${input.audience}` : "",
    input.angleHint ? `Angle to explore: ${input.angleHint}` : "",
    `Produce ${input.conceptCount} DISTINCT concepts. Distinct means a different strategic angle, not reworded copy.`,
    "",
    "## Copy limits — hard ceilings, count the characters",
    `headline ≤ ${COPY_LIMITS.headline}`,
    `subhead ≤ ${COPY_LIMITS.subhead}`,
    `primaryText ≤ ${COPY_LIMITS.primaryText}`,
    "",
    "## Image prompt",
    "",
    "For each concept also write an image prompt for a generative image model.",
    "A real product photograph is supplied as a reference image — the packaging,",
    "label and bottle shape in your scene must match it exactly. Describe the",
    "scene around the product; never describe the product's own label text as",
    "something to invent.",
    "",
    "`textToRender` is the exact list of strings the image model will draw into",
    "the creative. Keep it short — a headline and at most one supporting line.",
    "Every string in it is subject to the same claim lock as the copy.",
    "",
    "`avoid` should list what must not appear: other brands, logos, human faces",
    "unless the concept needs one, text other than what you specified,",
    "watermarks, and cluttered backgrounds.",
    "",
    "The aesthetic is minimal and clinical: generous negative space, a restrained",
    "palette, one clear focal point. Not a busy lifestyle collage.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateBrief(
  client: GeminiTextClient,
  input: BriefInput,
): Promise<TextResult<BriefResponse>> {
  return client.generateJson<BriefResponse>(
    {
      system: buildSystemPrompt(),
      prompt: buildUserPrompt(input),
      responseSchema: RESPONSE_SCHEMA,
      temperature: 1.0,
    },
    (value) => BriefResponseSchema.parse(value),
  );
}

/**
 * Flattens the structured image prompt into the string sent to the image model.
 *
 * Kept separate from generation so the exact text sent is inspectable, loggable
 * and diffable — when a creative comes out wrong, the first question is always
 * "what did we actually ask for?"
 */
export function renderImagePrompt(
  brief: { imagePrompt: BriefResponse["concepts"][number]["imagePrompt"] },
  placement: PlacementSpec,
): string {
  const p = brief.imagePrompt;
  const lines = [
    `A ${placement.width}×${placement.height} advertising creative for a premium, minimal skincare brand.`,
    "",
    `Scene: ${p.scene}`,
    `Composition: ${p.composition}`,
    `Lighting: ${p.lighting}`,
    `Colour palette: ${p.palette}`,
    `Product placement: ${p.productPlacement}`,
    `Typography: ${p.typography}`,
  ];

  if (p.textToRender.length > 0) {
    lines.push(
      "",
      "Render exactly this text, spelled character for character, with no additions:",
      ...p.textToRender.map((t) => `  "${t}"`),
    );
  } else {
    lines.push("", "Render no text at all.");
  }

  lines.push(
    "",
    "The product in the reference image must be reproduced faithfully: same",
    "bottle, same cap, same label artwork and same label text. Do not redesign,",
    "relabel or restyle the packaging.",
    "",
    `Avoid: ${p.avoid.join(", ")}.`,
  );

  return lines.join("\n");
}
