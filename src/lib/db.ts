import type { PrismaClient } from "@/generated/prisma/client";
import { env, requireDatabaseUrl } from "./env.ts";

/**
 * Prisma client, constructed LAZILY.
 *
 * This module used to build the client at import time. That made merely
 * importing it fatal when DATABASE_URL was absent — and because Next bundles a
 * route's whole import graph, a single route that touched this file took itself
 * down on a deployment with no database, over a query it might never run.
 *
 * Construction is deferred until a caller actually asks. When one does and
 * there is no connection string, the error names the missing variable at the
 * point of use rather than at boot.
 *
 * The generated client is also imported dynamically, not statically. That is
 * not a micro-optimisation: `@/generated/prisma/client` is produced by
 * `prisma generate` and resolved through a tsconfig path alias, so a static
 * import makes this module unloadable anywhere the alias is not resolved. The
 * unit tests run TypeScript directly on plain Node with no bundler, so a
 * top-level import here would take down every test that touches run history
 * without ever intending to open a connection. Dynamic import keeps the client
 * entirely out of the graph until something with a real DATABASE_URL asks.
 *
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * connection pool on every edit until Postgres refuses connections. The client
 * is cached on globalThis so only one pool ever exists per process.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

async function createClient(): Promise<PrismaClient> {
  // Both imports deferred: the adapter and the generated client are the two
  // heaviest things in the graph and neither is needed without a connection.
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import("@prisma/adapter-pg"),
    import("@/generated/prisma/client"),
  ]);
  const adapter = new PrismaPg({ connectionString: requireDatabaseUrl() });
  return new PrismaClient({
    adapter,
    log:
      env().NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
  });
}

/** Throws a named error if DATABASE_URL is unset. */
export async function getPrisma(): Promise<PrismaClient> {
  globalForPrisma.prisma ??= await createClient();
  return globalForPrisma.prisma;
}
