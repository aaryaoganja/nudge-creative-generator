/**
 * Seeded brand and policy configuration.
 *
 * These are the `config` rows from docs/ARCHITECTURE.md §6 in their pre-database
 * form. They live in git so they are reviewable in a diff; once the schema
 * lands they get seeded into versioned rows and the runtime reads the database,
 * not this file. Shape is deliberately already row-like.
 *
 * Everything here is grounded in what the brand actually publishes and in the
 * regulatory regime it operates under — not invented tone-of-voice filler.
 */

export interface BrandVoice {
  brand: string;
  positioning: string;
  register: string[];
  does: string[];
  avoids: string[];
  vocabulary: { prefer: string[]; avoid: string[] };
}

export interface PolicyRule {
  id: string;
  severity: "blocking" | "major" | "minor";
  /** Case-insensitive patterns matched against generated copy. */
  patterns: string[];
  rationale: string;
}

export const BRAND_VOICE: BrandVoice = {
  brand: "Minimalist",
  positioning:
    "Radical ingredient transparency. Active concentrations are printed on the " +
    "front of the pack (10% Niacinamide, 2% Salicylic Acid, 15.6% hair actives). " +
    "Formulations are developed in-house and described by what is in them and at " +
    "what strength, not by the outcome they promise.",
  register: [
    "Education-first: explain the active and why the concentration matters",
    "Clinical and plain — closer to a lab note than a beauty ad",
    "Confident without hyperbole; the number is the proof, not the adjective",
    "Minimal ornamentation in both language and layout",
  ],
  does: [
    "State the active and its exact concentration",
    "Name the specific concern the product addresses",
    "Let the formulation speak; short sentences",
    "Respect the reader's intelligence",
  ],
  avoids: [
    "Fear-based marketing — no shame, anxiety or urgency about appearance",
    "Celebrity endorsement framing",
    "Exaggerated or absolute outcome claims",
    "Miracle/transformation language",
    "Comparative claims against named competitors",
  ],
  vocabulary: {
    prefer: [
      "helps reduce",
      "supports",
      "visibly",
      "formulated with",
      "clinically studied ingredient",
      "concentration",
    ],
    avoid: [
      "miracle",
      "magic",
      "instant",
      "permanent",
      "guaranteed",
      "cure",
      "flawless",
      "perfect skin",
    ],
  },
};

/**
 * Visual identity tokens.
 *
 * These constrain how the product may be DEPICTED, not just what may be said.
 * Without them the image model reverts to generic-skincare-ad defaults: wet
 * marble, tropical leaves, dewy models, gold foil — the exact register this
 * brand is positioned against.
 *
 * Seeded from the brand's published aesthetic. `npm run scrape -- brand`
 * extracts live candidates from the theme stylesheet; those should be reviewed
 * and merged in here rather than trusted automatically.
 */
export interface BrandVisual {
  palette: { name: string; hex: string; use: string }[];
  typography: string[];
  photography: string[];
  composition: string[];
  neverDepict: string[];
}

export const BRAND_VISUAL: BrandVisual = {
  palette: [
    { name: "Bone", hex: "#F4F1EC", use: "Primary background" },
    { name: "Sand", hex: "#E8E1D7", use: "Secondary surface, soft shadow" },
    { name: "Ink", hex: "#1A1A1A", use: "Primary type" },
    { name: "Graphite", hex: "#6B6B6B", use: "Secondary type" },
    { name: "Clinical white", hex: "#FFFFFF", use: "Product surface, packaging" },
  ],
  typography: [
    "Geometric or neo-grotesque sans only — no serifs, no scripts, no display faces",
    "Tight tracking on headlines; generous leading on body",
    "Two weights maximum in one creative",
    "Concentration figures set at the largest type size — the number is the message",
    "Sentence case or lowercase. Never all-caps shouting, never title case",
  ],
  photography: [
    "The real product, photographed — never illustrated, rendered or restyled",
    "Matte, even, diffuse light. One soft directional source",
    "Neutral seamless or plaster-textured surfaces",
    "Long, soft, natural shadow anchoring the product to the surface",
    "Product occupies a clear focal position with real negative space around it",
  ],
  composition: [
    "One idea per creative. One focal point",
    "At least 40% negative space",
    "Asymmetric balance over centred symmetry where it aids hierarchy",
    "Text and product must not overlap",
  ],
  neverDepict: [
    "Wet or glossy marble surfaces",
    "Tropical leaves, monstera, palm fronds, botanical clutter",
    "Water splashes, droplet crowns, liquid swirls",
    "Gold foil, metallic gradients, luxury-cosmetics ornament",
    "Dewy close-up model skin as the hero",
    "Before-and-after panels",
    "Starbursts, badges, sale explosions, arrows",
    "Any other brand's packaging, logo or wordmark",
    "Invented packaging, invented label text, or a redesigned bottle",
    "Stock-photo lifestyle collage",
  ],
};

/**
 * Deterministic policy rules.
 *
 * These run as regex before any image is generated (pipeline stage 4), because
 * catching a banned claim in text costs nothing and catching it after
 * generation costs $0.134 per image.
 *
 * Grounded in: the ASCI code's requirement that every objectively ascertainable
 * claim be capable of substantiation on demand; the Drugs and Cosmetics Rules
 * 1945, under which a cosmetic claiming to cure or treat a disease is regulated
 * as a drug; and the tighter claims governance that follows from Hindustan
 * Unilever holding a majority stake.
 */
export const POLICY_RULES: PolicyRule[] = [
  {
    id: "disease-claim",
    severity: "blocking",
    patterns: [
      "\\bcures?\\b",
      "\\bheals?\\b",
      "\\btreats?\\b",
      "\\btreatment for\\b",
      "\\bremedy for\\b",
      "\\beliminates?\\s+(acne|eczema|psoriasis|dermatitis)",
      "\\bmedical(ly)?\\s+proven\\b",
    ],
    rationale:
      "A cosmetic that claims to cure or treat a disease falls under drug " +
      "regulation per the Drugs and Cosmetics Rules 1945.",
  },
  {
    id: "absolute-claim",
    severity: "blocking",
    patterns: [
      "\\b100\\s*%\\s*(effective|guaranteed|results|safe)",
      "\\bguaranteed?\\b",
      "\\bpermanent(ly)?\\b",
      "\\bcompletely\\s+(removes?|eliminates?|clears?)",
      "\\bno\\s+side\\s+effects\\b",
    ],
    rationale:
      "Absolute claims cannot be substantiated on demand, which the ASCI code " +
      "requires for every objectively ascertainable claim.",
  },
  {
    id: "unsubstantiated-proof",
    severity: "major",
    patterns: [
      "\\bclinically\\s+proven\\b",
      "\\bdermatologist\\s+proven\\b",
      "\\bscientifically\\s+proven\\b",
      "\\bproven\\s+to\\s+(cure|eliminate|remove)",
      "\\b#1\\b",
      "\\bnumber\\s+one\\b",
      "\\bbest\\s+(in|selling)\\b",
    ],
    rationale:
      "Proof and ranking claims require held substantiation. 'Clinically " +
      "studied ingredient' is defensible; 'clinically proven product' is not, " +
      "unless a study on this formulation exists.",
  },
  {
    id: "fear-based",
    severity: "major",
    patterns: [
      "\\bugly\\b",
      "\\bembarrass(ing|ed|ment)\\b",
      "\\bashamed?\\b",
      "\\bhide\\s+your\\b",
      "\\bnobody\\s+will\\b",
      "\\bstop\\s+being\\b",
    ],
    rationale:
      "The brand deliberately avoids the fear and shame framing common in the " +
      "category. Off-voice and reputationally costly.",
  },
  {
    id: "competitor-mention",
    severity: "blocking",
    patterns: [
      "\\bthe\\s+ordinary\\b",
      "\\bcerave\\b",
      "\\bplum\\b",
      "\\bmamaearth\\b",
      "\\bdot\\s*&\\s*key\\b",
      "\\bderma\\s*co\\b",
      "\\bbetter\\s+than\\s+\\w+",
    ],
    rationale:
      "Comparative advertising against named competitors invites an ASCI " +
      "complaint and is outside the brand's stated approach.",
  },
  {
    id: "medical-advice",
    severity: "major",
    patterns: [
      "\\breplaces?\\s+(your\\s+)?(doctor|dermatologist|medication)",
      "\\bno\\s+need\\s+(to\\s+see|for)\\s+a\\s+(doctor|dermatologist)",
    ],
    rationale: "Discouraging medical consultation is a safety issue.",
  },
];

/**
 * Copy length ceilings, so overflow is caught at generation rather than at
 * render. Superseded per-request by config/placements.ts when the selection
 * spans platforms with tighter limits.
 */
export const COPY_LIMITS = {
  headline: 40,
  subhead: 60,
  primaryText: 125,
  cta: 20,
} as const;

/**
 * Hook craft.
 *
 * The scorer flagged the first real creative at 74 for stopping power with
 * "relies on standard category phrasing" — and it was right. "Broad spectrum UV
 * protection" is a line any sunscreen could run. The specification the brand
 * actually prints on the pack is the thing no competitor can copy, and it is
 * what should lead.
 *
 * These are patterns, not templates. The model picks the one that fits the
 * product and writes it fresh.
 */
export const HOOK_PATTERNS = [
  {
    name: "The specification",
    shape: "Lead with the exact number the pack states.",
    example: "SPF 50 PA++++. Printed on the front.",
    why: "The figure is proof and no competitor can borrow it.",
  },
  {
    name: "The objection",
    shape: "Name the reason people avoid this category, then answer it.",
    example: "No white cast. That is the whole brief.",
    why: "Speaks to the reason someone has not bought yet.",
  },
  {
    name: "The substitution",
    shape: "Frame it as replacing something in the current routine.",
    example: "One step. Not three.",
    why: "Concrete, and implies effort saved rather than effort added.",
  },
  {
    name: "The plain fact",
    shape: "State something true and specific that sounds like nobody wrote it.",
    example: "Niacinamide 10%. Zinc 1%. Nothing else worth mentioning.",
    why: "Understatement reads as confidence in this brand's register.",
  },
  {
    name: "The comparison to nothing",
    shape: "Contrast against the absence of the product, not a competitor.",
    example: "Two weeks of sun. Or two weeks of this.",
    why: "Avoids comparative-advertising exposure entirely.",
  },
] as const;

/** How the brand appears in the creative itself. */
export type BrandMark = "on_pack_only" | "wordmark" | "none";

export const BRAND_MARK_GUIDANCE: Record<BrandMark, string> = {
  on_pack_only:
    "The brand appears only where it genuinely is — printed on the packaging. " +
    "The ad account's page name and avatar already carry the brand in the feed, " +
    "so a second lockup is redundant and adds clutter this brand avoids.",
  wordmark:
    "Place the Minimalist wordmark small and quiet in one corner, in Ink on the " +
    "background colour. Never larger than the body copy, never centred, never " +
    "given a container or badge.",
  none:
    "No brand mark at all, and do not rely on the packaging being legible. Use " +
    "only for tests where brand attribution is deliberately withheld.",
};

/** How price is presented, when it is shown at all. */
export type PriceDisplay = "none" | "price_only" | "was_now";

export const PRICE_DISPLAY_GUIDANCE: Record<PriceDisplay, string> = {
  none: "Do not mention price. Let the product and the claim carry the ad.",
  price_only:
    "State the current price once, quietly, as the last thing read. No " +
    "strikethrough, no 'was', no percentage.",
  was_now:
    "Show the original price struck through, then the current price larger " +
    "beside it, and the discount percentage. Both figures and the percentage " +
    "must match the product data exactly.",
};

export const CTA_OPTIONS = [
  "Shop Now",
  "Learn More",
  "Buy Now",
  "Discover",
  "Get Yours",
  "See Ingredients",
] as const;

export type Objective =
  | "awareness"
  | "consideration"
  | "conversion"
  | "retargeting";

export const OBJECTIVE_GUIDANCE: Record<Objective, string> = {
  awareness:
    "Introduce the active and the concern it addresses. Lead with the " +
    "ingredient story. No urgency, no discount emphasis.",
  consideration:
    "Explain why this concentration and this formulation. Compare against the " +
    "reader's current routine, never against a named brand.",
  conversion:
    "Lead with the specific outcome and the offer. Keep the claim conservative " +
    "and the call to action unambiguous.",
  retargeting:
    "Assume prior awareness. Short, direct, reason-to-act-now without " +
    "manufactured scarcity.",
};
