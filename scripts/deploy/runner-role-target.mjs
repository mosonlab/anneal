import { buildInfoFromVersionDocument } from "../../packages/build-info/index.mjs";

import { DeployFailure } from "./quiet-window-lib.mjs";
import { resolveDeployRole as resolveConfiguredDeployRole } from "./deploy-role.mjs";

const ACCEPTED_DESTINATION = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;
const DESTINATION_SHAPE = /^(?<scheme>[A-Za-z][A-Za-z0-9+.\-]*):\/\/(?<authority>[^/?#]*)(?<path>[^?#]*)(?<query>\?[^#]*)?(?<fragment>#.*)?$/u;
const HIGHEST_PORT = 65_535;

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

export const resolveDeployRoleOrFail = (environment = process.env) => {
  try {
    return resolveConfiguredDeployRole(environment);
  } catch {
    fail("deploy-role-invalid", String(environment.AGENTOS_DEPLOY_ROLE));
  }
};

const splitAuthority = (authority) => {
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

const destinationRefusal = (value) => {
  if (value === "") return "destination-empty";
  const shape = DESTINATION_SHAPE.exec(value)?.groups;
  if (!shape) return "destination-unparsable";
  if (shape.scheme !== "http") return "scheme-not-http";
  const authority = shape.authority ?? "";
  if (authority.includes("@")) return "userinfo-present";
  const { host, port } = splitAuthority(authority);
  if (host !== "127.0.0.1") return "host-not-numeric-loopback";
  if (port === null || port === "") return "port-missing";
  if (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > HIGHEST_PORT) return "port-invalid";
  if ((shape.path ?? "") !== "") return "path-present";
  if (shape.query !== undefined) return "query-present";
  if (shape.fragment !== undefined) return "fragment-present";
  return "destination-unparsable";
};

export const controlPlaneApiBaseUrl = (environment = process.env) => {
  const configured = environment?.RUNNER_API_URL === undefined
    ? `http://127.0.0.1:${environment?.API_PORT ?? "3000"}`
    : environment.RUNNER_API_URL;
  const value = typeof configured === "string" ? configured.trim() : "";
  const accepted = ACCEPTED_DESTINATION.exec(value);
  if (accepted && Number(accepted[1]) <= HIGHEST_PORT) return value;
  fail("control-plane-api-url-invalid", destinationRefusal(value));
};

export const requireRunnerDeployPreflight = (environment = process.env) => {
  const runnerIdPrefix = environment?.AGENTOS_RUNNER_ID_PREFIX;
  if (typeof runnerIdPrefix !== "string" || runnerIdPrefix === "") {
    fail("runner-id-prefix-required", "AGENTOS_RUNNER_ID_PREFIX-must-identify-this-host");
  }
  if (!/^[A-Za-z0-9_.-]+$/u.test(runnerIdPrefix)) {
    fail("runner-id-prefix-invalid", String(runnerIdPrefix));
  }
  const operatorToken = environment?.OPERATOR_TOKEN;
  if (typeof operatorToken !== "string" || operatorToken === "") {
    fail("runner-registration-verification-unavailable", "OPERATOR_TOKEN-missing");
  }
  return Object.freeze({
    apiBaseUrl: controlPlaneApiBaseUrl(environment),
    operatorToken,
    runnerIdPrefix,
  });
};

/** The loopback API origin and operator credential a control-plane host must
 * use to prove its own local runners re-registered. The control plane always
 * answers on its own loopback port, so no destination is configurable here. */
export const requireControlPlaneRegistrationAccess = (environment = process.env) => {
  const operatorToken = environment?.OPERATOR_TOKEN;
  if (typeof operatorToken !== "string" || operatorToken === "") {
    fail("runner-registration-verification-unavailable", "OPERATOR_TOKEN-missing");
  }
  return Object.freeze({
    apiBaseUrl: controlPlaneApiBaseUrl({ API_PORT: environment?.API_PORT }),
    operatorToken,
  });
};

export const readRunnerControlPlaneRevision = async ({ apiBaseUrl, fetchImpl = fetch }) => {
  const verifiedApiBaseUrl = controlPlaneApiBaseUrl({ RUNNER_API_URL: apiBaseUrl });
  const endpoint = `${verifiedApiBaseUrl}/version`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    fail("control-plane-version-unreachable", error instanceof Error ? error.name : "request-failed");
  }
  if (!response?.ok) fail("control-plane-version-unreachable", `http-${response?.status ?? "unknown"}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("control-plane-version-invalid", "response-is-not-json");
  }
  if (payload?.dirty === true) fail("control-plane-build-dirty", String(payload?.commit ?? "unknown"));
  const { info, service } = buildInfoFromVersionDocument(payload);
  if (!info.stamped || info.dirty || info.commit === null || service !== "@anneal/api") {
    fail("control-plane-version-invalid", "clean-stamped-api-commit-required");
  }
  return info.commit;
};

/** Resolve the runner host's only legal deployment target. The source check is
 * deliberately part of this preflight, before an artifact builder is called. */
export const readRunnerTargetRevision = async ({
  apiBaseUrl,
  fetchImpl = fetch,
  sourceContainsCommit,
  deployedCommit = null,
}) => {
  const commit = await readRunnerControlPlaneRevision({ apiBaseUrl, fetchImpl });
  if (commit === deployedCommit) return commit;

  let contained;
  try {
    contained = await sourceContainsCommit(commit);
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("control-plane-commit-unavailable", error instanceof Error ? error.name : "source-check-failed");
  }
  if (contained !== true) fail("control-plane-commit-unavailable", commit);
  return commit;
};
