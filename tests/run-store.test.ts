import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  finishRun,
  getRun,
  isRunId,
  kindOfRunId,
  listRuns,
  newRunId,
  startRun,
} from "../src/lib/run.ts";
import { isAssetId, sha256Hex, storage } from "../src/lib/storage.ts";
import { resetEnvCache } from "../src/lib/env.ts";

/**
 * These run against the MEMORY path on purpose.
 *
 * DATABASE_URL is unset in the test environment, so every call here exercises
 * the fallback the app uses when Postgres is unreachable. That is the branch
 * worth pinning down in a unit test: the Postgres branch is verified for real
 * against a live database in the integration script, and a mocked Prisma client
 * would only prove the mock works.
 *
 * The property that matters either way is the same: a run must be openable by
 * its id before it finishes, and must still exist after it fails.
 */

beforeEach(() => {
  (globalThis as { memoryRuns?: unknown }).memoryRuns = [];
  delete process.env.DATABASE_URL;
  resetEnvCache();
});

describe("run ids", () => {
  it("are prefixed by what produced them", () => {
    assert.match(newRunId("generation"), /^gen_[0-9a-f]{20}$/);
    assert.match(newRunId("scoring"), /^scr_[0-9a-f]{20}$/);
  });

  it("are 80 bits, because the id is now a capability in a URL", () => {
    const id = newRunId("generation").slice(4);
    assert.equal(id.length, 20);
    // Distinct across a batch: a collision would hand one person another
    // person's run.
    const ids = new Set(Array.from({ length: 500 }, () => newRunId("scoring")));
    assert.equal(ids.size, 500);
  });

  it("recognises its own and rejects everything else", () => {
    assert.ok(isRunId(newRunId("generation")));
    assert.ok(!isRunId("gen_short"));
    assert.ok(!isRunId("gen_XXXXXXXXXXXXXXXXXXXX"), "hex only");
    assert.ok(!isRunId("../../etc/passwd"));
    assert.ok(!isRunId("run_1a2b3c4d5e6f708192a3"));
    assert.equal(kindOfRunId(newRunId("scoring")), "scoring");
    assert.equal(kindOfRunId("nonsense"), null);
  });
});

describe("a run exists before it succeeds", () => {
  it("is readable while still running", async () => {
    const id = newRunId("generation");
    await startRun({ id, kind: "generation", subject: "A serum" });

    const { run } = await getRun(id);
    assert.ok(run, "a started run must be findable by its id");
    assert.equal(run.status, "running");
    assert.equal(run.subject, "A serum");
  });

  it("survives its own failure", async () => {
    // The run somebody actually needs to send you is the one that broke. The
    // previous store recorded only the success path.
    const id = newRunId("generation");
    await startRun({ id, kind: "generation" });
    await finishRun({
      id,
      status: "failed",
      summary: "Generation failed",
      error: "the model refused",
    });

    const { run } = await getRun(id);
    assert.equal(run?.status, "failed");
    assert.equal(run?.error, "the model refused");
  });

  it("keeps the opening timestamp when it finishes", async () => {
    const id = newRunId("scoring");
    await startRun({ id, kind: "scoring" });
    const started = (await getRun(id)).run?.startedAt;
    await finishRun({ id, status: "ok", summary: "82/100" });
    const finished = (await getRun(id)).run;
    assert.equal(finished?.startedAt, started);
    assert.ok(finished?.finishedAt);
  });

  it("replaces rather than duplicates on finish", async () => {
    const id = newRunId("generation");
    await startRun({ id, kind: "generation" });
    await finishRun({ id, status: "ok", summary: "done" });
    const { runs } = await listRuns();
    assert.equal(runs.filter((r) => r.id === id).length, 1);
  });
});

describe("history", () => {
  it("reports durable:false when nothing is stored, and says why", async () => {
    // The old code derived this from "is DATABASE_URL set", which on Railway
    // meant it claimed durability while the store was an array in memory.
    const { durable, note } = await listRuns();
    assert.equal(durable, false);
    assert.match(note, /not being stored|memory/i);
    assert.match(note, /will not open for anyone else|lost on redeploy/i);
  });

  it("filters by kind and returns newest first", async () => {
    for (const kind of ["generation", "scoring", "generation"] as const) {
      const id = newRunId(kind);
      await startRun({ id, kind });
      await finishRun({ id, status: "ok", summary: kind });
    }
    const all = await listRuns();
    assert.equal(all.runs.length, 3);
    assert.equal((await listRuns("scoring")).runs.length, 1);
    assert.equal((await listRuns("generation")).runs.length, 2);
  });

  it("does not put payloads in the list", async () => {
    // A history list that carried every payload would pull whole result sets
    // into memory to render a table of one-line summaries.
    const id = newRunId("generation");
    await startRun({ id, kind: "generation" });
    await finishRun({
      id,
      status: "ok",
      summary: "1 creative",
      payload: { huge: "x".repeat(10_000) },
    });

    const { runs } = await listRuns();
    assert.equal(runs[0].payload, undefined);
    // ...but the single-id read does carry it, or a shared link renders nothing.
    assert.ok((await getRun(id)).run?.payload);
  });

  it("refuses to look up something that is not a run id", async () => {
    assert.equal((await getRun("../../secrets")).run, null);
  });
});

describe("content-addressed assets", () => {
  it("hashes deterministically", () => {
    const a = sha256Hex(new Uint8Array([1, 2, 3]));
    const b = sha256Hex(new Uint8Array([1, 2, 3]));
    assert.equal(a, b);
    assert.notEqual(a, sha256Hex(new Uint8Array([1, 2, 4])));
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("accepts only a 64-character hex id", () => {
    assert.ok(isAssetId(sha256Hex(new Uint8Array([9]))));
    assert.ok(!isAssetId("abc"));
    assert.ok(!isAssetId("../../etc/passwd"));
    assert.ok(!isAssetId(sha256Hex(new Uint8Array([9])).toUpperCase()));
  });

  it("degrades to nothing rather than throwing without a database", async () => {
    // A missing image must cost a picture, never a page.
    const store = storage();
    assert.equal(await store.put(new Uint8Array([1]), { mimeType: "image/png" }), null);
    assert.equal(await store.get(sha256Hex(new Uint8Array([1]))), null);
    assert.equal(await store.prune([]), 0);
  });
});
