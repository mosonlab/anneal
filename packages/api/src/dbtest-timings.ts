/**
 * Where the database wave's time actually went, per file.
 *
 * The wave is the largest single cost in the merge gate and the only number the
 * gate reports about it is the total. Deciding what to make cheaper from that
 * number means guessing, and the two rounds of tuning before this one both
 * started by guessing at file size and both guessed wrong — the expensive files
 * were expensive for reasons (a ten-second sleep, a process spawn per statement)
 * that no amount of reading the file would have shown.
 *
 * `node:test` parallelises across files and runs the tests inside one file in
 * order, so a file's own wall clock is the wave's lower bound and the only
 * granularity worth recording. Each test process appends one line here as it
 * exits; the runner reads them afterwards and reports the slowest first.
 *
 * A line is a complete JSON object written in one `appendFileSync` call, which
 * is what keeps concurrent writers from interleaving: several files finish at
 * once by design.
 */

/** Names the file every test process appends its own line to. */
export const timingsEnvironmentVariable = "AGENTOS_DBTEST_TIMINGS";
export const timingHistoryEnvironmentVariable = "AGENTOS_DBTEST_TIMING_HISTORY";

/**
 * How a file is named in the report.
 *
 * The whole path is what gets recorded, because the gate runs `packages/db` and
 * `packages/api` as one pool and those suites contain same-named pairs —
 * `preflight-goal-execution.dbtest.ts` and `service-maintenance-lock.dbtest.ts`
 * exist in both. A report keyed on the basename would silently merge each pair
 * into one line, which is the same trap `fileDirectoryName` documents. The
 * package is kept and the invariant `src/` dropped, so the two are told apart
 * without printing an absolute path per row.
 */
export const timingDisplayName = (file: string): string => {
  const marker = "/packages/";
  const index = file.lastIndexOf(marker);
  if (index === -1) return file;
  return file.slice(index + marker.length).replace("/src/", "/");
};

export interface DbtestFileTiming {
  file: string;
  ms: number;
}

/** History controls order only. Unknown files run first so new slow tests do
 * not become an unmeasured tail. Every requested file is retained exactly once
 * per occurrence, regardless of stale or foreign history entries. */
export const orderByTimings = (files: string[], timings: DbtestFileTiming[]): string[] => {
  const known = new Map(timings.map(({ file, ms }) => [timingDisplayName(file), ms]));
  return [...files].sort((left, right) => {
    const a = known.get(timingDisplayName(left));
    const b = known.get(timingDisplayName(right));
    if (a === undefined && b !== undefined) return -1;
    if (b === undefined && a !== undefined) return 1;
    return (b ?? 0) - (a ?? 0) || left.localeCompare(right);
  });
};

export const formatTimingLine = (timing: DbtestFileTiming): string => `${JSON.stringify(timing)}\n`;

/**
 * Reads what the test processes wrote.
 *
 * A malformed or truncated line is dropped rather than thrown on: this is a
 * report about a run, and a run that already produced a verdict must not be
 * turned red by its own bookkeeping. A dropped line is counted so the report
 * cannot quietly describe fewer files than ran.
 */
export const parseTimings = (contents: string): { timings: DbtestFileTiming[]; unreadable: number } => {
  const timings: DbtestFileTiming[] = [];
  let unreadable = 0;
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const record = parsed as Partial<DbtestFileTiming>;
      if (typeof record.file !== "string" || typeof record.ms !== "number" || !Number.isFinite(record.ms) || record.ms < 0) {
        unreadable += 1;
        continue;
      }
      timings.push({ file: record.file, ms: record.ms });
    } catch {
      unreadable += 1;
    }
  }
  return { timings, unreadable };
};

/**
 * The report: slowest first, and only as long as it is useful.
 *
 * The tail is what decides the wave — the pool drains at the pace of its
 * longest file — so the head of this list is the whole reason it exists. The
 * rest is summarised rather than printed, because a 78-line table in a gate log
 * is a wall nobody reads.
 */
export const formatTimingReport = (
  timings: DbtestFileTiming[],
  { top = 10, unreadable = 0 }: { top?: number; unreadable?: number } = {},
): string[] => {
  if (timings.length === 0) {
    return [`no per-file timings were recorded${unreadable > 0 ? ` (${unreadable} unreadable)` : ""}`];
  }
  const ordered = [...timings].sort((left, right) => right.ms - left.ms);
  const totalMs = ordered.reduce((sum, entry) => sum + entry.ms, 0);
  const shown = ordered.slice(0, top).map((entry) => ({ name: timingDisplayName(entry.file), ms: entry.ms }));
  const width = Math.max(...shown.map((entry) => entry.name.length));
  const lines = shown.map((entry) => `  ${entry.name.padEnd(width)}  ${(entry.ms / 1000).toFixed(1)}s`);
  const head = `slowest ${shown.length} of ${ordered.length} files`
    + ` (${(totalMs / 1000).toFixed(1)}s of work, longest file ${(ordered[0]!.ms / 1000).toFixed(1)}s)`;
  const tail = unreadable > 0 ? [`  ${unreadable} timing line(s) were unreadable and are missing from this report`] : [];
  return [head, ...lines, ...tail];
};
