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
  avoid: z.array(z.string()).max(10),
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

export interface PlacementSpec {
  id: string;
  label: string;
  width: number;
  height: number;
  maxBytes: number | null;
  platform: string;
}

/** v0 is 4:5 only. Every other placement is an INSERT, never a deploy. */
export const PLACEMENTS: Record<string, PlacementSpec> = {
  meta_feed_4x5: {
    id: "meta_feed_4x5",
    label: "Meta Feed 4:5",
    width: 1080,
    height: 1350,
    maxBytes: 30 * 1024 * 1024,
    platform: "meta",
  },
};

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
