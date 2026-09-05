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

    // Must match src/app/api/health/route.ts. That route deliberately does NOT
    // fail on an unreachable database: no user-facing route queries Postgres
    // yet, and a 503 over an unused dependency would make Railway withhold
    // traffic from a perfectly working UI.
    healthcheck: "/api/health",
    healthcheckTimeout: 60,

    // Runs after build, before traffic shifts to the new deployment. A failure
    // here aborts the deploy, so a bad migration never serves traffic.
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
      GEMINI_API_KEY: preserve(),
      FIRECRAWL_API_KEY: preserve(),
    },
  });

  return project("nudge-creative-generator", {
    resources: [db, web],
  });
});
