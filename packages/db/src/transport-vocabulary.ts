/** Transport symptoms shared by Run verdicts, runner commands, and GitHub writes.
 * Callers choose the evidence channel; access refusals always veto transport. */
export const TRANSIENT_SYSTEM_ERROR_CODES: ReadonlySet<string> = new Set([
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
]);

export const TRANSIENT_TRANSPORT_PATTERNS: readonly RegExp[] = [
  /fetch failed/i,
  /SSL_ERROR_SYSCALL/i,
  /SSL_connect/i,
  /unexpected EOF/i,
  /early EOF/i,
  /\bPost\s+"[^"]+"\s*:\s*EOF\b/i,
  /our servers are currently overloaded/i,
  /\bmodel\s+is\s+(?:currently\s+)?at capacity\b/i,
  /connection (?:reset|closed|timed out|lost|aborted|refused)/i,
  /RPC failed/i,
  /Operation timed out/i,
  /Failed to connect/i,
  /Could not resolve host/i,
  /Recv failure/i,
  /socket hang ?up/i,
  /HTTP(?: response)?\s*(?:408|425|429|5\d\d)/i,
  /status(?: code)?\s*(?:408|425|429|5\d\d)/i,
  /502 Bad Gateway/i,
  /503 Service Unavailable/i,
  /504 Gateway Timeout/i,
  ...Array.from(TRANSIENT_SYSTEM_ERROR_CODES, (code) => new RegExp(code, "i")),
];

export const DETERMINISTIC_ACCESS_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read Username/i,
  /permission denied/i,
  /forbidden/i,
  /HTTP(?: response)?\s*(?:401|403)/i,
  /status(?: code)?\s*(?:401|403)/i,
  /bad credentials/i,
  /authorization failed/i,
  /\bunauthorized\b/i,
  /invalid credentials/i,
  /requested URL returned error:\s*(?:401|403)\b/i,
  /resource not accessible/i,
];

export const isDeterministicAccessRefusal = (text: string): boolean =>
  DETERMINISTIC_ACCESS_PATTERNS.some((pattern) => pattern.test(text));

export const isTransientTransportFailure = (text: string): boolean =>
  !isDeterministicAccessRefusal(text)
  && TRANSIENT_TRANSPORT_PATTERNS.some((pattern) => pattern.test(text));
