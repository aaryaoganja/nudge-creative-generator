import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  buildScorerSystemPrompt,
  buildScorerUserPrompt,
  DIMENSIONS,
  scoreCreative,
  WEIGHTS,
  type BrandIdentity,
  SCORER_RESPONSE_SCHEMA,
  type VisionScore,
} from "../src/lib/pipeline/score.ts";
import { GeminiTextClient } from "../src/lib/providers/gemini-text.ts";
import { PLACEMENTS } from "../src/lib/pipeline/types.ts";
import type { ProductSnapshot } from "../src/lib/scrape/shopify.ts";

function vision(overrides: Partial<VisionScore> = {}): VisionScore {
  return {
    extractedText: ["15.6% ACTIVES"],
    dimensionScores: {
      brand_fit: 85,
      compliance: 90,
      clarity: 80,
      craft: 85,
      stopping_power: 75,
    },
    readsAsGenericSkincareAd: false,
    genericMarkers: [],
    brandIdentity: {
      isThisBrand: true,
      detectedBrand: "Minimalist",
      confidence: 0.95,
      evidence: "Lowercase minimalist wordmark on an amber dropper bottle.",
    },
    competingBrandVisible: false,
    findings: [],
    doMore: [],
    doLess: [],
    summary: "Clean, on-brand.",
    ...overrides,
  };
}

/** A creative that is plainly somebody else's, as the model would report it. */
function otherBrand(overrides: Partial<BrandIdentity> = {}): BrandIdentity {
  return {
    isThisBrand: false,
    detectedBrand: "The Ordinary",
    confidence: 0.93,
    evidence: "The Ordinary wordmark set in Times on a frosted dropper bottle.",
    ...overrides,
  };
}

const SNAPSHOT = {
  title: "Hair Growth + Anti-Grey 15.6% Hair Serum",
  productType: "Hair Care",
  concentrations: [15.6],
  priceMinor: 81000,
  compareAtPriceMinor: 89900,
  discountPct: 10,
  descriptionText: "A 15.6% blend of six actives.",
  sourceUrl: "https://beminimalist.co/products/x",
} as unknown as ProductSnapshot;

describe("weights", () => {
  it("sum to 1 and give compliance the most influence", () => {
    const total = DIMENSIONS.reduce((s, d) => s + WEIGHTS[d], 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
    const max = Math.max(...DIMENSIONS.map((d) => WEIGHTS[d]));
    assert.equal(WEIGHTS.compliance, max);
  });
});

describe("aggregate — hard gates cannot be averaged away", () => {
  it("passes a clean, high-scoring creative", () => {
    const { overall, verdict } = aggregate(vision(), []);
    assert.ok(overall >= 80, `overall was ${overall}`);
    assert.equal(verdict, "pass");
  });

  it("BLOCKS on a blocking finding even at a high score", () => {
    // The core requirement: a beautiful creative with a banned claim is blocked,
    // not averaged down to a passing number.
    const { overall, verdict } = aggregate(
      vision({
        findings: [
          {
            severity: "blocking",
            dimension: "compliance",
            observation: "Claims to cure hair fall.",
            action: "Remove the claim.",
            verified: true,
          },
        ],
      }),
      [],
    );
    assert.ok(overall >= 80, "score stays high");
    assert.equal(verdict, "blocked", "but the verdict blocks");
  });

  it("BLOCKS when a competing brand is visible, but keeps the score", () => {
    // Contamination — our creative with someone else's logo in frame. One
    // fixable defect, so the number it would earn once fixed is preserved.
    const { overall, verdict } = aggregate(
      vision({ competingBrandVisible: true }),
      [],
    );
    assert.equal(verdict, "blocked");
    assert.ok(overall >= 80, `score should survive, was ${overall}`);
  });

  it("BLOCKS on a deterministic placement failure", () => {
    assert.equal(
      aggregate(vision(), ["Image is 540×675, below the minimum."]).verdict,
      "blocked",
    );
  });

  it("requires a fix when the creative reads as a generic skincare ad", () => {
    // Polished but interchangeable is a failure for this brand specifically.
    const { verdict } = aggregate(
      vision({ readsAsGenericSkincareAd: true, genericMarkers: ["wet marble"] }),
      [],
    );
    assert.equal(verdict, "fix_required");
  });

  it("requires a fix below 70 even with nothing flagged", () => {
    const { verdict } = aggregate(
      vision({
        dimensionScores: {
          brand_fit: 60,
          compliance: 65,
          clarity: 60,
          craft: 60,
          stopping_power: 55,
        },
      }),
      [],
    );
    assert.equal(verdict, "fix_required");
  });
});

describe("aggregate — a creative for another brand is not scored, it is refused", () => {
  it("returns a hard 0 and blocks, ignoring the dimension scores entirely", () => {
    // Every dimension is high: this is a competently made ad. It is just not
    // ours, and 62 would read as "nearly there" about something unusable.
    const { overall, verdict } = aggregate(
      vision({ brandIdentity: otherBrand() }),
      [],
    );
    assert.equal(overall, 0);
    assert.equal(verdict, "blocked");
  });

  it("zeroes even when nothing else is wrong with the creative", () => {
    const { overall } = aggregate(
      vision({
        brandIdentity: otherBrand({ detectedBrand: null }),
        dimensionScores: {
          brand_fit: 100,
          compliance: 100,
          clarity: 100,
          craft: 100,
          stopping_power: 100,
        },
      }),
      [],
    );
    assert.equal(overall, 0);
  });

  it("does NOT zero on a low-confidence hunch", () => {
    // Below the threshold the model is guessing, and a guess must not tell a
    // marketer their own creative belongs to someone else.
    const { overall, verdict } = aggregate(
      vision({ brandIdentity: otherBrand({ confidence: 0.2 }) }),
      [],
    );
    assert.ok(overall >= 80, `overall was ${overall}`);
    assert.equal(verdict, "pass");
  });

  it("reads a percent-scale confidence as high confidence", () => {
    // Models answer 0–100 often enough that 85 must not be clamped to a value
    // that silently disarms the gate.
    assert.equal(
      aggregate(vision({ brandIdentity: otherBrand({ confidence: 85 }) }), [])
        .overall,
      0,
    );
  });

  it("scores normally when the model returned no brand assessment", () => {
    // Absence of an answer is not an accusation.
    const { overall, verdict } = aggregate(
      vision({ brandIdentity: undefined }),
      [],
    );
    assert.ok(overall >= 80);
    assert.equal(verdict, "pass");
  });

  it("scores normally when the creative is unattributed but ours", () => {
    // No pack, no wordmark: isThisBrand stays true with low confidence, which
    // must not be mistaken for a wrong-brand upload.
    const { verdict } = aggregate(
      vision({
        brandIdentity: {
          isThisBrand: true,
          detectedBrand: null,
          confidence: 0.2,
          evidence: "No packaging or wordmark in frame.",
        },
      }),
      [],
    );
    assert.equal(verdict, "pass");
  });
});

/** 1×1 PNG. The deterministic layer runs for real; only the model is stubbed. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function scoreWith(payload: VisionScore) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(payload) }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch;
  try {
    return await scoreCreative(new GeminiTextClient("fake-key"), {
      image: { bytes: TINY_PNG, mimeType: "image/png" },
      placement: PLACEMENTS.meta_feed_4x5,
      snapshot: null,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("scoreCreative — reporting a wrong-brand upload", () => {
  it("leads with the wrong-brand finding and names the brand", async () => {
    const result = await scoreWith(
      vision({
        brandIdentity: otherBrand(),
        findings: [
          {
            severity: "major",
            dimension: "clarity",
            observation: "The headline competes with the pack.",
            action: "Shrink the headline.",
            verified: true,
          },
        ],
      }),
    );

    assert.equal(result.overall, 0);
    assert.equal(result.verdict, "blocked");

    // Ahead of the model's own findings AND of the placement failures the 1×1
    // PNG earns — nothing below it matters until the right file is uploaded.
    const first = result.findings[0];
    assert.equal(first.severity, "blocking");
    assert.match(first.observation, /not a Minimalist creative/i);
    assert.match(first.observation, /The Ordinary/);
    assert.match(first.action, /Upload the Minimalist creative/i);

    // The one line most people read must not say "Clean, on-brand."
    assert.match(result.summary, /not Minimalist's/);
    assert.match(result.summary, /The Ordinary/);

    // A 0/100 headline beside an 85 brand-fit bar reads as a bug.
    assert.ok(
      DIMENSIONS.every((d) => result.dimensionScores[d] === 0),
      `dimension bars were ${JSON.stringify(result.dimensionScores)}`,
    );
  });

  it("leaves a contaminated creative its score, summary and bars", async () => {
    const result = await scoreWith(vision({ competingBrandVisible: true }));

    assert.equal(result.verdict, "blocked");
    assert.ok(result.overall >= 80, `overall was ${result.overall}`);
    assert.equal(result.summary, "Clean, on-brand.");
    assert.equal(result.dimensionScores.brand_fit, 85);
    assert.ok(
      result.findings.some((f) => /Another brand's packaging/.test(f.observation)),
      "the competing-mark finding is missing",
    );
    assert.ok(
      !result.findings.some((f) => /not a Minimalist creative/i.test(f.observation)),
      "contamination must not be reported as a wrong-brand upload",
    );
  });
});

describe("scorer prompt — brand identity", () => {
  it("teaches the model what the packaging looks like", () => {
    const prompt = buildScorerSystemPrompt();
    assert.match(prompt, /amber-glass/i);
    assert.match(prompt, /lowercase `minimalist` wordmark/i);
    assert.match(prompt, /thin coloured rule/i);
    assert.match(prompt, /concentration printed on the front/i);
    assert.match(prompt, /spec-sheet/i);
  });

  it("separates a wrong-brand upload from a contaminated creative", () => {
    const prompt = buildScorerSystemPrompt();
    assert.match(prompt, /brandIdentity\.isThisBrand/);
    assert.match(prompt, /scores 0/i);
    assert.match(prompt, /competingBrandVisible/);
    assert.match(prompt, /keeps its score/i);
    // Only positive evidence may fire it — an unattributed creative is not
    // another brand's.
    assert.match(prompt, /only on positive evidence/i);
  });
});

describe("scorer prompt — verification posture", () => {
  it("supplies the product as source of truth when a URL was given", () => {
    const prompt = buildScorerUserPrompt(PLACEMENTS.meta_feed_4x5, SNAPSHOT);
    assert.match(prompt, /Source of truth/);
    assert.match(prompt, /15\.6%/);
    assert.match(prompt, /₹810/);
    assert.match(prompt, /BLOCKING/);
  });

  it("instructs unverified reporting when no URL was given", () => {
    const prompt = buildScorerUserPrompt(PLACEMENTS.meta_feed_4x5, null);
    assert.match(prompt, /No product page supplied/);
    assert.match(prompt, /verified: false/);
    assert.match(prompt, /Unverified:/);
    // Must not silently pass or silently fail the unverifiable claims.
    assert.match(prompt, /do NOT assume it is wrong/i);
    assert.match(prompt, /Do NOT assume a claim is correct/i);
    // Everything judgeable from the image alone is still scored normally.
    assert.match(prompt, /can all\s*\n?still be judged/);
  });
});

describe("scorer response schema — order is part of the instruction", () => {
  it("asks for the brand call before anything that depends on it", () => {
    // The prompt tells the model to decide whose creative this is FIRST. If
    // brandIdentity is emitted after dimensionScores, it has already scored
    // brand fit against Minimalist's identity before deciding the ad is
    // somebody else's — and then has to contradict its own numbers.
    const schema = SCORER_RESPONSE_SCHEMA as unknown as {
      required: string[];
      propertyOrdering?: string[];
    };
    assert.equal(schema.required[0], "brandIdentity");
    assert.equal(schema.propertyOrdering?.[0], "brandIdentity");
    assert.ok(
      (schema.propertyOrdering?.indexOf("dimensionScores") ?? -1) >
        (schema.propertyOrdering?.indexOf("brandIdentity") ?? -1),
    );
  });

  it("pins confidence to the 0–1 scale the gate reads it on", () => {
    const confidence = (
      SCORER_RESPONSE_SCHEMA as unknown as {
        properties: {
          brandIdentity: {
            properties: { confidence: { minimum?: number; maximum?: number } };
          };
        };
      }
    ).properties.brandIdentity.properties.confidence;
    assert.equal(confidence.minimum, 0);
    assert.equal(confidence.maximum, 1);
  });
});

describe("scoreCreative — a wrong-brand report says nothing about craft", () => {
  it("replaces the do-more/do-less advice", async () => {
    const result = await scoreWith(
      vision({
        brandIdentity: otherBrand(),
        doMore: ["Lean further into the amber-glass packaging"],
        doLess: ["Crop the headline tighter"],
      }),
    );

    // Advice to a competitor's art director, printed beside a 0.
    assert.ok(
      !result.doMore.some((d) => /amber-glass/.test(d)),
      JSON.stringify(result.doMore),
    );
    assert.deepEqual(result.doLess, []);
    assert.equal(result.doMore.length, 1);
    assert.match(result.doMore[0], /Upload the Minimalist creative/i);
  });

  it("leaves the advice alone on a normal review", async () => {
    const result = await scoreWith(
      vision({ doMore: ["Set the concentration larger"], doLess: ["Two type weights"] }),
    );
    assert.deepEqual(result.doMore, ["Set the concentration larger"]);
    assert.deepEqual(result.doLess, ["Two type weights"]);
  });

  it("claims no more than the model established when the brand is unnamed", async () => {
    // detectedBrand null means the name could not be read. Asserting that "the
    // packaging, wordmark and type" are another brand's is three facts we do
    // not have — the evidence line is where the observation belongs.
    const result = await scoreWith(
      vision({
        brandIdentity: otherBrand({
          detectedBrand: null,
          evidence: "A serif wordmark this brand does not use, on a frosted bottle.",
        }),
      }),
    );
    const first = result.findings[0].observation;
    assert.match(first, /not a Minimalist creative/i);
    assert.ok(!/packaging, wordmark and type/.test(first), first);
    assert.match(first, /serif wordmark/);
  });
});

describe("confidence normalisation", () => {
  it("treats a bare 1 as certainty, not as one percent", () => {
    // Ambiguous by construction, and resolved deliberately: confidence is only
    // read alongside an affirmative isThisBrand:false, and a model that names a
    // competitor and then rates itself 1% sure is incoherent.
    assert.equal(aggregate(vision({ brandIdentity: otherBrand({ confidence: 1 }) }), []).overall, 0);
  });

  it("still lets a genuinely uncertain percent value through", () => {
    const { verdict } = aggregate(
      vision({ brandIdentity: otherBrand({ confidence: 25 }) }),
      [],
    );
    assert.equal(verdict, "pass");
  });
});

describe("scorer prompt — what the creative was made for", () => {
  it("says so plainly when no placement was stated", () => {
    // The panel used to post a hardcoded meta_feed_4x5, so a square creative
    // was measured against a 4:5 spec nobody had chosen and came back blocked
    // for a craft failure it had not committed.
    const prompt = buildScorerUserPrompt(null, null);
    assert.match(prompt, /Intended placement: not stated/);
    assert.match(prompt, /do not assume a target aspect ratio/i);
    assert.ok(!prompt.includes("1080×1350"), prompt.slice(0, 200));
  });

  it("names the placement when one was stated", () => {
    const prompt = buildScorerUserPrompt(PLACEMENTS.meta_story_9x16, null);
    assert.match(prompt, /1080×1920/);
  });

  it("judges against the objective when one was given", () => {
    const prompt = buildScorerUserPrompt(null, null, null, "retargeting");
    assert.match(prompt, /Campaign objective: retargeting/);
    // The guidance itself, not just the word, or the objective is decoration.
    assert.match(prompt, /against THAT job/);
  });

  it("says the objective is unknown rather than assuming one", () => {
    const prompt = buildScorerUserPrompt(null, null, null, null);
    assert.match(prompt, /Campaign objective: not stated/);
  });
});
