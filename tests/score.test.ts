import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  buildScorerUserPrompt,
  DIMENSIONS,
  WEIGHTS,
  type VisionScore,
} from "../src/lib/pipeline/score.ts";
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
    competingBrandVisible: false,
    findings: [],
    doMore: [],
    doLess: [],
    summary: "Clean, on-brand.",
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

  it("BLOCKS when a competing brand is visible", () => {
    assert.equal(
      aggregate(vision({ competingBrandVisible: true }), []).verdict,
      "blocked",
    );
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
    assert.match(prompt, /Unverified —/);
    // Must not silently pass or silently fail the unverifiable claims.
    assert.match(prompt, /do NOT assume it is wrong/i);
    assert.match(prompt, /Do NOT assume a claim is correct/i);
    // Everything judgeable from the image alone is still scored normally.
    assert.match(prompt, /can all\s*\n?still be judged/);
  });
});
