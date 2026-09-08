import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DETERMINISTIC_ACCESS_PATTERNS, isTransientTransportFailure, TRANSIENT_TRANSPORT_PATTERNS,
} from "@anneal/db/transport-vocabulary";

const transientMessages = [
  "fetch failed",
  "SSL_ERROR_SYSCALL",
  "SSL_connect",
  "unexpected EOF",
  "early EOF",
  "Post \"https://example.com\": EOF",
  "our servers are currently overloaded",
  "Selected model is at capacity. Please try a different model.",
  "This model is currently at capacity.",
  "connection reset",
  "connection closed",
  "connection timed out",
  "connection lost",
  "connection aborted",
  "Connection refused",
  "RPC failed",
  "Operation timed out",
  "Failed to connect",
  "Could not resolve host",
  "Recv failure",
  "socket hangup",
  "socket hang up",
  "HTTP 408",
  "HTTP response 425",
  "HTTP 429",
  "HTTP 503",
  "status 408",
  "status code 425",
  "status 429",
  "status code 500",
  "502 Bad Gateway",
  "503 Service Unavailable",
  "504 Gateway Timeout",
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ETIMEOUT"
];

const refusals = [
  "authentication failed",
  "could not read Username",
  "permission denied",
  "forbidden",
  "HTTP 401",
  "HTTP response 403",
  "status 401",
  "status code 403",
  "bad credentials",
  "authorization failed",
  "unauthorized",
  "invalid credentials",
  "requested URL returned error: 401",
  "requested URL returned error: 403",
  "resource not accessible"
];

const nonTransportMessages = [
  "",
  "ordinary task failure",
  "preflight timed out after 30 seconds",
  "operation aborted",
  "AbortError",
  "EOF",
  "disk is at capacity",
  "the connection pool is at capacity; aborting",
  "HTTP 404"
];

const shell = readFileSync(new URL("../runtime-tools/regression-verification.sh", import.meta.url), "utf8");
const transientSource = shell.match(/^FETCH_TRANSIENT_RE='([^']+)'$/m)?.[1];
const refusalSource = shell.match(/^FETCH_ACCESS_REFUSAL_RE='([^']+)'$/m)?.[1];
const predicate = shell.match(/^fetch_is_transient\(\) \(\n[\s\S]*?^\)/m)?.[0];
assert.ok(transientSource);
assert.ok(refusalSource);
assert.ok(predicate);

// POSIX space classes are the only ERE syntax needing translation for JS.
const asJs = (source: string): RegExp => new RegExp(source.replaceAll("[[:space:]]", "\\s"), "i");
const transientRegex = asJs(transientSource);
const refusalRegex = asJs(refusalSource);

const messages = [
  ...transientMessages,
  ...transientMessages.map((text) => text.toUpperCase()),
  ...nonTransportMessages,
  ...refusals,
  ...refusals.map((text) => `${text}; ECONNRESET`),
  ...refusals.map((text) => `Selected model is at capacity; ${text}`),
];

test("shell fetch and TypeScript agree across the vocabulary, including veto precedence", () => {
  for (const message of messages) {
    assert.equal(
      !refusalRegex.test(message) && transientRegex.test(message),
      isTransientTransportFailure(message), message,
    );
  }
  for (const pattern of TRANSIENT_TRANSPORT_PATTERNS) {
    assert.ok(transientMessages.some((text) => pattern.test(text)), String(pattern));
  }
  for (const pattern of DETERMINISTIC_ACCESS_PATTERNS) {
    assert.ok(refusals.some((text) => pattern.test(text)), String(pattern));
  }
  for (const alternative of transientSource.split("|")) {
    // Complete alternatives only: grouped branches are covered by TS fixtures.
    if (alternative.includes("(") || alternative.includes(")")) continue;
    assert.ok(transientMessages.some((text) => asJs(alternative).test(text)), alternative);
  }
});

test("the actual Bash fetch predicate agrees without invoking regression tooling", () => {
  const result = execFileSync("bash", ["-c", `
FETCH_TRANSIENT_RE=$1
FETCH_ACCESS_REFUSAL_RE=$2
shift 2
${predicate}
for message in "$@"; do
  if fetch_is_transient "$message"; then printf 'true\\n'; else printf 'false\\n'; fi
done
`, "transport-parity", transientSource, refusalSource, ...messages], { encoding: "utf8" });
  assert.deepEqual(result.trim().split("\n"), messages.map((message) => String(isTransientTransportFailure(message))));
});
