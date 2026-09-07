import { type Locale, translate } from "./i18n-core";

/**
 * The registration seam. `format.ts` keeps every signature — 41 call sites in 17
 * files, two of them in the non-React module `lib/schedule.ts` — so the locale
 * reaches the formatters by registration rather than by a hook and a parameter
 * ripple.
 *
 * `LocaleProvider` calls this in its render body, an idempotent assignment rather
 * than an effect, so the very paint that switches the language already formats in
 * it. The callback is `(key, vars)`, not `translate` itself, which is
 * `(locale, key, vars)`: the provider passes a locale-bound closure.
 *
 * Provider-free, the module answers in English through the same dictionaries, so
 * `format.ts` holds no English fragments of its own.
 */
export type FormatTranslate = (key: string, vars?: Record<string, string | number>) => string;

let activeLocale: Locale = "en";
let activeTranslate: FormatTranslate = (key, vars) => translate("en", key, vars);

export const setFormatLocale = (locale: Locale, translateFor: FormatTranslate): void => {
  activeLocale = locale;
  activeTranslate = translateFor;
};

/** The active locale, for the one consumer that needs the tag itself rather than
 *  a translated string: `schedule.ts` passes it to `cronstrue`. */
export const formatLocale = (): Locale => activeLocale;

/** The module-level translator, so pure modules downstream of `format.ts` stay
 *  parameter-free. */
export const formatT: FormatTranslate = (key, vars) => activeTranslate(key, vars);

const INTL_TAGS: Record<Locale, string> = { en: "en-US", zh: "zh-CN" };

/** Memoised per locale and style: switching the language must not rebuild an
 *  `Intl.DateTimeFormat` on every render. `en-US` and its options are unchanged
 *  from before this batch, so English output is byte-identical. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const intl = (style: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${style}:${activeLocale}`;
  const held = formatters.get(key);
  if (held) return held;
  const made = new Intl.DateTimeFormat(INTL_TAGS[activeLocale], options);
  formatters.set(key, made);
  return made;
};

const DATE_TIME = (): Intl.DateTimeFormat =>
  intl("dateTime", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const DATE = (): Intl.DateTimeFormat =>
  intl("date", { month: "short", day: "numeric", year: "numeric" });

export const formatDateTime = (value: string | null | undefined): string =>
  value ? DATE_TIME().format(new Date(value)) : "—";

export const formatDate = (value: string | null | undefined): string =>
  value ? DATE().format(new Date(value)) : "—";

export const timeAgo = (value: string | null | undefined): string => {
  if (!value) return "—";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return formatT("format.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatT("format.minutesAgo", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatT("format.hoursAgo", { n: hours });
  const days = Math.round(hours / 24);
  return days < 30 ? formatT("format.daysAgo", { n: days }) : formatDate(value);
};

export const duration = (from: string | null | undefined, to: string | null | undefined, now = Date.now()): string => {
  if (!from) return "—";
  const end = to ? new Date(to).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(from).getTime()) / 1000));
  if (seconds < 60) return formatT("format.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  return formatT("format.minutesSeconds", { m: minutes, s: seconds % 60 });
};

/** At most one decimal, so `20` stays `20` and `19.94` becomes `19.9`. */
const trim = (value: number): string => value.toFixed(1).replace(/\.0$/u, "");

export const UNKNOWN = "—";

export const measured = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

/** A span that arrives already in milliseconds, where `duration` above takes a
 *  pair of ISO timestamps. `null` means the span was never measured, so it is
 *  the em dash and never `0s`; a sub-second span keeps its millisecond unit
 *  rather than rounding to a zero that reads as "no time at all", and a
 *  measured `0` still renders as `0`. */
export const durationMs = (value: number | null | undefined): string => {
  if (!measured(value)) return UNKNOWN;
  if (value < 1000) return formatT("format.millis", { n: Math.round(value) });
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return formatT("format.seconds", { n: seconds });
  return formatT("format.minutesSeconds", { m: Math.floor(seconds / 60), s: seconds % 60 });
};

/** A long span, in the largest two units that carry information.
 *  `durationMs` is right for one run's phase and wrong for a chain's lead time:
 *  it would report three days as "4320m 0s". Null is the em dash for the same
 *  reason it is there — an unmeasured span is not a zero one. */
export const spanMs = (value: number | null | undefined): string => {
  if (!measured(value)) return UNKNOWN;
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return durationMs(value);
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? formatT("format.hoursMinutes", { h: hours, m: minutes % 60 })
    : formatT("format.daysHours", { d: Math.floor(hours / 24), h: hours % 24 });
};

/** A `0..1` ratio as a percentage, or `null` when the ratio was never measured
 *  — the caller drops its clause rather than claiming `0%`. A measured `0` is
 *  still `0%`, because a run really can read nothing from cache. */
export const percent = (ratio: number | null | undefined): string | null =>
  measured(ratio) ? `${trim(ratio * 100)}%` : null;

/** An output rate as prose. Whether it is a measurement or a bound is the
 *  caller's to say; this only formats the number. */
export const tokensPerSecond = (value: number | null | undefined): string =>
  measured(value) ? formatT("format.tokensPerSecond", { n: trim(value) }) : UNKNOWN;

export const durationWithInboxWait = (
  from: string | null | undefined,
  to: string | null | undefined,
  includesInboxWait: boolean,
  now = Date.now(),
): string => {
  const elapsed = duration(from, to, now);
  return includesInboxWait && elapsed !== "—"
    ? formatT("format.durationWithInboxWait", { duration: elapsed })
    : elapsed;
};

/** Decimal columns arrive as strings; `null` means the runner never reported cost. */
export const money = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "—" : `$${Number(value).toFixed(2)}`;

export const sha = (value: string | null | undefined): string => (value ? value.slice(0, 7) : "—");

/** Stable synchronous content identity for the Foundation card. This is a
 * revision fingerprint, not a semantic version or a security hash. */
export const contentRevision = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 7);
};

export const titleCase = (value: string): string =>
  value.toLowerCase().replace(/[_-]/g, " ").replace(/(^|\s)\S/g, (match) => match.toUpperCase());

/** First non-empty line — inbox rows show it as the message title. */
export const firstLine = (body: string): string => {
  const line = body.split("\n").find((candidate) => candidate.trim().length > 0);
  return (line ?? "").replace(/[*`#]/g, "").trim();
};

export const restLines = (body: string): string => {
  const lines = body.split("\n");
  const index = lines.findIndex((candidate) => candidate.trim().length > 0);
  return lines.slice(index + 1).join(" ").replace(/[*`#]/g, "").replace(/\s+/g, " ").trim();
};

export const initial = (value: string): string => (value.trim()[0] ?? "?").toUpperCase();

/** Token counts, shortened for a stat pill. `null` means the runner never
 *  reported usage — never `0`, which would read as "this run spent nothing". */
export const compactTokens = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const short = (divided: number, suffix: string): string =>
    `${divided.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  // Thresholds compare the *rounded* value, not the raw one: at exactly
  // 1_000_000 the raw test renders 999_999 as `1000K`, which reads as a
  // formatting bug rather than a number. 999_950 is where `toFixed(1)` of
  // `value / 1_000` first reaches `1000.0`.
  if (Math.abs(value) >= 999_950) return short(value / 1_000_000, "M");
  if (Math.abs(value) >= 999.95) return short(value / 1_000, "K");
  return String(value);
};

/** Usage estimates routinely land below one cent. Keep ordinary amounts on the
 * familiar two decimals, but retain enough precision that a positive amount is
 * never presented as zero. */
export const usageMoney = (value: string | number): string => {
  const amount = Number(value);
  if (amount === 0 || Math.abs(amount) >= 0.005 || !Number.isFinite(amount)) return money(value);
  const decimals = Math.min(8, Math.max(3, Math.ceil(-Math.log10(Math.abs(amount))) + 2));
  const fixed = amount.toFixed(decimals).replace(/0+$/u, "").replace(/\.$/u, "");
  if (Number(fixed) !== 0) return `$${fixed}`;
  return `$${amount.toExponential(2)}`;
};

export const usageCostLabel = (value: import("./types").UsageCost | null | undefined): string => {
  if (value?.costUsd !== null && value?.costUsd !== undefined) {
    const amount = usageMoney(value.costUsd);
    return value.estimated ? formatT("format.usageCost.estimated", { amount }) : amount;
  }
  if (!value) return "—";
  const parts = [
    value.inputTokens === null ? null : formatT("format.usageCost.input", { n: compactTokens(value.inputTokens) }),
    value.cachedInputTokens === null ? null : formatT("format.usageCost.cachedInput", { n: compactTokens(value.cachedInputTokens) }),
    value.outputTokens === null ? null : formatT("format.usageCost.output", { n: compactTokens(value.outputTokens) }),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "—" : parts.join(" · ");
};

/** A card's one-number reading of a usage cost, or `null` when the cost carries
 *  no money value. A card has room for the amount and nothing else: the
 *  estimated qualifier and the token breakdown belong to the detail page. */
export const usageCostAmount = (value: import("./types").UsageCost | null | undefined): string | null =>
  value === null || value === undefined || value.costUsd === null ? null : usageMoney(value.costUsd);

/** A repo remote as a browsable GitHub URL, or `null` when it is anything else.
 *  No other forge is recognised: a wrong guess would render a broken link. */
export const repoWebUrl = (remoteUrl: string | null | undefined): string | null => {
  if (!remoteUrl) return null;
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
  if (https) return `https://github.com/${https[1]}/${https[2]}`;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  // The `ssh://` form of the same remote. Only the standard `git` user and the
  // bare `github.com` host: another user or a port is a shape we do not know how
  // to browse, so it stays `null` rather than becoming a guessed link.
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshUrl) return `https://github.com/${sshUrl[1]}/${sshUrl[2]}`;
  return null;
};

/** `#39` from a `/pull/39` tail; the whole URL when it does not parse, because a
 *  link with no label is worse than a long one. */
export const pullRequestLabel = (url: string): string => {
  const parsed = /\/pull\/(\d+)\/?$/.exec(url);
  return parsed === null ? url : `#${parsed[1]}`;
};

export const compact = (value: unknown, max = 160): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
