import { z } from "zod";
import { safeFetch } from "../http/safe-fetch.ts";
import { parseProductUrl } from "./product-url.ts";

/**
 * Shopify storefront JSON client.
 *
 * Shopify publishes structured product JSON on every storefront with no API
 * key, no OAuth and no headless browser:
 *
 *   GET /products.json?limit=250&page=N   → the whole catalogue, paginated
 *   GET /products/<handle>.js             → one product
 *
 * That covers the entire product-data path, which is why no scraping library is
 * a dependency of this project.
 *
 * ── The one trap ──────────────────────────────────────────────────────────
 * The two endpoints report money in DIFFERENT UNITS:
 *
 *   /products.json      price: "810.00"   decimal string, major units
 *   /products/<h>.js    price: 81000      integer, MINOR units (paise)
 *
 * Reading the second as rupees prices the product at ₹81,000. Both are
 * normalised to integer minor units here and nowhere else.
 */

const MoneyFromDecimalString = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => {
    if (v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  });

const MoneyFromMinorUnits = z
  .union([z.number(), z.null()])
  .transform((v) => (v === null || !Number.isFinite(v) ? null : Math.round(v)));

const ImageSchema = z.object({
  id: z.number().optional(),
  src: z.string(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  position: z.number().nullable().optional(),
});

const CatalogVariantSchema = z.object({
  id: z.number(),
  title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  available: z.boolean().nullable().optional(),
  price: MoneyFromDecimalString,
  compare_at_price: MoneyFromDecimalString,
});

const CatalogProductSchema = z.object({
  id: z.number(),
  title: z.string(),
  handle: z.string(),
  body_html: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  images: z.array(ImageSchema).nullable().optional(),
  variants: z.array(CatalogVariantSchema).nullable().optional(),
});

export const CatalogResponseSchema = z.object({
  products: z.array(CatalogProductSchema),
});

const ProductJsVariantSchema = z.object({
  id: z.number(),
  title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  available: z.boolean().nullable().optional(),
  price: MoneyFromMinorUnits,
  compare_at_price: MoneyFromMinorUnits,
});

export const ProductJsSchema = z.object({
  id: z.number(),
  title: z.string(),
  handle: z.string(),
  description: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  images: z.array(z.string()).nullable().optional(),
  media: z
    .array(
      z.object({
        src: z.string().nullable().optional(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
        position: z.number().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  variants: z.array(ProductJsVariantSchema).nullable().optional(),
});

export interface ProductImage {
  src: string;
  width: number | null;
  height: number | null;
  position: number | null;
}

export interface ProductSnapshot {
  sourceUrl: string;
  shopifyId: number;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  descriptionHtml: string | null;
  descriptionText: string | null;
  /** Integer minor units (paise). Never a float — money is not a float. */
  priceMinor: number | null;
  compareAtPriceMinor: number | null;
  currency: string;
  discountPct: number | null;
  sku: string | null;
  available: boolean | null;
  variantId: number | null;
  /**
   * Percentages lifted from the title, e.g. "15.6% Hair Serum" → [15.6].
   * These are claim-bearing numbers under the ASCI substantiation rules and
   * must survive into the creative unaltered — see docs/ARCHITECTURE.md §24.2.
   */
  concentrations: number[];
  images: ProductImage[];
  fetchedAt: string;
}

export interface ShopifyClientOptions {
  allowedHosts: readonly string[];
  currency?: string;
  timeoutMs?: number;
}

export class ShopifyFetchError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ShopifyFetchError";
    this.status = status;
  }
}

export function extractConcentrations(title: string): number[] {
  const out: number[] = [];
  for (const m of title.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

export function discountPct(
  priceMinor: number | null,
  compareAtMinor: number | null,
): number | null {
  if (priceMinor === null || compareAtMinor === null) return null;
  if (compareAtMinor <= 0 || compareAtMinor <= priceMinor) return null;
  return Math.round(((compareAtMinor - priceMinor) / compareAtMinor) * 100);
}

/** Picks the variant the URL asked for, else the first available, else the first. */
function selectVariant<T extends { id: number; available?: boolean | null }>(
  variants: T[] | null | undefined,
  wantedId: number | null,
): T | null {
  if (!variants || variants.length === 0) return null;
  if (wantedId !== null) {
    const exact = variants.find((v) => v.id === wantedId);
    if (exact) return exact;
  }
  return variants.find((v) => v.available === true) ?? variants[0];
}

export class ShopifyClient {
  private readonly allowedHosts: readonly string[];
  private readonly currency: string;
  private readonly timeoutMs: number;

  constructor(options: ShopifyClientOptions) {
    this.allowedHosts = options.allowedHosts;
    this.currency = options.currency ?? "INR";
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Fetches one product by its public URL. */
  async fetchProduct(productUrl: string): Promise<ProductSnapshot> {
    const parsed = parseProductUrl(productUrl, this.allowedHosts);
    if (!parsed.ok) {
      throw new ShopifyFetchError(parsed.message);
    }

    const response = await safeFetch(parsed.jsonUrl, {
      allowedHosts: this.allowedHosts,
      timeoutMs: this.timeoutMs,
      accept: "application/json,text/javascript,*/*",
      maxBytes: 4 * 1024 * 1024,
    });

    if (response.status === 404) {
      throw new ShopifyFetchError(
        `No product found at ${parsed.canonical}. Check the URL is current.`,
        404,
      );
    }
    if (response.status !== 200) {
      throw new ShopifyFetchError(
        `${parsed.jsonUrl} returned HTTP ${response.status}`,
        response.status,
      );
    }

    return this.parseProductJs(
      response.body,
      parsed.canonical,
      parsed.variantId === null ? null : Number(parsed.variantId),
    );
  }

  /** Exposed separately so it can be tested against a fixture with no network. */
  parseProductJs(
    raw: string,
    sourceUrl: string,
    wantedVariantId: number | null,
  ): ProductSnapshot {
    const parsed = ProductJsSchema.safeParse(safeJsonParse(raw, sourceUrl));
    if (!parsed.success) {
      throw new ShopifyFetchError(
        `Unexpected product JSON at ${sourceUrl}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      );
    }

    const p = parsed.data;
    const variant = selectVariant(p.variants, wantedVariantId);

    const images: ProductImage[] =
      p.media && p.media.length > 0
        ? p.media
            .filter((m): m is { src: string } & typeof m => Boolean(m.src))
            .map((m, i) => ({
              src: absolutise(m.src as string, sourceUrl),
              width: m.width ?? null,
              height: m.height ?? null,
              position: m.position ?? i + 1,
            }))
        : (p.images ?? []).map((src, i) => ({
            src: absolutise(src, sourceUrl),
            width: null,
            height: null,
            position: i + 1,
          }));

    const priceMinor = variant?.price ?? null;
    const compareAtPriceMinor = variant?.compare_at_price ?? null;

    return {
      sourceUrl,
      shopifyId: p.id,
      handle: p.handle,
      title: p.title,
      vendor: p.vendor ?? null,
      productType: p.type ?? null,
      tags: p.tags ?? [],
      descriptionHtml: p.description ?? null,
      descriptionText: htmlToText(p.description),
      priceMinor,
      compareAtPriceMinor,
      currency: this.currency,
      discountPct: discountPct(priceMinor, compareAtPriceMinor),
      sku: variant?.sku ?? null,
      available: variant?.available ?? null,
      variantId: variant?.id ?? null,
      concentrations: extractConcentrations(p.title),
      images,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * One page of the catalogue. `page` is 1-indexed; an empty `products` array
   * means the end. This is the precompute crawler's entry point.
   */
  async fetchCatalogPage(
    origin: string,
    page = 1,
    limit = 250,
  ): Promise<ProductSnapshot[]> {
    const url = `${origin.replace(/\/$/, "")}/products.json?limit=${limit}&page=${page}`;
    const response = await safeFetch(url, {
      allowedHosts: this.allowedHosts,
      timeoutMs: this.timeoutMs,
      accept: "application/json",
      maxBytes: 16 * 1024 * 1024,
    });

    if (response.status !== 200) {
      throw new ShopifyFetchError(
        `${url} returned HTTP ${response.status}`,
        response.status,
      );
    }

    return this.parseCatalog(response.body, origin);
  }

  /** Exposed separately so it can be tested against a fixture with no network. */
  parseCatalog(raw: string, origin: string): ProductSnapshot[] {
    const parsed = CatalogResponseSchema.safeParse(safeJsonParse(raw, origin));
    if (!parsed.success) {
      throw new ShopifyFetchError(
        `Unexpected catalogue JSON from ${origin}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      );
    }

    const now = new Date().toISOString();

    return parsed.data.products.map((p) => {
      const variant = selectVariant(p.variants, null);
      const priceMinor = variant?.price ?? null;
      const compareAtPriceMinor = variant?.compare_at_price ?? null;

      return {
        sourceUrl: `${origin.replace(/\/$/, "")}/products/${p.handle}`,
        shopifyId: p.id,
        handle: p.handle,
        title: p.title,
        vendor: p.vendor ?? null,
        productType: p.product_type ?? null,
        tags: p.tags ?? [],
        descriptionHtml: p.body_html ?? null,
        descriptionText: htmlToText(p.body_html),
        priceMinor,
        compareAtPriceMinor,
        currency: this.currency,
        discountPct: discountPct(priceMinor, compareAtPriceMinor),
        sku: variant?.sku ?? null,
        available: variant?.available ?? null,
        variantId: variant?.id ?? null,
        concentrations: extractConcentrations(p.title),
        images: (p.images ?? []).map((img, i) => ({
          src: absolutise(img.src, origin),
          width: img.width ?? null,
          height: img.height ?? null,
          position: img.position ?? i + 1,
        })),
        fetchedAt: now,
      } satisfies ProductSnapshot;
    });
  }

  /** Walks every catalogue page. `maxPages` bounds a runaway or hostile store. */
  async *crawlCatalog(
    origin: string,
    { limit = 250, maxPages = 40 } = {},
  ): AsyncGenerator<ProductSnapshot[]> {
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.fetchCatalogPage(origin, page, limit);
      if (batch.length === 0) return;
      yield batch;
      if (batch.length < limit) return;
    }
  }
}

function safeJsonParse(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ShopifyFetchError(
      `Response from ${context} was not valid JSON (got ${raw.slice(0, 80)}…)`,
    );
  }
}

/** Shopify sometimes emits protocol-relative CDN URLs (//cdn.shopify.com/...). */
function absolutise(src: string, base: string): string {
  if (src.startsWith("//")) return `https:${src}`;
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}
