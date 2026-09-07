/**
 * Inbox's bearer-carrying local API destination policy. Keep this pure parser
 * aligned with the runner, web proxy and deploy target using the shared
 * scripts/fixtures/local-api-origin-cases.json table. Validate before fetching.
 */

/** The whole accept decision. Anything this does not match is refused. */
const ACCEPTED_DESTINATION = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;

/** Structural decomposition, used only to explain a refusal. */
const DESTINATION_SHAPE =
  /^(?<scheme>[A-Za-z][A-Za-z0-9+.\-]*):\/\/(?<authority>[^/?#]*)(?<path>[^?#]*)(?<query>\?[^#]*)?(?<fragment>#.*)?$/u;

const HIGHEST_PORT = 65_535;

export type LocalApiDestinationRefusal =
  | "destination-empty"
  | "destination-unparsable"
  | "scheme-not-http"
  | "userinfo-present"
  | "host-not-numeric-loopback"
  | "port-missing"
  | "port-invalid"
  | "path-present"
  | "query-present"
  | "fragment-present";

export type LocalApiDestination =
  | { accepted: true; origin: string; port: number }
  | { accepted: false; reason: LocalApiDestinationRefusal };

/** Host and port as written, without normalising either. */
const splitAuthority = (authority: string): { host: string; port: string | null } => {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return { host: authority, port: null };
    const after = authority.slice(close + 1);
    return { host: authority.slice(0, close + 1), port: after.startsWith(":") ? after.slice(1) : null };
  }
  const separator = authority.lastIndexOf(":");
  if (separator === -1) return { host: authority, port: null };
  return { host: authority.slice(0, separator), port: authority.slice(separator + 1) };
};

const classify = (value: string): LocalApiDestinationRefusal => {
  const shape = DESTINATION_SHAPE.exec(value)?.groups;
  if (!shape) return "destination-unparsable";
  // Case-sensitive: `HTTP://` is not the accepted spelling, and saying so is
  // more useful than silently folding it.
  if (shape["scheme"] !== "http") return "scheme-not-http";
  const authority = shape["authority"] ?? "";
  if (authority.includes("@")) return "userinfo-present";
  const { host, port } = splitAuthority(authority);
  if (host !== "127.0.0.1") return "host-not-numeric-loopback";
  if (port === null || port === "") return "port-missing";
  if (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > HIGHEST_PORT) return "port-invalid";
  if ((shape["path"] ?? "") !== "") return "path-present";
  if (shape["query"] !== undefined) return "query-present";
  if (shape["fragment"] !== undefined) return "fragment-present";
  // Unreachable: a value that survives every check above is the accepted form,
  // which the caller already matched. Refusing is still the safe answer.
  return "destination-unparsable";
};

/**
 * Decide whether one configured destination is the supported loopback origin.
 * Pure: it performs no I/O and touches no ambient state.
 */
export const parseLocalApiDestination = (raw: string | undefined | null): LocalApiDestination => {
  // An .env reader already strips surrounding whitespace; indentation in a
  // hand-edited file is not a different policy.
  const value = (raw ?? "").trim();
  if (value === "") return { accepted: false, reason: "destination-empty" };
  const accepted = ACCEPTED_DESTINATION.exec(value);
  const port = accepted ? Number(accepted[1]) : 0;
  if (accepted && port <= HIGHEST_PORT) return { accepted: true, origin: value, port };
  return { accepted: false, reason: classify(value) };
};

