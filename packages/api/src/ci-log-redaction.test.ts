import assert from "node:assert/strict";
import test from "node:test";

import { redactCiLog } from "./ci-log-redaction.js";

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
  for (const secret of ["ghp_", "github_pat_", "abc.def-123", "key-value-123",
    "quoted secret value", "json-secret", "private-material"]) {
    assert.ok(!redacted.includes(secret), `redaction leaked ${secret}`);
  }
  assert.match(redacted, /Bearer \[REDACTED\]/u);
  assert.match(redacted, /\[REDACTED PEM BLOCK\]/u);
});
