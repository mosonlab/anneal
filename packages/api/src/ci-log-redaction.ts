/** Remove common credential shapes before CI evidence reaches durable or Agent-facing text. */
export const redactCiLog = (value: string): string => value
  .replace(/-----BEGIN ([A-Z][A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/gu, "[REDACTED PEM BLOCK]")
  .replace(/\bBearer[ \t]+[^\s"']+/giu, "Bearer [REDACTED]")
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/gu, "[REDACTED GITHUB TOKEN]")
  .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)(["'])(.*?)\2/giu,
    "$1$2[REDACTED]$2")
  .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)([^\s,;"']+)/giu,
    "$1[REDACTED]");
