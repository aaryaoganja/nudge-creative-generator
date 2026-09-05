import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ShopifyClient } from "../src/lib/scrape/shopify.ts";
import { safeFetchBinary } from "../src/lib/http/safe-fetch.ts";
import { GeminiTextClient } from "../src/lib/providers/gemini-text.ts";
import { GeminiImageProvider } from "../src/lib/providers/gemini-image.ts";
import { generateBrief, renderImagePrompt } from "../src/lib/pipeline/brief.ts";
import { claimsFrom, PLACEMENTS } from "../src/lib/pipeline/types.ts";
import { checkPolicy } from "../src/lib/policy/check.ts";

/**
 * End-to-end wiring smoke test with the transport stubbed.
 *
 * Every module in the chain runs for real — the URL verifier, the SSRF guard
 * (including live DNS resolution), snapshot normalisation, prompt construction,
 * structured-output parsing, the policy gate, and image-response decoding. Only
 * the HTTP transport is replaced.
 *
 * This catches every wiring fault under our control: schema drift between
 * stages, malformed outbound request bodies, unit errors, import cycles. It
 * cannot catch the one class of fault that lives on the other side of the
 * network — a remote API whose real shape differs from the one coded here.
 * That needs `railway run npm run try`.
 *
 * The stub also RECORDS every outbound request, so the assertions check what we
 * actually send, not just what we do with the reply.
 */

const PRODUCT_JS = {
  id: 8640410419361,
  title: "Hair Growth + Anti-Grey 15.6% Hair Serum",
  handle: "hair-growth-anti-grey-actives-15-6-hair-serum",
  description:
    "<p>An advanced formulation powered by a 15.6% blend of 6 proven actives: Darkenyl, Redensyl, Procapil, AnaGain, Bicapil &amp; Silverfree.</p>",
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

/** Deliberately mixed: concept 2 invents a concentration and must be blocked. */
const BRIEF_JSON = {
  concepts: [
    {
      concept: {
        name: "The number on the front",
        angle: "Lead with the stated concentration as the proof point",
        rationale:
          "The brand prints concentrations on pack; the ad should do the same.",
      },
      copy: {
        headline: "15.6% actives. Stated plainly.",
        subhead: "Six studied actives in one serum",
        primaryText:
          "Formulated with a 15.6% blend of six actives, including Darkenyl. Now ₹810.",
        cta: "Shop Now",
      },
      imagePrompt: {
        scene: "A single serum bottle on a warm sand-toned plaster surface",
        composition: "Centred, generous negative space above and below",
        lighting: "Soft directional daylight from the upper left, long soft shadow",
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
        angle: "Exaggerates the concentration",
        rationale: "Included to prove the gate fires inside the real chain.",
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

/** 1×1 PNG — enough to prove bytes decode and flow through. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

/** Minimal shapes of the outbound bodies, so assertions stay typed. */
interface TextRequestBody {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ parts: Array<{ text?: string }> }>;
  generationConfig: { responseMimeType?: string; responseSchema?: unknown };
}

interface ImageRequestBody {
  contents: Array<{
    parts: Array<{
      text?: string;
      inline_data?: { mime_type: string; data: string };
    }>;
  }>;
  generationConfig: {
    imageConfig: { aspectRatio?: string; imageSize?: string };
  };
}

const recorded: Recorded[] = [];
let realFetch: typeof globalThis.fetch;

function json(payload: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

before(() => {
  realFetch = globalThis.fetch;

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

    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    recorded.push({ url, method: init?.method ?? "GET", body: parsedBody });

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
      // Image model returns inline image data; text model returns JSON text.
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
      return json({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(BRIEF_JSON) }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 3480,
          candidatesTokenCount: 1190,
          totalTokenCount: 4670,
        },
      });
    }

    throw new Error(`Unexpected outbound request in smoke test: ${url}`);
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

describe("pipeline smoke — full chain, stubbed transport", () => {
  it("runs resolve → brief → gate → prompt → image", async () => {
    recorded.length = 0;

    // ── 1. resolve ────────────────────────────────────────────────────────
    const shopify = new ShopifyClient({
      allowedHosts: ["beminimalist.co"],
      currency: "INR",
    });
    const snapshot = await shopify.fetchProduct(
      "https://beminimalist.co/collections/hair/products/hair-growth-anti-grey-actives-15-6-hair-serum?utm_source=meta",
    );

    assert.equal(snapshot.title, PRODUCT_JS.title);
    assert.equal(snapshot.priceMinor, 81000, "minor units preserved");
    assert.equal(snapshot.discountPct, 10);
    assert.deepEqual(snapshot.concentrations, [15.6]);

    // The collection-form URL must have resolved to the bare .js endpoint.
    const shopifyCall = recorded.find((r) => r.url.endsWith(".js"));
    assert.ok(shopifyCall, "no Shopify request recorded");
    assert.equal(
      shopifyCall.url,
      "https://beminimalist.co/products/hair-growth-anti-grey-actives-15-6-hair-serum.js",
    );

    const claims = claimsFrom(snapshot);
    assert.deepEqual(claims.concentrations, ["15.6%"]);
    assert.equal(claims.priceDisplay, "₹810");
    assert.equal(claims.compareAtDisplay, "₹899");

    // ── 2. brief ──────────────────────────────────────────────────────────
    const text = new GeminiTextClient("fake-key", "gemini-3.7-flash");
    const briefResult = await generateBrief(text, {
      snapshot,
      claims,
      placement: PLACEMENTS.meta_feed_4x5,
      objective: "conversion",
      conceptCount: 2,
    });

    assert.equal(briefResult.value.concepts.length, 2);
    assert.equal(briefResult.usage.inputTokens, 3480);
    assert.equal(briefResult.usage.outputTokens, 1190);
    // 3480/1e6*0.75 + 1190/1e6*3.75 = 0.00261 + 0.0044625
    assert.ok(
      Math.abs(briefResult.usage.costUsd - 0.0070725) < 1e-6,
      `cost was ${briefResult.usage.costUsd}`,
    );

    // What we SENT matters as much as what we parsed.
    const textCall = recorded.find(
      (r) => r.url.includes(":generateContent") && !r.url.includes("image"),
    );
    assert.ok(textCall, "no Gemini text request recorded");
    const body = textCall.body as TextRequestBody;
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.ok(body.generationConfig.responseSchema, "responseSchema missing");
    assert.ok(body.systemInstruction, "systemInstruction missing");

    const systemText = body.systemInstruction.parts[0].text;
    assert.match(systemText, /claim lock/i);
    assert.match(systemText, /Drugs and Cosmetics Rules/);

    const userText = body.contents[0].parts[0].text ?? "";
    assert.match(userText, /Percentages you may use: 15\.6%/);
    assert.match(userText, /₹810/);
    assert.match(userText, /1080×1350/);

    // ── 3. policy gate ────────────────────────────────────────────────────
    const gated = briefResult.value.concepts.map((c) => ({
      name: c.concept.name,
      brief: c,
      result: checkPolicy(c, claims),
    }));

    assert.equal(gated[0].result.verdict, "pass", "clean concept should pass");
    assert.equal(
      gated[1].result.verdict,
      "blocked",
      "overclaimed concept must be blocked",
    );

    const blockedRules = new Set(gated[1].result.findings.map((f) => f.ruleId));
    for (const expected of [
      "invented-percentage",
      "invented-price",
      "disease-claim",
      "absolute-claim",
      "unsubstantiated-proof",
    ]) {
      assert.ok(
        blockedRules.has(expected),
        `expected rule ${expected}, got ${[...blockedRules].join(", ")}`,
      );
    }
    // The invented "18% ACTIVES" in image text must be caught too.
    assert.ok(
      gated[1].result.findings.some((f) => f.field.includes("textToRender")),
      "invented claim in image text was not caught",
    );

    const passing = gated.filter((g) => g.result.verdict !== "blocked");
    assert.equal(passing.length, 1);

    // ── 4. prompt ─────────────────────────────────────────────────────────
    const prompt = renderImagePrompt(
      passing[0].brief,
      PLACEMENTS.meta_feed_4x5,
    );
    assert.match(prompt, /1080×1350/);
    assert.match(prompt, /"15\.6% ACTIVES"/);
    assert.match(prompt, /reproduced faithfully/);
    // Brand palette must reach the image model, or it reverts to generic defaults.
    assert.match(prompt, /#F4F1EC/);
    assert.match(prompt, /#1A1A1A/);
    // The generic-skincare-ad markers must be forbidden explicitly, whether or
    // not the copywriter thought to list them.
    assert.match(prompt, /marble/i);
    assert.match(prompt, /tropical leaves/i);
    assert.match(prompt, /gold foil/i);
    // The model's own avoid list survives alongside the brand-level bans.
    assert.match(prompt, /other brands/i);

    // ── 5. reference image + generation ───────────────────────────────────
    const reference = await safeFetchBinary(snapshot.images[0].src, {
      allowedHosts: ["cdn.shopify.com"],
      accept: "image/*",
    });
    assert.ok(reference.bytes > 0, "reference image had no bytes");
    assert.equal(reference.contentType, "image/jpeg");

    const image = new GeminiImageProvider("fake-key", "gemini-3-pro-image");
    const generated = await image.generate({
      prompt,
      aspectRatio: "4:5",
      resolution: "2K",
      referenceImages: [
        { bytes: reference.data, mimeType: "image/jpeg" },
      ],
    });

    assert.equal(generated.mimeType, "image/png");
    assert.ok(generated.bytes.byteLength > 0);
    // PNG magic number — proves base64 decoding produced real image bytes.
    assert.deepEqual(
      Array.from(generated.bytes.slice(0, 4)),
      [0x89, 0x50, 0x4e, 0x47],
    );

    const imageCall = recorded.find(
      (r) => r.url.includes(":generateContent") && r.url.includes("image"),
    );
    assert.ok(imageCall, "no Gemini image request recorded");
    const imageBody = imageCall.body as ImageRequestBody;
    assert.equal(
      imageBody.generationConfig.imageConfig.aspectRatio,
      "4:5",
      "aspect ratio not sent",
    );
    assert.equal(imageBody.generationConfig.imageConfig.imageSize, "2K");
    // The reference photo must actually be attached, or the model invents packaging.
    const parts = imageBody.contents[0].parts;
    assert.ok(
      parts.some((p) => p.text),
      "prompt text missing",
    );
    const inline = parts.find((p) => p.inline_data)?.inline_data;
    assert.ok(inline, "reference image not attached to the request");
    assert.equal(inline.mime_type, "image/jpeg");
    assert.ok(inline.data.length > 0);
  });

  it("rejects a 4:1 banner on Nano Banana Pro before spending", async () => {
    // Pro does not support the extreme ratios; the guard must fire client-side
    // rather than surfacing as a server error after a billable call.
    const image = new GeminiImageProvider("fake-key", "gemini-3-pro-image");
    await assert.rejects(
      () => image.generate({ prompt: "x", aspectRatio: "8:1" }),
      /does not support aspect ratio 8:1/,
    );
  });

  it("surfaces a safety block as a readable error", async () => {
    const before = globalThis.fetch;
    globalThis.fetch = (async () =>
      json({ promptFeedback: { blockReason: "SAFETY" } })) as typeof fetch;
    try {
      const image = new GeminiImageProvider("fake-key", "gemini-3-pro-image");
      await assert.rejects(
        () => image.generate({ prompt: "x", aspectRatio: "1:1" }),
        /No image returned \(SAFETY\)/,
      );
    } finally {
      globalThis.fetch = before;
    }
  });
});
