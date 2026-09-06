/**
 * Live provider verification — proves the keys and wire shapes actually work.
 *
 *   railway run npm run verify              # free: models, text round-trip, page read
 *   railway run npm run verify -- --image   # adds one real generation (~$0.134)
 *
 * `npm run models` only lists what a key can see. This actually SENDS something
 * and reads the reply, which is the only way to confirm the request shapes in
 * gemini-text.ts and gemini-image.ts are accepted, the one class
 * of fault the offline smoke test cannot reach.
 *
 * Each check is independent and reports on its own, so a page-read failure does
 * not hide a Gemini success. Exit code is non-zero if any free check fails.
 */

import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GeminiTextClient } from "../src/lib/providers/gemini-text.ts";
import { GeminiImageProvider } from "../src/lib/providers/gemini-image.ts";
import { fetchPageText } from "../src/lib/scrape/page-text.ts";
import { readImageMeta } from "../src/lib/image/meta.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string, skipped = false) {
  checks.push({ name, ok, detail, skipped });
  const mark = skipped ? "–" : ok ? "✓" : "✗";
  console.log(`  ${mark} ${name}\n      ${detail}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkModelsVisible(apiKey: string, wantText: string, wantImage: string) {
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": apiKey } },
    );
    if (!response.ok) {
      record(
        "Gemini key is valid",
        false,
        `GET /models returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
      return;
    }
    const payload = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    const ids = new Set(
      (payload.models ?? []).map((m) => (m.name ?? "").replace(/^models\//, "")),
    );
    record("Gemini key is valid", true, `${ids.size} models visible`);
    record(
      `Text model available (${wantText})`,
      ids.has(wantText),
      ids.has(wantText) ? "present" : "NOT in this key's model list",
    );
    record(
      `Image model available (${wantImage})`,
      ids.has(wantImage),
      ids.has(wantImage) ? "present" : "NOT in this key's model list",
    );
  } catch (error) {
    record("Gemini key is valid", false, errorText(error));
  }
}

async function checkTextRoundTrip(apiKey: string, model: string) {
  try {
    const client = new GeminiTextClient(apiKey, model);
    const result = await client.generateJson<{ ok: boolean; brand: string }>(
      {
        system:
          "You verify API connectivity. Reply with JSON only, no commentary.",
        prompt:
          'Return exactly {"ok": true, "brand": "Minimalist"} and nothing else.',
        responseSchema: {
          type: "object",
          properties: { ok: { type: "boolean" }, brand: { type: "string" } },
          required: ["ok", "brand"],
        },
        temperature: 0,
        maxOutputTokens: 256,
      },
      (value) => value as { ok: boolean; brand: string },
    );

    record(
      "Text round-trip + structured output",
      result.value?.ok === true,
      `replied ${JSON.stringify(result.value)} · ${result.usage.inputTokens} in / ` +
        `${result.usage.outputTokens} out · $${result.usage.costUsd.toFixed(6)} · ${result.latencyMs}ms`,
    );
  } catch (error) {
    record(
      "Text round-trip + structured output",
      false,
      `${errorText(error)}\n      → the request shape in src/lib/providers/gemini-text.ts needs correcting`,
    );
  }
}

async function checkVision(apiKey: string, model: string) {
  // A 2×2 PNG is enough to prove image input is accepted on this model.
  const tiny = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8AARIQBEyMDGgAAeYEDAcU3FUAAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    const client = new GeminiTextClient(apiKey, model);
    const result = await client.generateJson<{ sawImage: boolean }>(
      {
        prompt:
          'An image is attached. Return exactly {"sawImage": true} if you can see it.',
        responseSchema: {
          type: "object",
          properties: { sawImage: { type: "boolean" } },
          required: ["sawImage"],
        },
        temperature: 0,
        maxOutputTokens: 256,
        images: [{ bytes: tiny, mimeType: "image/png" }],
      },
      (value) => value as { sawImage: boolean },
    );
    record(
      "Vision input accepted (powers the scorer)",
      result.value?.sawImage === true,
      `replied ${JSON.stringify(result.value)} · $${result.usage.costUsd.toFixed(6)}`,
    );
  } catch (error) {
    record("Vision input accepted (powers the scorer)", false, errorText(error));
  }
}

/**
 * Can this deployment read the product page?
 *
 * The one check that has to run from inside the container. A storefront that
 * serves its content happily to a browser can still refuse a datacentre IP, and
 * that is the only circumstance in which a hosted scraper would be worth
 * reintroducing. If this passes, the built-in reader is enough.
 */
async function checkPageRead(productUrl: string) {
  const hosts = (process.env.STORE_ALLOWED_HOSTS ?? "beminimalist.co")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  try {
    const page = await fetchPageText(productUrl, { allowedHosts: hosts });
    const hasSubstance = page.markdown.length >= 200;
    record(
      "Product page read (no key, no third party)",
      hasSubstance,
      hasSubstance
        ? `${page.markdown.length} chars, title: ${page.title ?? "none"}`
        : `only ${page.markdown.length} chars came back, which is not enough to enrich a brief`,
    );
    if (hasSubstance) {
      console.log(
        `      first 160 chars: ${page.markdown.slice(0, 160).replace(/\n/g, " ")}`,
      );
    }
  } catch (error) {
    record(
      "Product page read (no key, no third party)",
      false,
      `${errorText(error)}\n      the storefront refused this container. Briefs will` +
        `\n      still generate, from the product JSON alone, and the UI will say so.`,
    );
  }
}

async function checkImageGeneration(apiKey: string, model: string, outDir: string) {
  try {
    const provider = new GeminiImageProvider(apiKey, model);
    const image = await provider.generate({
      prompt:
        "A single unbranded white cosmetic bottle centred on a warm sand-toned " +
        "plaster surface. Soft directional daylight from the upper left, long " +
        "soft shadow. Minimal, clinical, generous negative space. No text.",
      aspectRatio: "4:5",
      resolution: "2K",
    });

    const meta = readImageMeta(image.bytes);
    await mkdir(outDir, { recursive: true });
    const path = join(outDir, `verify.${meta.format === "jpeg" ? "jpg" : "png"}`);
    await writeFile(path, image.bytes);

    record(
      "Image generation round-trip",
      image.bytes.byteLength > 0,
      `${meta.format} ${meta.width}×${meta.height} · ` +
        `${(image.bytes.byteLength / 1024).toFixed(0)}KB · ${image.latencyMs}ms · $0.134\n` +
        `      → ${path}`,
    );
  } catch (error) {
    record(
      "Image generation round-trip",
      false,
      `${errorText(error)}\n      → the request shape in src/lib/providers/gemini-image.ts needs correcting`,
    );
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      image: { type: "boolean", default: false },
      url: { type: "string" },
      out: { type: "string" },
    },
  });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "✗ GEMINI_API_KEY is not set.\n  Railway:  railway run npm run verify",
    );
    return 1;
  }

  const textModel = process.env.GEMINI_TEXT_MODEL ?? "gemini-3.7-flash";
  const imageModel = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image";
  const productUrl =
    values.url ??
    process.env.STORE_ORIGIN ??
    "https://beminimalist.co/products/hair-growth-anti-grey-actives-15-6-hair-serum";

  console.log(`\nVerifying live providers\n  text : ${textModel}\n  image: ${imageModel}\n`);

  await checkModelsVisible(apiKey, textModel, imageModel);
  await checkTextRoundTrip(apiKey, textModel);
  await checkVision(apiKey, textModel);
  await checkPageRead(productUrl);

  if (values.image) {
    await checkImageGeneration(apiKey, imageModel, values.out ?? "out/verify");
  } else {
    record(
      "Image generation round-trip",
      true,
      "skipped — pass --image to spend $0.134 and confirm it",
      true,
    );
  }

  const failed = checks.filter((c) => !c.ok && !c.skipped);
  const passed = checks.filter((c) => c.ok && !c.skipped);
  console.log(
    `\n${passed.length} passed, ${failed.length} failed, ` +
      `${checks.filter((c) => c.skipped).length} skipped\n`,
  );

  if (failed.length > 0) {
    console.log("Failing checks name the file to correct. Nothing else is wired to them.\n");
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`✗ ${errorText(error)}`);
    process.exitCode = 1;
  });
