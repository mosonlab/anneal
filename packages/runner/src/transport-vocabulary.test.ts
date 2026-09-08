import assert from "node:assert/strict";
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
  "ETIMEOUT",
  "notunauthorized ECONNRESET",
  "HTTP\t503",
  "model\tis currently\tat capacity"
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
  "HTTP 404",
  "xmodel is at capacity",
  "model is at capacityx",
  "xPost \"https://example.com\": EOF",
  "Post \"https://example.com\": EOFx"
];

const messages = [
  ...transientMessages,
  ...transientMessages.map((text) => text.toUpperCase()),
  ...nonTransportMessages,
  ...refusals,
  ...refusals.map((text) => `${text}; ECONNRESET`),
  ...refusals.map((text) => `Selected model is at capacity; ${text}`),
];

test("shared transport vocabulary covers its categories and access veto precedence", () => {
  for (const message of messages) {
    const expected = transientMessages.some((candidate) => candidate.toLowerCase() === message.toLowerCase());
    assert.equal(isTransientTransportFailure(message), expected, message);
  }
  for (const pattern of TRANSIENT_TRANSPORT_PATTERNS) {
    assert.ok(transientMessages.some((text) => pattern.test(text)), String(pattern));
  }
  for (const pattern of DETERMINISTIC_ACCESS_PATTERNS) {
    assert.ok(refusals.some((text) => pattern.test(text)), String(pattern));
  }
});
