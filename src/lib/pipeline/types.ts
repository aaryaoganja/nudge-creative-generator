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

export const ConceptSchema = z.object({
  name: z.string().min(1).max(60),
  angle: z.string().min(1).max(200),
  rationale: z.string().min(1).max(400),
});

export const CopySchema = z.object({
  headline: z.string().min(1),
  subhead: z.string().min(1),
  primaryText: z.string().min(1),
  cta: z.enum(CTA_OPTIONS),
});

export const ImagePromptSchema = z.object({
  scene: z.string().min(1),
  composition: z.string().min(1),
  lighting: z.string().min(1),
  palette: z.string().min(1),
  productPlacement: z.string().min(1),
  /** Exactly what the image model should render as visible text. */
  textToRender: z.array(z.string()).max(6),
  typography: z.string().min(1),
  /**
   * Concept-specific exclusions only. The brand-wide bans in
   * BRAND_VISUAL.neverDepict are merged in by renderImagePrompt, so the model
   * is not asked to restate them — it used to be, and since that list has
   * exactly 10 entries and this cap was 10, a single concept-specific avoid
   * made every generation fail schema validation.
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
