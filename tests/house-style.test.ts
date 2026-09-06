import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConceptBriefSchema, houseStyle } from "../src/lib/pipeline/types.ts";
import { VisionScoreSchema } from "../src/lib/pipeline/score.ts";
import { BRAND_VISUAL, CREATIVE_GRAMMAR, POLICY_RULES } from "../config/brand.ts";
import { PLACEMENTS as PLACEMENTS_LIST, OFFER_PRESETS, ANGLE_PRESETS } from "../config/placements.ts";
import { PLACEMENTS } from "../src/lib/pipeline/types.ts";
import { buildSystemPrompt, buildUserPrompt } from "../src/lib/pipeline/brief.ts";
import { buildScorerSystemPrompt, buildScorerUserPrompt } from "../src/lib/pipeline/score.ts";

/**
 * No em dash anywhere a person can see one, and no way for the model to put one
 * back.
 *
 * Instructing a model not to use a character works most of the time, and most
 * of the time is not a standard when the failure is burned into a 2K PNG. The
 * transform is the enforcement; these tests are what stop it being deleted as
 * "surely unnecessary" later.
 */

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

describe("houseStyle", () => {
  it("turns a spaced em dash into a comma", () => {
    assert.equal(
      houseStyle(`15.6% actives ${EM} stated plainly`),
      "15.6% actives, stated plainly",
    );
  });

  it("turns an unspaced em dash into a comma", () => {
    assert.equal(houseStyle(`Six actives${EM}one serum`), "Six actives, one serum");
  });

  it("treats an en dash the same way", () => {
    assert.equal(houseStyle(`Barrier care ${EN} daily`), "Barrier care, daily");
  });

  it("drops an ellipsis rather than replacing it", () => {
    assert.equal(houseStyle(`Results${ELLIPSIS}`), "Results");
    assert.equal(houseStyle(`Wait${ELLIPSIS}then rinse`), "Wait then rinse");
  });

  it("does not leave doubled punctuation or spaces behind", () => {
    assert.equal(houseStyle(`One ${EM} , two`), "One, two");
    assert.equal(houseStyle(`A  ${EM}  B`), "A, B");
  });

  it("leaves a hyphen alone", () => {
    // A hyphen is a word-joiner, not a dash, and "anti-grey" must survive.
    assert.equal(houseStyle("Hair Growth + Anti-Grey"), "Hair Growth + Anti-Grey");
  });

  it("leaves clean copy untouched", () => {
    assert.equal(houseStyle("15.6% actives, stated plainly"), "15.6% actives, stated plainly");
  });
});

describe("the guard runs on the way through the schema", () => {
  const brief = (headline: string) => ({
    concept: { name: `A ${EM} B`, angle: "Ingredient led", rationale: "Because." },
    copy: { headline, subhead: "Six actives", primaryText: "A blend.", cta: "Shop Now" },
    imagePrompt: {
      layoutArchetype: "Single plinth",
      scene: "Studio",
      composition: "Centred",
      lighting: "Soft",
      palette: "Paper white",
      productPlacement: "Centre",
      textToRender: [`15.6% ACTIVES ${EM} STATED PLAINLY`],
      typography: "Geometric sans",
      avoid: ["clutter"],
    },
  });

  it("cleans the headline the ad card renders", () => {
    const parsed = ConceptBriefSchema.parse(brief(`Stated plainly ${EM} 15.6%`));
    assert.equal(parsed.copy.headline, "Stated plainly, 15.6%");
  });

  it("cleans the strings the image model draws into the PNG", () => {
    const parsed = ConceptBriefSchema.parse(brief("Fine"));
    assert.ok(!parsed.imagePrompt.textToRender[0].includes(EM));
  });

  it("cleans the concept name, which titles the card and the download", () => {
    const parsed = ConceptBriefSchema.parse(brief("Fine"));
    assert.equal(parsed.concept.name, "A, B");
  });

  it("cleans the scorer's prose too", () => {
    const parsed = VisionScoreSchema.parse({
      extractedText: [],
      dimensionScores: { brand_fit: 80, compliance: 80, clarity: 80, craft: 80, stopping_power: 80 },
      readsAsGenericSkincareAd: false,
      genericMarkers: [],
      competingBrandVisible: false,
      findings: [
        {
          severity: "minor",
          dimension: "craft",
          observation: `Unverified ${EM} the price could not be checked`,
          action: `Add the URL ${EM} then score again`,
          verified: false,
        },
      ],
      doMore: [`Lead with the number ${EM} it is the proof`],
      doLess: [],
      summary: `Clean ${EM} on brand`,
    });
    assert.ok(!parsed.summary.includes(EM), parsed.summary);
    assert.ok(!parsed.findings[0].observation.includes(EM));
    assert.ok(!parsed.findings[0].action.includes(EM));
    assert.ok(!parsed.doMore[0].includes(EM));
  });
});

describe("nothing sent to a model teaches it the habit", () => {
  const SNAPSHOT = {
    title: "Hair Growth + Anti-Grey 15.6% Hair Serum",
    productType: "Hair Care",
    tags: [],
    images: [],
    concentrations: [15.6],
    priceMinor: 81000,
    compareAtPriceMinor: 89900,
    discountPct: 10,
    descriptionText: "A 15.6% blend.",
    sourceUrl: "https://beminimalist.co/products/x",
  };
  const CLAIMS = {
    concentrations: ["15.6%"],
    priceDisplay: "₹810",
    compareAtDisplay: "₹899",
    discountPct: 10,
  };

  const prompts = () => [
    ["brief system", buildSystemPrompt()],
    [
      "brief user",
      buildUserPrompt({
        snapshot: SNAPSHOT as never,
        claims: CLAIMS as never,
        placement: PLACEMENTS.meta_feed_4x5,
        objective: "conversion",
        conceptCount: 2,
        offer: "Buy 2, get 1 free",
      }),
    ],
    ["scorer system", buildScorerSystemPrompt()],
    ["scorer user", buildScorerUserPrompt(PLACEMENTS.meta_feed_4x5, SNAPSHOT as never)],
    ["scorer user, no product", buildScorerUserPrompt(null, null)],
  ];

  it("has no em dash in any prompt actually sent", () => {
    for (const [name, prompt] of prompts()) {
      assert.ok(
        !(prompt as string).includes(EM),
        `${name} still contains an em dash: ${(prompt as string)
          .split("\n")
          .filter((l) => l.includes(EM))
          .join(" | ")}`,
      );
    }
  });
});

describe("nothing rendered from config carries one", () => {
  it("placement labels, surfaces, notes and safe zones are clean", () => {
    for (const placement of PLACEMENTS_LIST) {
      for (const field of [placement.label, placement.surface, placement.note, placement.safeZone]) {
        if (field) assert.ok(!field.includes(EM), `${placement.id}: ${field}`);
      }
    }
  });

  it("preset chips are clean", () => {
    for (const preset of [...OFFER_PRESETS, ...ANGLE_PRESETS]) {
      assert.ok(!preset.includes(EM), preset);
    }
  });

  it("brand config strings are clean", () => {
    const strings = [
      ...BRAND_VISUAL.palette.flatMap((c) => [c.name, c.use]),
      ...BRAND_VISUAL.typography,
      ...BRAND_VISUAL.photography,
      ...BRAND_VISUAL.composition,
      ...BRAND_VISUAL.neverDepict,
      CREATIVE_GRAMMAR.summary,
      ...CREATIVE_GRAMMAR.ground,
      ...CREATIVE_GRAMMAR.typeHierarchy,
      ...CREATIVE_GRAMMAR.restraint,
      ...CREATIVE_GRAMMAR.archetypes.flatMap((a) => [a.useWhen, a.description, a.stacked ?? "", ...a.readingOrder]),
      ...CREATIVE_GRAMMAR.devices.flatMap((d) => [d.name, d.what, d.useWhen, ...d.rules]),
      ...CREATIVE_GRAMMAR.props.flatMap((p) => [p.name, p.description, p.useWhen]),
      ...CREATIVE_GRAMMAR.ctaTreatments.flatMap((c) => [c.name, c.useWhen, c.description]),
      ...POLICY_RULES.map((r) => r.rationale),
    ];
    const dirty = strings.filter((s) => s.includes(EM));
    assert.deepEqual(dirty, [], `${dirty.length} config strings still carry an em dash`);
  });
});
