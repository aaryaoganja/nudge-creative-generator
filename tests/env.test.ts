import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { env, resetEnvCache, hasDatabase, requireDatabaseUrl } from "../src/lib/env.ts";

/**
 * Regression guard for a production outage.
 *
 * DATABASE_URL was required by the schema, and every route calls env(). On a
 * deployment where the database was not wired, all four routes threw
 * "Invalid environment configuration — DATABASE_URL" and the app was down over
 * a dependency none of them queries.
 */

const saved = { ...process.env };

beforeEach(() => {
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe("env — the app boots without a database", () => {
  it("parses with DATABASE_URL entirely absent", () => {
    delete process.env.DATABASE_URL;
    const config = env();
    assert.equal(config.DATABASE_URL, undefined);
    // The defaults every route depends on must still be there.
    assert.deepEqual(config.STORE_ALLOWED_HOSTS, [
      "beminimalist.co",
      "global.beminimalist.co",
    ]);
    assert.deepEqual(config.IMAGE_CDN_HOSTS, ["cdn.shopify.com"]);
    assert.equal(config.STORE_CURRENCY, "INR");
    assert.equal(config.GEMINI_TEXT_MODEL, "gemini-3.7-flash");
    assert.equal(config.GEMINI_IMAGE_MODEL, "gemini-3-pro-image");
  });

  it("reports the database as absent rather than guessing", () => {
    delete process.env.DATABASE_URL;
    assert.equal(hasDatabase(), false);
  });

  it("still accepts a database when one is provided", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/d";
    assert.equal(hasDatabase(), true);
    assert.equal(env().DATABASE_URL, "postgresql://u:p@localhost:5432/d");
  });

  it("rejects a malformed connection string", () => {
    process.env.DATABASE_URL = "not-a-url";
    assert.throws(() => env(), /DATABASE_URL/);
  });
});

describe("requireDatabaseUrl — fails at the point of use, not at boot", () => {
  it("throws a named, actionable error when unset", () => {
    delete process.env.DATABASE_URL;
    assert.throws(
      () => requireDatabaseUrl(),
      (error: unknown) =>
        error instanceof Error &&
        /DATABASE_URL is not set/.test(error.message) &&
        /Provision Postgres/.test(error.message),
    );
  });

  it("returns the URL when configured", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/d";
    assert.equal(requireDatabaseUrl(), "postgresql://u:p@localhost:5432/d");
  });
});

describe("provider keys are optional", () => {
  it("boots with no provider keys at all", () => {
    delete process.env.DATABASE_URL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    const config = env();
    assert.equal(config.GEMINI_API_KEY, undefined);
    assert.equal(config.FIRECRAWL_API_KEY, undefined);
  });
});
