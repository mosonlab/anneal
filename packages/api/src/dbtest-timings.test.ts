/**
 * The report is bookkeeping about a run, so its rules are about not lying and
 * not failing: drop what it cannot read, say how much it dropped, and never
 * throw where a verdict has already been reached.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTimingLine, formatTimingReport, orderByTimings, parseTimings, timingDisplayName } from "./dbtest-timings.js";

it("history orders long files first across checkouts without selecting or dropping files", () => {
  const files = ["/new/packages/api/src/a.ts", "/new/packages/db/src/a.ts", "/new/packages/api/src/new.ts"];
  const history = [
    { file: "api/a.ts", ms: 10 }, { file: "/old/packages/db/src/a.ts", ms: 90 },
    { file: "api/deleted.ts", ms: 999 },
  ];
  assert.deepEqual(orderByTimings(files, history), [files[2], files[1], files[0]]);
  assert.deepEqual(files, ["/new/packages/api/src/a.ts", "/new/packages/db/src/a.ts", "/new/packages/api/src/new.ts"]);
});

describe("formatTimingLine", () => {
  it("writes one complete line per file, which is what keeps concurrent writers apart", () => {
    const line = formatTimingLine({ file: "chain.dbtest.ts", ms: 1234 });
    assert.equal(line, '{"file":"chain.dbtest.ts","ms":1234}\n');
    assert.equal(parseTimings(line).timings.length, 1);
  });
});

describe("parseTimings", () => {
  it("reads the lines the test processes wrote, in any order", () => {
    const contents = formatTimingLine({ file: "b.dbtest.ts", ms: 200 })
      + formatTimingLine({ file: "a.dbtest.ts", ms: 100 });
    assert.deepEqual(parseTimings(contents), {
      timings: [{ file: "b.dbtest.ts", ms: 200 }, { file: "a.dbtest.ts", ms: 100 }],
      unreadable: 0,
    });
  });

  it("counts what it cannot read instead of throwing or silently shrinking", () => {
    // A process killed mid-write is the ordinary way to get a partial line, and
    // that is exactly a run someone is already investigating.
    const contents = `{"file":"a.dbtest.ts","ms":10}\n{"file":"trunc\n{"file":"b.dbtest.ts"}\n[]\n`;
    const result = parseTimings(contents);
    assert.deepEqual(result.timings, [{ file: "a.dbtest.ts", ms: 10 }]);
    assert.equal(result.unreadable, 3);
  });

  it("ignores blank lines, including the trailing newline every writer leaves", () => {
    assert.deepEqual(parseTimings("\n\n").timings, []);
    assert.equal(parseTimings("\n\n").unreadable, 0);
  });
});

describe("timingDisplayName", () => {
  it("keeps the package, so the same-named pairs in db and api stay two rows", () => {
    // The pool contains both of these, and a report that merged them would be
    // pointing at the wrong file half the time.
    assert.equal(
      timingDisplayName("/repo/packages/api/src/service-maintenance-lock.dbtest.ts"),
      "api/service-maintenance-lock.dbtest.ts",
    );
    assert.equal(
      timingDisplayName("/repo/packages/db/src/service-maintenance-lock.dbtest.ts"),
      "db/service-maintenance-lock.dbtest.ts",
    );
    assert.notEqual(
      timingDisplayName("/repo/packages/api/src/preflight-goal-execution.dbtest.ts"),
      timingDisplayName("/repo/packages/db/src/preflight-goal-execution.dbtest.ts"),
    );
  });

  it("returns a path it does not recognise unchanged rather than guessing", () => {
    assert.equal(timingDisplayName("/elsewhere/x.dbtest.ts"), "/elsewhere/x.dbtest.ts");
    assert.equal(timingDisplayName("unknown"), "unknown");
  });
});

describe("formatTimingReport", () => {
  const timings = Array.from({ length: 12 }, (_unused, index) => ({
    file: `f${index}.dbtest.ts`,
    ms: (index + 1) * 1000,
  }));

  it("puts the longest file first, because that is what the wave waits for", () => {
    const lines = formatTimingReport(timings);
    assert.match(lines[0] ?? "", /slowest 10 of 12 files/u);
    assert.match(lines[0] ?? "", /longest file 12\.0s/u);
    assert.match(lines[1] ?? "", /f11\.dbtest\.ts\s+12\.0s/u);
    assert.match(lines[10] ?? "", /f2\.dbtest\.ts\s+3\.0s/u);
    assert.equal(lines.length, 11, "a table nobody reads is worse than a short one");
  });

  it("reports total work as well as the tail, so packing efficiency is computable", () => {
    // 78s of work over 12 files: the gate's own question is how much of that a
    // lane count can actually absorb.
    assert.match(formatTimingReport(timings)[0] ?? "", /78\.0s of work/u);
  });

  it("says so when there is nothing to report rather than printing an empty table", () => {
    assert.deepEqual(formatTimingReport([]), ["no per-file timings were recorded"]);
    assert.deepEqual(formatTimingReport([], { unreadable: 2 }), ["no per-file timings were recorded (2 unreadable)"]);
  });

  it("admits dropped lines in the report itself, not only in the count", () => {
    const lines = formatTimingReport([{ file: "a.dbtest.ts", ms: 1000 }], { unreadable: 1 });
    assert.match(lines.at(-1) ?? "", /1 timing line\(s\) were unreadable/u);
  });
});
