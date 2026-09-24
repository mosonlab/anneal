const UNMATCHED_PEM_BEGIN = /-----BEGIN ([A-Z][A-Z0-9 ]+)-----[\s\S]*$/u;

/** Remove common credential shapes before CI evidence reaches durable or Agent-facing text. */
export const redactCiLog = (value: string): string => value
  .replace(/-----BEGIN ([A-Z][A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/gu, "[REDACTED PEM BLOCK]")
  .replace(UNMATCHED_PEM_BEGIN, "[REDACTED TRUNCATED PEM]")
  .replace(/\bBearer[ \t]+[^\s"']+/giu, "Bearer [REDACTED]")
  .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)(["'])(.*?)\2/giu,
    "$1$2[REDACTED]$2")
  .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)([^\s,;"']+)/giu,
    "$1[REDACTED]")
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/gu, "[REDACTED GITHUB TOKEN]");

/** Truncate an already-redacted excerpt, optionally retaining its first line. */
export const truncateRedactedCiLog = (
  value: string,
  maxBytes: number,
  preserveFirstLine = false,
): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;

  const firstLineEnd = preserveFirstLine ? value.indexOf("\n") : -1;
  const requestedPrefixBytes = firstLineEnd >= 0 ? Buffer.byteLength(value.slice(0, firstLineEnd + 1)) : 0;
  const prefixBytes = Math.min(requestedPrefixBytes, maxBytes);
  const tailBytes = maxBytes - prefixBytes;
  const truncated = Buffer.concat([
    bytes.subarray(0, prefixBytes),
    tailBytes > 0 ? bytes.subarray(-tailBytes) : Buffer.alloc(0),
  ]).toString("utf8");

  // The byte boundary can cut through a PEM marker or its body. Fail closed on
  // any block that no longer has its matching END marker in the excerpt.
  let safeTruncated = truncated.replace(UNMATCHED_PEM_BEGIN, "[REDACTED TRUNCATED PEM]");
  while (Buffer.byteLength(safeTruncated, "utf8") > maxBytes) safeTruncated = safeTruncated.slice(0, -1);
  return safeTruncated;
};
