import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConceptBriefSchema } from "../src/lib/pipeline/types.ts";
import { renderImagePrompt, buildSystemPrompt } from "../src/lib/pipeline/brief.ts";
import { PLACEMENTS } from "../src/lib/pipeline/types.ts";
import { BRAND_VISUAL } from "../config/brand.ts";
import { describeSchemaFailure } from "../src/lib/providers/gemini-text.ts";

function brief(avoid: string[]) {
  return {
    concept: { name: "C", angle: "A", rationale: "R" },
    copy: {
      headline: "SPF 50, stated plainly",
      subhead: "Daily protection",
      primaryText: "Broad spectrum SPF 50.",
      cta: "Shop Now" as const,
    },
    imagePrompt: {
      scene: "Studio",
      composition: "Off-centre",
      lighting: "Soft",
      palette: "Sand",
      productPlacement: "Lower third",
      textToRender: ["SPF 50"],
      typography: "Geometric sans",
      avoid,
    },
  };
}

describe("avoid array — the cap that made every generation fail", () => {
  it("accepts more entries than there are brand-wide bans", () => {
    // The old cap was 10 and BRAND_VISUAL.neverDepict has exactly 10 entries,
    // while the prompt ordered the model to echo all of them. One additional
    // concept-specific avoid therefore broke schema validation every time.
    const avoid = [...BRAND_VISUAL.neverDepict, "beach umbrellas", "sunglasses"];
    assert.ok(avoid.length > 10);
    const parsed = ConceptBriefSchema.safeParse(brief(avoid));
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  it("still rejects an unbounded list", () => {
    const parsed = ConceptBriefSchema.safeParse(
      brief(Array.from({ length: 40 }, (_, i) => `item ${i}`)),
    );
    assert.equal(parsed.success, false);
  });
});

describe("the prompt no longer contradicts the schema", () => {
  it("tells the model NOT to repeat the brand-wide bans", () => {
    const system = buildSystemPrompt();
    assert.match(system, /Do NOT repeat it/);
    assert.match(system, /only exclusions specific to YOUR concept/);
  });

  it("still states the bans so the model knows the register to avoid", () => {
    const system = buildSystemPrompt();
    assert.match(system, /marble/i);
    assert.match(system, /gold foil/i);
  });

  it("asks for an explicit reading order", () => {
    const system = buildSystemPrompt();
    assert.match(system, /Reading order/i);
    assert.match(system, /FIRST/);
    assert.match(system, /If everything is/);
  });
});

describe("renderImagePrompt merges the bans the model was told to skip", () => {
  it("injects every brand-wide ban even when the model listed none", () => {
    const prompt = renderImagePrompt(brief([]), PLACEMENTS.meta_feed_4x5);
    for (const ban of BRAND_VISUAL.neverDepict) {
      assert.ok(
        prompt.includes(ban),
        `brand ban missing from prompt: "${ban}"`,
      );
    }
  });

  it("does not duplicate a ban the model happened to repeat", () => {
    const repeated = BRAND_VISUAL.neverDepict[0];
    const prompt = renderImagePrompt(brief([repeated]), PLACEMENTS.meta_feed_4x5);
    const occurrences = prompt.split(repeated).length - 1;
    assert.equal(occurrences, 1, `"${repeated}" appeared ${occurrences} times`);
  });
});

describe("schema failures are readable, not raw Zod JSON", () => {
  it("names the field and the problem in a sentence", () => {
    const parsed = ConceptBriefSchema.safeParse(
      brief(Array.from({ length: 40 }, (_, i) => `x${i}`)),
    );
    assert.equal(parsed.success, false);
    const message = describeSchemaFailure(parsed.error);
    assert.match(message, /imagePrompt\.avoid/);
    assert.match(message, /could not accept/);
    // The marketer-facing string must not be a JSON dump.
    assert.ok(!message.includes('"code"'), "leaked raw Zod JSON");
    assert.ok(!message.includes("[ {"), "leaked raw Zod JSON");
  });

  it("falls back gracefully on a non-Zod error", () => {
    assert.match(
      describeSchemaFailure(new Error("boom")),
      /did not match the expected shape: boom/,
    );
  });
});
