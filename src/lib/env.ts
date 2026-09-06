import { z } from "zod";

/**
 * Fail fast on misconfiguration at boot rather than on the first request.
 *
 * Kept lazy so that `next build` (and `prisma generate`) do not require a real
 * environment — the schema is only evaluated when a request actually needs it.
 *
 * Provider keys are all optional. The pipeline degrades rather than refusing to
 * boot: without an image key the generator still produces deterministic
 * creatives, and `requireImageProvider()` is what raises a useful error at the
 * point of use. That keeps a missing key from taking down the health check.
 */

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );

const schema = z.object({
  /**
   * OPTIONAL, deliberately.
   *
   * No user-facing route queries Postgres: resolve, generate and score all run
   * without it. Making this required meant every one of those routes threw
   * `Invalid environment configuration — DATABASE_URL` on a deployment where
   * the database was not wired, taking the whole app down over a dependency it
   * does not use.
   *
   * It becomes required when something actually reads from it — see
   * requireDatabaseUrl(), which fails loudly at the point of use instead.
   */
  DATABASE_URL: z.string().url().optional(),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /**
   * Hosts the fetcher is permitted to reach. This is both the SSRF control and
   * a product-correctness control: the tool serves one brand, so a URL from
   * anywhere else is a user error worth reporting, not a page worth fetching.
   */
  STORE_ALLOWED_HOSTS: csv("beminimalist.co,global.beminimalist.co"),

  /** Default storefront used when a command is not given an explicit origin. */
  STORE_ORIGIN: z.string().url().default("https://beminimalist.co"),

  /**
   * Product photography lives on a different host to the storefront. It gets
   * its own allowlist rather than being trusted because a storefront response
   * happened to mention it.
   */
  IMAGE_CDN_HOSTS: csv("cdn.shopify.com"),

  /** Shopify's JSON endpoints do not report currency; the storefront implies it. */
  STORE_CURRENCY: z.string().length(3).default("INR"),

  /**
   * The whole pipeline runs on the Gemini key: gemini-3.7-flash writes copy and
   * scores creatives (it accepts image input), gemini-3-pro-image generates
   * them. Anthropic and OpenAI stay wired but unused — no key, no cost, and the
   * provider seam means adding one later is config, not code.
   */
  GEMINI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),

  /** Forces a provider. Unset means "whichever key is present", Gemini first. */
  IMAGE_PROVIDER: z.enum(["gemini", "openai"]).optional(),

  /**
   * Nano Banana Pro. Note it does NOT support the extreme banner ratios
   * (1:4, 4:1, 1:8, 8:1) that gemini-3.1-flash-image does, so leaderboard and
   * skyscraper placements must be derived by crop/extend rather than generated
   * natively. See docs/ARCHITECTURE.md §24.1.
   */
  GEMINI_IMAGE_MODEL: z.string().default("gemini-3-pro-image"),

  /** Copy generation, creative direction, and vision scoring. */
  GEMINI_TEXT_MODEL: z.string().default("gemini-3.7-flash"),

  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-1"),

  /**
   * Only needed for brand-asset discovery if the zero-dependency CSS extractor
   * in src/lib/scrape/brand-assets.ts proves insufficient. Product data never
   * needs it — Shopify publishes that as JSON.
   */
  FIRECRAWL_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration. ${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: forget the memoised environment. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * For code that genuinely needs Postgres. Throws where the need is, rather than
 * at import time in a module that a route merely happens to pull in.
 */
export function requireDatabaseUrl(): string {
  const url = env().DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Provision Postgres and inject its connection " +
        "string, or use a code path that does not read from the database.",
    );
  }
  return url;
}

export function hasDatabase(): boolean {
  return Boolean(env().DATABASE_URL);
}
