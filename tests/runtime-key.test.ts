import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetSecretCache } from "../src/lib/auth.ts";
import {
  KEY_COOKIE,
  maskKey,
  openKey,
  sealKey,
  validateKey,
} from "../src/lib/key-cookie.ts";
import { describeKey, geminiKeyForRequest } from "../src/lib/runtime-key.ts";
import { resetEnvCache } from "../src/lib/env.ts";

/**
 * The override is a live credential kept in a cookie, so the two things worth
 * pinning down are that a cookie this server did not seal cannot become a key,
 * and that nothing in the status the UI renders can be turned back into one.
 */

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetSecretCache();
  resetEnvCache();
});

function requestWith(cookie?: string): Request {
  return new Request("https://studio.test/api/generate", {
    headers: cookie ? { cookie } : {},
  });
}

describe("the sealed key cookie", () => {
  it("round-trips", async () => {
    delete process.env.APP_PASSWORD;
    const sealed = await sealKey("AIzaSyExampleKeyValue0001");
    assert.equal(await openKey(sealed), "AIzaSyExampleKeyValue0001");
  });

  it("does not carry the key in the clear", async () => {
    delete process.env.APP_PASSWORD;
    const sealed = await sealKey("AIzaSyExampleKeyValue0001");
    assert.equal(sealed.includes("AIzaSy"), false);
    assert.equal(sealed.includes("0001"), false);
  });

  it("produces a different cookie for the same key each time", async () => {
    // A fresh IV per seal: two people with the same key must not have the same
    // cookie value, or the cookie itself becomes a key fingerprint.
    delete process.env.APP_PASSWORD;
    const a = await sealKey("same-key");
    const b = await sealKey("same-key");
    assert.notEqual(a, b);
    assert.equal(await openKey(b), "same-key");
  });

  it("refuses a tampered cookie rather than decrypting garbage", async () => {
    delete process.env.APP_PASSWORD;
    const sealed = await sealKey("AIzaSyExampleKeyValue0001");
    const parts = sealed.split(".");

    // Flip one character of the ciphertext. GCM authenticates, so this must
    // fail closed instead of yielding a mangled string that would be sent to
    // Google as a credential.
    const body = parts[2];
    const flipped = (body[0] === "A" ? "B" : "A") + body.slice(1);
    assert.equal(await openKey(`${parts[0]}.${parts[1]}.${flipped}`), null);
  });

  it("refuses cookies from another APP_PASSWORD", async () => {
    process.env.APP_PASSWORD = "first-password";
    const sealed = await sealKey("AIzaSyExampleKeyValue0001");

    process.env.APP_PASSWORD = "second-password";
    assert.equal(await openKey(sealed), null);
  });

  it("refuses junk without throwing", async () => {
    delete process.env.APP_PASSWORD;
    for (const junk of [undefined, null, "", "v1", "v2.a.b", "v1.a.b", "not a cookie"]) {
      assert.equal(await openKey(junk), null, `opened ${junk}`);
    }
  });
});

describe("validateKey", () => {
  it("accepts a plausible key and trims it", () => {
    const verdict = validateKey("  AIzaSyExampleKeyValue0001  ");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.key, "AIzaSyExampleKeyValue0001");
  });

  it("names the problem instead of just refusing", () => {
    const empty = validateKey("   ");
    assert.equal(empty.ok, false);
    assert.match(empty.ok ? "" : empty.message, /Paste a key/);

    const spaced = validateKey("AIza key with spaces");
    assert.equal(spaced.ok, false);
    assert.match(spaced.ok ? "" : spaced.message, /spaces or line breaks/);

    const long = validateKey("x".repeat(401));
    assert.equal(long.ok, false);
    assert.match(long.ok ? "" : long.message, /longer than 400/);
  });
});

describe("maskKey — the only rendering of a key this app allows", () => {
  it("shows four trailing characters and nothing else", () => {
    assert.equal(maskKey("AIzaSyExampleKeyValueaf31"), "…af31");
  });

  it("shows nothing at all for a key too short to mask", () => {
    assert.equal(maskKey("abcd"), "…");
    assert.equal(maskKey("a"), "…");
  });

  it("is null when there is no key", () => {
    assert.equal(maskKey(undefined), null);
    assert.equal(maskKey(null), null);
    assert.equal(maskKey("   "), null);
  });
});

describe("geminiKeyForRequest — which key gets spent", () => {
  it("uses the environment key when there is no override", async () => {
    delete process.env.APP_PASSWORD;
    process.env.GEMINI_API_KEY = "env-key-1234";
    assert.equal(await geminiKeyForRequest(requestWith()), "env-key-1234");
  });

  it("prefers a valid override over the environment", async () => {
    delete process.env.APP_PASSWORD;
    process.env.GEMINI_API_KEY = "env-key-1234";
    const sealed = await sealKey("override-key-5678");
    assert.equal(
      await geminiKeyForRequest(requestWith(`${KEY_COOKIE}=${sealed}`)),
      "override-key-5678",
    );
  });

  it("falls back to the environment when the override cookie is forged", async () => {
    delete process.env.APP_PASSWORD;
    process.env.GEMINI_API_KEY = "env-key-1234";
    assert.equal(
      await geminiKeyForRequest(requestWith(`${KEY_COOKIE}=v1.aaaa.bbbb`)),
      "env-key-1234",
    );
  });

  it("finds the cookie among others", async () => {
    delete process.env.APP_PASSWORD;
    delete process.env.GEMINI_API_KEY;
    const sealed = await sealKey("override-key-5678");
    const cookie = `nudge_session=abc.def; ${KEY_COOKIE}=${sealed}; other=1`;
    assert.equal(await geminiKeyForRequest(requestWith(cookie)), "override-key-5678");
  });

  it("is undefined when neither source has a key", async () => {
    delete process.env.APP_PASSWORD;
    delete process.env.GEMINI_API_KEY;
    assert.equal(await geminiKeyForRequest(requestWith()), undefined);
  });
});

describe("describeKey — what the page is allowed to say", () => {
  it("reports the override and its last four characters", async () => {
    delete process.env.APP_PASSWORD;
    process.env.GEMINI_API_KEY = "env-key-1234";
    const status = await describeKey(await sealKey("override-key-5678"));
    assert.deepEqual(status, {
      source: "override",
      masked: "…5678",
      environmentPresent: true,
    });
  });

  it("reports the environment when no override is set", async () => {
    delete process.env.APP_PASSWORD;
    process.env.GEMINI_API_KEY = "env-key-1234";
    assert.deepEqual(await describeKey(null), {
      source: "environment",
      masked: "…1234",
      environmentPresent: true,
    });
  });

  it("says so when there is no key anywhere", async () => {
    delete process.env.APP_PASSWORD;
    delete process.env.GEMINI_API_KEY;
    assert.deepEqual(await describeKey(undefined), {
      source: "none",
      masked: null,
      environmentPresent: false,
    });
  });

  it("still works when the environment itself is unparseable", async () => {
    // The page whose job is "the deployment's config is wrong, let me supply a
    // key by hand" must not be taken down by the deployment's config being
    // wrong.
    delete process.env.APP_PASSWORD;
    process.env.GEMINI_API_KEY = "env-key-1234";
    process.env.DATABASE_URL = "not-a-url";
    const status = await describeKey(await sealKey("override-key-5678"));
    assert.equal(status.source, "override");
    assert.equal(status.masked, "…5678");
  });
});

/**
 * A structural test, not a behavioural one, and deliberately so.
 *
 * The /keys page tells the user their key "is in effect". For a long while it
 * was not: geminiKeyForRequest() existed, was documented, was unit-tested — and
 * had no caller anywhere in src/. Both spending routes still read
 * config.GEMINI_API_KEY, so a user pasted a key, was told it was in use, and
 * every generation quietly spent the deployment's key instead.
 *
 * No unit test of the module could have caught that, because the module was
 * correct. What was wrong was the wiring, so the wiring is what is asserted.
 */
describe("the override is actually wired into the routes that spend money", () => {
  const SPENDING_ROUTES = [
    "src/app/api/generate/route.ts",
    "src/app/api/score/route.ts",
  ];

  it("routes the key through geminiKeyForRequest, not the environment", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const path of SPENDING_ROUTES) {
      const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      assert.match(
        source,
        /geminiKeyForRequest\(request\)/,
        `${path} never asks which key to spend`,
      );
      assert.ok(
        !/config\.GEMINI_API_KEY/.test(source),
        `${path} still reads the environment key directly`,
      );
    }
  });

  it("leaves the health probe reporting on the deployment's own key", async () => {
    // The exception, and it has to stay one: /api/health is reachable without a
    // session, so a probe that flipped to green because whoever ran curl
    // happened to carry an override cookie would report on the caller rather
    // than on the deployment.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../src/app/api/health/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /config\.GEMINI_API_KEY/);
    assert.ok(!/geminiKeyForRequest/.test(source));
  });
});
