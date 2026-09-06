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
import { literalsIn } from "../policy/check.ts";
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
    `You are a Senior Ad Creative Specialist with fifteen years across direct-response`,
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
    "## Regulatory constraints, non-negotiable",
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
    "## The claim lock. Read it twice.",
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
    "## Visual identity, binding on the image prompt",
    "",
    "Palette (use these and nothing else):",
    ...BRAND_VISUAL.palette.map((c) => `- ${c.name} ${c.hex}: ${c.use}`),
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
    "## The creative grammar, how this brand actually assembles a creative",
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
    "Props. This is the complete vocabulary; nothing outside it appears in frame:",
    ...CREATIVE_GRAMMAR.props.map(
      (p) => `- **${p.name}**: ${p.description} Use when: ${p.useWhen}`,
    ),
    "",
    "Graphic devices, with their construction rules:",
    ...CREATIVE_GRAMMAR.devices.flatMap((d) => [
      `- **${d.name}**: ${d.what}`,
      `  Use when: ${d.useWhen}`,
      ...d.rules.map((r) => `    · ${r}`),
    ]),
    "",
    "Call to action. Pick the treatment the layout calls for:",
    ...CREATIVE_GRAMMAR.ctaTreatments.map(
      (c) => `- **${c.name}** (${c.useWhen}): ${c.description}`,
    ),
    "",
    "Restraint. These are the rules that stop the vocabulary becoming clutter:",
    ...CREATIVE_GRAMMAR.restraint.map((r) => `- ${r}`),
    "",
    "NEVER depict any of the following. Each one is a hallmark of the generic",
    "skincare ad this brand is positioned against:",
    ...BRAND_VISUAL.neverDepict.map((n) => `- ${n}`),
    "",
    "That list is appended to every image prompt automatically. Do NOT repeat it",
    "in the `avoid` field. Put only exclusions specific to YOUR concept there,",
    "such as props or a setting that would muddle the particular idea.",
    "",
    "## The hook, the line that decides whether the ad works",
    "",
    "A feed creative competes with everything else on the screen. A headline",
    "that any competitor could also run has already failed, however well set it",
    "is. 'Broad spectrum UV protection' is a category statement; 'SPF 50 PA++++,",
    "printed on the front' is this brand's.",
    "",
    "Test every headline you write: could a rival brand run this exact line?",
    "If yes, rewrite it around something only this product can say: the stated",
    "concentration, the named active, the specific objection it answers.",
    "",
    "Patterns that work for this brand. Pick the one that fits and write it",
    "fresh. These are shapes, not templates to fill in:",
    "",
    ...HOOK_PATTERNS.flatMap((pattern) => [
      `- **${pattern.name}**: ${pattern.shape}`,
      `  e.g. "${pattern.example}"  (${pattern.why})`,
    ]),
    "",
    "Each concept must use a DIFFERENT pattern. Two concepts running the same",
    "shape with different words are one concept, not two.",
    "",
    "## Reading order. Design for it explicitly.",
    "",
    "A feed creative gets roughly one second. Decide what is read first, second",
    "and third, and make the composition enforce that order:",
    "",
    "1. FIRST: the single strongest element. For this brand that is almost",
    "   always the concentration figure or the product itself, at a size nothing",
    "   else competes with.",
    "2. SECOND: the benefit or concern, in one short line.",
    "3. THIRD: price, offer or call to action, deliberately quiet.",
    "",
    "State that hierarchy in `composition` in those terms. If everything is",
    "large, nothing is read.",
  ].join("\n");
}

export function buildUserPrompt(input: BriefInput): string {
  const { snapshot, claims, placement, objective } = input;

  /*
   * The offer's own figures are permitted claims.
   *
   * They come from the person running the campaign, not from the model, and a
   * promotion is a fact about the campaign rather than about the product page.
   * The same literals are added to the deterministic gate in
   * src/lib/policy/check.ts, from the same helper, so the instruction below and
   * the enforcement afterwards cannot disagree: previously the prompt said
   * "feature verbatim" while the gate blocked the result.
   */
  const authorised = literalsIn(input.offer);
  const permittedPercents = [
    ...claims.concentrations,
    ...(claims.discountPct !== null ? [`${claims.discountPct}%`] : []),
    ...authorised.percents,
  ];
  const permittedMoney = [
    ...([claims.priceDisplay, claims.compareAtDisplay].filter(Boolean) as string[]),
    ...authorised.money,
  ];

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
          "This is the page as a customer sees it. Use it for substance:",
          "ingredients, mechanism, how it is used, what concern it addresses.",
          "It does NOT widen the claim lock: numbers still come only from the",
          "permitted list below, whatever this page appears to say.",
          "",
          input.pageMarkdown,
          "",
        ].join("\n")
      : "",
    "## Permitted numeric claims, the complete list",
    `Percentages you may use: ${dedupe(permittedPercents).join(", ") || "NONE. Use no percentage at all."}`,
    `Money you may use: ${dedupe(permittedMoney).join(", ") || "NONE. Do not mention a price."}`,
    claims.discountPct !== null
      ? `Discount: ${claims.discountPct}% off`
      : "No discount. Do not imply one.",
    input.offer
      ? `Offer to feature verbatim: "${input.offer}". Its figures are in the permitted list above; print them exactly as written here.`
      : "",
    "",
    "## Brief",
    `Objective: ${objective}. ${OBJECTIVE_GUIDANCE[objective]}`,
    `Placement: ${placement.label}, ${placement.width}×${placement.height}px (${placement.platform})`,
    input.audience ? `Audience: ${input.audience}` : "",
    `Produce ${input.conceptCount} DISTINCT concepts. Distinct means a different strategic angle, not reworded copy.`,
    "",
    /*
     * The angle is an instruction, not a suggestion, and it needs its own block
     * saying so.
     *
     * It used to be one line reading "Angle to explore: ...", buried in this
     * list between the placement and the concept count, competing against two
     * far more forceful neighbours: the conversion objective ("Lead with the
     * specific outcome and the offer") and an offer marked "feature verbatim,
     * print exactly as written". It lost every time. A run briefed to answer
     * the single biggest objection came back as a large "15% OFF" over a
     * struck-through price, which is a faithful reading of everything on the
     * page EXCEPT the angle.
     *
     * The fix is not to shout louder, it is to say which instruction governs
     * what. The angle decides what the creative ARGUES. The objective decides
     * how hard it asks for the sale. Those are different jobs and they stop
     * fighting once the prompt says so.
     */
    ...(input.angleHint
      ? [
          "## The angle. This governs the concept.",
          "",
          `The angle for this brief is: ${input.angleHint}`,
          "",
          "This is not a suggestion to weigh against the objective. It decides",
          "what each concept ARGUES, and the headline has to carry it: someone",
          "reading only the headline should be able to tell you which angle was",
          "briefed. The objective decides how hard the creative asks for the",
          "sale, and the offer, if there is one, is the THIRD read at most.",
          "",
          "If the angle names an objection, a concern or a comparison, the",
          "creative has to answer it with something specific from the product",
          "page. Do not restate the angle as a slogan; use it, then say the",
          "thing that resolves it. A concept whose headline could have been",
          "written without this angle has not used it.",
          "",
          input.offer
            ? `The offer is still printed verbatim, but it is a supporting line rather than the headline. An offer set as the largest element in the frame means the angle was ignored.`
            : "",
        ].filter(Boolean)
      : []),
    "",
    "## Copy limits. These are hard ceilings; count the characters.",
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
    "## Layout. Pick one archetype per concept.",
    "",
    `This creative is ${placement.width}×${placement.height} (${placement.ratio}), a ${orientationOf(placement.width, placement.height).toUpperCase()} frame.`,
    "Only the layouts below can be built in it. Set `layoutArchetype` to one of",
    "these names EXACTLY. The construction rules are expanded from it and sent",
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
    "A real product photograph is supplied as a reference image. The packaging,",
    "label and bottle shape in your scene must match it exactly. Describe the",
    "scene around the product; never describe the product's own label text as",
    "something to invent.",
    "",
    "`textToRender` is the exact list of strings the image model will draw into",
    "the creative. Keep it short: a headline and at most one supporting line.",
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
 * and diffable. When a creative comes out wrong the first question is always
 * "what did we actually ask for?"
 *
 * `settings` is not optional decoration. The brand-mark and price choices used
 * to reach the copy model and stop there, so the only trace of them in the
 * image was whatever the text model happened to restate in its own
 * `typography` and `composition` strings. Picking "no brand mark" and getting a
 * wordmark anyway is not a near miss, it is the setting not existing. Both now
 * travel to the model that actually draws the pixels.
 */
export interface ImagePromptSettings {
  brandMark?: BrandMark;
  priceDisplay?: PriceDisplay;
  /** The placement's own chrome rule, for the frames that have one. */
  safeZone?: string | null;
  /**
   * What the creative argues. The copy model was told; the image model was not,
   * so the layout could be assembled around an offer while the copy answered an
   * objection, and the two halves of the same creative disagreed.
   */
  angle?: string | null;
}

export function renderImagePrompt(
  brief: { imagePrompt: BriefResponse["concepts"][number]["imagePrompt"] },
  placement: PlacementSpec,
  settings: ImagePromptSettings = {},
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
      `Layout: ${archetype.name}. Build the frame exactly this way:`,
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
        "Graphic devices available to this layout. Use at most two, built to these rules:",
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

  if (settings.angle) {
    lines.push(
      "",
      `This creative argues one thing: ${settings.angle}. The largest element in`,
      "the frame must serve that argument. If an offer or a price appears, it is",
      "a supporting line, not the hero.",
    );
  }

  lines.push(
    "",
    "Brand mark: " + BRAND_MARK_GUIDANCE[settings.brandMark ?? "on_pack_only"],
    "Price: " + PRICE_DISPLAY_GUIDANCE[settings.priceDisplay ?? "price_only"],
  );

  /*
   * The placement's safe zone, sent to the model that can actually act on it.
   * It was shown in the picker and then dropped: a 9:16 story was generated
   * with no idea that platform chrome covers the top 14% and bottom 20%, which
   * is exactly how a headline ends up under the profile row.
   */
  if (settings.safeZone) {
    lines.push(`Safe area: ${settings.safeZone}. Keep all type inside it.`);
  }

  lines.push(
    "",
    "The product in the reference image must be reproduced faithfully: same",
    "bottle, same cap, same label artwork and same label text. Do not redesign,",
    "relabel or restyle the packaging. Do not invent label text.",
    "",
    "Palette. Use these values and no others:",
    // A null hex is the product accent, which has no fixed value: it is sampled
    // from the pack in the reference photograph. Saying so reads correctly;
    // printing the prose in the hex column, as this used to, does not.
    ...BRAND_VISUAL.palette.map((c) =>
      c.hex
        ? `  ${c.hex}  ${c.name} (${c.use})`
        : `  (no fixed value)  ${c.name}: ${c.use}`,
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
