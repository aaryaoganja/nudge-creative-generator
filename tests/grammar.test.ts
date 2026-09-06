import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARCHETYPE_NAMES,
  BRAND_VISUAL,
  CREATIVE_GRAMMAR,
  archetypeByName,
  archetypesFor,
  orientationOf,
} from "../config/brand.ts";
import { buildSystemPrompt, buildUserPrompt, renderImagePrompt } from "../src/lib/pipeline/brief.ts";
import { PLACEMENTS } from "../src/lib/pipeline/types.ts";
import type { ProductSnapshot } from "../src/lib/scrape/shopify.ts";

/**
 * The creative grammar is the part of this system that decides whether a
 * generation looks like the client's live banners or like any competent
 * skincare ad. It shipped once as a 260-line config that nothing imported —
 * every constraint in it satisfied, and none of it reaching a model. These
 * tests exist so that cannot happen again quietly.
 */

const SNAPSHOT = {
  title: "Hair Growth + Anti-Grey 15.6% Hair Serum",
  productType: "Hair Care",
  tags: [],
  images: [],
  concentrations: [15.6],
  priceMinor: 81000,
  compareAtPriceMinor: 89900,
  discountPct: 10,
  descriptionText: "A 15.6% blend of six actives.",
  sourceUrl: "https://beminimalist.co/products/x",
} as unknown as ProductSnapshot;

const CLAIMS = {
  concentrations: ["15.6%"],
  priceDisplay: "₹810",
  compareAtDisplay: "₹899",
  discountPct: 10,
};

function userPrompt(placement: (typeof PLACEMENTS)[keyof typeof PLACEMENTS]) {
  return buildUserPrompt({
    snapshot: SNAPSHOT,
    claims: CLAIMS as never,
    placement,
    objective: "conversion",
    conceptCount: 2,
  });
}

describe("orientation", () => {
  it("classifies every shipped placement", () => {
    assert.equal(orientationOf(1200, 628), "wide");
    assert.equal(orientationOf(1080, 1080), "square");
    assert.equal(orientationOf(1080, 1350), "tall");
    assert.equal(orientationOf(1080, 1920), "tall");
  });
});

describe("archetype selection follows the frame", () => {
  it("offers the banner layouts in a wide frame", () => {
    const names = archetypesFor(1200, 628).map((a) => a.name);
    assert.ok(names.includes("Labelled range"), names.join(", "));
    assert.ok(names.includes("Formula callout"));
    // A single centred plinth in a 1.91:1 banner leaves two thirds of the
    // frame empty on either side.
    assert.ok(!names.includes("Single plinth"), names.join(", "));
  });

  it("withholds the busiest layout from a tall frame", () => {
    // The regression this whole change exists for: a 9:16 story was being
    // briefed as a left-type-stack banner because the split was hardcoded into
    // placement-independent composition rules.
    const names = archetypesFor(1080, 1920).map((a) => a.name);
    assert.ok(!names.includes("Labelled range"), names.join(", "));
    assert.ok(names.includes("Single plinth"));
  });

  it("never returns an empty set", () => {
    for (const [w, h] of [[100, 1000], [1000, 100], [1, 1]]) {
      assert.ok(archetypesFor(w, h).length > 0, `${w}x${h}`);
    }
  });

  it("declares a stacked rearrangement wherever it claims to work tall", () => {
    for (const a of CREATIVE_GRAMMAR.archetypes) {
      if (a.orientations.includes("tall")) {
        assert.ok(a.stacked, `${a.name} claims "tall" with no stacked layout`);
      }
    }
  });
});

describe("the grammar is internally consistent", () => {
  it("names only devices that exist", () => {
    const known = new Set(CREATIVE_GRAMMAR.devices.map((d) => d.name));
    for (const a of CREATIVE_GRAMMAR.archetypes) {
      for (const device of a.usesDevices) {
        assert.ok(known.has(device), `${a.name} uses unknown device "${device}"`);
      }
    }
  });

  it("keeps every archetype inside the two-device restraint rule", () => {
    // `restraint` caps a creative at two devices besides the CTA. An archetype
    // is a menu, not a checklist, so three is allowed to be OFFERED — but the
    // rule that caps use has to travel with it into the image prompt.
    for (const a of CREATIVE_GRAMMAR.archetypes) {
      assert.ok(a.usesDevices.length <= 3, `${a.name} offers ${a.usesDevices.length}`);
    }
    assert.ok(
      CREATIVE_GRAMMAR.restraint.some((r) => /at most two devices/i.test(r)),
      "the cap itself is missing from restraint",
    );
  });

  it("exposes every archetype name for the response schema", () => {
    assert.deepEqual(
      [...ARCHETYPE_NAMES].sort(),
      CREATIVE_GRAMMAR.archetypes.map((a) => a.name).sort(),
    );
    for (const name of ARCHETYPE_NAMES) {
      assert.ok(archetypeByName(name), name);
    }
  });

  it("keeps the banner split out of the placement-independent rules", () => {
    // BRAND_VISUAL.composition applies to every frame, so a 45/55 left-right
    // split has no business in it. The negative-space rule legitimately says
    // "35–45%", hence matching the split itself rather than any percentage.
    const joined = BRAND_VISUAL.composition.join(" ").toLowerCase();
    assert.ok(!/\bsplit frame\b/.test(joined), joined);
    assert.ok(!/\bleft type stack\b/.test(joined), joined);
    assert.ok(!/roughly 45%/.test(joined), joined);
  });

  it("holds one hex or none, never prose in the hex column", () => {
    for (const entry of BRAND_VISUAL.palette) {
      if (entry.hex === null) continue;
      assert.match(entry.hex, /^#[0-9A-F]{6}$/i, `${entry.name}: ${entry.hex}`);
    }
    // The accent is the deliberate null — it is sampled from the pack.
    assert.equal(
      BRAND_VISUAL.palette.filter((c) => c.hex === null).length,
      1,
    );
  });
});

describe("the grammar reaches the model", () => {
  it("carries the devices and their construction rules into the system prompt", () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes(CREATIVE_GRAMMAR.summary));
    for (const device of CREATIVE_GRAMMAR.devices) {
      assert.ok(prompt.includes(device.name), `missing device: ${device.name}`);
    }
    for (const prop of CREATIVE_GRAMMAR.props) {
      assert.ok(prompt.includes(prop.name), `missing prop: ${prop.name}`);
    }
    assert.match(prompt, /1px, Hairline grey/);
    assert.match(prompt, /sharp 0px corners/);
  });

  it("offers a 9:16 brief only the layouts that fit it", () => {
    const prompt = userPrompt(PLACEMENTS.meta_story_9x16);
    assert.match(prompt, /TALL frame/);
    assert.ok(prompt.includes("Single plinth"));
    assert.ok(!prompt.includes("Labelled range"), "offered a layout that cannot be built");
    // The tall rearrangement, not the banner description, is what it must build.
    assert.match(prompt, /In THIS frame:/);
  });

  it("offers a landscape brief the banner layouts", () => {
    const prompt = userPrompt(PLACEMENTS.google_landscape);
    assert.match(prompt, /WIDE frame/);
    assert.ok(prompt.includes("Labelled range"));
    assert.ok(!prompt.includes("In THIS frame:"), "applied a stacked layout to a banner");
  });
});

function imagePrompt(layoutArchetype: string) {
  return {
    imagePrompt: {
      layoutArchetype,
      scene: "A serum bottle on a white cylinder",
      composition: "Centred",
      lighting: "Even and diffuse",
      palette: "Paper white and Ink",
      productPlacement: "Centre",
      textToRender: ["15.6% ACTIVES"],
      typography: "Geometric sans",
      avoid: ["beach umbrellas"],
    },
  };
}

describe("renderImagePrompt expands the chosen archetype", () => {
  it("emits the construction rules for exactly the devices that layout uses", () => {
    const rendered = renderImagePrompt(
      imagePrompt("Formula callout"),
      PLACEMENTS.meta_feed_4x5,
    );
    assert.match(rendered, /Layout: Formula callout/);
    assert.ok(rendered.includes("Solid eyebrow chip"));
    assert.ok(rendered.includes("Accent phrase"));
    // Devices belonging to other layouts must not travel with it: the prompt
    // budget is per image, and `restraint` caps a creative at two devices.
    assert.ok(!rendered.includes("Bordered testimonial card"), rendered);
    assert.ok(!rendered.includes("Bordered stat box"));
  });

  it("uses the stacked rearrangement in a tall frame and not in a wide one", () => {
    const tall = renderImagePrompt(
      imagePrompt("Offer block"),
      PLACEMENTS.meta_story_9x16,
    );
    const wide = renderImagePrompt(
      imagePrompt("Offer block"),
      PLACEMENTS.google_landscape,
    );
    const stacked = archetypeByName("Offer block")?.stacked ?? "";
    assert.ok(stacked.length > 0);
    assert.ok(tall.includes(stacked));
    assert.ok(!wide.includes(stacked));
  });

  it("degrades to the model's own composition when the name is unknown", () => {
    // The schema takes a string rather than an enum so that renaming a row in
    // config/brand.ts cannot turn every generation into a validation failure.
    const rendered = renderImagePrompt(imagePrompt("Diagonal split"), PLACEMENTS.meta_feed_4x5);
    assert.ok(!rendered.includes("Layout:"), rendered);
    assert.match(rendered, /Composition: Centred/);
  });

  it("never prints prose where a hex value belongs", () => {
    const rendered = renderImagePrompt(
      imagePrompt("Single plinth"),
      PLACEMENTS.meta_feed_4x5,
    );
    assert.match(rendered, /#F4F1EC {2}Bone/);
    assert.ok(!rendered.includes("(sampled from the pack in the reference image)  Product accent"));
    assert.match(rendered, /\(no fixed value\) {2}Product accent/);
  });
});
