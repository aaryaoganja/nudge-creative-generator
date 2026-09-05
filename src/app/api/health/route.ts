import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Railway probes this path (see .railway/railway.ts `healthcheck`). It must never
// be prerendered or cached, or the probe would pass against a stale snapshot.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const startedAt = Date.now();

  try {
    // Cheapest possible round-trip that proves the pool is actually usable.
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    return NextResponse.json(
      {
        status: "unhealthy",
        database: "unreachable",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    status: "ok",
    database: "reachable",
    latencyMs: Date.now() - startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
