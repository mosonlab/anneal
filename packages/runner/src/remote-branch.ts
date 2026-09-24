import type { CommandRunner } from "./exec.js";

/**
 * The remote branch this Run publishes to carries commits the Run's own head
 * does not contain, and the runner could not reconcile them.
 *
 * Raised in two places, both from repository facts the runner read itself
 * rather than from push wording:
 *
 *  - DELIVER: `git push` of the chain branch failed and a fetch of that branch
 *    showed a tip that is not an ancestor of HEAD. Replaying the same head can
 *    only be rejected again, so the failure is deterministic.
 *  - PROVISION: the declared head carries commits the published base lacks and
 *    merging them into the base conflicts. Starting the agent anyway would
 *    reproduce the DELIVER rejection at the end of the session.
 *
 * It is a type so the failure envelope can carry a typed marker
 * (`remoteBranchDiverged`) and the control plane never has to match git's text.
 */
export class RemoteBranchDivergedError extends Error {
  constructor(
    message: string,
    readonly branch: string,
    readonly remoteSha: string,
    readonly foreignCommits: readonly string[],
  ) {
    super(message);
    this.name = "RemoteBranchDivergedError";
  }
}

export const isRemoteBranchDiverged = (error: unknown): error is RemoteBranchDivergedError =>
  error instanceof RemoteBranchDivergedError;

/** How many foreign commits are named individually; the total is always stated. */
const LISTED_FOREIGN_COMMITS = 10;
const SUBJECT_LIMIT = 120;

export type ForeignCommits = {
  total: number;
  /** `<sha> <author> <email>: <subject>`, newest first. */
  listed: string[];
};

/**
 * The commits reachable from `remoteSha` but not from `head`: what someone
 * else put on the branch. Read with a tab-separated format so a subject with
 * spaces or colons cannot be misparsed.
 */
export const readForeignCommits = async (
  run: CommandRunner,
  head: string,
  remoteSha: string,
): Promise<ForeignCommits> => {
  const range = `${head}..${remoteSha}`;
  const count = Number.parseInt(await run("git", ["rev-list", "--count", range]), 10);
  const log = await run("git", [
    "log", `--max-count=${LISTED_FOREIGN_COMMITS}`, "--format=%H%x09%an <%ae>%x09%s", range,
  ]);
  const listed = log.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    const [sha = "", author = "", ...subject] = line.split("\t");
    const text = subject.join("\t");
    return `${sha} ${author}: ${text.length > SUBJECT_LIMIT ? `${text.slice(0, SUBJECT_LIMIT)}…` : text}`;
  });
  return { total: Number.isFinite(count) ? count : listed.length, listed };
};

export const describeForeignCommits = (foreign: ForeignCommits): string => {
  const more = foreign.total > foreign.listed.length
    ? `; ${foreign.total - foreign.listed.length} more not listed`
    : "";
  return `${foreign.total} foreign commit(s): ${foreign.listed.join("; ")}${more}`;
};
