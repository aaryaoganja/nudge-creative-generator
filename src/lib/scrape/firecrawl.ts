/**
 * Firecrawl, for pages that only assemble themselves in a browser.
 *
 * ── Why this exists alongside the Shopify JSON client ─────────────────────
 * Shopify's `/products/<handle>.js` returns the product's `description` field
 * and nothing else. The page a customer actually sees usually carries far more:
 * ingredient breakdowns, how-to-use, "why it works", FAQ blocks, and review
 * summaries, rendered from metafields, theme sections or third-party apps and
 * absent from the JSON entirely.
 *
 * That extra material matters twice over:
 *   - the copywriter has more grounded substance to work from, so concepts stop
 *     recycling the same one-paragraph description
 *   - the SCORER gets a wider source of truth, so a claim that appears in a
 *     creative can be checked against the whole page rather than one field
 *
 * It is strictly an ENRICHMENT. Product facts (price, concentrations, images)
 * still come from the structured JSON, because a parsed number beats a number
 * read out of prose. If Firecrawl is unconfigured, rate-limited or down, the
 * pipeline proceeds without it rather than failing.
 *
 * It is also no longer the first choice. src/lib/scrape/page-text.ts reads the
 * same page with no key and no third party, because a Shopify theme renders its
 * content server-side; this is the fallback for a storefront where that is not
 * true. See tryScrapePage at the bottom of this file.
 *
 * ── Verification status ───────────────────────────────────────────────────
 * Endpoint, auth scheme and request shape are taken from the published v2
 * OpenAPI description: POST https://api.firecrawl.dev/v2/scrape, bearer auth,
 * a `url` plus scrape options. The RESPONSE envelope is parsed defensively:
 * both `{ success, data: { markdown } }` and a flat `{ markdown }` are
 * accepted, because the exact wrapper could not be confirmed from this
 * environment.
 */

import { fetchPageText, type PageText } from "./page-text.ts";

const API_URL = "https://api.firecrawl.dev/v2/scrape";

/**
 * Kept as an alias rather than a second shape. Both readers produce the same
 * thing, so callers never branch on which one answered; they read `source` if
 * they want to tell the user.
 */
export type FirecrawlPage = Omit<PageText, "source">;

export class FirecrawlError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "FirecrawlError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface FirecrawlOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Trim to keep prompt cost bounded; the tail of a PDP is usually boilerplate. */
  maxChars?: number;
}

/** Tolerates both the wrapped and flat response envelopes. */
export function extractPage(payload: unknown, sourceUrl: string): FirecrawlPage | null {
  if (typeof payload !== "object" || payload === null) return null;

  const root = payload as Record<string, unknown>;
  const container =
    typeof root.data === "object" && root.data !== null
      ? (root.data as Record<string, unknown>)
      : root;

  const markdown = typeof container.markdown === "string" ? container.markdown : null;
  if (!markdown) return null;

  const metadata =
    typeof container.metadata === "object" && container.metadata !== null
      ? (container.metadata as Record<string, unknown>)
      : {};

  return {
    markdown,
    title: typeof metadata.title === "string" ? metadata.title : null,
    description:
      typeof metadata.description === "string" ? metadata.description : null,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Strips the parts of a storefront page that are navigation rather than content.
 *
 * Firecrawl's `onlyMainContent` does most of this, but Shopify themes still
 * leak cart drawers, announcement bars and footer link farms into the markdown,
 * and every one of those tokens is paid for on each brief.
 */
export function tidyMarkdown(markdown: string, maxChars: number): string {
  const cleaned = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images — we use the JSON's image list
    .replace(/^\s*\[[^\]]*\]\([^)]*\)\s*$/gm, "") // bare link-only lines (nav)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length <= maxChars) return cleaned;
  // Cut at a paragraph boundary rather than mid-sentence.
  const cut = cleaned.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n\n");
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trim();
}

export async function scrapePage(
  url: string,
  options: FirecrawlOptions,
): Promise<FirecrawlPage> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30_000,
  );

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        blockAds: true,
        removeBase64Images: true,
        timeout: options.timeoutMs ?? 30_000,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new FirecrawlError(
        `HTTP ${response.status}: ${text.slice(0, 300)}`,
        {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }

    const page = extractPage(await response.json(), url);
    if (!page) {
      throw new FirecrawlError("Response contained no markdown content.");
    }

    return {
      ...page,
      markdown: tidyMarkdown(page.markdown, options.maxChars ?? 6000),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort enrichment. Returns null on any failure — a missing page body
 * degrades copy quality, it does not justify failing the run.
 */
export interface EnrichOptions {
  apiKey?: string;
  allowedHosts: string[];
  maxChars?: number;
}

/**
 * The full product page, by whichever reader can get it.
 *
 * Order matters and is deliberate. The built-in reader goes FIRST because a
 * Shopify theme renders the ingredient blocks, the how-to-use section and the
 * FAQ into the HTML the server returns; Firecrawl is the fallback for a
 * storefront that genuinely assembles itself in a browser, and for the case
 * where the direct fetch is refused.
 *
 * This used to return `{ page: null, warning: null }` the moment no API key was
 * configured, which is the worst of both: enrichment was silently off on any
 * deployment without a Firecrawl key, and nothing anywhere said so. A brief
 * asking the model to "answer the single biggest objection" then had one
 * sentence of product description to work from, because the objections live in
 * the page copy that was never fetched. Both readers failing is now a stated
 * warning, not silence.
 */
export async function tryScrapePage(
  url: string,
  options: EnrichOptions,
): Promise<{ page: PageText | null; warning: string | null }> {
  const maxChars = options.maxChars ?? 6000;
  const problems: string[] = [];

  try {
    const page = await fetchPageText(url, {
      allowedHosts: options.allowedHosts,
      maxChars,
    });
    // A page that yielded almost nothing is a page this reader could not read,
    // whatever the HTTP status said. Fall through rather than enrich with
    // three words of navigation.
    if (page.markdown.length >= 200) return { page, warning: null };
    problems.push(
      `the page returned only ${page.markdown.length} characters of readable text`,
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (options.apiKey) {
    try {
      const page = await scrapePage(url, { apiKey: options.apiKey, maxChars });
      return { page: { ...page, source: "firecrawl" as const }, warning: null };
    } catch (error) {
      problems.push(
        `Firecrawl: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    page: null,
    warning:
      `Could not read the full product page (${problems.join("; ")}). ` +
      `Working from the structured product data only, which is thinner: ` +
      `ingredient detail, usage and FAQ copy are not available to this brief.`,
  };
}
