import { parseLocalApiDestination, type MergeExecutorObservation, type MergeExecutorDaemonSnapshot } from "@anneal/db";

/** Freeze the API registry observation before the Inbox decision transaction. */
export const readMergeExecutorLiveness = async (options: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (reason: string) => void;
} = {}): Promise<MergeExecutorObservation> => {
  const env = options.env ?? process.env;
  if (!env.MERGE_EXECUTOR_RUNNER_IDS?.split(",").some((id) => id.trim())) return [];
  const unreadable = (cause: string): MergeExecutorObservation => {
    (options.log ?? ((reason) => console.error(`Inbox executor liveness unreadable: ${reason}`)))(cause);
    return { observation: "unreadable", cause };
  };
  const destination = parseLocalApiDestination(env.RUNNER_API_URL ?? "http://127.0.0.1:3000");
  if (!destination.accepted) return unreadable(destination.reason);
  if (!env.OPERATOR_TOKEN) return unreadable("no-token");
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${destination.origin}/runners`, {
      headers: { Authorization: `Bearer ${env.OPERATOR_TOKEN}` },
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
  } catch {
    return unreadable("unreachable");
  }
  if (!response.ok) return unreadable(`http-${response.status}`);
  try {
    const body = await response.json() as { daemons?: unknown } | null;
    if (!body || !Array.isArray(body.daemons)) return unreadable("malformed");
    const daemons: MergeExecutorDaemonSnapshot[] = [];
    for (const daemon of body.daemons as unknown[]) {
      if (typeof daemon !== "object" || daemon === null || !("runnerId" in daemon) || !("online" in daemon)
        || typeof daemon.runnerId !== "string" || typeof daemon.online !== "boolean") return unreadable("malformed");
      daemons.push({ runnerId: daemon.runnerId, online: daemon.online });
    }
    return daemons;
  } catch {
    return unreadable("malformed");
  }
};
