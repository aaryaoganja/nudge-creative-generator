/**
 * Phase 0 — one end-to-end run, to disk.
 *
 *   railway run npm run try -- <product-url>
 *   npm run try -- <product-url> --concepts 2 --no-image
 *
 * Real product → brief → policy gate → image prompt → ONE image → files on disk.
 * The smallest thing that exercises every integration at once: the scraper, the
 * CDN fetch, both Gemini models, structured output, and the claim lock.
 *
 * Deliberately writes everything it did — prompts included — so that when a
 * creative comes out wrong the first question ("what did we actually ask for?")
 * is answerable without re-running anything.
 *
 * Costs real money: ~$0.007 for the brief plus ~$0.134 per image.
 * `--no-image` runs the whole chain except generation, for free.
 */

import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ShopifyClient } from "../src/lib/scrape/shopify.ts";
import { safeFetchBinary, FetchRejectedError } from "../src/lib/http/safe-fetch.ts";
import { GeminiTextClient } from "../src/lib/providers/gemini-text.ts";
import { GeminiImageProvider } from "../src/lib/providers/gemini-image.ts";
import { generateBrief, renderImagePrompt } from "../src/lib/pipeline/brief.ts";
import { claimsFrom, PLACEMENTS } from "../src/lib/pipeline/types.ts";
import { checkPolicy, type Finding } from "../src/lib/policy/check.ts";
import type { Objective } from "../config/brand.ts";

const IMAGE_COST_USD = 0.134;

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function hosts(name: string, fallback: string): string[] {
  return env(name, fallback)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function severityMark(severity: Finding["severity"]): string {
  return severity === "blocking" ? "✗" : severity === "major" ? "!" : "·";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      concepts: { type: "string" },
      objective: { type: "string" },
      offer: { type: "string" },
      angle: { type: "string" },
      audience: { type: "string" },
      out: { type: "string" },
      "no-image": { type: "boolean", default: false },
    },
  });

  const url = positionals[0];
  if (!url) {
    console.error(
      "Usage: npm run try -- <product-url> [--concepts 2] [--objective conversion]\n" +
        "                     [--offer \"20% off\"] [--angle \"...\"] [--no-image]",
    );
    return 1;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "✗ GEMINI_API_KEY is not set.\n  Railway:  railway run npm run try -- <url>",
    );
    return 1;
  }

  const conceptCount = Math.min(Math.max(Number(values.concepts ?? 2), 1), 5);
  const objective = (values.objective ?? "conversion") as Objective;
  const placement = PLACEMENTS.meta_feed_4x5;
  const outDir = values.out ?? join("out", String(Date.now()));

  const storeHosts = hosts(
    "STORE_ALLOWED_HOSTS",
    "beminimalist.co,global.beminimalist.co",
  );
  const cdnHosts = hosts("IMAGE_CDN_HOSTS", "cdn.shopify.com");

  await mkdir(outDir, { recursive: true });
  let spend = 0;

  // ── 1. resolve ────────────────────────────────────────────────────────────
  console.log(`\n[1/5] resolve   ${url}`);
  const shopify = new ShopifyClient({
    allowedHosts: storeHosts,
    currency: env("STORE_CURRENCY", "INR"),
  });
  const snapshot = await shopify.fetchProduct(url);
  const claims = claimsFrom(snapshot);

  console.log(`      ${snapshot.title}`);
  console.log(
    `      ${claims.priceDisplay ?? "—"}` +
      (claims.compareAtDisplay ? ` was ${claims.compareAtDisplay}` : "") +
      (claims.discountPct !== null ? `  −${claims.discountPct}%` : ""),
  );
  console.log(
    `      claim-bearing values: ${claims.concentrations.join(", ") || "none"}`,
  );
  console.log(`      ${snapshot.images.length} images`);
  await writeFile(
    join(outDir, "01-snapshot.json"),
    JSON.stringify(snapshot, null, 2),
  );

  // ── 2. brief ──────────────────────────────────────────────────────────────
  console.log(`\n[2/5] brief     ${conceptCount} concepts · ${objective} · ${placement.label}`);
  const text = new GeminiTextClient(
    apiKey,
    env("GEMINI_TEXT_MODEL", "gemini-3.7-flash"),
  );
  const briefResult = await generateBrief(text, {
    snapshot,
    claims,
    placement,
    objective,
    conceptCount,
    offer: values.offer,
    angleHint: values.angle,
    audience: values.audience,
  });
  spend += briefResult.usage.costUsd;

  console.log(
    `      ${briefResult.usage.inputTokens} in / ${briefResult.usage.outputTokens} out` +
      `  $${briefResult.usage.costUsd.toFixed(4)}  ${briefResult.latencyMs}ms`,
  );
  await writeFile(
    join(outDir, "02-brief.json"),
    JSON.stringify(briefResult.value, null, 2),
  );

  // ── 3. policy gate — before any image spend ───────────────────────────────
  console.log(`\n[3/5] policy    gate runs before generation`);
  const gated = briefResult.value.concepts.map((brief, i) => {
    const result = checkPolicy(brief, claims);
    const label = `${i + 1}. ${brief.concept.name}`;
    const mark =
      result.verdict === "pass" ? "✓" : result.verdict === "blocked" ? "✗" : "!";
    console.log(`      ${mark} ${label}  [${result.verdict}]`);
    console.log(`         "${brief.copy.headline}"`);
    for (const f of result.findings) {
      console.log(
        `         ${severityMark(f.severity)} ${f.ruleId} @ ${f.field}: "${f.evidence}"`,
      );
    }
    return { brief, result };
  });
  await writeFile(
    join(outDir, "03-policy.json"),
    JSON.stringify(
      gated.map((g) => ({ concept: g.brief.concept.name, ...g.result })),
      null,
      2,
    ),
  );

  const passing = gated.filter((g) => g.result.verdict !== "blocked");
  if (passing.length === 0) {
    console.log(
      `\n✗ Every concept was blocked by the policy gate. No image spend.`,
    );
    console.log(`  Artefacts: ${outDir}`);
    return 1;
  }

  const chosen = passing[0];
  const imagePrompt = renderImagePrompt(chosen.brief, placement);
  await writeFile(join(outDir, "04-image-prompt.txt"), imagePrompt);
  console.log(`\n[4/5] prompt    concept "${chosen.brief.concept.name}"`);
  console.log(`      → ${join(outDir, "04-image-prompt.txt")}`);

  if (values["no-image"]) {
    console.log(`\n[5/5] generate  SKIPPED (--no-image)`);
    console.log(`\n  spend: $${spend.toFixed(4)}`);
    console.log(`  artefacts: ${outDir}\n`);
    return 0;
  }

  // ── 4. reference image from the CDN ───────────────────────────────────────
  const reference = snapshot.images[0];
  if (!reference) {
    console.log(`\n✗ Product has no images to use as a generation reference.`);
    return 1;
  }
  console.log(`\n[5/5] generate  reference: ${reference.src}`);
  const referenceBytes = await safeFetchBinary(reference.src, {
    allowedHosts: cdnHosts,
    accept: "image/*",
    maxBytes: 12 * 1024 * 1024,
  });
  console.log(
    `      reference ${(referenceBytes.bytes / 1024).toFixed(0)}KB ${referenceBytes.contentType ?? ""}`,
  );

  // ── 5. one image ──────────────────────────────────────────────────────────
  const image = new GeminiImageProvider(
    apiKey,
    env("GEMINI_IMAGE_MODEL", "gemini-3-pro-image"),
  );
  const generated = await image.generate({
    prompt: imagePrompt,
    aspectRatio: "4:5",
    resolution: "2K",
    referenceImages: [
      {
        bytes: referenceBytes.data,
        mimeType: referenceBytes.contentType?.split(";")[0] ?? "image/jpeg",
      },
    ],
  });
  spend += IMAGE_COST_USD;

  const ext = generated.mimeType.includes("png") ? "png" : "jpg";
  const imagePath = join(
    outDir,
    `05-${slug(chosen.brief.concept.name)}-${placement.width}x${placement.height}.${ext}`,
  );
  await writeFile(imagePath, generated.bytes);

  console.log(
    `      ${generated.model}  ${(generated.bytes.byteLength / 1024).toFixed(0)}KB  ${generated.latencyMs}ms`,
  );
  console.log(`      → ${imagePath}`);

  await writeFile(
    join(outDir, "06-run.json"),
    JSON.stringify(
      {
        url,
        placement,
        objective,
        conceptCount,
        textModel: briefResult.model,
        imageModel: generated.model,
        usage: briefResult.usage,
        imageCostUsd: IMAGE_COST_USD,
        totalCostUsd: spend,
        chosenConcept: chosen.brief.concept.name,
        verdicts: gated.map((g) => ({
          concept: g.brief.concept.name,
          verdict: g.result.verdict,
        })),
      },
      null,
      2,
    ),
  );

  console.log(`\n  spend: $${spend.toFixed(4)}`);
  console.log(`  artefacts: ${outDir}`);
  console.log(
    `\n  Check the image: do "${claims.concentrations.join('", "') || "—"}"` +
      ` and "${claims.priceDisplay ?? "—"}" render EXACTLY right?`,
  );
  console.log(
    `  That answer decides path A vs B (docs/ARCHITECTURE.md §24.4).\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof FetchRejectedError) {
      console.error(`\n✗ Request rejected (${error.reason}): ${error.message}`);
      if (error.reason === "host_not_allowed") {
        console.error(
          `  Add the host to IMAGE_CDN_HOSTS or STORE_ALLOWED_HOSTS.`,
        );
      }
    } else {
      console.error(
        `\n✗ ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  });
