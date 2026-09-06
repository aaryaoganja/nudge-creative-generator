import { safeFetch } from "../http/safe-fetch.ts";

/**
 * Brand asset discovery — fonts, colours and logo — straight off the storefront.
 *
 * A Shopify theme declares its type and colour system in its own stylesheet, so
 * the fonts and palette are already published as machine-readable CSS. Fetching
 * and parsing that is cheaper and more precise than a general-purpose scraping
 * service, and adds no dependency.
 *
 * This is deliberately BEST-EFFORT and produces *candidates* for a human to
 * confirm, not a brand kit to trust blindly. Themes name custom properties
 * whatever they like. Treat the output as the first draft of the `brand_voice`
 * config row (docs/ARCHITECTURE.md §6), reviewed before it is made active.
 */

export interface FontCandidate {
  family: string;
  /** Absolute URLs to the actual font files, usable for baking into renders. */
  sources: string[];
  weight: string | null;
  style: string | null;
}

export interface ColourCandidate {
  /** The CSS custom property name, e.g. "--color-accent". */
  name: string;
  value: string;
  /** How many times the theme declared it — a crude importance signal. */
  occurrences: number;
}

export interface BrandAssets {
  origin: string;
  stylesheets: string[];
  fonts: FontCandidate[];
  colours: ColourCandidate[];
  logoCandidates: string[];
  faviconCandidates: string[];
  fetchedAt: string;
  warnings: string[];
}

export interface BrandAssetOptions {
  allowedHosts: readonly string[];
  maxStylesheets?: number;
  timeoutMs?: number;
}

export async function extractBrandAssets(
  origin: string,
  options: BrandAssetOptions,
): Promise<BrandAssets> {
  const warnings: string[] = [];
  const base = origin.replace(/\/$/, "");

  const home = await safeFetch(base, {
    allowedHosts: options.allowedHosts,
    timeoutMs: options.timeoutMs ?? 15_000,
    accept: "text/html",
    maxBytes: 8 * 1024 * 1024,
  });

  if (home.status !== 200) {
    throw new Error(`${base} returned HTTP ${home.status}`);
  }

  const html = home.body;
  const stylesheets = findStylesheets(html, base).slice(
    0,
    options.maxStylesheets ?? 6,
  );

  const fonts: FontCandidate[] = [];
  const colourCounts = new Map<string, Map<string, number>>();

  for (const href of stylesheets) {
    try {
      const css = await safeFetch(href, {
        allowedHosts: options.allowedHosts,
        timeoutMs: options.timeoutMs ?? 15_000,
        accept: "text/css",
        maxBytes: 6 * 1024 * 1024,
      });
      if (css.status !== 200) {
        warnings.push(`Stylesheet ${href} returned HTTP ${css.status}`);
        continue;
      }
      fonts.push(...parseFontFaces(css.body, href));
      collectCustomProperties(css.body, colourCounts);
    } catch (error) {
      warnings.push(
        `Could not read stylesheet ${href}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Inline <style> blocks: Shopify themes commonly emit the active colour
  // scheme inline rather than in the external sheet.
  for (const block of html.matchAll(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
  )) {
    collectCustomProperties(block[1], colourCounts);
  }

  const colours: ColourCandidate[] = [];
  for (const [name, values] of colourCounts) {
    let best = "";
    let bestCount = 0;
    let total = 0;
    for (const [value, count] of values) {
      total += count;
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    colours.push({ name, value: best, occurrences: total });
  }
  colours.sort(
    (a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name),
  );

  if (fonts.length === 0) {
    warnings.push(
      "No @font-face rules found. The theme may load fonts from a font CDN, so check the stylesheet list.",
    );
  }
  if (colours.length === 0) {
    warnings.push(
      "No colour custom properties found. The palette may be hard-coded in the theme.",
    );
  }

  return {
    origin: base,
    stylesheets,
    fonts: dedupeFonts(fonts),
    colours,
    logoCandidates: findLogos(html, base),
    faviconCandidates: findFavicons(html, base),
    fetchedAt: new Date().toISOString(),
    warnings,
  };
}

function findStylesheets(html: string, base: string): string[] {
  const out: string[] = [];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const el = tag[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(el)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(el)?.[1];
    if (!href) continue;
    const abs = absolutise(href, base);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

export function parseFontFaces(css: string, cssHref: string): FontCandidate[] {
  const out: FontCandidate[] = [];

  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = block[1];

    const family = /font-family\s*:\s*([^;]+)/i
      .exec(body)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    if (!family) continue;

    const sources: string[] = [];
    for (const src of body.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
      const abs = absolutise(src[2].trim(), cssHref);
      if (abs && !sources.includes(abs)) sources.push(abs);
    }

    out.push({
      family,
      sources,
      weight: /font-weight\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? null,
      style: /font-style\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? null,
    });
  }

  return out;
}

function dedupeFonts(fonts: FontCandidate[]): FontCandidate[] {
  const byKey = new Map<string, FontCandidate>();
  for (const font of fonts) {
    const key = `${font.family.toLowerCase()}|${font.weight ?? ""}|${font.style ?? ""}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...font, sources: [...font.sources] });
      continue;
    }
    for (const src of font.sources) {
      if (!existing.sources.includes(src)) existing.sources.push(src);
    }
  }
  return [...byKey.values()];
}

/**
 * Collects `--name: value` declarations whose value looks like a colour.
 * Shopify themes also express colours as bare RGB triples ("18, 18, 18") for
 * use inside rgb(), so those count too.
 */
function collectCustomProperties(
  css: string,
  into: Map<string, Map<string, number>>,
): void {
  for (const decl of css.matchAll(/(--[a-z0-9-_]+)\s*:\s*([^;{}]+)/gi)) {
    const name = decl[1].toLowerCase();
    const value = decl[2].trim();
    if (!looksLikeColour(value)) continue;

    let values = into.get(name);
    if (!values) {
      values = new Map<string, number>();
      into.set(name, values);
    }
    values.set(value, (values.get(value) ?? 0) + 1);
  }
}

export function looksLikeColour(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
  if (/^(?:rgb|rgba|hsl|hsla|oklch|lab|lch|color)\(/.test(v)) return true;
  if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(v)) return true;
  return false;
}

function findLogos(html: string, base: string): string[] {
  const out: string[] = [];

  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const el = tag[0];
    if (!/logo/i.test(el)) continue;
    const src =
      /\bsrc\s*=\s*["']([^"']+)["']/i.exec(el)?.[1] ??
      /\bdata-src\s*=\s*["']([^"']+)["']/i.exec(el)?.[1];
    if (!src) continue;
    const abs = absolutise(src, base);
    if (abs && !out.includes(abs)) out.push(abs);
  }

  // og:image is a reliable fallback and is always absolute.
  const og = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i.exec(html)?.[0];
  if (og) {
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(og)?.[1];
    if (content) {
      const abs = absolutise(content, base);
      if (abs && !out.includes(abs)) out.push(abs);
    }
  }

  return out;
}

function findFavicons(html: string, base: string): string[] {
  const out: string[] = [];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const el = tag[0];
    if (!/rel\s*=\s*["']?[^"'>]*icon/i.test(el)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(el)?.[1];
    if (!href) continue;
    const abs = absolutise(href, base);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

function absolutise(ref: string, base: string): string | null {
  const trimmed = ref.trim();
  if (trimmed.startsWith("data:")) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}
