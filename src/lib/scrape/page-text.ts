import { safeFetch } from "../http/safe-fetch.ts";

/**
 * The product page as readable text, with no third party and no API key.
 *
 * ── Why there is no hosted scraper here ───────────────────────────────────
 * A hosted scraper earns its keep on pages that only assemble themselves in a
 * browser. A Shopify product page is not one of those. The theme renders the
 * description, the ingredient blocks, the how-to-use section and the FAQ into
 * the HTML the server returns, which is why `curl` on a product page shows all
 * of it, and why this app already reads the same origin for the product JSON
 * without difficulty. Paying an API, holding a key and taking an outbound
 * dependency to read text that arrives in the first response is a cost with
 * nothing on the other side of it.
 *
 * This project did carry Firecrawl for a while, and removing it fixed a bug
 * rather than causing one. Enrichment was Firecrawl-only and returned "no page,
 * no warning" whenever the call failed or no key was set, so a brief asking the
 * model to answer an objection had one sentence of product description to work
 * from and nothing said so. The objections live in the FAQ and the ingredient
 * copy. Now they are read directly, and a failure is reported on screen.
 *
 * If a storefront ever does need a browser, the shape to add is another reader
 * behind readProductPage() below, not a key that silently changes what the
 * default path does.
 *
 * ── What it does and does not do ──────────────────────────────────────────
 * It extracts text, not structure, and it is deliberately not an HTML parser.
 * Every hard product fact still comes from the Shopify JSON, because a parsed
 * number beats a number recovered from prose, and nothing here is trusted to
 * produce a claim. It only has to hand the copywriter more grounded material
 * than one paragraph, and hand the scorer a wider source of truth.
 *
 * It goes through safeFetch, so it inherits the SSRF guards, the host
 * allowlist, the per-redirect revalidation and the streaming size cap that
 * every other outbound request in this app uses.
 */

export interface PageText {
  markdown: string;
  title: string | null;
  description: string | null;
  sourceUrl: string;
  fetchedAt: string;
  /** Which reader produced this, so the UI can say so rather than imply. */
  source: "page";
}

/** Elements whose contents are never prose. Dropped whole, including tags. */
const DROP = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "iframe",
  "form",
];

/**
 * Named entities worth handling literally.
 *
 * Not a full table on purpose: numeric references cover the long tail, and the
 * handful below are the ones a storefront actually emits. Getting `&amp;` and
 * `&nbsp;` right matters because they appear in nearly every ingredient list.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: ",",
  hellip: "",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  deg: "°",
  times: "x",
  eacute: "é",
  copy: "(c)",
  reg: "(r)",
  trade: "(tm)",
  middot: "-",
  bull: "-",
  euro: "€",
  pound: "£",
  dollar: "$",
};

export function decodeEntities(html: string): string {
  return html.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Reject anything outside the Unicode range, and the surrogate block,
      // rather than letting String.fromCodePoint throw on hostile input.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** The `content` of the first matching meta tag, in either attribute order. */
function meta(html: string, name: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(html);
    if (found?.[1]) return decodeEntities(found[1]).trim() || null;
  }
  return null;
}

/**
 * Readable text from an HTML document.
 *
 * Exported so it can be tested against a fixture without a network call, which
 * is the only way to keep this honest: an extractor is a pile of regexes, and
 * regexes over HTML are exactly the code that rots without tests.
 */
export function extractText(html: string, maxChars = 6000): string {
  let text = html;

  for (const tag of DROP) {
    text = text.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"),
      " ",
    );
    // Self-closing or unclosed variants, so a stray <svg/> does not survive.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), " ");
  }

  // HTML comments, including conditional ones.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // List items become bullets before the generic tag strip, or an ingredient
  // list collapses into one unreadable run-on line.
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");

  // Everything that implies a line break becomes one.
  text = text.replace(
    /<\/?(p|div|section|article|br|h[1-6]|tr|ul|ol|table|header|footer|dt|dd|blockquote)\b[^>]*>/gi,
    "\n",
  );

  // A table cell is a column, not a paragraph.
  text = text.replace(/<\/?(td|th)\b[^>]*>/gi, "  ");

  // Whatever is left.
  text = text.replace(/<[^>]+>/g, " ");

  text = decodeEntities(text);

  text = text
    // Collapse runs of spaces and tabs, but not newlines: the structure above
    // is the only thing separating a heading from its paragraph.
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    // Three or more blank lines is theme boilerplate, not emphasis.
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Navigation, cookie banners and footers survive extraction and are pure
  // noise in a creative brief. Dropping very short lines removes most of it
  // without needing to know anything about the theme.
  text = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return true;
      if (trimmed.startsWith("- ")) return trimmed.length > 4;
      return trimmed.length > 2;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

export interface PageTextOptions {
  allowedHosts: string[];
  maxChars?: number;
  timeoutMs?: number;
}

export async function fetchPageText(
  url: string,
  options: PageTextOptions,
): Promise<PageText> {
  const response = await safeFetch(url, {
    allowedHosts: options.allowedHosts,
    accept: "text/html,application/xhtml+xml",
    // A PDP is tens of kilobytes. A megabyte cap is generous and still bounds
    // what a hostile or misconfigured origin can make this process hold.
    maxBytes: 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 10_000,
  });

  const html = response.body;
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  return {
    markdown: extractText(html, options.maxChars ?? 6000),
    title:
      meta(html, "og:title") ??
      (titleTag?.[1] ? decodeEntities(titleTag[1]).trim() : null),
    description: meta(html, "og:description") ?? meta(html, "description"),
    sourceUrl: response.url,
    fetchedAt: new Date().toISOString(),
    source: "page",
  };
}

export interface EnrichResult {
  page: PageText | null;
  warning: string | null;
}

/**
 * The product page, or a clear statement of why not.
 *
 * Enrichment must never fail a run: every hard product fact comes from the
 * Shopify JSON, and this only adds substance for the copywriter and a wider
 * source of truth for the scorer. But it must never fail SILENTLY either, which
 * is the mistake this replaces. A thin brief and a model ignoring its brief
 * look identical from the outside, and the difference is the first thing you
 * need when a creative comes back wrong.
 */
export async function readProductPage(
  url: string,
  options: PageTextOptions,
): Promise<EnrichResult> {
  try {
    const page = await fetchPageText(url, options);
    // A page that yielded almost nothing is a page this reader could not read,
    // whatever the HTTP status said. Enriching a brief with three words of
    // navigation is worse than admitting there was nothing to add.
    if (page.markdown.length >= 200) return { page, warning: null };
    return {
      page: null,
      warning:
        `The product page returned only ${page.markdown.length} characters of ` +
        `readable text, so this brief was written from the structured product ` +
        `data alone. Ingredient detail, usage and FAQ copy were not available.`,
    };
  } catch (error) {
    return {
      page: null,
      warning:
        `Could not read the product page (${
          error instanceof Error ? error.message : String(error)
        }). This brief was written from the structured product data alone, ` +
        `which is thinner: ingredient detail, usage and FAQ copy were not ` +
        `available to it.`,
    };
  }
}
