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
      layoutArchetype: "Single plinth",
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

describe("an offer the operator typed is an authorised claim", () => {
  /**
   * The prompt tells the model to print the offer "verbatim". The gate used to
   * have never heard of it, so obeying that instruction produced a blocking
   * invented-percentage finding and the concept was dropped before any image
   * was generated. The model's only other option was to silently drop the
   * number the marketer typed. Both broke the promise on the field's label.
   */
  it("permits a percentage that appears in the offer", () => {
    const withOffer = brief({ headline: "20% off this week" });

    // Without the offer, this is exactly the invented claim the gate exists for.
    const unauthorised = checkPolicy(withOffer, CLAIMS);
    assert.equal(unauthorised.verdict, "blocked");
    assert.ok(
      unauthorised.findings.some((f) => f.ruleId === "invented-percentage"),
    );

    // With it, the same copy is legitimate.
    const authorised = checkPolicy(withOffer, CLAIMS, {
      offer: "20% off this week",
    });
    assert.ok(
      !authorised.findings.some((f) => f.ruleId === "invented-percentage"),
      JSON.stringify(authorised.findings),
    );
  });

  it("permits a rupee figure that appears in the offer", () => {
    const copy = brief({ primaryText: "Free shipping over ₹499." });
    assert.equal(checkPolicy(copy, CLAIMS).verdict, "blocked");
    assert.ok(
      !checkPolicy(copy, CLAIMS, { offer: "Free shipping over ₹499" }).findings.some(
        (f) => f.ruleId === "invented-price",
      ),
    );
  });

  it("matches a comma-formatted offer against the copy's plain figure", () => {
    // The scanner normalises "₹1,499" to "₹1499", so the allow-list has to be
    // normalised the same way or an authorised figure still blocks.
    const copy = brief({ primaryText: "Yours for ₹1499." });
    assert.ok(
      !checkPolicy(copy, CLAIMS, { offer: "Bundle at ₹1,499" }).findings.some(
        (f) => f.ruleId === "invented-price",
      ),
    );
  });

  it("authorises only the exact figures typed, never their neighbours", () => {
    // A 20% offer must not become licence to write 25%. The gate widens by
    // literal, not by pattern.
    const copy = brief({ headline: "25% off this week" });
    const result = checkPolicy(copy, CLAIMS, { offer: "20% off this week" });
    assert.equal(result.verdict, "blocked");
    assert.ok(result.findings.some((f) => f.evidence === "25%"));
  });

  it("changes nothing when there is no offer", () => {
    const copy = brief({ headline: "15.6% actives, stated plainly" });
    assert.deepEqual(
      checkPolicy(copy, CLAIMS).findings,
      checkPolicy(copy, CLAIMS, { offer: null }).findings,
    );
  });
});
