import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  familyForSize,
  planGenerations,
  ratioForFamily,
} from "../src/lib/providers/image.ts";
import { arbitrarySize } from "../src/lib/providers/openai-image.ts";
import { extractInlineImage } from "../src/lib/providers/gemini-image.ts";

/** The placement sizes the tool has to deliver. */
const PLACEMENTS = [
  { name: "meta_feed_square", width: 1080, height: 1080 },
  { name: "meta_feed_portrait", width: 1080, height: 1350 },
  { name: "meta_story", width: 1080, height: 1920 },
  { name: "display_mpu", width: 300, height: 250 },
  { name: "display_large_rect", width: 336, height: 280 },
  { name: "display_leaderboard", width: 728, height: 90 },
  { name: "display_half_page", width: 300, height: 600 },
  { name: "display_skyscraper", width: 160, height: 600 },
  { name: "display_mobile_banner", width: 320, height: 50 },
  { name: "display_billboard", width: 970, height: 250 },
];

describe("aspect families", () => {
  it("groups the placement matrix into a handful of generations", () => {
    const plan = planGenerations(PLACEMENTS);
    // The whole point: ~10 placements must not mean ~10 image-model calls.
    assert.ok(
      plan.size <= 4,
      `expected at most 4 generations, planned ${plan.size}`,
    );
    const covered = [...plan.values()].reduce((n, sizes) => n + sizes.length, 0);
    assert.equal(covered, PLACEMENTS.length);
  });

  it("classifies each placement the way a designer would", () => {
    assert.equal(familyForSize(1080, 1080), "square");
    assert.equal(familyForSize(1080, 1350), "vertical");
    assert.equal(familyForSize(1080, 1920), "vertical");
    assert.equal(familyForSize(300, 250), "square");
    assert.equal(familyForSize(728, 90), "banner");
    assert.equal(familyForSize(160, 600), "banner");
    assert.equal(familyForSize(970, 250), "banner");
  });

  it("picks the correct extreme ratio by orientation", () => {
    assert.equal(ratioForFamily("banner", 728, 90), "8:1");
    assert.equal(ratioForFamily("banner", 160, 600), "1:8");
  });
});

describe("OpenAI arbitrary sizing (gpt-image-2 class)", () => {
  it("returns sizes divisible by 16 on both axes", () => {
    for (const ratio of ["1:1", "4:5", "16:9", "3:2"] as const) {
      const size = arbitrarySize(ratio, "1K");
      assert.ok(size, `${ratio} should be expressible`);
      const [w, h] = size.split("x").map(Number);
      assert.equal(w % 16, 0, `${size} width not divisible by 16`);
      assert.equal(h % 16, 0, `${size} height not divisible by 16`);
    }
  });

  it("refuses ratios outside the documented 1:3–3:1 window", () => {
    // This is why the leaderboard cannot be generated natively by this model,
    // and why the deterministic resize step is not optional.
    assert.equal(arbitrarySize("8:1"), null);
    assert.equal(arbitrarySize("1:8"), null);
    assert.equal(arbitrarySize("4:1"), null);
    assert.equal(arbitrarySize("1:4"), null);
  });

  it("accepts 21:9, which is 2.33:1 and inside the window", () => {
    // Worth pinning: 21:9 reads like an extreme ratio but is not one.
    assert.equal(arbitrarySize("21:9", "1K"), "1024x432");
  });

  it("respects the documented maximum dimensions", () => {
    const size = arbitrarySize("16:9", "4K");
    assert.ok(size);
    const [w, h] = size.split("x").map(Number);
    assert.ok(w <= 3840, `width ${w} exceeds 3840`);
    assert.ok(h <= 2160, `height ${h} exceeds 2160`);
  });
});

describe("Gemini response parsing", () => {
  it("reads the camelCase inlineData shape", () => {
    const image = extractInlineImage({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }] } },
      ],
    });
    assert.equal(image?.data, "AAA");
    assert.equal(image?.mimeType, "image/png");
  });

  it("reads the snake_case inline_data shape", () => {
    // Both spellings appear across API versions; accepting one silently
    // reports "no image returned" on a perfectly good response.
    const image = extractInlineImage({
      candidates: [
        { content: { parts: [{ inline_data: { mime_type: "image/jpeg", data: "BBB" } }] } },
      ],
    });
    assert.equal(image?.data, "BBB");
    assert.equal(image?.mimeType, "image/jpeg");
  });

  it("skips text parts to find the image", () => {
    const image = extractInlineImage({
      candidates: [
        {
          content: {
            parts: [{ text: "Here is your ad" }, { inlineData: { data: "CCC" } }],
          },
        },
      ],
    });
    assert.equal(image?.data, "CCC");
  });

  it("returns null when the request was safety-blocked", () => {
    assert.equal(
      extractInlineImage({ promptFeedback: { blockReason: "SAFETY" } }),
      null,
    );
    assert.equal(extractInlineImage({}), null);
  });
});
