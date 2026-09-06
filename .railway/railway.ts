/**
 * Railway Infrastructure as Code.
 *
 * This replaces railway.json / railway.toml (Config as Code), which is deprecated
 * and which new services cannot opt into at all. Railway reads this file through
 * the CLI, not at deploy time:
 *
 *   npm install
 *   railway login && railway link
 *   railway config plan     # preview, read-only
 *   railway config apply    # applies after confirmation
 *
 * Docs: https://docs.railway.com/infrastructure-as-code/reference
 */
import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

export default defineRailway((ctx) => {
  const prod = ctx.environment === "production";

  // Railway-managed Postgres. Provisioned now so the schema work in
  // docs/PLAN.md §6 has somewhere to land; nothing user-facing reads it yet.
  const db = postgres("postgres");

  const web = service("web", {
    // Must match the repository's DEFAULT branch, or Railway builds whatever
    // the default happens to point at rather than this code.
    source: github("aaryaoganja/nudge-creative-generator", { branch: "main" }),

    // A Dockerfile is present at the repo root, so Railway builds with it and
    // no build/start command is needed here — the image's CMD runs the server.

    // Must match src/app/api/health/route.ts. That route still does NOT fail on
    // an unreachable database, even now that run history is a Postgres table.
    // The reasoning has changed rather than gone away: without Postgres the app
    // degrades to in-memory history and says so in the UI, so every paid
    // feature still works. Failing the probe would take a mostly-working
    // deployment out of rotation over a feature that has already handled its
    // own absence.
    healthcheck: "/api/health",
    healthcheckTimeout: 60,

    // Migrations run before traffic shifts. This was deliberately commented out
    // while nothing read Postgres, with the instruction to restore it in the
    // same change that introduced the first route which actually queries it.
    // That change is this one: runs and run_assets are created by
    // prisma/migrations/20260905230519_runs_and_assets, and without this line
    // those tables would simply not exist here. The failure would not be loud:
    // the deploy would succeed, the health check would pass, and every write to
    // history would throw at request time on both replicas.
    //
    // The full path is deliberate. Next's standalone output prunes node_modules
    // to what the app imports at runtime and nothing imports the Prisma CLI, so
    // the Dockerfile copies it in explicitly for exactly this command.
    preDeploy: "node node_modules/prisma/build/index.js migrate deploy",

    replicas: prod ? 2 : 1,

    env: {
      NODE_ENV: "production",
      DATABASE_URL: db.env.DATABASE_URL,

      // Storefront. Not secret — kept here so the allowlist that gates every
      // outbound fetch is reviewable in git rather than hidden in a dashboard.
      STORE_ALLOWED_HOSTS: "beminimalist.co,global.beminimalist.co",
      STORE_ORIGIN: "https://beminimalist.co",
      STORE_CURRENCY: "INR",
      IMAGE_CDN_HOSTS: "cdn.shopify.com",

      // Models. Overridable without a code change; verify against a live key
      // with `railway run npm run models`.
      GEMINI_TEXT_MODEL: "gemini-3.7-flash",
      GEMINI_IMAGE_MODEL: "gemini-3-pro-image",

      // Secrets: set once in the Railway dashboard, then kept as-is by IaC.
      // Without preserve() they would have to live in this file, in git.
      //
      // APP_PASSWORD is the gate. It MUST be listed here: this env block is
      // declarative, so a variable set in the dashboard but absent from the map
      // is liable to be dropped by `railway config apply` — at which point the
      // gate silently falls back to the default that is published in this
      // repository, and the deployment is effectively open.
      APP_PASSWORD: preserve(),
      GEMINI_API_KEY: preserve(),
      FIRECRAWL_API_KEY: preserve(),
    },
  });

  return project("nudge-creative-generator", {
    resources: [db, web],
  });
});
