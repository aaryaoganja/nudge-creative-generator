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
 * offset, and JPEG carries them in the first SOFn marker.
 */

export type ImageFormat = "png" | "jpeg" | "unknown";

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

  return { format: "unknown", width: null, height: null, bytes };
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
 * Deterministic layer-1 check: does this file meet the placement spec?
 *
 * Pure function, no model. Never ask a language model what 1080×1350 is.
 */
export function checkPlacement(
  data: Uint8Array,
  placement: { width: number; height: number; maxBytes: number | null; label: string },
): PlacementCheck {
  const meta = readImageMeta(data);
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!META_FORMATS.includes(meta.format)) {
    failures.push(
      `Format is "${meta.format}". Meta accepts JPG or PNG only.`,
    );
  }

  if (placement.maxBytes !== null && meta.bytes > placement.maxBytes) {
    failures.push(
      `File is ${(meta.bytes / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${(placement.maxBytes / 1024 / 1024).toFixed(0)}MB cap for ${placement.label}.`,
    );
  }

  if (meta.width === null || meta.height === null) {
    failures.push("Could not read image dimensions from the file header.");
    return { ok: false, failures, warnings, meta };
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
