import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * connection pool on every edit until Postgres refuses connections. Cache the
 * client on globalThis so only one pool ever exists per process.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env().DATABASE_URL });
  return new PrismaClient({
    adapter,
    log:
      env().NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createClient();

if (env().NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
