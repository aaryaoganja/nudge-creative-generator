/**
 * Product URL validation and canonicalisation.
 *
 * The tool accepts exactly one thing: a single-product URL. Everything else is
 * rejected up front with a message that says what was wrong, because a
 * half-parsed collection page produces a confidently wrong ad rather than an
 * error.
 */

/**
 * Shopify serves a product at BOTH of these, and the second is the form people
 * actually copy out of the address bar after browsing a collection:
 *
 *   /products/<handle>
 *   /collections/<collection>/products/<handle>
 *
 * Optionally prefixed with a locale segment (/en-in/...) on international
 * storefronts. Matching only `^/products/` looks right and rejects valid input.
 */
const PRODUCT_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:collections\/[^/]+\/)?products\/([a-z0-9][a-z0-9._-]*)$/i;

/**
 * Dropped on canonicalisation. `variant` is deliberately NOT in this list:
 * variants carry different prices and different images, so discarding it caches
 * the wrong price against the wrong photo — silently, which is the worst kind.
 */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "ttclid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "referrer",
  "srsltid",
  "pr_prod_strat",
  "pr_rec_id",
  "pr_rec_pid",
  "pr_ref_pid",
  "pr_seq",
];

export type ProductUrlRejection =
  | "malformed_url"
  | "scheme_not_allowed"
  | "host_not_allowed"
  | "collection_page"
  | "blog_page"
  | "home_page"
  | "not_a_product_page";

export interface ProductUrlOk {
  ok: true;
  /** Tracking params stripped, `variant` preserved. Use as the cache key. */
  canonical: string;
  origin: string;
  handle: string;
  variantId: string | null;
  /** Shopify's per-product JSON endpoint for this URL. */
  jsonUrl: string;
}

export interface ProductUrlError {
  ok: false;
  reason: ProductUrlRejection;
  /** Written for the marketer pasting the URL, not for a log file. */
  message: string;
}

export type ProductUrlResult = ProductUrlOk | ProductUrlError;

export function parseProductUrl(
  raw: string,
  allowedHosts: readonly string[],
): ProductUrlResult {
  const trimmed = raw.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: "malformed_url",
      message: `"${trimmed}" is not a valid URL. Paste the full address including https://`,
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: "scheme_not_allowed",
      message: `Only https URLs are accepted (got "${url.protocol.replace(":", "")}").`,
    };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = allowedHosts.some((a) => {
    const bare = a.toLowerCase().replace(/^\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
  if (!allowed) {
    return {
      ok: false,
      reason: "host_not_allowed",
      message: `"${host}" is not a configured store domain. Allowed: ${allowedHosts.join(", ")}`,
    };
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const match = PRODUCT_PATH.exec(path);

  if (!match) {
    return { ok: false, ...describeNonProductPath(path) };
  }

  const handle = match[1].toLowerCase();
  const variantId = url.searchParams.get("variant");

  const canonicalUrl = new URL(url.href);
  canonicalUrl.hash = "";
  canonicalUrl.hostname = host;
  canonicalUrl.pathname = path;
  for (const param of TRACKING_PARAMS) canonicalUrl.searchParams.delete(param);
  canonicalUrl.searchParams.sort();

  return {
    ok: true,
    canonical: canonicalUrl.href,
    origin: url.origin,
    handle,
    variantId,
    // Always built from the bare handle: the /collections/<c>/products/<h> form
    // also serves .js, but the short form is the one that is stable if the
    // product is later removed from that collection.
    jsonUrl: `${url.origin}/products/${handle}.js`,
  };
}

function describeNonProductPath(path: string): {
  reason: ProductUrlRejection;
  message: string;
} {
  if (path === "/") {
    return {
      reason: "home_page",
      message:
        "That is the store home page. Open a single product and paste its URL.",
    };
  }
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?collections\//i.test(path)) {
    return {
      reason: "collection_page",
      message:
        "That is a collection page listing many products. Open one product and paste its URL.",
    };
  }
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?blogs\//i.test(path)) {
    return {
      reason: "blog_page",
      message: "That is a blog article, not a product. Paste a product URL.",
    };
  }
  return {
    reason: "not_a_product_page",
    message: `"${path}" is not a product page. A product URL looks like /products/<name>.`,
  };
}
