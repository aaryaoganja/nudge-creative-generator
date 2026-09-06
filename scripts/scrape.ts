/**
 * Scraper CLI — the proof that the fetch path works where it has to work.
 *
 * This runs on plain Node with no build step and no dev dependency, so the same
 * command runs locally, in CI, and inside the Railway container:
 *
 *   npm run scrape -- product https://beminimalist.co/products/<handle>
 *   npm run scrape -- catalog                       # every product, paginated
 *   npm run scrape -- catalog --limit 5 --pages 1   # a quick smoke test
 *   npm run scrape -- brand                         # fonts, colours, logo
 *
 * On Railway:  railway run npm run scrape -- catalog --limit 5 --pages 1
 * which executes in the deployed environment against the real network, using
 * the real STORE_ALLOWED_HOSTS. That is the only test that actually counts —
 * a scrape that works from a developer laptop proves nothing about the
 * container's egress.
 *
 * Exit code is non-zero on failure so CI and `railway run` report it properly.
 */

import { parseArgs } from "node:util";
import { ShopifyClient, type ProductSnapshot } from "../src/lib/scrape/shopify.ts";
import { extractBrandAssets } from "../src/lib/scrape/brand-assets.ts";
import { parseProductUrl } from "../src/lib/scrape/product-url.ts";
import { fetchPageText } from "../src/lib/scrape/page-text.ts";
import { FetchRejectedError } from "../src/lib/http/safe-fetch.ts";

const DEFAULT_HOSTS = "beminimalist.co,global.beminimalist.co";
const DEFAULT_ORIGIN = "https://beminimalist.co";

function config() {
  const hosts = (process.env.STORE_ALLOWED_HOSTS ?? DEFAULT_HOSTS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    hosts,
    origin: process.env.STORE_ORIGIN ?? DEFAULT_ORIGIN,
    currency: process.env.STORE_CURRENCY ?? "INR",
  };
}

function money(minor: number | null, currency: string): string {
  if (minor === null) return "—";
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

function summarise(p: ProductSnapshot, currency: string): string {
  const discount = p.discountPct === null ? "" : `  (-${p.discountPct}%)`;
  const conc =
    p.concentrations.length > 0
      ? `  actives: ${p.concentrations.map((c) => `${c}%`).join(", ")}`
      : "";
  return [
    `  ${p.title}`,
    `    ${money(p.priceMinor, currency)}` +
      (p.compareAtPriceMinor && p.compareAtPriceMinor !== p.priceMinor
        ? ` was ${money(p.compareAtPriceMinor, currency)}`
        : "") +
      discount,
    `    ${p.productType ?? "uncategorised"} · ${p.images.length} images · ${
      p.available === false ? "OUT OF STOCK" : "in stock"
    }${conc}`,
  ].join("\n");
}

async function cmdProduct(url: string, json: boolean): Promise<number> {
  const { hosts, currency } = config();

  const parsed = parseProductUrl(url, hosts);
  if (!parsed.ok) {
    console.error(`✗ ${parsed.message}`);
    console.error(`  (reason: ${parsed.reason})`);
    return 2;
  }

  console.error(`→ canonical: ${parsed.canonical}`);
  console.error(`→ fetching:  ${parsed.jsonUrl}`);

  const client = new ShopifyClient({ allowedHosts: hosts, currency });
  const snapshot = await client.fetchProduct(url);

  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(`\n✓ ${snapshot.handle}\n`);
    console.log(summarise(snapshot, currency));
    console.log(`\n  images:`);
    for (const img of snapshot.images.slice(0, 5)) {
      const dims = img.width && img.height ? ` ${img.width}×${img.height}` : "";
      console.log(`    ${img.position}.${dims} ${img.src}`);
    }
    if (snapshot.descriptionText) {
      console.log(`\n  description:\n    ${snapshot.descriptionText.slice(0, 300)}…`);
    }
  }
  return 0;
}

async function cmdCatalog(
  originArg: string | undefined,
  limit: number,
  maxPages: number,
  json: boolean,
): Promise<number> {
  const { hosts, origin: defaultOrigin, currency } = config();
  const origin = originArg ?? defaultOrigin;

  console.error(`→ crawling ${origin}/products.json (limit ${limit}, max ${maxPages} pages)`);

  const client = new ShopifyClient({ allowedHosts: hosts, currency });
  const all: ProductSnapshot[] = [];
  let page = 0;

  for await (const batch of client.crawlCatalog(origin, { limit, maxPages })) {
    page++;
    console.error(`  page ${page}: ${batch.length} products`);
    all.push(...batch);
  }

  if (json) {
    console.log(JSON.stringify(all, null, 2));
    return 0;
  }

  console.log(`\n✓ ${all.length} products\n`);
  for (const p of all.slice(0, 20)) console.log(summarise(p, currency), "\n");
  if (all.length > 20) console.log(`  … and ${all.length - 20} more`);

  const byType = new Map<string, number>();
  const withConcentrations = all.filter((p) => p.concentrations.length > 0);
  for (const p of all) {
    const key = p.productType ?? "uncategorised";
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }

  console.log(`\n  categories:`);
  for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count.toString().padStart(4)}  ${type}`);
  }
  console.log(
    `\n  ${withConcentrations.length}/${all.length} products carry a concentration in the title`,
  );
  console.log(`  (these are claim-bearing — see docs/ARCHITECTURE.md §24.2)`);
  return 0;
}

async function cmdBrand(
  originArg: string | undefined,
  json: boolean,
): Promise<number> {
  const { hosts, origin: defaultOrigin } = config();
  const origin = originArg ?? defaultOrigin;

  console.error(`→ extracting brand assets from ${origin}`);
  const assets = await extractBrandAssets(origin, { allowedHosts: hosts });

  if (json) {
    console.log(JSON.stringify(assets, null, 2));
    return 0;
  }

  console.log(`\n✓ ${assets.stylesheets.length} stylesheets\n`);
  for (const sheet of assets.stylesheets) console.log(`    ${sheet}`);

  console.log(`\n  fonts (${assets.fonts.length}):`);
  for (const font of assets.fonts.slice(0, 15)) {
    const weight = font.weight ? ` ${font.weight}` : "";
    console.log(`    ${font.family}${weight}  (${font.sources.length} files)`);
    if (font.sources[0]) console.log(`      ${font.sources[0]}`);
  }

  console.log(`\n  colour tokens (${assets.colours.length}, top 15):`);
  for (const colour of assets.colours.slice(0, 15)) {
    console.log(`    ${colour.name.padEnd(34)} ${colour.value}   ×${colour.occurrences}`);
  }

  console.log(`\n  logo candidates:`);
  for (const logo of assets.logoCandidates.slice(0, 5)) console.log(`    ${logo}`);

  if (assets.warnings.length > 0) {
    console.log(`\n  warnings:`);
    for (const w of assets.warnings) console.log(`    ! ${w}`);
  }
  console.log(
    `\n  Review before promoting to an active brand_voice config row —` +
      ` theme CSS is a candidate set, not a brand kit.`,
  );
  return 0;
}


/**
 * Read the product page as text, the way the brief does.
 *
 * This is the command that answers "do we still need Firecrawl?", and it has to
 * be run where the app runs, not on a laptop:
 *
 *   railway run npm run scrape -- page https://beminimalist.co/products/<handle>
 *
 * A storefront that serves its content to a browser can still refuse a
 * datacentre IP, and the only way to know is to ask from the datacentre. If
 * this prints the FAQ and the ingredient copy, the built-in reader is enough
 * and no third-party scraper is needed.
 */
async function cmdPage(url: string, json: boolean): Promise<number> {
  const { hosts } = config();
  const verdict = parseProductUrl(url, hosts);
  if (!verdict.ok) {
    console.error(`✗ ${verdict.message}`);
    return 2;
  }

  let page;
  try {
    page = await fetchPageText(verdict.canonical, { allowedHosts: hosts });
  } catch (error) {
    console.error(
      `✗ Could not read the page: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "\n  If this fails from inside the deployment but works locally, the" +
        "\n  storefront is refusing the container's IP. That is the one case" +
        "\n  where a hosted scraper earns its keep.",
    );
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(page, null, 2));
    return 0;
  }

  console.log(`✓ ${page.sourceUrl}`);
  console.log(`  Title:      ${page.title ?? "none"}`);
  console.log(`  Characters: ${page.markdown.length}`);
  console.log("");

  // The three things a brief actually needs, checked by eye rather than
  // asserted: a count alone does not tell you whether the useful part arrived.
  const signals: Array<[string, RegExp]> = [
    ["ingredient or actives copy", /ingredient|actives|%\s|concentration/i],
    ["usage instructions", /how to use|apply|routine|nightly|morning/i],
    ["questions or objections", /faq|frequently asked|will it|how long|can i/i],
  ];
  for (const [label, pattern] of signals) {
    console.log(`  ${pattern.test(page.markdown) ? "found" : "MISSING"}  ${label}`);
  }

  console.log("\n  First 800 characters as the model will see them:\n");
  console.log(
    page.markdown
      .slice(0, 800)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );
  return 0;
}

function usage(): void {
  console.error(
    [
      "Usage: npm run scrape -- <command> [options]",
      "",
      "Commands:",
      "  product <url>        Fetch and normalise one product",
      "  page    <url>        Read the product page as the brief reads it",
      "  catalog [origin]     Crawl every product via /products.json",
      "  brand   [origin]     Extract fonts, colour tokens and logo from theme CSS",
      "",
      "Options:",
      "  --json               Emit raw JSON instead of a summary",
      "  --limit <n>          Products per catalogue page (default 250)",
      "  --pages <n>          Maximum catalogue pages (default 40)",
      "",
      "Environment:",
      "  STORE_ALLOWED_HOSTS  Comma-separated host allowlist",
      `                       (default: ${DEFAULT_HOSTS})`,
      `  STORE_ORIGIN         Default storefront (default: ${DEFAULT_ORIGIN})`,
      "  STORE_CURRENCY       ISO code for display (default: INR)",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      limit: { type: "string" },
      pages: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const [command, arg] = positionals;
  if (values.help || !command) {
    usage();
    return values.help ? 0 : 1;
  }

  const json = values.json === true;
  const limit = values.limit ? Number(values.limit) : 250;
  const pages = values.pages ? Number(values.pages) : 40;

  switch (command) {
    case "product":
      if (!arg) {
        console.error("✗ product requires a URL");
        return 1;
      }
      return cmdProduct(arg, json);
    case "page":
      if (!arg) {
        console.error("✗ page requires a URL");
        return 1;
      }
      return cmdPage(arg, json);
    case "catalog":
      return cmdCatalog(arg, limit, pages, json);
    case "brand":
      return cmdBrand(arg, json);
    default:
      console.error(`✗ Unknown command "${command}"`);
      usage();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof FetchRejectedError) {
      console.error(`✗ Request rejected (${error.reason}): ${error.message}`);
    } else {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  });
