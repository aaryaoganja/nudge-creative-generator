import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ShopifyClient,
  discountPct,
  extractConcentrations,
  htmlToText,
} from "../src/lib/scrape/shopify.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(here, "fixtures", name), "utf8");

const client = new ShopifyClient({
  allowedHosts: ["beminimalist.co"],
  currency: "INR",
});

describe("money units — the difference between the two endpoints", () => {
  it("reads /products.json decimal strings as major units", () => {
    const [product] = client.parseCatalog(
      fixture("catalog.json"),
      "https://beminimalist.co",
    );
    // "810.00" in the JSON means ₹810.00 → 81000 paise.
    assert.equal(product.priceMinor, 81000);
    assert.equal(product.compareAtPriceMinor, 89900);
  });

  it("reads /products/<handle>.js integers as MINOR units", () => {
    const product = client.parseProductJs(
      fixture("product.json"),
      "https://beminimalist.co/products/x",
      null,
    );
    // 81000 in the JSON is already paise. Treating it as rupees would price
    // this product at ₹81,000 — the bug this test exists to prevent.
    assert.equal(product.priceMinor, 81000);
    assert.equal(product.compareAtPriceMinor, 89900);
  });

  it("agrees across both endpoints for the same product", () => {
    const [fromCatalog] = client.parseCatalog(
      fixture("catalog.json"),
      "https://beminimalist.co",
    );
    const fromProduct = client.parseProductJs(
      fixture("product.json"),
      "https://beminimalist.co/products/x",
      null,
    );
    assert.equal(fromCatalog.priceMinor, fromProduct.priceMinor);
    assert.equal(fromCatalog.shopifyId, fromProduct.shopifyId);
  });
});

describe("variant selection", () => {
  it("prefers the requested variant", () => {
    const [, serum] = client.parseCatalog(
      fixture("catalog.json"),
      "https://beminimalist.co",
    );
    assert.equal(serum.handle, "niacinamide-10-face-serum");
    // The 30ml variant is unavailable, so the available 60ml wins by default.
    assert.equal(serum.variantId, 41000000000002);
    assert.equal(serum.priceMinor, 59900);
  });
});

describe("claim-bearing data", () => {
  it("extracts concentrations from the title", () => {
    assert.deepEqual(
      extractConcentrations("Hair Growth + Anti-Grey 15.6% Hair Serum"),
      [15.6],
    );
    assert.deepEqual(
      extractConcentrations("Niacinamide 10% + Zinc 1% Face Serum"),
      [10, 1],
    );
    assert.deepEqual(extractConcentrations("Gentle Cleanser"), []);
  });

  it("carries concentrations onto the snapshot", () => {
    const product = client.parseProductJs(
      fixture("product.json"),
      "https://beminimalist.co/products/x",
      null,
    );
    assert.deepEqual(product.concentrations, [15.6]);
  });

  it("computes the discount the ad will claim", () => {
    assert.equal(discountPct(81000, 89900), 10);
    assert.equal(discountPct(59900, 69900), 14);
    assert.equal(discountPct(81000, null), null);
    // A compare-at below the price is bad data, not a negative discount.
    assert.equal(discountPct(89900, 81000), null);
  });
});

describe("description handling", () => {
  it("strips tags and decodes entities", () => {
    const text = htmlToText(
      "<p>Darkenyl, Redensyl &amp; Silverfree</p><p>Second line</p>",
    );
    assert.ok(text?.includes("Darkenyl, Redensyl & Silverfree"));
    assert.ok(!text?.includes("<p>"));
  });

  it("drops script and style content entirely", () => {
    const text = htmlToText("<p>Keep</p><script>alert(1)</script>");
    assert.ok(text?.includes("Keep"));
    assert.ok(!text?.includes("alert"));
  });

  it("returns null for empty input", () => {
    assert.equal(htmlToText(null), null);
    assert.equal(htmlToText(""), null);
  });
});

describe("images", () => {
  it("absolutises protocol-relative CDN URLs", () => {
    const [product] = client.parseCatalog(
      fixture("catalog.json"),
      "https://beminimalist.co",
    );
    for (const img of product.images) {
      assert.ok(
        img.src.startsWith("https://"),
        `expected absolute https URL, got ${img.src}`,
      );
    }
  });

  it("keeps dimensions where Shopify reports them", () => {
    const [product] = client.parseCatalog(
      fixture("catalog.json"),
      "https://beminimalist.co",
    );
    assert.equal(product.images[0].width, 1103);
    assert.equal(product.images[0].height, 1600);
    // Portrait styled shots, not square white-background packshots —
    // the finding recorded in docs/ARCHITECTURE.md §24.5.
    assert.ok(product.images[0].height > product.images[0].width);
  });
});

describe("malformed input", () => {
  it("throws a readable error on non-JSON", () => {
    assert.throws(
      () => client.parseCatalog("<!doctype html><html>", "https://beminimalist.co"),
      /not valid JSON/,
    );
  });

  it("throws a readable error when the shape is wrong", () => {
    assert.throws(
      () => client.parseCatalog('{"products":[{"nope":1}]}', "https://x.co"),
      /Unexpected catalogue JSON/,
    );
  });
});
