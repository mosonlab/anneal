// The CLI sorts explicit filenames alphabetically. The programmatic runner
// preserves the measured queue order while retaining one process per file.
import { run } from "node:test";
import { spec } from "node:test/reporters";

const [concurrency, ...files] = process.argv.slice(2);
if (process.env.AGENTOS_DBTEST_PLAN) {
  // Node 20's run() has no execArgv option; it inherits process.execArgv.
  // Only file children load the preamble: this coordinator has no assignment.
  process.execArgv.push("--import", new URL("dbtest-preamble.mjs", import.meta.url).href);
}
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort();
  });
}
const stream = run({ files, concurrency: Number(concurrency), signal: controller.signal });
stream.on("test:fail", () => { process.exitCode ||= 1; });
stream.compose(spec).pipe(process.stdout);
