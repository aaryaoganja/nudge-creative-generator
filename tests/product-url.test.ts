import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProductUrl } from "../src/lib/scrape/product-url.ts";

const HOSTS = ["beminimalist.co", "global.beminimalist.co"];

describe("parseProductUrl — accepted shapes", () => {
  it("accepts the bare /products/<handle> form", () => {
    const r = parseProductUrl(
      "https://beminimalist.co/products/niacinamide-10-face-serum",
      HOSTS,
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.handle, "niacinamide-10-face-serum");
  });

  it("accepts /collections/<c>/products/<handle> — the address-bar form", () => {
    // Regression guard. A naive /^\/products\// check rejects this, and it is
    // the URL people actually copy after browsing a collection.
    const r = parseProductUrl(
      "https://beminimalist.co/collections/serums/products/niacinamide-10-face-serum",
      HOSTS,
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.handle, "niacinamide-10-face-serum");
    assert.equal(
      r.ok && r.jsonUrl,
      "https://beminimalist.co/products/niacinamide-10-face-serum.js",
    );
  });

  it("accepts a locale-prefixed path on the international storefront", () => {
    const r = parseProductUrl(
      "https://global.beminimalist.co/en-in/products/salicylic-acid-02",
      HOSTS,
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.handle, "salicylic-acid-02");
  });

  it("tolerates a trailing slash", () => {
    const r = parseProductUrl(
      "https://beminimalist.co/products/vitamin-c-10/",
      HOSTS,
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.handle, "vitamin-c-10");
  });
});

describe("parseProductUrl — canonicalisation", () => {
  it("preserves ?variant= because price and image depend on it", () => {
    const r = parseProductUrl(
      "https://beminimalist.co/products/niacinamide-10-face-serum?variant=41000000000002",
      HOSTS,
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.variantId, "41000000000002");
    assert.ok(r.ok && r.canonical.includes("variant=41000000000002"));
  });

  it("strips tracking params but keeps variant", () => {
    const r = parseProductUrl(
      "https://beminimalist.co/products/x?utm_source=meta&fbclid=abc&variant=99&gclid=z",
      HOSTS,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(!r.canonical.includes("utm_source"));
    assert.ok(!r.canonical.includes("fbclid"));
    assert.ok(!r.canonical.includes("gclid"));
    assert.ok(r.canonical.includes("variant=99"));
  });

  it("produces one cache key for URLs differing only by tracking noise", () => {
    const a = parseProductUrl(
      "https://beminimalist.co/products/x?utm_campaign=diwali&variant=7",
      HOSTS,
    );
    const b = parseProductUrl(
      "https://beminimalist.co/products/x?variant=7&fbclid=q#reviews",
      HOSTS,
    );
    assert.equal(a.ok && b.ok && a.canonical, b.ok ? b.canonical : "mismatch");
  });

  it("does NOT collapse different variants to the same key", () => {
    const a = parseProductUrl("https://beminimalist.co/products/x?variant=1", HOSTS);
    const b = parseProductUrl("https://beminimalist.co/products/x?variant=2", HOSTS);
    assert.notEqual(a.ok && a.canonical, b.ok && b.canonical);
  });
});

describe("parseProductUrl — rejections name the actual problem", () => {
  it("rejects a collection page with a usable message", () => {
    const r = parseProductUrl("https://beminimalist.co/collections/skin", HOSTS);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "collection_page");
    assert.match(!r.ok ? r.message : "", /collection page/i);
  });

  it("rejects the home page", () => {
    const r = parseProductUrl("https://beminimalist.co/", HOSTS);
    assert.equal(!r.ok && r.reason, "home_page");
  });

  it("rejects a blog article", () => {
    const r = parseProductUrl("https://beminimalist.co/blogs/skin-care/x", HOSTS);
    assert.equal(!r.ok && r.reason, "blog_page");
  });

  it("rejects an off-allowlist host", () => {
    const r = parseProductUrl("https://example.com/products/x", HOSTS);
    assert.equal(!r.ok && r.reason, "host_not_allowed");
  });

  it("rejects http", () => {
    const r = parseProductUrl("http://beminimalist.co/products/x", HOSTS);
    assert.equal(!r.ok && r.reason, "scheme_not_allowed");
  });

  it("rejects a lookalike host that merely contains the domain", () => {
    const r = parseProductUrl(
      "https://beminimalist.co.evil.example/products/x",
      HOSTS,
    );
    assert.equal(!r.ok && r.reason, "host_not_allowed");
  });

  it("accepts a genuine subdomain", () => {
    const r = parseProductUrl("https://shop.beminimalist.co/products/x", HOSTS);
    assert.equal(r.ok, true);
  });
});
