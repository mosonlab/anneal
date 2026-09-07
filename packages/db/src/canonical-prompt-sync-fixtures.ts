/**
 * Prompt-only rollover fixtures must restore every prompt byte from before
 * optional review omission, not just the older Regression script path. The
 * generation digest authenticates the whole template.
 */
export const restorePreOptionalReviewPrompt = (prompt: string): string => prompt
  .replaceAll("review-findings", "sol-findings")
  .replaceAll("the code review report", "the Sol report")
  // Every registered generation predates the salvage-resume rollover, so the
  // fix prompt drops that sentence pair before the older spellings are restored.
  .replace(
    " If that HEAD is a `WIP salvage` commit of a prior Run of this same task and its parent is the reviewed head, the salvaged changes are your own failed attempt's in-progress fixes: validate them against the reports, continue on top of them, and record the reviewed head — the salvage commit's parent — as `sourceHead`. Every other reviewed-head mismatch remains a stop.",
    "",
  )
  .replace(
    "Read the immutable `sol-findings` review output and, when present, the immutable `blind-findings` output through their Anneal step outputs. The blind review may be absent when its optional step was omitted; when it is absent, the Sol report is the sole report. Verify that every present report's reviewed head is the HEAD you are about to fix. When both reports are present, also verify that they report the same reviewed base and the same reviewed head.",
    "Read both immutable review outputs from the preceding layer — `sol-findings` and `blind-findings` — through their Anneal step outputs, and verify both report the same reviewed base and the same reviewed head, and that the head they reviewed is the HEAD you are about to fix.",
  )
  .replace(
    "Record exactly one disposition per finding id across every present report",
    "Record exactly one disposition per finding id across both reports",
  )
  .replace(
    "Otherwise read the implementation summary,\nevery present review report (`sol-findings` and, when instantiated,\n`blind-findings`), and the fixed implementation with its dispositions from\nAnneal. The blind review report may be absent when its optional step was\nomitted. Review the entire refreshed fix diff as one unit, account for every\nfinding id in every present report, rerun focused regressions, and verify that the approved",
    "Otherwise read the implementation summary,\nboth review reports, and the fixed implementation with its dispositions from\nAnneal. Review the entire refreshed fix diff as one unit, account for every\nfinding id, rerun focused regressions, and verify that the approved",
  );

/** Restore the revalidation v1 bytes carried by both deployed generations. */
export const restorePreTierRevalidationPrompt = (prompt: string): string => prompt
  .replace(/After checking the brief and the tree, judge the implementation tier\.[\s\S]*?(?=After the PATCH succeeds)/u, "")
  .replace('"schemaVersion":2', '"schemaVersion":1')
  .replace(',"route":{"tier":"default|frontend|hard|hazard","reason":"<criterion that applies, or why none does>"}', "");
