import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { env, hasDatabase } from "@/lib/env";

// Railway probes this path (see .railway/railway.ts `healthcheck`). It must never
// be prerendered or cached, or the probe would pass against a stale snapshot.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Liveness probe.
 *
 * A health check must answer one question: can this service do its job? Right
 * now the job is resolving product pages, generating creatives and scoring
 * them — none of which touches Postgres. The database is reported, because
 * knowing it is unreachable is useful, but it does NOT fail the probe.
 *
 * That distinction matters operationally. Railway withholds traffic from a
 * deployment whose health check fails, so a 503 here over a database the app
 * never queries would take the whole UI offline for a dependency it does not
 * use — the failure looking, from the outside, exactly like "the site is down".
 *
 * When a route genuinely depends on Postgres, this becomes a hard failure again.
 */
/**
 * Which commit is actually live.
 *
 * Railway injects these automatically. Without them, "is the deploy current?"
 * takes a screenshot and a guess — this project spent a while serving a build
 * of a commit that no longer existed on any branch, and nothing in the running
 * app could say so. One curl now answers it.
 */
function deployment() {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA ?? null;
  return {
    commit: sha ? sha.slice(0, 7) : null,
    branch: process.env.RAILWAY_GIT_BRANCH ?? null,
    message: process.env.RAILWAY_GIT_COMMIT_MESSAGE?.split("\n")[0] ?? null,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
    service: process.env.RAILWAY_SERVICE_NAME ?? null,
  };
}

/**
 * This route is reachable without a session — Railway's prober has no cookie
 * jar, and a probe that fails takes the whole deployment out of rotation.
 *
 * The middleware used to answer it directly with a hardcoded 200, which meant
 * the health check reported "ok" for a build whose route handlers could not
 * load at all. It passes through now, so reaching this code IS the liveness
 * signal — and the redaction that used to justify the short-circuit happens
 * here instead: an anonymous caller learns that the service is up and nothing
 * else. Commit SHAs, provider booleans and database errors are for whoever can
 * sign in.
 */
export async function GET() {
  const startedAt = Date.now();

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const authenticated = await verifySessionToken(token);

  if (!authenticated) {
    return NextResponse.json(
      { status: "ok", authenticated: false },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  let database: "reachable" | "unreachable" | "not_configured" = "not_configured";
  let databaseError: string | null = null;

  if (hasDatabase()) {
    database = "unreachable";
    try {
      // Cheapest possible round-trip that proves the pool is actually usable.
      await (await getPrisma()).$queryRaw`SELECT 1`;
      database = "reachable";
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
    }
  }

  // Surfaced so a misconfigured deployment is diagnosable from the probe alone,
  // rather than requiring a log dive. Booleans only — never the values.
  let providers = { gemini: false };
  let configError: string | null = null;
  try {
    const config = env();
    // One provider now. Page enrichment reads the storefront directly, so
    // there is no second key whose absence could quietly change behaviour.
    providers = { gemini: Boolean(config.GEMINI_API_KEY) };
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  return NextResponse.json({
    status: "ok",
    authenticated: true,
    // Present in every signed-in response so a stale deployment identifies itself.
    deployment: deployment(),
    // Bumped whenever the shape of this response changes, so a client can tell
    // an old build from a new one even if the git vars are unavailable.
    appVersion: "0.2.0-studio",
    database,
    databaseError,
    databaseRequired: false,
    providers,
    configError,
    latencyMs: Date.now() - startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
