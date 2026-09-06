import { z } from "zod";
import { CTA_OPTIONS } from "../../../config/brand.ts";

/**
 * The creative brief — `AdSpec` v0.
 *
 * This is the object the whole system exists to produce (docs/ARCHITECTURE.md
 * §6). The model authors it; nothing downstream invents content. Two properties
 * matter more than the rest:
 *
 *   - `claims` is COPIED from the product snapshot, never generated. The model
 *     is told the concentration and the price; it does not get to compute or
 *     restate them. That is what makes a misrendered "15.6%" detectable rather
 *     than plausible.
 *   - `imagePrompt.textToRender` is the exact set of strings the image model is
 *     asked to draw, so the policy gate and the verifier both have something
 *     concrete to check against.
 */


/**
 * Punctuation the product does not use, stripped from every model-authored
 * string before anything downstream sees it.
 *
 * This is a house style rule with teeth. Instructing the model not to write an
 * em dash works most of the time, and "most of the time" is not a standard: the
 * failure lands in a headline burned into a 2K PNG, where it cannot be edited
 * without paying to generate the image again. A transform costs nothing and
 * cannot be argued with, so it runs rather than the prompt being trusted.
 *
 * It rewrites rather than rejects. Blocking a concept over punctuation would
 * burn a paid brief to fix a comma, and the meaning of every one of these is
 * preserved by the substitution:
 *
 *   "15.6% actives — stated plainly"  ->  "15.6% actives, stated plainly"
 *   "Six actives—one serum"           ->  "Six actives, one serum"
 *   "Results…"                        ->  "Results"
 *
 * An em dash between two spaces becomes a comma; one with no spaces around it
 * is joining words and becomes a comma too. An ellipsis is simply dropped: it
 * is a trailing-off gesture that has no place in a 40-character headline.
 */
export function houseStyle(value: string): string {
  return value
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s*\u2026\s*/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A string the model wrote, cleaned before it can be rendered or drawn. */
const modelText = z.string().transform(houseStyle);

export const ConceptSchema = z.object({
  // Every one of these is rendered: `name` titles the ad card, captions the
  // lightbox and names the downloaded file; `angle` and `rationale` are shown
  // under it. All three are the model's prose, so all three are cleaned.
  name: modelText.pipe(z.string().min(1).max(60)),
  angle: modelText.pipe(z.string().min(1).max(200)),
  rationale: modelText.pipe(z.string().min(1).max(400)),
});

export const CopySchema = z.object({
  headline: modelText.pipe(z.string().min(1)),
  subhead: modelText.pipe(z.string().min(1)),
  primaryText: modelText.pipe(z.string().min(1)),
  // Not cleaned: it is an enum of strings this repository wrote.
  cta: z.enum(CTA_OPTIONS),
});

export const ImagePromptSchema = z.object({
  /**
   * Which of the brand's layouts this concept is built in, BY NAME.
   *
   * A name rather than prose, because the construction rules that separate this
   * brand's banner from a generic one — 1px leader lines, sharp-cornered
   * callout boxes, the specification set inside the headline — are too long and
   * too easily paraphrased away to leave to the model. It picks; renderImagePrompt
   * expands the entry from CREATIVE_GRAMMAR verbatim.
   *
   * Not a z.enum: the catalogue lives in config/brand.ts and a rename there must
   * not become a validation failure here. An unrecognised name degrades to the
   * model's own `composition` line, which is what the prompt did before.
   */
  layoutArchetype: z.string().min(1).max(60),
  scene: z.string().min(1),
  composition: z.string().min(1),
  lighting: z.string().min(1),
  palette: z.string().min(1),
  productPlacement: z.string().min(1),
  /**
   * Exactly what the image model should render as visible text.
   *
   * Cleaned before it is sent, not after: an em dash here is drawn into the
   * PNG, and there is no editing it out afterwards.
   */
  textToRender: z.array(modelText).max(6),
  typography: z.string().min(1),
  /**
   * Concept-specific exclusions only. The brand-wide bans in
   * BRAND_VISUAL.neverDepict are merged in by renderImagePrompt, so the model
   * is not asked to restate them — it used to be, and since the cap was set to
   * the exact length of that list, a single concept-specific avoid made every
   * generation fail schema validation. The cap is now well clear of it; do not
   * tie it back to BRAND_VISUAL.neverDepict.length.
   */
  avoid: z.array(z.string()).max(24),
});

export const ConceptBriefSchema = z.object({
  concept: ConceptSchema,
  copy: CopySchema,
  imagePrompt: ImagePromptSchema,
});

export const BriefResponseSchema = z.object({
  concepts: z.array(ConceptBriefSchema).min(1).max(5),
});

export type Concept = z.infer<typeof ConceptSchema>;
export type Copy = z.infer<typeof CopySchema>;
export type ImagePrompt = z.infer<typeof ImagePromptSchema>;
export type ConceptBrief = z.infer<typeof ConceptBriefSchema>;
export type BriefResponse = z.infer<typeof BriefResponseSchema>;

/** Facts lifted verbatim from the snapshot. The model never authors these. */
export interface Claims {
  concentrations: string[];
  priceDisplay: string | null;
  compareAtDisplay: string | null;
  discountPct: number | null;
}

/**
 * The placement catalogue lives in config/placements.ts — Meta and Google,
 * with the copy limits each platform enforces. Re-exported here so the pipeline
 * has one import for its types.
 */
export {
  PLACEMENTS_BY_ID,
  placementsSorted,
  limitsFor,
  COPY_LIMITS as PLATFORM_COPY_LIMITS,
  type PlacementSpec,
  type Platform,
} from "../../../config/placements.ts";

import { PLACEMENTS_BY_ID } from "../../../config/placements.ts";

/** Back-compat alias for callers that indexed the old map directly. */
export const PLACEMENTS = PLACEMENTS_BY_ID;

/** Composes the money and concentration facts the model is allowed to state. */
export function claimsFrom(snapshot: {
  concentrations: number[];
  priceMinor: number | null;
  compareAtPriceMinor: number | null;
  discountPct: number | null;
  currency: string;
}): Claims {
  const symbol = snapshot.currency === "INR" ? "₹" : `${snapshot.currency} `;
  const fmt = (minor: number | null) =>
    minor === null ? null : `${symbol}${Math.round(minor / 100)}`;

  return {
    concentrations: snapshot.concentrations.map((c) => `${c}%`),
    priceDisplay: fmt(snapshot.priceMinor),
    compareAtDisplay: fmt(snapshot.compareAtPriceMinor),
    discountPct: snapshot.discountPct,
  };
}
