import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env, requireDatabaseUrl } from "@/lib/env";

/**
 * Prisma client, constructed LAZILY.
 *
 * This module used to build the client at import time. That made merely
 * importing it fatal when DATABASE_URL was absent — and because Next bundles a
 * route's whole import graph, a single route that touched this file took itself
 * down on a deployment with no database, over a query it might never run.
 *
 * Nothing user-facing reads Postgres yet, so construction is deferred until a
 * caller actually asks. When one does and there is no connection string, the
 * error names the missing variable at the point of use rather than at boot.
 *
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * connection pool on every edit until Postgres refuses connections. The client
 * is cached on globalThis so only one pool ever exists per process.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: requireDatabaseUrl() });
  return new PrismaClient({
    adapter,
    log:
      env().NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
  });
}

/** Throws a named error if DATABASE_URL is unset. */
export function getPrisma(): PrismaClient {
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}
