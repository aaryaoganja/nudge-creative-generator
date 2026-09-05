import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FetchRejectedError,
  assertUrlIsFetchable,
  hostIsAllowed,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
} from "../src/lib/http/safe-fetch.ts";

const HOSTS = ["beminimalist.co"];

describe("private address detection", () => {
  it("blocks the cloud metadata endpoint", () => {
    // The single most important entry in this list. A fetcher that reaches
    // 169.254.169.254 hands out instance credentials.
    assert.equal(isPrivateIPv4("169.254.169.254"), true);
  });

  it("blocks RFC1918, loopback, CGNAT and reserved space", () => {
    for (const ip of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "198.18.0.1",
    ]) {
      assert.equal(isPrivateIPv4(ip), true, `${ip} should be blocked`);
    }
  });

  it("allows ordinary public addresses", () => {
    // 23.227.38.x is Shopify's edge — the range this fetcher must reach.
    for (const ip of ["8.8.8.8", "1.1.1.1", "23.227.38.65"]) {
      assert.equal(isPrivateIPv4(ip), false, `${ip} should be allowed`);
    }
  });

  it("treats 172.15 and 172.32 as public — the off-by-one on RFC1918", () => {
    assert.equal(isPrivateIPv4("172.15.0.1"), false);
    assert.equal(isPrivateIPv4("172.32.0.1"), false);
  });

  it("blocks IPv6 loopback, ULA and link-local", () => {
    assert.equal(isPrivateIPv6("::1"), true);
    assert.equal(isPrivateIPv6("::"), true);
    assert.equal(isPrivateIPv6("fc00::1"), true);
    assert.equal(isPrivateIPv6("fd12:3456::1"), true);
    assert.equal(isPrivateIPv6("fe80::1"), true);
    assert.equal(isPrivateIPv6("2606:4700:4700::1111"), false);
  });

  it("blocks IPv4-mapped IPv6 that wraps a private address", () => {
    // ::ffff:169.254.169.254 is the metadata endpoint wearing a hat.
    assert.equal(isPrivateIPv6("::ffff:169.254.169.254"), true);
    assert.equal(isPrivateIPv6("::ffff:10.0.0.1"), true);
    assert.equal(isPrivateIPv6("::ffff:8.8.8.8"), false);
  });

  it("refuses anything that is not a parseable IP", () => {
    assert.equal(isPrivateAddress("not-an-ip"), true);
    assert.equal(isPrivateAddress(""), true);
  });
});

describe("host allowlist", () => {
  it("matches the exact host and real subdomains", () => {
    assert.equal(hostIsAllowed("beminimalist.co", HOSTS), true);
    assert.equal(hostIsAllowed("shop.beminimalist.co", HOSTS), true);
    assert.equal(hostIsAllowed("BEMINIMALIST.CO", HOSTS), true);
  });

  it("rejects suffix-collision lookalikes", () => {
    assert.equal(hostIsAllowed("beminimalist.co.evil.example", HOSTS), false);
    assert.equal(hostIsAllowed("notbeminimalist.co", HOSTS), false);
    assert.equal(hostIsAllowed("evil-beminimalist.co", HOSTS), false);
  });
});

describe("assertUrlIsFetchable", () => {
  it("rejects non-https", async () => {
    await assert.rejects(
      () => assertUrlIsFetchable("http://beminimalist.co/x", HOSTS),
      (e: unknown) =>
        e instanceof FetchRejectedError && e.reason === "scheme_not_allowed",
    );
  });

  it("rejects off-allowlist hosts before any DNS lookup", async () => {
    await assert.rejects(
      () => assertUrlIsFetchable("https://169.254.169.254/latest/meta-data/", HOSTS),
      (e: unknown) =>
        e instanceof FetchRejectedError && e.reason === "host_not_allowed",
    );
  });

  it("rejects a private IP literal even when allowlisted", async () => {
    await assert.rejects(
      () => assertUrlIsFetchable("https://127.0.0.1/x", ["127.0.0.1"]),
      (e: unknown) =>
        e instanceof FetchRejectedError && e.reason === "private_address",
    );
  });

  it("rejects malformed URLs", async () => {
    await assert.rejects(
      () => assertUrlIsFetchable("not a url", HOSTS),
      (e: unknown) =>
        e instanceof FetchRejectedError && e.reason === "malformed_url",
    );
  });

  it("rejects a host that resolves to loopback", async () => {
    // localhost is allowlisted here on purpose: the allowlist is not the last
    // line of defence, DNS resolution is.
    await assert.rejects(
      () => assertUrlIsFetchable("https://localhost/x", ["localhost"]),
      (e: unknown) =>
        e instanceof FetchRejectedError &&
        (e.reason === "private_address" || e.reason === "dns_failure"),
    );
  });
});
