import {
  ARCHETYPE_NAMES,
  BRAND_MARK_GUIDANCE,
  BRAND_VISUAL,
  BRAND_VOICE,
  COPY_LIMITS,
  CREATIVE_GRAMMAR,
  CTA_OPTIONS,
  HOOK_PATTERNS,
  OBJECTIVE_GUIDANCE,
  POLICY_RULES,
  PRICE_DISPLAY_GUIDANCE,
  archetypeByName,
  archetypesFor,
  orientationOf,
  type BrandMark,
  type Objective,
  type PriceDisplay,
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
  /**
   * Full rendered page content from Firecrawl. Optional — its absence costs
   * copy depth, not correctness, since every hard fact still comes from the
   * structured snapshot.
   */
  pageMarkdown?: string | null;
  brandMark?: BrandMark;
  priceDisplay?: PriceDisplay;
  /** Overrides COPY_LIMITS when the placement selection spans platforms. */
  copyLimits?: { headline: number; primaryText: number; description: number };
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
              layoutArchetype: { type: "string", enum: [...ARCHETYPE_NAMES] },
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
              "layoutArchetype",
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
    "# Role",
    "",
    `You are a Senior Ad Creative Specialist — fifteen years across direct-response`,
    `and brand, now leading creative for ${BRAND_VOICE.brand}, an Indian skincare and`,
    "haircare brand. You have shipped thousands of Meta creatives and you know the",
    "difference between an ad that stops a thumb and one that merely looks nice.",
    "",
    "You are also the last line of defence before a claim reaches the public. You",
    "have sat through regulatory reviews. You do not write a number you cannot",
    "point to a source for.",
    "",
    "Two failure modes you actively avoid:",
    "- The generic skincare ad: wet marble, tropical leaves, water splashes, gold",
    "  foil, a dewy model, a starburst badge. Interchangeable with fifty other brands.",
    "- The over-promise: language that would need a clinical trial to defend.",
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
    "",
    "## The source-of-truth lock",
    "",
    "Everything factual in the creative must trace to the product page you are",
    "given. Do not introduce ingredients, benefits, certifications, awards,",
    "user counts, ratings, timeframes ('results in 4 weeks') or country of origin",
    "unless the page states them. If the page does not say it, it does not exist.",
    "",
    "## Visual identity — binding on the image prompt",
    "",
    "Palette (use these and nothing else):",
    ...BRAND_VISUAL.palette.map((c) => `- ${c.name} ${c.hex} — ${c.use}`),
    "",
    "Typography:",
    ...BRAND_VISUAL.typography.map((t) => `- ${t}`),
    "",
    "Photography:",
    ...BRAND_VISUAL.photography.map((p) => `- ${p}`),
    "",
    "Composition:",
    ...BRAND_VISUAL.composition.map((c) => `- ${c}`),
    "",
    "## The creative grammar — how this brand actually assembles a creative",
    "",
    "Everything above says what a creative may be MADE OF. This says how the",
    "brand puts those parts together, and it is the difference between a",
    "tasteful product shot on white and an ad that looks like the ones already",
    "running. The live creatives are closer to a spec sheet than a photograph.",
    "",
    CREATIVE_GRAMMAR.summary,
    "",
    "Ground:",
    ...CREATIVE_GRAMMAR.ground.map((g) => `- ${g}`),
    "",
    "Type hierarchy:",
    ...CREATIVE_GRAMMAR.typeHierarchy.map((t) => `- ${t}`),
    "",
    "Props — the complete vocabulary. Nothing outside this list appears in frame:",
    ...CREATIVE_GRAMMAR.props.map(
      (p) => `- **${p.name}** — ${p.description} Use when: ${p.useWhen}`,
    ),
    "",
    "Graphic devices, with their construction rules:",
    ...CREATIVE_GRAMMAR.devices.flatMap((d) => [
      `- **${d.name}** — ${d.what}`,
      `  Use when: ${d.useWhen}`,
      ...d.rules.map((r) => `    · ${r}`),
    ]),
    "",
    "Call to action — pick the treatment the layout calls for:",
    ...CREATIVE_GRAMMAR.ctaTreatments.map(
      (c) => `- **${c.name}** (${c.useWhen}) — ${c.description}`,
    ),
    "",
    "Restraint — the rules that stop this vocabulary becoming clutter:",
    ...CREATIVE_GRAMMAR.restraint.map((r) => `- ${r}`),
    "",
    "NEVER depict any of the following. Each one is a hallmark of the generic",
    "skincare ad this brand is positioned against:",
    ...BRAND_VISUAL.neverDepict.map((n) => `- ${n}`),
    "",
    "That list is appended to every image prompt automatically. Do NOT repeat it",
    "in the `avoid` field — put only exclusions specific to YOUR concept there,",
    "such as props or a setting that would muddle the particular idea.",
    "",
    "## The hook — the line that decides whether the ad works",
    "",
    "A feed creative competes with everything else on the screen. A headline",
    "that any competitor could also run has already failed, however well set it",
    "is. 'Broad spectrum UV protection' is a category statement; 'SPF 50 PA++++,",
    "printed on the front' is this brand's.",
    "",
    "Test every headline you write: could a rival brand run this exact line?",
    "If yes, rewrite it around something only this product can say — the stated",
    "concentration, the named active, the specific objection it answers.",
    "",
    "Patterns that work for this brand. Pick the one that fits and write it",
    "fresh — these are shapes, not templates to fill in:",
    "",
    ...HOOK_PATTERNS.flatMap((pattern) => [
      `- **${pattern.name}** — ${pattern.shape}`,
      `  e.g. "${pattern.example}"  (${pattern.why})`,
    ]),
    "",
    "Each concept must use a DIFFERENT pattern. Two concepts running the same",
    "shape with different words are one concept, not two.",
    "",
    "## Reading order — design for it explicitly",
    "",
    "A feed creative gets roughly one second. Decide what is read first, second",
    "and third, and make the composition enforce that order:",
    "",
    "1. FIRST — the single strongest element. For this brand that is almost",
    "   always the concentration figure or the product itself, at a size nothing",
    "   else competes with.",
    "2. SECOND — the benefit or concern, in one short line.",
    "3. THIRD — price, offer or call to action, deliberately quiet.",
    "",
    "State that hierarchy in `composition` in those terms. If everything is",
    "large, nothing is read.",
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
    input.pageMarkdown
      ? [
          "## Full product page",
          "",
          "This is the page as a customer sees it. Use it for substance —",
          "ingredients, mechanism, how it is used, what concern it addresses.",
          "It does NOT widen the claim lock: numbers still come only from the",
          "permitted list below, whatever this page appears to say.",
          "",
          input.pageMarkdown,
          "",
        ].join("\n")
      : "",
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
    `headline ≤ ${input.copyLimits?.headline ?? COPY_LIMITS.headline}`,
    `subhead ≤ ${COPY_LIMITS.subhead}`,
    `primaryText ≤ ${input.copyLimits?.primaryText ?? COPY_LIMITS.primaryText}`,
    input.copyLimits && input.copyLimits.headline < COPY_LIMITS.headline
      ? "These are the TIGHTEST limits across the selected placements. Copy that fits the loosest platform is truncated on the strictest, so write to these."
      : "",
    "",
    "## Brand mark",
    BRAND_MARK_GUIDANCE[input.brandMark ?? "on_pack_only"],
    "",
    "## Price",
    PRICE_DISPLAY_GUIDANCE[input.priceDisplay ?? "price_only"],
    "",
    "## Layout — pick one archetype per concept",
    "",
    `This creative is ${placement.width}×${placement.height} (${placement.ratio}), a ${orientationOf(placement.width, placement.height).toUpperCase()} frame.`,
    "Only the layouts below can be built in it. Set `layoutArchetype` to one of",
    "these names EXACTLY — the construction rules are expanded from it and sent",
    "to the image model, so a name outside this list loses them.",
    "",
    ...archetypesFor(placement.width, placement.height).flatMap((a) => [
      `### ${a.name}`,
      `Use when: ${a.useWhen}`,
      a.description,
      orientationOf(placement.width, placement.height) === "tall" && a.stacked
        ? `In THIS frame: ${a.stacked}`
        : "",
      `Reading order: ${a.readingOrder.join(" → ")}`,
      `Devices: ${a.usesDevices.join("; ")}`,
      "",
    ]),
    "Where several concepts are requested, prefer a different archetype for each.",
    "Two concepts in the same layout with different words are one concept.",
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
  const orientation = orientationOf(placement.width, placement.height);

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

  /*
   * The brand's own layout, expanded from the name the brief chose.
   *
   * This is the section that makes the output look like the client's live
   * banners rather than like a competent stock creative. It is placed above the
   * model's own composition line on purpose: where the two disagree, the
   * brand's grammar is the one that has to win.
   *
   * Only the devices this archetype names are expanded. Shipping all six would
   * both cost prompt budget on every image and contradict the restraint rule
   * that caps a creative at two devices besides the CTA.
   */
  const archetype = archetypeByName(p.layoutArchetype);
  if (archetype) {
    lines.push(
      "",
      `Layout — ${archetype.name}. Build the frame exactly this way:`,
      archetype.description,
    );
    if (orientation === "tall" && archetype.stacked) {
      lines.push(archetype.stacked);
    }
    lines.push(`Reading order, largest to smallest: ${archetype.readingOrder.join(" → ")}.`);

    const devices = archetype.usesDevices
      .map((name) => CREATIVE_GRAMMAR.devices.find((d) => d.name === name))
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    if (devices.length > 0) {
      lines.push(
        "",
        "Graphic devices available to this layout — use at most two, built to these rules:",
        ...devices.flatMap((d) => [
          `  ${d.name}: ${d.what}`,
          ...d.rules.map((r) => `    - ${r}`),
        ]),
      );
    }

    lines.push(
      "",
      "Hold these regardless of anything above:",
      ...CREATIVE_GRAMMAR.restraint.map((r) => `  - ${r}`),
    );
  }

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
    "relabel or restyle the packaging. Do not invent label text.",
    "",
    "Palette — use these values and no others:",
    // A null hex is the product accent, which has no fixed value: it is sampled
    // from the pack in the reference photograph. Saying so reads correctly;
    // printing the prose in the hex column, as this used to, does not.
    ...BRAND_VISUAL.palette.map((c) =>
      c.hex
        ? `  ${c.hex}  ${c.name} (${c.use})`
        : `  (no fixed value)  ${c.name} — ${c.use}`,
    ),
    "",
    "Do not render any of the following:",
    ...dedupe([...BRAND_VISUAL.neverDepict, ...p.avoid]).map((a) => `  - ${a}`),
  );

  return lines.join("\n");
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
