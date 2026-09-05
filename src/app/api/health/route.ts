import { NextResponse } from "next/server";
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
export async function GET() {
  const startedAt = Date.now();

  let database: "reachable" | "unreachable" | "not_configured" = "not_configured";
  let databaseError: string | null = null;

  if (hasDatabase()) {
    database = "unreachable";
    try {
      // Cheapest possible round-trip that proves the pool is actually usable.
      await getPrisma().$queryRaw`SELECT 1`;
      database = "reachable";
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
    }
  }

  // Surfaced so a misconfigured deployment is diagnosable from the probe alone,
  // rather than requiring a log dive. Booleans only — never the values.
  let providers = { gemini: false, firecrawl: false };
  let configError: string | null = null;
  try {
    const config = env();
    providers = {
      gemini: Boolean(config.GEMINI_API_KEY),
      firecrawl: Boolean(config.FIRECRAWL_API_KEY),
    };
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  return NextResponse.json({
    status: "ok",
    database,
    databaseError,
    databaseRequired: false,
    providers,
    configError,
    latencyMs: Date.now() - startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
