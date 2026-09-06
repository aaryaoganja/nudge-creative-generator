/**
 * Image dimensions and format, read from the file header.
 *
 * Meta accepts JPG and PNG up to 30 MB and treats its published pixel sizes as
 * MINIMUMS rather than targets, so a 2K generation at 4:5 is already above spec
 * for the 1080×1350 feed placement. That removes the need for a resize step —
 * and therefore an image-processing dependency — from v0 entirely. What is
 * still needed is proof that what the model returned actually meets the spec,
 * which is what this does.
 *
 * Zero dependencies: PNG carries width and height in the IHDR chunk at a fixed
 * offset, JPEG carries them in the first SOFn marker, and WebP carries them in
 * the chunk immediately after the RIFF header.
 *
 * WebP is read but not accepted for a Meta placement, which is the honest
 * position: Meta takes JPG and PNG only, so a WebP upload has to be told that
 * rather than told "this is not an image". The scorer's file picker offers WebP
 * and its route allows the MIME type, so before this the sniffer reported
 * `unknown` and every WebP was refused as a corrupt file.
 */

export type ImageFormat = "png" | "jpeg" | "webp" | "unknown";

export interface ImageMeta {
  format: ImageFormat;
  width: number | null;
  height: number | null;
  bytes: number;
}

export function readImageMeta(data: Uint8Array): ImageMeta {
  const bytes = data.byteLength;

  if (isPng(data)) {
    // Signature (8) + length (4) + "IHDR" (4) → width at 16, height at 20.
    if (bytes >= 24) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        format: "png",
        width: view.getUint32(16, false),
        height: view.getUint32(20, false),
        bytes,
      };
    }
    return { format: "png", width: null, height: null, bytes };
  }

  if (isJpeg(data)) {
    const dims = jpegDimensions(data);
    return { format: "jpeg", width: dims?.width ?? null, height: dims?.height ?? null, bytes };
  }

  if (isWebp(data)) {
    const dims = webpDimensions(data);
    return { format: "webp", width: dims?.width ?? null, height: dims?.height ?? null, bytes };
  }

  return { format: "unknown", width: null, height: null, bytes };
}

/** "RIFF" .... "WEBP" */
function isWebp(d: Uint8Array): boolean {
  return (
    d.length >= 12 &&
    d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 &&
    d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50
  );
}

/**
 * Three container variants, all little-endian, all with the size in the chunk
 * that starts at byte 12.
 *
 *   VP8    lossy      14-bit width and height at offset 26, after a 3-byte
 *                     start code and the 0x9d012a sync marker
 *   VP8L   lossless   14-bit width-1 and height-1 packed into 4 bytes at 21
 *   VP8X   extended   24-bit canvas width-1 and height-1 at offset 24
 */
function webpDimensions(d: Uint8Array): { width: number; height: number } | null {
  const chunk = String.fromCharCode(d[12], d[13], d[14], d[15]);

  if (chunk === "VP8 " && d.length >= 30) {
    return {
      width: ((d[27] << 8) | d[26]) & 0x3fff,
      height: ((d[29] << 8) | d[28]) & 0x3fff,
    };
  }

  if (chunk === "VP8L" && d.length >= 25) {
    const bits = d[21] | (d[22] << 8) | (d[23] << 16) | (d[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === "VP8X" && d.length >= 30) {
    return {
      width: (d[24] | (d[25] << 8) | (d[26] << 16)) + 1,
      height: (d[27] | (d[28] << 8) | (d[29] << 16)) + 1,
    };
  }

  return null;
}

function isPng(d: Uint8Array): boolean {
  return (
    d.length >= 8 &&
    d[0] === 0x89 &&
    d[1] === 0x50 &&
    d[2] === 0x4e &&
    d[3] === 0x47 &&
    d[4] === 0x0d &&
    d[5] === 0x0a &&
    d[6] === 0x1a &&
    d[7] === 0x0a
  );
}

function isJpeg(d: Uint8Array): boolean {
  return d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff;
}

function jpegDimensions(d: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < d.length) {
    if (d[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = d[offset + 1];
    // SOF0–SOF15, excluding DHT (c4), JPG (c8) and DAC (cc) which are not frames.
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isFrame) {
      return {
        height: (d[offset + 5] << 8) | d[offset + 6],
        width: (d[offset + 7] << 8) | d[offset + 8],
      };
    }
    const length = (d[offset + 2] << 8) | d[offset + 3];
    if (length <= 0) return null;
    offset += 2 + length;
  }
  return null;
}

export interface PlacementCheck {
  ok: boolean;
  failures: string[];
  warnings: string[];
  meta: ImageMeta;
}

/** Meta accepts these two and nothing else for image ads. */
const META_FORMATS: ImageFormat[] = ["png", "jpeg"];

/**
 * The widest limits any placement in the catalogue imposes.
 *
 * Used when the caller has not said which placement a creative is for. The
 * format and byte checks still mean something without a target shape; the size
 * and ratio checks do not, and inventing one produced the worst kind of
 * finding: a square creative failed for not being 4:5 when nobody had ever
 * claimed it was.
 */
const UNSPECIFIED_PLACEMENT = {
  label: "an unspecified placement",
  maxBytes: 30 * 1024 * 1024,
};

/**
 * Deterministic layer-1 check: does this file meet the placement spec?
 *
 * Pure function, no model. Never ask a language model what 1080×1350 is.
 *
 * `placement` may be null, meaning the creative was uploaded without saying
 * what it is for. Format and file size are still checked; dimensions and aspect
 * ratio are reported, not judged.
 */
export function checkPlacement(
  data: Uint8Array,
  placement:
    | { width: number; height: number; maxBytes: number | null; label: string }
    | null,
): PlacementCheck {
  const meta = readImageMeta(data);
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!META_FORMATS.includes(meta.format)) {
    failures.push(
      meta.format === "webp"
        ? "This is a WebP. Meta and Google both take JPG or PNG only, so this file cannot be uploaded as it is. Everything else below still applies; re-export it as PNG."
        : `Format is "${meta.format}". Meta accepts JPG or PNG only.`,
    );
  }

  const capBytes = placement
    ? placement.maxBytes
    : UNSPECIFIED_PLACEMENT.maxBytes;
  const capLabel = placement ? placement.label : UNSPECIFIED_PLACEMENT.label;

  if (capBytes !== null && meta.bytes > capBytes) {
    failures.push(
      `File is ${(meta.bytes / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${(capBytes / 1024 / 1024).toFixed(0)}MB cap for ${capLabel}.`,
    );
  }

  if (meta.width === null || meta.height === null) {
    failures.push("Could not read image dimensions from the file header.");
    return { ok: false, failures, warnings, meta };
  }

  // No stated placement, so there is no shape to be wrong about.
  if (!placement) {
    return { ok: failures.length === 0, failures, warnings, meta };
  }

  // Meta's sizes are minimums, so larger passes; smaller does not.
  if (meta.width < placement.width || meta.height < placement.height) {
    failures.push(
      `Image is ${meta.width}×${meta.height}, below the ${placement.width}×${placement.height} ` +
        `minimum for ${placement.label}.`,
    );
  }

  const targetRatio = placement.width / placement.height;
  const actualRatio = meta.width / meta.height;
  const drift = Math.abs(actualRatio - targetRatio) / targetRatio;

  if (drift > 0.02) {
    // Meta will letterbox or crop a mismatched ratio — silently, and usually
    // through the headline.
    failures.push(
      `Aspect ratio is ${actualRatio.toFixed(3)} but ${placement.label} expects ` +
        `${targetRatio.toFixed(3)}. Meta will crop or letterbox this.`,
    );
  } else if (drift > 0.005) {
    warnings.push(
      `Aspect ratio is ${actualRatio.toFixed(3)} against an expected ${targetRatio.toFixed(3)}. Close, but not exact.`,
    );
  }

  return { ok: failures.length === 0, failures, warnings, meta };
}
