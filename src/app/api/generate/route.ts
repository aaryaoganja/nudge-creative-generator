import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  channel: z.enum(["email", "push", "sms", "in_app"]),
});

/**
 * Placeholder generation endpoint.
 *
 * The persistence, validation and error paths are real and deployable; the
 * generation step itself is a stub, since the creative-generation logic has not
 * been specified yet. Replace the marked block with the model call.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const { prompt, channel } = parsed.data;

  const creative = await prisma.creative.create({
    data: { prompt, channel, status: "PENDING" },
  });

  try {
    // --- replace me -------------------------------------------------------
    // Call the model here and use its output as `body`.
    const body = `[stub] ${channel} creative for: ${prompt}`;
    // ----------------------------------------------------------------------

    const done = await prisma.creative.update({
      where: { id: creative.id },
      data: { status: "READY", body },
    });

    return NextResponse.json(done, { status: 201 });
  } catch (error) {
    await prisma.creative.update({
      where: { id: creative.id },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      },
    });

    return NextResponse.json({ error: "Generation failed" }, { status: 502 });
  }
}

export async function GET() {
  const creatives = await prisma.creative.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({ creatives });
}
