import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import type { Stats } from "node:fs";
import { test } from "node:test";

import { createAppJwt, mintInstallationToken, type AppJwtSigner } from "./github-app-auth.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const TOKEN = `installation_${"T".repeat(32)}`;
const expiresAt = new Date(NOW.getTime() + 60 * 60_000).toISOString();
const safePrivateKey = {
  currentUid: () => 501,
  statPrivateKey: async () => ({
    uid: 501,
    mode: 0o100600,
    size: 1_700,
    isFile: () => true,
  } as Stats),
};

test("the App JWT has the bounded claims and exact RS256 signing input", () => {
  let seenInput = "";
  let seenKey = "";
  const signer: AppJwtSigner = (input, key) => {
    seenInput = input;
    seenKey = key;
    return "signature";
  };
  const result = createAppJwt("12345", "private-key-bytes", NOW, signer);
  assert.equal(seenInput, result.signingInput);
  assert.equal(seenKey, "private-key-bytes");
  assert.deepEqual(result.claims, {
    iat: Math.floor(NOW.getTime() / 1_000) - 60,
    exp: Math.floor(NOW.getTime() / 1_000) + 9 * 60,
    iss: "12345",
  });
  const [encodedHeader, encodedClaims, signature] = result.jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8")), result.claims);
  assert.equal(signature, "signature");
});

test("the default signer produces a verifiable RS256 App JWT", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const result = createAppJwt("12345", privateKey, NOW);
  const signature = Buffer.from(result.jwt.split(".")[2]!, "base64url");
  assert.equal(verify("RSA-SHA256", Buffer.from(result.signingInput), keys.publicKey, signature), true);
});

test("a mint uses the official endpoint and accepts only a bounded token response", async () => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; signal: AbortSignal }> = [];
  const result = await mintInstallationToken({
    ...safePrivateKey,
    appId: "12345",
    installationId: "67890",
    privateKeyFile: "/private/app.pem",
    restUrl: "https://api.github.test/",
    timeoutMs: 100,
    now: () => NOW,
    readPrivateKey: async () => "private-key-bytes",
    signer: () => "signature",
    http: async (request) => {
      requests.push(request);
      return { status: 201, body: JSON.stringify({ token: TOKEN, expires_at: expiresAt }) };
    },
  });
  assert.deepEqual(result, { ok: true, token: TOKEN, expiresAt: new Date(expiresAt) });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.github.test/app/installations/67890/access_tokens");
  assert.equal(requests[0]!.method, "POST");
  assert.equal(requests[0]!.headers.Accept, "application/vnd.github+json");
  assert.match(requests[0]!.headers.Authorization!, /^Bearer [^.]+\.[^.]+\.signature$/u);
  assert.equal(requests[0]!.signal.aborted, false);
});

test("key-read and signing failures are named without exposing secret material", async () => {
  const secret = "PRIVATE-KEY-SECRET-MATERIAL";
  const base = {
    ...safePrivateKey,
    appId: "12345", installationId: "67890", privateKeyFile: "/private/app.pem",
    restUrl: "https://api.github.test", timeoutMs: 100, now: () => NOW,
    http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: expiresAt }) }),
  };
  const unreadable = await mintInstallationToken({ ...base, readPrivateKey: async () => { throw new Error(secret); } });
  assert.deepEqual(unreadable, { ok: false, failure: "private-key-read-failed" });
  assert.equal(JSON.stringify(unreadable).includes(secret), false);

  const unsigned = await mintInstallationToken({
    ...base, readPrivateKey: async () => secret, signer: () => { throw new Error(secret); },
  });
  assert.deepEqual(unsigned, { ok: false, failure: "app-jwt-signing-failed" });
  assert.equal(JSON.stringify(unsigned).includes(secret), false);
});

test("per-Run metadata revalidation refuses replaced, foreign, permissive, and oversized key paths before read", async () => {
  const unsafeStats = [
    { uid: 501, mode: 0o10600, size: 1_700, isFile: () => false },
    { uid: 0, mode: 0o100600, size: 1_700, isFile: () => true },
    { uid: 501, mode: 0o100640, size: 1_700, isFile: () => true },
    { uid: 501, mode: 0o100600, size: 64 * 1_024 + 1, isFile: () => true },
  ];
  for (const stats of unsafeStats) {
    let readCalls = 0;
    let httpCalls = 0;
    const result = await mintInstallationToken({
      appId: "12345",
      installationId: "67890",
      privateKeyFile: "/private/app.pem",
      restUrl: "https://api.github.test",
      timeoutMs: 100,
      now: () => NOW,
      currentUid: () => 501,
      statPrivateKey: async () => stats as Stats,
      readPrivateKey: async () => { readCalls += 1; return "private-key-bytes"; },
      http: async () => {
        httpCalls += 1;
        return { status: 201, body: JSON.stringify({ token: TOKEN, expires_at: expiresAt }) };
      },
    });
    assert.deepEqual(result, { ok: false, failure: "private-key-read-failed" });
    assert.equal(readCalls, 0);
    assert.equal(httpCalls, 0);
  }
});

test("a non-settling private-key read is aborted and named within the configured bound", async () => {
  let readSignal: AbortSignal | undefined;
  let httpCalls = 0;
  const startedAt = Date.now();
  const result = await mintInstallationToken({
    ...safePrivateKey,
    appId: "12345",
    installationId: "67890",
    privateKeyFile: "/private/app.pem",
    restUrl: "https://api.github.test",
    timeoutMs: 10,
    now: () => NOW,
    readPrivateKey: async (_path, signal) => {
      readSignal = signal;
      return await new Promise<string>(() => {});
    },
    http: async () => {
      httpCalls += 1;
      return { status: 201, body: JSON.stringify({ token: TOKEN, expires_at: expiresAt }) };
    },
  });
  assert.deepEqual(result, { ok: false, failure: "private-key-read-failed" });
  assert.equal(readSignal?.aborted, true);
  assert.equal(httpCalls, 0);
  // The bound under test is the 10ms timeoutMs above, and the abort is asserted
  // directly. This wall clock only says the read was abandoned rather than
  // awaited, so it is sized for the loaded gate worker rather than an idle host
  // (CONTRIBUTING.md, "Test timing on the gate worker").
  assert.ok(Date.now() - startedAt < 30_000);
});

test("timeout, HTTP, malformed, token, and expiry failures are strict and redact response bodies", async () => {
  const secret = `response-secret-${"S".repeat(24)}`;
  const base = {
    ...safePrivateKey,
    appId: "12345", installationId: "67890", privateKeyFile: "/private/app.pem",
    restUrl: "https://api.github.test", timeoutMs: 5, now: () => NOW,
    readPrivateKey: async () => "private-key-bytes", signer: () => "signature",
  };
  const cases = [
    {
      expected: { ok: false, failure: "installation-token-request-failed" },
      http: ({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(secret)), { once: true });
      }),
    },
    { expected: { ok: false, failure: "installation-token-http-error", httpStatus: 403 }, http: async () => ({ status: 403, body: secret }) },
    { expected: { ok: false, failure: "installation-token-response-not-json" }, http: async () => ({ status: 201, body: secret }) },
    { expected: { ok: false, failure: "installation-token-response-malformed" }, http: async () => ({ status: 201, body: JSON.stringify({ token: "short", expires_at: expiresAt, error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-response-malformed" }, http: async () => ({ status: 201, body: JSON.stringify({ token: `${TOKEN}\n`, expires_at: expiresAt, error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-response-malformed" }, http: async () => ({ status: 201, body: JSON.stringify({ token: `${TOKEN}é`, expires_at: expiresAt, error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-response-malformed" }, http: async () => ({ status: 201, body: JSON.stringify({ token: `${TOKEN}\"escaped`, expires_at: expiresAt, error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-response-malformed" }, http: async () => ({ status: 201, body: JSON.stringify({ token: `${TOKEN}\\escaped`, expires_at: expiresAt, error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-expiry-invalid" }, http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: "not-a-date", error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-expiry-invalid" }, http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: NOW.toISOString(), error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-expiry-invalid" }, http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: new Date(NOW.getTime() + 60_000).toISOString(), error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-expiry-invalid" }, http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: new Date(NOW.getTime() + 121_000).toISOString(), error: secret }) }) },
    { expected: { ok: false, failure: "installation-token-expiry-invalid" }, http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString(), error: secret }) }) },
  ];
  for (const fixture of cases) {
    const result = await mintInstallationToken({ ...base, http: fixture.http as never });
    assert.deepEqual(result, fixture.expected);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("only the fresh installation-token lifetime window is accepted", async () => {
  const base = {
    ...safePrivateKey,
    appId: "12345", installationId: "67890", privateKeyFile: "/private/app.pem",
    restUrl: "https://api.github.test", timeoutMs: 100, now: () => NOW,
    readPrivateKey: async () => "private-key-bytes", signer: () => "signature",
  };
  for (const remainingMs of [55 * 60_000, 60 * 60_000, 65 * 60_000]) {
    const boundaryExpiry = new Date(NOW.getTime() + remainingMs).toISOString();
    const result = await mintInstallationToken({
      ...base,
      http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: boundaryExpiry }) }),
    });
    assert.deepEqual(result, { ok: true, token: TOKEN, expiresAt: new Date(boundaryExpiry) });
  }
  const tooStale = await mintInstallationToken({
    ...base,
    http: async () => ({ status: 201, body: JSON.stringify({ token: TOKEN, expires_at: new Date(NOW.getTime() + 55 * 60_000 - 1).toISOString() }) }),
  });
  assert.deepEqual(tooStale, { ok: false, failure: "installation-token-expiry-invalid" });
});
