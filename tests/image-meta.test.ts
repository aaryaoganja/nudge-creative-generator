import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readImageMeta, checkPlacement } from "../src/lib/image/meta.ts";

const META_4X5 = {
  width: 1080,
  height: 1350,
  maxBytes: 30 * 1024 * 1024,
  label: "Meta Feed 4:5",
};

/** Minimal valid PNG header carrying the given dimensions. */
function png(width: number, height: number, padTo = 0): Uint8Array {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return padTo > head.length
    ? Buffer.concat([head, Buffer.alloc(padTo - head.length)])
    : head;
}

/**
 * Minimal but well-formed JPEG: SOI, a correctly-sized APP0 segment that must
 * be skipped, then the SOF0 frame carrying the dimensions.
 */
function jpeg(width: number, height: number): Uint8Array {
  const soi = Buffer.from([0xff, 0xd8]);

  const app0 = Buffer.alloc(18);
  app0.writeUInt8(0xff, 0);
  app0.writeUInt8(0xe0, 1);
  app0.writeUInt16BE(16, 2); // length covers the 16 bytes after the marker
  app0.write("JFIF\0", 4, "ascii");

  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(11, 2);
  sof.writeUInt8(8, 4); // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  return Buffer.concat([soi, app0, sof]);
}

describe("readImageMeta", () => {
  it("reads PNG dimensions from the IHDR chunk", () => {
    const meta = readImageMeta(png(1638, 2048));
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 1638);
    assert.equal(meta.height, 2048);
  });

  it("reads JPEG dimensions from the SOF0 marker", () => {
    const meta = readImageMeta(jpeg(1080, 1350));
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1350);
  });

  it("reports unknown for anything that is not an image", () => {
    const meta = readImageMeta(Buffer.from("<!doctype html>", "utf8"));
    assert.equal(meta.format, "unknown");
    assert.equal(meta.width, null);
  });
});

describe("checkPlacement — Meta 4:5", () => {
  it("accepts a 2K generation, since Meta's sizes are minimums", () => {
    // 1638×2048 is 4:5 and above the 1080×1350 minimum. This is what Nano
    // Banana Pro returns at 2K, and it must pass without a resize step.
    const result = checkPlacement(png(1638, 2048), META_4X5);
    assert.equal(result.ok, true, result.failures.join("; "));
  });

  it("accepts exactly 1080×1350", () => {
    assert.equal(checkPlacement(png(1080, 1350), META_4X5).ok, true);
  });

  it("rejects an image below the minimum", () => {
    const result = checkPlacement(png(540, 675), META_4X5);
    assert.equal(result.ok, false);
    assert.match(result.failures.join(" "), /below the 1080×1350 minimum/);
  });

  it("rejects a square image sent to a 4:5 placement", () => {
    // Meta would crop this, usually through the headline.
    const result = checkPlacement(png(1080, 1080), META_4X5);
    assert.equal(result.ok, false);
    assert.match(result.failures.join(" "), /crop or letterbox/);
  });

  it("rejects a format Meta does not accept", () => {
    const gif = Buffer.from("GIF89a" + "\0".repeat(20), "binary");
    const result = checkPlacement(gif, META_4X5);
    assert.equal(result.ok, false);
    assert.match(result.failures.join(" "), /Meta accepts JPG or PNG only/);
  });

  it("rejects a file over the size cap", () => {
    const result = checkPlacement(png(1638, 2048, 1024), {
      ...META_4X5,
      maxBytes: 512,
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join(" "), /over the/);
  });
});
