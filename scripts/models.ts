/**
 * Model discovery — asks the Gemini API what this key can actually see.
 *
 * Model IDs move faster than any document, and a wrong one fails at the worst
 * possible moment: mid-pipeline, after money has been spent on earlier stages.
 * Rather than trusting a hardcoded string, this asks:
 *
 *   railway run npm run models
 *
 * It verifies the two IDs this project depends on and prints everything else
 * the key can reach, so a rename is a one-line env change rather than a debug
 * session.
 *
 * Exit code 0 when both configured models are present, 1 otherwise.
 */

import { parseArgs } from "node:util";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface ModelInfo {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface ModelsResponse {
  models?: ModelInfo[];
  nextPageToken?: string;
}

/** "models/gemini-3.7-flash" → "gemini-3.7-flash" */
function bareId(name: string | undefined): string {
  return (name ?? "").replace(/^models\//, "");
}

async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const all: ModelInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${API_BASE}/models`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: { "x-goog-api-key": apiKey },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `GET /models returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as ModelsResponse;
    all.push(...(payload.models ?? []));
    pageToken = payload.nextPageToken;
  } while (pageToken);

  return all;
}

function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
    },
  });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "✗ GEMINI_API_KEY is not set.\n" +
        "  Locally:  export GEMINI_API_KEY=...\n" +
        "  Railway:  railway run npm run models",
    );
    return Promise.resolve(1);
  }

  const wantText = process.env.GEMINI_TEXT_MODEL ?? "gemini-3.7-flash";
  const wantImage = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image";

  return listModels(apiKey).then((models) => {
    if (values.json) {
      console.log(JSON.stringify(models, null, 2));
      return 0;
    }

    const ids = new Set(models.map((m) => bareId(m.name)));
    console.log(`\n✓ Key can see ${models.length} models\n`);

    let ok = true;
    for (const [label, wanted] of [
      ["GEMINI_TEXT_MODEL ", wantText],
      ["GEMINI_IMAGE_MODEL", wantImage],
    ] as const) {
      if (ids.has(wanted)) {
        console.log(`  ✓ ${label}  ${wanted}`);
      } else {
        ok = false;
        console.log(`  ✗ ${label}  ${wanted}  — NOT AVAILABLE TO THIS KEY`);
        const near = [...ids]
          .filter((id) => sharesPrefix(id, wanted))
          .slice(0, 6);
        if (near.length > 0) {
          console.log(`      closest matches: ${near.join(", ")}`);
        }
      }
    }

    const imageCapable = models.filter((m) =>
      /image/i.test(bareId(m.name)),
    );
    const generateCapable = models.filter((m) =>
      m.supportedGenerationMethods?.includes("generateContent"),
    );

    console.log(`\n  image-capable models (${imageCapable.length}):`);
    for (const m of imageCapable) {
      console.log(`    ${bareId(m.name)}`);
    }

    if (values.all) {
      console.log(`\n  all generateContent models (${generateCapable.length}):`);
      for (const m of generateCapable) {
        const ctx = m.inputTokenLimit
          ? `  in ${m.inputTokenLimit.toLocaleString()}`
          : "";
        const out = m.outputTokenLimit
          ? ` / out ${m.outputTokenLimit.toLocaleString()}`
          : "";
        console.log(`    ${bareId(m.name).padEnd(42)}${ctx}${out}`);
      }
    } else {
      console.log(`\n  (pass --all to list every generateContent model)`);
    }

    console.log("");
    return ok ? 0 : 1;
  });
}

/** Loose relatedness so a renamed model surfaces as a suggestion. */
function sharesPrefix(candidate: string, wanted: string): boolean {
  const stem = wanted.split(/[-.]/).slice(0, 2).join("-");
  return candidate.includes(stem.split("-")[0]) && candidate.includes("gemini");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
