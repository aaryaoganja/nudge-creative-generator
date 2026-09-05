import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_TTL_SECONDS,
  appPassword,
  issueSessionToken,
  resetSecretCache,
  safeNextPath,
  timingSafeEqual,
  verifyPassword,
  verifySessionToken,
} from "../src/lib/auth.ts";

/**
 * The gate is the only thing between the open internet and a key that spends
 * money, so these are the properties that have to hold rather than a walk
 * through the implementation: a forged cookie must fail, an expired one must
 * fail, and rotating the password must invalidate everything already issued.
 */

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetSecretCache();
});

describe("the password", () => {
  it("defaults to NUDGE when APP_PASSWORD is unset", async () => {
    delete process.env.APP_PASSWORD;
    assert.equal(appPassword(), "NUDGE");
    assert.equal(await verifyPassword("NUDGE"), true);
  });

  it("rejects the near misses", async () => {
    delete process.env.APP_PASSWORD;
    for (const attempt of ["", "nudge", "NUDG", "NUDGE ", "NUDGEE", " NUDGE"]) {
      assert.equal(await verifyPassword(attempt), false, `accepted "${attempt}"`);
    }
  });

  it("is overridable, and then the default stops working", async () => {
    process.env.APP_PASSWORD = "a-much-longer-secret";
    assert.equal(await verifyPassword("a-much-longer-secret"), true);
    assert.equal(await verifyPassword("NUDGE"), false);
  });

  it("ignores surrounding whitespace in the configured value", async () => {
    // Railway's variable editor is a text box; a trailing newline pasted into
    // it should not silently change the password.
    process.env.APP_PASSWORD = "  spaced  ";
    assert.equal(appPassword(), "spaced");
    assert.equal(await verifyPassword("spaced"), true);
  });

  it("falls back to the default when the variable is blank", async () => {
    process.env.APP_PASSWORD = "   ";
    assert.equal(appPassword(), "NUDGE");
  });
});

describe("the session cookie", () => {
  it("verifies a token it just issued", async () => {
    delete process.env.APP_PASSWORD;
    assert.equal(await verifySessionToken(await issueSessionToken()), true);
  });

  it("never contains the password", async () => {
    process.env.APP_PASSWORD = "hunter2-and-then-some";
    const token = await issueSessionToken();
    assert.equal(token.includes("hunter2"), false);
    assert.equal(token.includes("hunter2-and-then-some"), false);
  });

  it("rejects a tampered payload", async () => {
    delete process.env.APP_PASSWORD;
    const token = await issueSessionToken();
    const [version, expiry, nonce, signature] = token.split(".");

    // Extend the expiry, keep the signature: the classic forgery.
    const forged = `${version}.${Number(expiry) + 86_400}.${nonce}.${signature}`;
    assert.equal(await verifySessionToken(forged), false);
  });

  it("rejects a made-up signature", async () => {
    delete process.env.APP_PASSWORD;
    const token = await issueSessionToken();
    const parts = token.split(".");
    parts[3] = "AAAA".repeat(11);
    assert.equal(await verifySessionToken(parts.join(".")), false);
  });

  it("rejects malformed and empty tokens without throwing", async () => {
    delete process.env.APP_PASSWORD;
    for (const token of [
      undefined,
      null,
      "",
      "v1",
      "v1.1.2",
      "v2.1.2.3",
      "....",
      "v1.abc.def.not base64!",
    ]) {
      assert.equal(await verifySessionToken(token), false, `accepted ${token}`);
    }
  });

  it("expires", async () => {
    delete process.env.APP_PASSWORD;
    const issued = Date.now();
    const token = await issueSessionToken(issued);

    const oneSecondBefore = issued + (SESSION_TTL_SECONDS - 1) * 1000;
    assert.equal(await verifySessionToken(token, oneSecondBefore), true);

    const oneSecondAfter = issued + (SESSION_TTL_SECONDS + 1) * 1000;
    assert.equal(await verifySessionToken(token, oneSecondAfter), false);
  });

  it("is invalidated by rotating APP_PASSWORD", async () => {
    process.env.APP_PASSWORD = "first-password";
    const token = await issueSessionToken();
    assert.equal(await verifySessionToken(token), true);

    process.env.APP_PASSWORD = "second-password";
    assert.equal(await verifySessionToken(token), false);
  });

  it("issues a distinct token every time", async () => {
    delete process.env.APP_PASSWORD;
    const now = Date.now();
    const a = await issueSessionToken(now);
    const b = await issueSessionToken(now);
    assert.notEqual(a, b);
  });
});

describe("timingSafeEqual", () => {
  it("compares content, not identity", () => {
    assert.equal(
      timingSafeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])),
      true,
    );
    assert.equal(
      timingSafeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4])),
      false,
    );
  });

  it("returns false on a length mismatch instead of throwing", () => {
    assert.equal(
      timingSafeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3])),
      false,
    );
  });
});

describe("safeNextPath — the login page is not an open redirect", () => {
  it("keeps a same-origin path with its query", () => {
    assert.equal(safeNextPath("/keys"), "/keys");
    assert.equal(safeNextPath("/?tab=score"), "/?tab=score");
  });

  it("refuses anything that can leave the origin", () => {
    for (const hostile of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "http://evil.example",
      "javascript:alert(1)",
      "evil.example",
    ]) {
      assert.equal(safeNextPath(hostile), "/", `followed ${hostile}`);
    }
  });

  it("does not send a freshly signed-in user back to the login page", () => {
    assert.equal(safeNextPath("/login"), "/");
    assert.equal(safeNextPath("/login?next=/keys"), "/");
  });

  it("defaults to the root", () => {
    assert.equal(safeNextPath(null), "/");
    assert.equal(safeNextPath(undefined), "/");
    assert.equal(safeNextPath(""), "/");
  });
});
