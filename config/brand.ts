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
    "Clinical and plain, closer to a lab note than a beauty ad",
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
    "Fear-based marketing. No shame, anxiety or urgency about appearance",
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
 * Rewritten against three banner ads the brand is currently running, rather
 * than against a generic "minimal clinical" mood board. The two directions are
 * not the same thing, and the difference showed up in every generation: the
 * real ads sit on flat WHITE, not warm sand; the product stands on white
 * geometric pedestals rather than a styled surface; and the frame carries a
 * small set of recurring flat graphic devices — hairline leader lines to
 * small-caps labels, thin-bordered callout boxes, a sharp-cornered black or
 * outlined CTA — that a "beautiful product photograph" brief never produces.
 * Those devices are specified in CREATIVE_GRAMMAR below.
 *
 * `npm run scrape -- brand` extracts live candidates from the theme
 * stylesheet; those should be reviewed against the running creatives and
 * merged in here rather than trusted automatically.
 */
export interface PaletteEntry {
  name: string;
  /**
   * The literal value, or null when the colour is not knowable in advance.
   *
   * Null is not a placeholder: the product accent IS the packaging's own colour,
   * sampled from the reference photograph at render time, and there is no hex
   * that would be right for every SKU. This used to be a `string` carrying the
   * prose "(sampled from the pack in the reference image)", which meant the
   * image prompt shipped a line reading `(sampled from the pack…)  Product
   * accent (…)` where every other line read `#1A1A1A  Ink (…)`. A field typed
   * as a hex value should hold a hex value or nothing.
   */
  hex: string | null;
  use: string;
}

export interface BrandVisual {
  palette: PaletteEntry[];
  typography: string[];
  photography: string[];
  composition: string[];
  neverDepict: string[];
}

export const BRAND_VISUAL: BrandVisual = {
  palette: [
    {
      name: "Paper white",
      hex: "#FFFFFF",
      use: "The ground, edge to edge, in almost every creative. Flat: no gradient, no vignette, no texture",
    },
    {
      name: "Bone",
      hex: "#F4F1EC",
      use: "The only alternative ground, when pure white would blow out against a white feed. Never mixed with paper white in one creative",
    },
    {
      name: "Ink",
      hex: "#1A1A1A",
      use: "Headlines, solid CTA fill, solid eyebrow chip, callout-box copy",
    },
    {
      name: "Graphite",
      hex: "#6B6B6B",
      use: "Body copy, small-caps leader labels, attributed names, the sub-label under a stat",
    },
    {
      name: "Hairline",
      hex: "#D4D4D4",
      use: "1px leader lines, callout-box borders, the short rule under an offer line. Never thicker than 1px",
    },
    {
      name: "Shadow grey",
      hex: "#E9E9E9",
      use: "The soft contact shadow under a pedestal or bottle. The only shading anywhere on the ground",
    },
    {
      name: "Product accent",
      hex: null,
      use: "Sampled from the pack in the reference photograph. The product's own colour and nothing else. Permitted on exactly one phrase of copy, or on a molecule diagram. Never a background, never a button, never a second phrase",
    },
  ],
  typography: [
    "Geometric or neo-grotesque sans only: no serifs, no scripts, no display faces",
    "Headline in heavy weight Ink, left aligned, two lines maximum, tight tracking with generous leading",
    "The specification lives INSIDE the headline at full headline size ('B12 + Oat Extract 6.5%'), never demoted to a badge or a caption",
    "Weight, not size, carries the second line: a heavy line above a lighter line of the same or smaller size. Two weights maximum in one creative",
    "Body copy regular weight, sentence case, one or two lines, set well below the headline",
    "Uppercase is reserved for exactly three things: the eyebrow chip, the small-caps leader labels, and the single very large offer line. Everything else is sentence case",
    "Small-caps leader labels are the smallest type in the frame: letter-spaced, Graphite, one to three words",
    "One accent-coloured phrase per creative at most, and only in the product's own colour",
  ],
  photography: [
    "The real product, photographed. Never illustrated, rendered or restyled",
    "Shot on flat white with no environment, no set, no surface texture and no horizon line",
    "Products stand on white geometric pedestals (cubes, cylinders, stepped blocks) at two or three different heights, or lie in a flat-lay directly on the white",
    "Even, diffuse light; a short soft grey contact shadow under each pedestal, never a long dramatic cast shadow",
    "A cluster of two to four units reads as the range; labels stay front-facing and legible",
    "At most two props beyond the pedestals, drawn from the prop vocabulary in CREATIVE_GRAMMAR: clear glass, a petri dish with a smear of the product, a single raw ingredient, a molecule diagram",
    "No hands, no models, no bathroom, no plants, no fabric, no water",
  ],
  /*
   * Placement-INDEPENDENT rules only. The left-type-stack/right-cluster split
   * used to be the first line here, which meant a 1080×1920 story creative was
   * instructed to build a landscape banner: the split is a property of one
   * archetype, not of the brand. Layout now lives in CREATIVE_GRAMMAR.archetypes,
   * chosen against the frame's aspect ratio by archetypesFor().
   */
  composition: [
    "One idea per creative, and one element larger than everything else: the specification figure or the offer line",
    "Reading order is enforced by size: eyebrow chip, headline with the specification, supporting line, then CTA",
    "35–45% of the frame stays empty white; devices float on it and are separated by space, not by boxes",
    "Only the callout boxes and the CTA are enclosed. Nothing else gets a border, a card or a background fill",
    "Text and product never overlap; a leader line may cross empty white but never the type",
    "The ad is never framed. No outer border, no rounded corners on the creative itself",
    "The type stack and the product cluster occupy separate regions of the frame and never overlap; which region is which is set by the chosen layout archetype",
  ],
  neverDepict: [
    "Wet or glossy marble surfaces",
    "Tropical leaves, monstera, palm fronds, botanical clutter",
    "Water splashes, droplet crowns, liquid swirls",
    "Gold foil, metallic gradients, luxury-cosmetics ornament",
    "Dewy close-up model skin as the hero",
    "Before-and-after panels",
    "Starbursts, badges, sale explosions, arrows",
    "Rounded or pill-shaped buttons, drop-shadowed cards, app-style UI chrome",
    "Coloured, gradient, textured or photographic backgrounds behind the product",
    "Any other brand's packaging, logo or wordmark",
    "Invented packaging, invented label text, or a redesigned bottle",
    "Stock-photo lifestyle collage",
  ],
};

/**
 * The recurring layout grammar of the brand's live banner ads.
 *
 * BRAND_VISUAL says what the creative may be made of. This says how the brand
 * actually assembles those parts, because that is where generations were
 * failing: every constraint could be satisfied by a tasteful product shot on
 * white that still looked nothing like the ads running on the site. The real
 * creatives are closer to a spec sheet than to a photograph — a type stack on
 * the left, a pedestal cluster on the right, and two or three flat graphic
 * devices annotating it.
 *
 * Derived from three creatives supplied by the client: a range banner with
 * leader-line labels and a testimonial card, a single-SKU formula banner with
 * the concentration set inside the headline, and an offer banner built around
 * one very large uppercase line.
 *
 * Deliberately a small vocabulary. The archetypes are alternatives, not
 * layers — picking one and applying it cleanly is the point, and `restraint`
 * exists because the failure mode of a device list is a creative that uses
 * every device at once.
 */
/**
 * How a frame is shaped, which is the first thing a layout has to answer to.
 *
 * The reference creatives are all banners, and describing them as banners in a
 * placement-independent prompt produced 1080×1920 stories built as though they
 * were 1200×628 — a left/right split squeezed into a column. An archetype now
 * declares which frames it works in, and carries the stacked rearrangement for
 * the tall ones instead of pretending the side-by-side version survives.
 */
export type Orientation = "wide" | "square" | "tall";

export function orientationOf(width: number, height: number): Orientation {
  const ratio = width / height;
  if (ratio >= 1.3) return "wide";
  if (ratio >= 0.85) return "square";
  return "tall";
}

export interface LayoutArchetype {
  name: string;
  /** The situation this layout is the right answer to. */
  useWhen: string;
  /** Frames this layout can actually be built in. */
  orientations: Orientation[];
  /** Concrete enough to build from without seeing the reference. */
  description: string;
  /**
   * How the same idea is rebuilt when the frame is taller than it is wide.
   * Required whenever `orientations` includes "tall".
   */
  stacked?: string;
  /**
   * Which entries in `devices` this layout is built from, by name.
   *
   * Named explicitly rather than inferred from the prose, so the image prompt
   * can carry the construction rules for exactly the devices in play. Emitting
   * all six would both blow the prompt budget and contradict `restraint`, which
   * caps a creative at two devices besides the CTA.
   */
  usesDevices: string[];
  /** What the eye must land on first, second, third. */
  readingOrder: string[];
}

export interface CreativeDevice {
  name: string;
  what: string;
  useWhen: string;
  /** Construction rules — the details that separate the brand's version from the generic one. */
  rules: string[];
}

export interface CtaTreatment {
  name: string;
  useWhen: string;
  description: string;
}

export interface PropItem {
  name: string;
  description: string;
  useWhen: string;
}

export interface CreativeGrammar {
  summary: string;
  ground: string[];
  archetypes: LayoutArchetype[];
  typeHierarchy: string[];
  props: PropItem[];
  ctaTreatments: CtaTreatment[];
  devices: CreativeDevice[];
  restraint: string[];
}

export const CREATIVE_GRAMMAR: CreativeGrammar = {
  summary:
    "A flat white banner split into a left type stack and a right cluster of " +
    "products standing on white geometric pedestals, annotated with a few thin " +
    "graphic devices (hairline leader lines to small-caps labels, " +
    "thin-bordered callout boxes, a solid black eyebrow chip) and closed by a " +
    "sharp-cornered CTA that is either a solid black block or a 1px black " +
    "outline.",
  ground: [
    "Pure white, flat, edge to edge. No gradient, vignette, paper texture or backdrop sweep",
    "Bone #F4F1EC only when pure white would disappear into the surrounding page",
    "The white is the composition, not an empty area waiting to be filled",
  ],
  archetypes: [
    {
      name: "Labelled range",
      useWhen:
        "Several SKUs, several concerns, or a range story, and whenever social " +
        "proof rather than a single specification is the angle.",
      // Deliberately not "tall": four units, two leader lines and two callout
      // boxes cannot be laid out in a 9:16 column without either overlapping
      // the type or shrinking the labels below legibility.
      orientations: ["wide", "square"],
      description:
        "Left: headline over a short checkmark list of two or three plain " +
        "qualifiers, then the CTA. Right: a cluster of three or four units " +
        "standing on white pedestals of stepped heights with soft grey contact " +
        "shadows. Hairline leader lines run from two or three of the units out " +
        "into the white to small-caps labels naming what each one is for. A " +
        "thin-bordered testimonial card overlaps the left edge of the cluster, " +
        "and a thin-bordered stat box sits far right.",
      usesDevices: ["Leader line and small-caps label", "Bordered testimonial card", "Bordered stat box"],
      readingOrder: [
        "Headline, two lines, heavy weight",
        "The product cluster and its leader-line labels",
        "Testimonial card and stat box",
        "CTA",
      ],
    },
    {
      name: "Formula callout",
      useWhen:
        "One hero SKU where the active, its concentration or a reformulation is " +
        "the message. The default for awareness and consideration.",
      orientations: ["wide", "square", "tall"],
      stacked:
        "In a tall frame the two halves swap from side-by-side to stacked: the " +
        "chip, headline and body copy occupy the top third, the flat-lay of pack, " +
        "petri dish and molecule diagram fills the middle, and the outlined CTA " +
        "sits in the bottom third. Nothing moves into the top or bottom margin.",
      description:
        "Left: a small solid black chip with white uppercase text above the " +
        "headline; the headline itself carries the actives and the concentration " +
        "at full headline size, with the product type set beneath in a lighter " +
        "weight; then one or two lines of body copy in which exactly one phrase " +
        "(the active's name) is set in the product's own colour; then an " +
        "outlined CTA. Right: the product in a flat-lay on white with a smear of " +
        "the formula in a clear glass petri dish, a single raw ingredient, and a " +
        "3D molecule diagram.",
      usesDevices: ["Solid eyebrow chip", "Accent phrase"],
      readingOrder: [
        "The chip",
        "The concentration inside the headline",
        "The accent-coloured active in the body line",
        "CTA",
      ],
    },
    {
      name: "Offer block",
      useWhen:
        "A promotion, bundle or free-product mechanic. Conversion and " +
        "retargeting, where the offer and not the formulation is the message.",
      orientations: ["wide", "square", "tall"],
      stacked:
        "In a tall frame the lede, the very large offer line, the hairline rule " +
        "and the mechanic line stack in the upper half, the units on their blocks " +
        "sit in the lower half, and the solid CTA closes beneath them.",
      description:
        "Left: a short light-weight lede line, then the offer as one very large " +
        "heavy uppercase line, then a short thin horizontal rule, then a single " +
        "line stating the mechanic plainly, then a solid black CTA. Right: two or " +
        "three units arranged on white cubic blocks of different heights with " +
        "soft shadows. No leader lines and no callout boxes: the offer line is " +
        "already the loudest thing in the frame.",
      usesDevices: ["Hairline rule"],
      readingOrder: [
        "The large uppercase offer line",
        "The mechanic line",
        "The products",
        "CTA",
      ],
    },
    {
      name: "Single plinth",
      useWhen:
        "Square and vertical placements, or any frame too narrow for a left/right " +
        "split. The fallback that keeps the grammar intact when the banner " +
        "layouts would break.",
      orientations: ["square", "tall"],
      stacked:
        "This layout is already a column: headline above, pedestal in the middle " +
        "third, CTA below. In a 9:16 frame keep every element out of the top 14% " +
        "and bottom 20%, which platform chrome covers.",
      description:
        "One unit centred on a single white pedestal on flat white, its soft " +
        "contact shadow the only shading. Headline with the specification stacked " +
        "above it, one supporting line and the CTA below. At most one leader line " +
        "and label, and no callout boxes.",
      usesDevices: ["Leader line and small-caps label"],
      readingOrder: [
        "The specification in the headline",
        "The product on its pedestal",
        "CTA",
      ],
    },
  ],
  typeHierarchy: [
    "Exactly one element is the largest in the frame: the specification inside the headline, or the offer line. Nothing else competes with it",
    "The specification is never separated out into a badge, a roundel or a caption. It is set as part of the headline sentence",
    "The second headline line drops a weight rather than a size, so the pair still reads as one headline",
    "Eyebrow chip text is roughly a quarter of the headline size, uppercase, letter-spaced",
    "Body copy is one or two lines, regular weight, sentence case, and sits clearly below the headline",
    "Small-caps leader labels and the sub-label under a stat are the smallest type in the frame",
    "CTA text is body size. Never headline size, never the largest thing in the frame",
    "Two type weights and one accent-coloured phrase is the whole budget for a creative",
  ],
  props: [
    {
      name: "White geometric pedestal",
      description:
        "A matte white cube, cylinder or stepped block raising a unit off the " +
        "ground, with a short soft grey contact shadow. Two or three heights in " +
        "one cluster.",
      useWhen:
        "Any time more than one unit is shown, and whenever the product would " +
        "otherwise float without an anchor.",
    },
    {
      name: "Clear glass form",
      description:
        "A plain glass sphere or block beside the cluster, catching a little " +
        "light. No liquid inside, no colour.",
      useWhen:
        "As a single quiet counterweight in a cluster that is otherwise all " +
        "bottles.",
    },
    {
      name: "Petri dish with a smear",
      description:
        "A shallow clear glass dish holding a smear of the actual formula, so " +
        "texture is shown rather than described.",
      useWhen: "When the texture or finish of the formula is part of the claim.",
    },
    {
      name: "Single raw ingredient",
      description:
        "One unit of the named botanical or mineral: one oat grain, one seed, a " +
        "few crystals, placed on the white, not scattered.",
      useWhen:
        "When the headline names a natural ingredient. One piece, never a " +
        "handful and never a whole plant.",
    },
    {
      name: "Molecule diagram",
      description:
        "A small 3D ball-and-stick or lattice diagram of the active, in grey or " +
        "in the product's own colour.",
      useWhen:
        "When the active itself is the story and the pack alone cannot show it.",
    },
  ],
  ctaTreatments: [
    {
      name: "Solid ink block",
      useWhen:
        "Conversion and offer creatives, and any layout with no other solid black " +
        "element in it.",
      description:
        "A solid #1A1A1A rectangle with sharp 0px corners and even padding, white " +
        "text set in sentence case ('Shop Now'). No shadow, no gradient, no icon, " +
        "no arrow.",
    },
    {
      name: "Outlined rectangle",
      useWhen:
        "Awareness and consideration creatives, and any layout that already " +
        "carries a solid black chip. Two solid black blocks in one frame fight.",
      description:
        "A 1px #1A1A1A border on white with sharp 0px corners, black uppercase " +
        "letter-spaced text ('SHOP NOW'). Same footprint as the solid block.",
    },
  ],
  devices: [
    {
      name: "Leader line and small-caps label",
      what:
        "A 1px hairline running from a specific unit out into the white, ending " +
        "at a short uppercase label that names what that unit is for.",
      useWhen:
        "A cluster where the units differ by purpose. The device is what turns a " +
        "group shot into a range explanation.",
      rules: [
        "1px, Hairline grey, straight or one right-angled bend. Never curved, never an arrow",
        "Starts at the unit it annotates and ends in empty white, never over the product or the type",
        "Label is one to three words, uppercase, letter-spaced, Graphite, e.g. 'ACNE CONTROL', 'OIL CONTROL'",
        "Two or three per creative. Labelling every unit turns the ad into a diagram",
      ],
    },
    {
      name: "Bordered testimonial card",
      what:
        "A thin-bordered rectangle holding a five-star row, a short quote in " +
        "quotation marks, and an italic attributed name with a small qualifier " +
        "beneath.",
      useWhen:
        "Social proof is the angle, and a real review exists to quote. Never with " +
        "invented copy or an invented name.",
      rules: [
        "1px Hairline border, sharp corners, white fill. No shadow, no rounding, no tint",
        "Overlaps the left edge of the product cluster so type and product read as one composition",
        "Quote is one sentence; the name is italic with 'Verified Buyer' or equivalent set smaller beneath",
        "Stars are a simple flat row, not a graphic badge",
      ],
    },
    {
      name: "Bordered stat box",
      what:
        "A thin-bordered rectangle holding one large figure with a short label " +
        "beneath it, e.g. '150k+' over 'Positive Reviews'.",
      useWhen:
        "There is a real, sourced number worth stating. Sits far right, opposite " +
        "the type stack.",
      rules: [
        "1px Hairline border, sharp corners, white fill",
        "The figure is the largest thing inside the box and the smallest of the frame's large elements",
        "One box per creative, and only for a figure that appears in the product data",
      ],
    },
    {
      name: "Solid eyebrow chip",
      what:
        "A small solid black rectangle above the headline carrying two or three " +
        "uppercase words in white.",
      useWhen:
        "Flagging what is new about this creative: a reformulation, a launch, a " +
        "pack change. Not a decoration and not a sale badge.",
      rules: [
        "Solid Ink fill, sharp corners, tight padding, white uppercase letter-spaced text",
        "Sits directly above the headline, left aligned to it",
        "One chip per creative, and it forces the outlined CTA rather than the solid one",
      ],
    },
    {
      name: "Hairline rule",
      what: "A short 1px horizontal line under a headline or offer line.",
      useWhen:
        "Separating a very large line from the body copy beneath it, where white " +
        "space alone leaves the two reading as one block.",
      rules: [
        "Short, roughly a third of the type stack's width, not a full-width divider",
        "1px, Hairline grey, no thickening and no second rule anywhere in the frame",
      ],
    },
    {
      name: "Accent phrase",
      what:
        "One phrase of body copy set in the product's own colour, sampled from " +
        "the pack in the reference image.",
      useWhen:
        "The phrase names the active or the thing the pack colour already stands " +
        "for. Otherwise the creative stays entirely Ink and Graphite.",
      rules: [
        "Exactly one phrase, inside body copy. Never the headline, never the CTA, never a fill",
        "The colour is taken from the packaging, never chosen for contrast",
        "If two products of different colours appear, the creative uses no accent at all",
      ],
    },
  ],
  restraint: [
    "Pick one archetype and build it cleanly. The archetypes are alternatives, never layers",
    "At most two devices besides the CTA in one creative. Chip plus leader lines plus both callout boxes is four ideas competing for one second of attention",
    "Every enclosed element in the frame is either a callout box, the chip or the CTA. If something else has acquired a border, remove the border",
    "Every rule and border is 1px. There is no second line weight in this system",
    "Corners are sharp everywhere: CTA, chip, callout boxes, pedestals",
  ],
};

/**
 * Every archetype name, as a tuple, so the brief schema can enumerate them.
 *
 * The brief model does not describe a layout in prose — it NAMES one of these,
 * and the image prompt is expanded from the matching entry. That is what makes
 * this file load-bearing rather than documentation: a grammar the generator can
 * ignore is a grammar that gets ignored, and the earlier version of it was
 * imported by nothing at all.
 */
export const ARCHETYPE_NAMES = CREATIVE_GRAMMAR.archetypes.map((a) => a.name) as [
  string,
  ...string[],
];

/** The archetypes that can actually be built in a frame of this shape. */
export function archetypesFor(width: number, height: number): LayoutArchetype[] {
  const orientation = orientationOf(width, height);
  const usable = CREATIVE_GRAMMAR.archetypes.filter((a) =>
    a.orientations.includes(orientation),
  );
  // A frame with no match would leave the model to invent a layout, which is
  // the failure this whole section exists to prevent. Single plinth is the
  // deliberate catch-all: it is the one layout that survives any aspect ratio.
  return usable.length > 0
    ? usable
    : CREATIVE_GRAMMAR.archetypes.filter((a) => a.name === "Single plinth");
}

/** Lookup by the name the brief returned; undefined for anything unrecognised. */
export function archetypeByName(name: string): LayoutArchetype | undefined {
  return CREATIVE_GRAMMAR.archetypes.find((a) => a.name === name);
}

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
    "The brand appears only where it genuinely is, printed on the packaging. " +
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
