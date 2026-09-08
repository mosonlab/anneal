import assert from "node:assert/strict";
import test from "node:test";

import {
  DETERMINISTIC_ACCESS_PATTERNS, isDeterministicAccessRefusal,
  isTransientTransportFailure, TRANSIENT_SYSTEM_ERROR_CODES, TRANSIENT_TRANSPORT_PATTERNS,
} from "./transport-vocabulary.js";

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

for (const message of transientMessages) {
  test(`transport symptom: ${message}`, () => {
    assert.equal(isTransientTransportFailure(message), true);
    assert.equal(isTransientTransportFailure(message.toUpperCase()), true);
  });
}

for (const message of refusals) {
  test(`access refusal veto: ${message}`, () => {
    assert.equal(isDeterministicAccessRefusal(message), true);
    for (const transport of transientMessages) {
      assert.equal(isTransientTransportFailure(`${transport}; ${message}`), false);
      assert.equal(isTransientTransportFailure(`${message}; ${transport}`), false);
    }
  });
}

for (const message of nonTransportMessages) {
  test(`not transport evidence: ${message}`, () => {
    assert.equal(isTransientTransportFailure(message), false);
  });
}

test("fixtures exercise every shared pattern and errno", () => {
  for (const pattern of TRANSIENT_TRANSPORT_PATTERNS) {
    assert.ok(transientMessages.some((text) => pattern.test(text)), String(pattern));
  }
  for (const pattern of DETERMINISTIC_ACCESS_PATTERNS) {
    assert.ok(refusals.some((text) => pattern.test(text)), String(pattern));
  }
  for (const code of TRANSIENT_SYSTEM_ERROR_CODES) {
    assert.ok(transientMessages.includes(code), code);
  }
});
