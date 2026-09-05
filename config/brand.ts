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
 * render. Meta truncates primary text around 125 characters on most surfaces.
 */
export const COPY_LIMITS = {
  headline: 40,
  subhead: 60,
  primaryText: 125,
  cta: 20,
} as const;

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
