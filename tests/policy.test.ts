import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPolicy, verdictFor } from "../src/lib/policy/check.ts";
import { claimsFrom } from "../src/lib/pipeline/types.ts";
import type { ConceptBrief } from "../src/lib/pipeline/types.ts";

/** The real product, so the fixtures exercise real numbers. */
const CLAIMS = claimsFrom({
  concentrations: [15.6],
  priceMinor: 81000,
  compareAtPriceMinor: 89900,
  discountPct: 10,
  currency: "INR",
});

function brief(overrides: {
  headline?: string;
  subhead?: string;
  primaryText?: string;
  textToRender?: string[];
}): ConceptBrief {
  return {
    concept: {
      name: "Test concept",
      angle: "Ingredient-led",
      rationale: "Leads with the active concentration.",
    },
    copy: {
      headline: overrides.headline ?? "15.6% actives, stated plainly",
      subhead: overrides.subhead ?? "Six studied actives in one serum",
      primaryText:
        overrides.primaryText ??
        "Formulated with a 15.6% blend of six actives. ₹810.",
      cta: "Shop Now",
    },
    imagePrompt: {
      scene: "Studio",
      composition: "Centred",
      lighting: "Soft",
      palette: "Warm neutral",
      productPlacement: "Centre",
      textToRender: overrides.textToRender ?? ["15.6% actives"],
      typography: "Clean sans",
      avoid: ["other brands"],
    },
  };
}

describe("claim lock — invented numbers", () => {
  it("passes a concentration the product actually states", () => {
    const result = checkPolicy(brief({}), CLAIMS);
    const invented = result.findings.filter(
      (f) => f.ruleId === "invented-percentage",
    );
    assert.deepEqual(invented, []);
  });

  it("BLOCKS a concentration the product does not state", () => {
    // The exact failure mode the whole design exists to catch: 15.6 → 15.8.
    const result = checkPolicy(
      brief({ headline: "15.8% actives, stated plainly" }),
      CLAIMS,
    );
    const invented = result.findings.find(
      (f) => f.ruleId === "invented-percentage",
    );
    assert.ok(invented, "expected an invented-percentage finding");
    assert.equal(invented.severity, "blocking");
    assert.equal(result.verdict, "blocked");
  });

  it("BLOCKS an invented percentage hidden in the image text", () => {
    // Rendering a claim is making a claim. Text destined for the image model is
    // checked exactly like copy.
    const result = checkPolicy(
      brief({ textToRender: ["Now with 20% actives"] }),
      CLAIMS,
    );
    const invented = result.findings.find(
      (f) => f.ruleId === "invented-percentage",
    );
    assert.ok(invented);
    assert.match(invented.field, /textToRender/);
    assert.equal(result.verdict, "blocked");
  });

  it("allows the computed discount percentage", () => {
    const result = checkPolicy(brief({ subhead: "10% off this week" }), CLAIMS);
    assert.deepEqual(
      result.findings.filter((f) => f.ruleId === "invented-percentage"),
      [],
    );
  });

  it("BLOCKS a wrong price", () => {
    const result = checkPolicy(
      brief({ primaryText: "Six studied actives. Now ₹610." }),
      CLAIMS,
    );
    const invented = result.findings.find((f) => f.ruleId === "invented-price");
    assert.ok(invented);
    assert.equal(result.verdict, "blocked");
  });

  it("allows both the price and the compare-at price", () => {
    const result = checkPolicy(
      brief({ primaryText: "₹810, down from ₹899." }),
      CLAIMS,
    );
    assert.deepEqual(
      result.findings.filter((f) => f.ruleId === "invented-price"),
      [],
    );
  });

  it("permits no numeric claim at all when the product states none", () => {
    const empty = claimsFrom({
      concentrations: [],
      priceMinor: null,
      compareAtPriceMinor: null,
      discountPct: null,
      currency: "INR",
    });
    const result = checkPolicy(brief({ headline: "10% niacinamide" }), empty);
    assert.equal(result.verdict, "blocked");
  });
});

describe("regulatory rules", () => {
  it("blocks disease-treatment claims", () => {
    const result = checkPolicy(brief({ headline: "Cures hair fall" }), CLAIMS);
    assert.ok(result.findings.some((f) => f.ruleId === "disease-claim"));
    assert.equal(result.verdict, "blocked");
  });

  it("blocks absolute and guarantee claims", () => {
    for (const headline of [
      "Guaranteed results",
      "Permanently removes grey",
      "100% effective formula",
    ]) {
      const result = checkPolicy(brief({ headline }), CLAIMS);
      assert.equal(result.verdict, "blocked", `"${headline}" should block`);
    }
  });

  it("flags unsubstantiated proof claims for revision", () => {
    const result = checkPolicy(
      brief({ subhead: "Clinically proven to work" }),
      CLAIMS,
    );
    assert.ok(
      result.findings.some((f) => f.ruleId === "unsubstantiated-proof"),
    );
    assert.equal(result.verdict, "fix_required");
  });

  it("flags fear-based framing, which is off-voice for this brand", () => {
    const result = checkPolicy(
      brief({ primaryText: "Hide your grey hair before anyone notices." }),
      CLAIMS,
    );
    assert.ok(result.findings.some((f) => f.ruleId === "fear-based"));
  });

  it("blocks named competitor comparisons", () => {
    const result = checkPolicy(
      brief({ headline: "Better than Mamaearth" }),
      CLAIMS,
    );
    assert.ok(result.findings.some((f) => f.ruleId === "competitor-mention"));
    assert.equal(result.verdict, "blocked");
  });
});

describe("copy limits", () => {
  it("flags an over-long headline before it reaches the renderer", () => {
    const result = checkPolicy(
      brief({ headline: "x".repeat(60) }),
      CLAIMS,
    );
    const finding = result.findings.find((f) => f.ruleId === "copy-length");
    assert.ok(finding);
    assert.equal(finding.severity, "minor");
  });
});

describe("verdict is separate from severity mix", () => {
  it("blocking beats everything else present", () => {
    assert.equal(
      verdictFor([
        { ruleId: "a", severity: "minor", field: "x", evidence: "", message: "" },
        { ruleId: "b", severity: "blocking", field: "y", evidence: "", message: "" },
      ]),
      "blocked",
    );
  });

  it("a clean brief passes", () => {
    assert.equal(verdictFor([]), "pass");
  });
});
