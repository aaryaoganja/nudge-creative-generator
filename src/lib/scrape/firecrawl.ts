/**
 * Firecrawl — full rendered page content, as markdown.
 *
 * ── Why this exists alongside the Shopify JSON client ─────────────────────
 * Shopify's `/products/<handle>.js` returns the product's `description` field
 * and nothing else. The page a customer actually sees usually carries far more:
 * ingredient breakdowns, how-to-use, "why it works", FAQ blocks, and review
 * summaries — rendered from metafields, theme sections or third-party apps, and
 * absent from the JSON entirely.
 *
 * That extra material matters twice over:
 *   - the copywriter has more grounded substance to work from, so concepts stop
 *     recycling the same one-paragraph description
 *   - the SCORER gets a wider source of truth, so a claim that appears in a
 *     creative can be checked against the whole page rather than one field
 *
 * It is strictly an ENRICHMENT. Product facts — price, concentrations, images —
 * still come from the structured JSON, because a parsed number beats a number
 * read out of prose. If Firecrawl is unconfigured, rate-limited or down, the
 * pipeline proceeds without it rather than failing.
 *
 * ── Verification status ───────────────────────────────────────────────────
 * Endpoint, auth scheme and request shape are taken from the published v2
 * OpenAPI description: POST https://api.firecrawl.dev/v2/scrape, bearer auth,
 * a `url` plus scrape options. The RESPONSE envelope is parsed defensively —
 * both `{ success, data: { markdown } }` and a flat `{ markdown }` are accepted
 * — because the exact wrapper could not be confirmed from this environment.
 */

const API_URL = "https://api.firecrawl.dev/v2/scrape";

export interface FirecrawlPage {
  markdown: string;
  title: string | null;
  description: string | null;
  sourceUrl: string;
  fetchedAt: string;
}

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
export async function tryScrapePage(
  url: string,
  apiKey: string | undefined,
  maxChars = 6000,
): Promise<{ page: FirecrawlPage | null; warning: string | null }> {
  if (!apiKey) {
    return { page: null, warning: null };
  }
  try {
    return { page: await scrapePage(url, { apiKey, maxChars }), warning: null };
  } catch (error) {
    return {
      page: null,
      warning: `Page enrichment unavailable (${
        error instanceof Error ? error.message : String(error)
      }). Working from the structured product data only.`,
    };
  }
}
