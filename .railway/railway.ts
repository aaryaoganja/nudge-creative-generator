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
 *   railway config apply    # apply after confirmation
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

  // Railway-managed Postgres. The helper owns provisioning; we only reference
  // its connection string from the web service below.
  const db = postgres("postgres");

  const web = service("web", {
    source: github("aaryaoganja/nudge-creative-generator", { branch: "main" }),

    // A Dockerfile is present at the repo root, so Railway builds with it and
    // no build/start command is needed here — the image's CMD runs the server.

    // Must match src/app/api/health/route.ts.
    healthcheck: "/api/health",
    healthcheckTimeout: 60,

    // Runs after build, before traffic shifts to the new deployment. A failure
    // here aborts the deploy, so a bad migration never serves traffic.
    preDeploy: "node node_modules/prisma/build/index.js migrate deploy",

    replicas: prod ? 2 : 1,

    env: {
      NODE_ENV: "production",
      DATABASE_URL: db.env.DATABASE_URL,
      // Set once in the Railway dashboard, then kept as-is by IaC. Without
      // preserve() the secret would have to live in this file, in git.
      ANTHROPIC_API_KEY: preserve(),
    },
  });

  return project("nudge-creative-generator", {
    resources: [db, web],
  });
});
