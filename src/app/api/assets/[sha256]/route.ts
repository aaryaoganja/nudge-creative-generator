import { NextResponse } from "next/server";
import { isAssetId, storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Serve a stored image by its own content hash.
 *
 * Behind the password gate, like everything else. Serving these from the app
 * rather than from a presigned storage URL is the point: an image is exactly as
 * private as the run it belongs to, and no third-party host enters the product.
 *
 * The response is immutable by construction. The URL names a SHA-256 and the
 * body is the bytes with that hash, so the same URL can never return anything
 * else. That is what earns the one-year immutable cache header, which matters
 * here because these are megabyte images that a shared run re-requests on every
 * open.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sha256: string }> },
) {
  const { sha256 } = await params;

  // Reject the shape before touching the database: an id that is not 64 hex
  // characters cannot name an asset, and saying so costs no query.
  if (!isAssetId(sha256)) {
    return NextResponse.json({ error: "Not an asset id." }, { status: 400 });
  }

  const asset = await storage().get(sha256);
  if (!asset) {
    return NextResponse.json(
      {
        error:
          "That image is no longer stored. Images are kept for recent runs only; the copy, prompts and scores for this run are still here.",
      },
      { status: 404 },
    );
  }

  return new NextResponse(Buffer.from(asset.data), {
    status: 200,
    headers: {
      "content-type": asset.mimeType,
      "content-length": String(asset.byteSize),
      "cache-control": "private, max-age=31536000, immutable",
      // The bytes are attacker-influenced only in the sense that a signed-in
      // user chose what to generate, but they are served from our origin, so
      // sniffing is switched off rather than trusted.
      "x-content-type-options": "nosniff",
    },
  });
}
