import assert from "node:assert/strict";
import test from "node:test";

import { redactCiLog, truncateRedactedCiLog } from "./ci-log-redaction.js";

test("CI log redaction removes common credentials and preserves useful failure text", () => {
  const pemStart = "-----BEGIN " + "PRIVATE KEY-----";
  const pemEnd = "-----END " + "PRIVATE KEY-----";
  const input = [
    "error TS2322 in packages/miniprogram",
    `token=${"ghp_" + "a".repeat(36)}`,
    `github_pat_${"b".repeat(36)}`,
    "Authorization: Bearer abc.def-123",
    "api_key=key-value-123",
    "client_secret='quoted secret value'",
    '"password":"json-secret"',
    `${pemStart}\nprivate-material\n${pemEnd}`,
  ].join("\n");
  const redacted = redactCiLog(input);
  assert.match(redacted, /error TS2322/u);
  assert.match(redacted, /token=\[REDACTED\]/u);
  for (const secret of ["ghp_", "github_pat_", "abc.def-123", "key-value-123",
    "quoted secret value", "json-secret", "private-material"]) {
    assert.ok(!redacted.includes(secret), `redaction leaked ${secret}`);
  }
  assert.match(redacted, /Bearer \[REDACTED\]/u);
  assert.match(redacted, /\[REDACTED PEM BLOCK\]/u);
});

test("CI log redaction removes an unterminated PEM block through the excerpt end", () => {
  const pemStart = "-----BEGIN " + "PRIVATE KEY-----";
  const redacted = redactCiLog(`compiler error\n${pemStart}\nprivate-material`);
  assert.match(redacted, /compiler error/u);
  assert.match(redacted, /\[REDACTED TRUNCATED PEM\]/u);
  assert.doesNotMatch(redacted, /private-material/u);
});

test("CI log truncation removes an unmatched PEM block at the retained boundary", () => {
  const pemStart = "-----BEGIN " + "PRIVATE KEY-----";
  const truncated = truncateRedactedCiLog(
    `header\n${"x".repeat(100)}\n${pemStart}\nprivate-material`, 50,
  );
  assert.match(truncated, /\[REDACTED TRUNCATED PEM\]/u);
  assert.doesNotMatch(truncated, /private-material/u);
  assert.ok(Buffer.byteLength(truncated) <= 50);
});
