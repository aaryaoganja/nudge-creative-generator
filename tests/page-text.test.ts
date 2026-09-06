import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractText } from "../src/lib/scrape/page-text.ts";

/**
 * An HTML extractor is a pile of regexes, and regexes over HTML are exactly the
 * code that rots silently. These are the fixtures that make it honest.
 *
 * What matters is not that the output is pretty. It is that the material an
 * objection-led brief depends on, the FAQ answers and the ingredient copy,
 * survives, and that the navigation and script noise around it does not.
 */

const PDP = `<!doctype html>
<html>
<head>
  <title>Body Care Kit | Minimalist</title>
  <meta name="description" content="A 3-step body routine.">
  <meta property="og:title" content="Body Care Kit">
  <script>window.theme={money:"Rs. {{amount}}"};var a=1<2;</script>
  <style>.hidden{display:none}</style>
</head>
<body>
  <nav><a href="/">Home</a><a href="/cart">Cart</a><a href="/x">X</a></nav>
  <h1>Body Care Kit</h1>
  <div class="rte">
    <p>Rough, bumpy skin on arms &amp; legs is usually keratosis pilaris.</p>
    <h2>Why it works</h2>
    <ul>
      <li>Salicylic Acid 2% clears the follicle</li>
      <li>Urea 10% softens the plug</li>
    </ul>
    <h2>Frequently asked questions</h2>
    <p>Will it sting on shaved skin? No &ndash; the formula is buffered.</p>
    <p>How long before I see a change? Most people report smoother skin in 4&nbsp;weeks.</p>
  </div>
  <noscript>Enable JavaScript</noscript>
  <svg viewBox="0 0 10 10"><path d="M0 0"/></svg>
  <footer><p>&copy; Minimalist</p></footer>
</body>
</html>`;

describe("decodeEntities", () => {
  it("handles the entities a storefront actually emits", () => {
    assert.equal(decodeEntities("arms &amp; legs"), "arms & legs");
    assert.equal(decodeEntities("4&nbsp;weeks"), "4 weeks");
    assert.equal(decodeEntities("&lt;script&gt;"), "<script>");
  });

  it("handles numeric and hex references", () => {
    assert.equal(decodeEntities("&#8377;810"), "₹810");
    assert.equal(decodeEntities("&#x20B9;810"), "₹810");
  });

  it("handles the footer and symbol entities a theme emits", () => {
    // Every one of these appeared in a real captured Shopify page.
    assert.equal(decodeEntities("&copy; 2026"), "(c) 2026");
    assert.equal(decodeEntities("Minimalist&reg;"), "Minimalist(r)");
    assert.equal(decodeEntities("3&ndash;4 weeks"), "3-4 weeks");
  });

  it("leaves an unknown entity alone rather than mangling it", () => {
    assert.equal(decodeEntities("&notarealentity;"), "&notarealentity;");
  });

  it("refuses codepoints that would throw or produce a lone surrogate", () => {
    // fromCodePoint throws on these; a product page is not worth a 500.
    assert.equal(decodeEntities("&#xD800;"), "&#xD800;");
    assert.equal(decodeEntities("&#1114112;"), "&#1114112;");
    assert.equal(decodeEntities("&#x110000;"), "&#x110000;");
  });
});

describe("extractText", () => {
  const text = extractText(PDP);

  it("keeps the copy a brief is actually built from", () => {
    assert.match(text, /keratosis pilaris/);
    assert.match(text, /Salicylic Acid 2%/);
    assert.match(text, /Urea 10%/);
  });

  it("keeps the FAQ, which is where the objections live", () => {
    // This is the whole reason enrichment exists. "Answer the single biggest
    // objection" is unanswerable from the Shopify description field alone.
    assert.match(text, /Will it sting on shaved skin/);
    assert.match(text, /smoother skin in 4 weeks/);
  });

  it("drops script and style content entirely", () => {
    assert.ok(!text.includes("window.theme"), text);
    assert.ok(!text.includes("display:none"), text);
    // The `1<2` inside the script must not survive as stray markup either.
    assert.ok(!text.includes("var a"), text);
  });

  it("drops noscript and svg", () => {
    assert.ok(!text.includes("Enable JavaScript"), text);
    assert.ok(!text.includes("viewBox"), text);
  });

  it("drops one and two character navigation fragments", () => {
    assert.ok(!/^X$/m.test(text), text);
  });

  it("turns list items into bullets rather than a run-on line", () => {
    assert.match(text, /- Salicylic Acid 2% clears the follicle/);
    assert.ok(
      !/follicle\s*Urea/.test(text),
      "two list items must not collide into one line",
    );
  });

  it("decodes entities in the output", () => {
    assert.match(text, /arms & legs/);
    assert.ok(!text.includes("&amp;"), text);
  });

  it("leaves no angle brackets behind", () => {
    assert.ok(!/[<>]/.test(text), text.slice(0, 400));
  });

  it("does not run paragraphs together", () => {
    assert.ok(text.includes("\n"), "block elements must produce line breaks");
    assert.ok(!/\n{3,}/.test(text), "and must not leave runs of blank lines");
  });

  it("truncates to the requested budget and says it did", () => {
    const short = extractText(PDP, 120);
    assert.ok(short.length <= 120 + "\n[truncated]".length);
    assert.match(short, /\[truncated\]/);
  });

  it("survives malformed markup without throwing", () => {
    // Real themes ship unclosed tags, stray brackets and broken comments.
    for (const nasty of [
      "<p>unclosed",
      "<script>never closed",
      "<!-- unterminated comment",
      "<<>><p>x</p>",
      "",
      "<div".repeat(200),
    ]) {
      assert.doesNotThrow(() => extractText(nasty));
    }
  });
});
