/**
 * Server startup.
 *
 * Next calls `register` once per server instance, before the first request is
 * served. One thing happens here, and it exists to keep a promise the product
 * makes: run history survives every deploy.
 *
 * The mechanism and the argument for doing it from inside the server are in
 * src/lib/migrate.ts. What matters at this level is the failure posture, which
 * is the one this project applies everywhere else: nothing here can stop the
 * server from booting. A missing database, an unreachable one, a migration that
 * fails or hangs, all of it ends with the app running and saying what is
 * degraded, because a deployment that refuses to start over its history table
 * is a worse outcome than one that starts and tells you the history table is
 * missing.
 */

/**
 * Below Railway's 60s healthcheckTimeout with room for the app's own startup.
 * Two small CREATE TABLE migrations take well under a second; this is sized for
 * a database that is still waking up, not for the DDL.
 */
const BOOT_BUDGET_MS = 25_000;

export async function register(): Promise<void> {
  // The Edge runtime has no child processes and no Postgres driver. Guarding
  // with a dynamic import rather than a top-level one keeps node:child_process
  // out of the Edge bundle entirely, which is the documented pattern.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureSchemaWithin } = await import("@/lib/migrate");
  const outcome = await ensureSchemaWithin(BOOT_BUDGET_MS);

  if (outcome === null) {
    console.warn(
      `[boot] Migrations are still running after ${BOOT_BUDGET_MS}ms. Serving now; history becomes durable when they finish.`,
    );
  }
}
