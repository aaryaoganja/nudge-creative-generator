/**
 * Offline transport stub — development only, never imported by the app.
 *
 * Replaces globalThis.fetch with canned Shopify and Gemini responses so the
 * real CLI can be exercised end to end without network access, API keys or
 * spend:
 *
 *   GEMINI_API_KEY=fake node --import ./scripts/dev-stub-transport.ts \
 *     scripts/try.ts https://beminimalist.co/products/<handle>
 *
 * Everything except the transport runs for real — argument parsing, the URL
 * verifier, the SSRF guard including live DNS, prompt construction, the policy
 * gate, cost accounting and file output. What it cannot verify is whether the
 * remote APIs actually accept the request shapes; that needs a live key.
 */

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PRODUCT_JS = {
  id: 8640410419361,
  title: "Hair Growth + Anti-Grey 15.6% Hair Serum",
  handle: "hair-growth-anti-grey-actives-15-6-hair-serum",
  description:
    "<p>An advanced formulation powered by a 15.6% blend of 6 proven actives: Darkenyl, Redensyl, Procapil, AnaGain, Bicapil &amp; Silverfree. At its core is Darkenyl, which visibly reduces grey hair density.</p>",
  vendor: "Minimalist",
  type: "Hair Care",
  tags: ["Anti-Hairfall", "Hair Growth"],
  variants: [
    {
      id: 46795996299425,
      title: "Default Title",
      sku: "8906128102065",
      available: true,
      price: 81000,
      compare_at_price: 89900,
    },
  ],
  media: [
    {
      position: 1,
      src: "https://cdn.shopify.com/s/files/1/0410/9608/5665/files/hero.jpg?v=1",
      width: 1103,
      height: 1600,
    },
  ],
};

const BRIEF_JSON = {
  concepts: [
    {
      concept: {
        name: "The number on the front",
        angle: "Lead with the stated concentration as the proof point",
        rationale:
          "The brand prints concentrations on the pack; the ad should do the same.",
      },
      copy: {
        headline: "15.6% actives. Stated plainly.",
        subhead: "Six studied actives, one serum",
        primaryText:
          "A 15.6% blend of six actives including Darkenyl, formulated for hair growth and grey density. ₹810.",
        cta: "Shop Now",
      },
      imagePrompt: {
        scene: "A single serum bottle on a warm sand-toned plaster surface",
        composition: "Centred with generous negative space above and below",
        lighting:
          "Soft directional daylight from the upper left casting a long soft shadow",
        palette: "Warm sand, bone white, deep charcoal type",
        productPlacement: "Lower third, upright, label facing camera",
        textToRender: ["15.6% ACTIVES"],
        typography: "Clean geometric sans, tight tracking, charcoal on sand",
        avoid: ["other brands", "human faces", "watermarks", "clutter"],
      },
    },
    {
      concept: {
        name: "Overclaimed variant",
        angle: "Deliberately non-compliant, to exercise the gate",
        rationale: "Proves the policy gate fires before any image spend.",
      },
      copy: {
        headline: "18% actives, guaranteed",
        subhead: "Clinically proven to reverse grey",
        primaryText: "Cures grey hair permanently. Only ₹610.",
        cta: "Buy Now",
      },
      imagePrompt: {
        scene: "Bottle on marble",
        composition: "Centred",
        lighting: "Hard studio light",
        palette: "Cool grey",
        productPlacement: "Centre",
        textToRender: ["18% ACTIVES"],
        typography: "Bold sans",
        avoid: ["clutter"],
      },
    },
  ],
};

const SCORE_JSON = {
  extractedText: ["15.6% ACTIVES", "Minimalist", "₹810"],
  dimensionScores: {
    brand_fit: 82,
    compliance: 91,
    clarity: 78,
    craft: 80,
    stopping_power: 68,
  },
  readsAsGenericSkincareAd: false,
  genericMarkers: [],
  competingBrandVisible: false,
  findings: [
    {
      severity: "minor",
      dimension: "clarity",
      observation:
        "The concentration figure and the product name compete for first read.",
      action:
        "Increase 15.6% to roughly twice the size of the product name so the number leads.",
      verified: true,
    },
    {
      severity: "major",
      dimension: "stopping_power",
      observation:
        "The composition is centred and static, which reads as a packshot rather than an ad.",
      action:
        "Offset the bottle to the left third and let the headline occupy the upper right.",
      verified: true,
    },
  ],
  doMore: [
    "Lead with the concentration figure at the largest type size",
    "Keep the negative space — it is what separates this from category noise",
  ],
  doLess: [
    "Centred symmetry; it flattens the hierarchy",
    "Secondary supporting copy that repeats the headline",
  ],
  summary:
    "On-brand and compliant. The hierarchy needs work before it will stop a thumb.",
};

function json(payload: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const rawBody = typeof init?.body === "string" ? init.body : "";

  if (url.includes("/products/") && url.endsWith(".js")) {
    return json(PRODUCT_JS, "application/javascript");
  }

  if (url.startsWith("https://cdn.shopify.com/")) {
    return new Response(Buffer.from(TINY_PNG_B64, "base64"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }

  if (url.includes(":generateContent")) {
    if (url.includes("image")) {
      return json({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { mimeType: "image/png", data: TINY_PNG_B64 } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      });
    }
    // The scorer is the text model called WITH an image attached.
    const isVisionScore = rawBody.includes("inline_data");
    return json({
      candidates: [
        {
          content: {
            parts: [
              { text: JSON.stringify(isVisionScore ? SCORE_JSON : BRIEF_JSON) },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: isVisionScore
        ? {
            promptTokenCount: 4520,
            candidatesTokenCount: 680,
            totalTokenCount: 5200,
          }
        : {
            promptTokenCount: 3480,
            candidatesTokenCount: 1190,
            totalTokenCount: 4670,
          },
    });
  }

  throw new Error(`dev-stub-transport: unexpected request to ${url}`);
}) as typeof globalThis.fetch;

console.error("⚠ dev-stub-transport active — no real network, no spend\n");
