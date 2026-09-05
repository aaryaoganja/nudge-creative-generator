import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPage,
  tidyMarkdown,
  tryScrapePage,
} from "../src/lib/scrape/firecrawl.ts";

describe("extractPage — tolerates both response envelopes", () => {
  it("reads the wrapped { success, data } shape", () => {
    const page = extractPage(
      {
        success: true,
        data: {
          markdown: "# Serum\n\n15.6% actives.",
          metadata: { title: "Hair Serum", description: "Six actives" },
        },
      },
      "https://beminimalist.co/products/x",
    );
    assert.equal(page?.markdown, "# Serum\n\n15.6% actives.");
    assert.equal(page?.title, "Hair Serum");
    assert.equal(page?.description, "Six actives");
  });

  it("reads a flat { markdown } shape", () => {
    // The exact wrapper could not be confirmed when this was written, so both
    // shapes are accepted rather than guessing one and failing on the other.
    const page = extractPage(
      { markdown: "# Serum", metadata: {} },
      "https://beminimalist.co/products/x",
    );
    assert.equal(page?.markdown, "# Serum");
    assert.equal(page?.title, null);
  });

  it("returns null when there is no markdown", () => {
    assert.equal(extractPage({ success: true, data: {} }, "u"), null);
    assert.equal(extractPage({ error: "nope" }, "u"), null);
    assert.equal(extractPage(null, "u"), null);
    assert.equal(extractPage("a string", "u"), null);
  });
});

describe("tidyMarkdown", () => {
  it("drops images, since the image list comes from the structured JSON", () => {
    const out = tidyMarkdown("Text ![alt](https://cdn/x.jpg) more", 1000);
    assert.ok(!out.includes("!["));
    assert.ok(out.includes("Text"));
    assert.ok(out.includes("more"));
  });

  it("drops link-only lines, which are navigation not content", () => {
    const out = tidyMarkdown(
      "# Product\n\n[Shop all](https://x/collections/all)\n\nReal copy here.",
      1000,
    );
    assert.ok(out.includes("Real copy here."));
    assert.ok(!out.includes("Shop all"));
  });

  it("collapses runs of blank lines", () => {
    assert.ok(!tidyMarkdown("a\n\n\n\n\nb", 1000).includes("\n\n\n"));
  });

  it("truncates at a paragraph boundary, not mid-sentence", () => {
    const body = `${"x".repeat(300)}\n\n${"y".repeat(300)}\n\n${"z".repeat(300)}`;
    const out = tidyMarkdown(body, 650);
    assert.ok(out.length <= 650);
    assert.ok(!out.includes("z"), "should have cut before the third block");
  });

  it("leaves short content untouched", () => {
    assert.equal(tidyMarkdown("Short and clean.", 1000), "Short and clean.");
  });
});

describe("tryScrapePage — enrichment must never fail the run", () => {
  it("no-ops silently when no key is configured", async () => {
    const result = await tryScrapePage("https://x/products/y", undefined);
    assert.equal(result.page, null);
    assert.equal(result.warning, null, "an unset optional key is not a warning");
  });

  it("degrades to a warning when the API errors", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as typeof fetch;
    try {
      const result = await tryScrapePage("https://x/products/y", "key");
      assert.equal(result.page, null);
      assert.match(result.warning ?? "", /enrichment unavailable/i);
      assert.match(result.warning ?? "", /429/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns the page and sends the documented request shape", async () => {
    const original = globalThis.fetch;
    let seenUrl = "";
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = String(
        (init?.headers as Record<string, string>)?.authorization ?? "",
      );
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          success: true,
          data: { markdown: "# Real page\n\nIngredients: Darkenyl.", metadata: {} },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await tryScrapePage("https://beminimalist.co/products/y", "k-123");
      assert.equal(seenUrl, "https://api.firecrawl.dev/v2/scrape");
      assert.equal(seenAuth, "Bearer k-123");
      assert.deepEqual(seenBody.formats, ["markdown"]);
      assert.equal(seenBody.onlyMainContent, true);
      assert.equal(seenBody.url, "https://beminimalist.co/products/y");
      assert.match(result.page?.markdown ?? "", /Darkenyl/);
      assert.equal(result.warning, null);
    } finally {
      globalThis.fetch = original;
    }
  });
});
