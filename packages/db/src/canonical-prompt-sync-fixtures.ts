/**
 * Restore the Regression bytes retired by the Chain workspace scope rollover
 * (2026-09-24), which exempted the tracked `.chain/` directory from scope
 * checks. Every registered generation predates it, so the older fixtures apply
 * it before reconstructing their earlier prompt bytes.
 */
export const restorePreChainWorkspaceScopePrompt = (prompt: string): string => prompt
  .replace(
    " The tracked `.chain/` Chain workspace is platform bookkeeping that merge execution strips from the merge commit tree; it never counts toward diff-scope, forbidden-surface, or changed-file acceptance checks, so never report it as a defect or modify it.",
    "",
  );

/**
 * Restore the prompt bytes retired by the defect-class sweep rollover
 * (2026-09-23): the Regression sweep, the input traces in Spec, Plan,
 * Revalidate, Implementation and plan review, the shared-contract sentences in
 * Implementation and review, and the review-fix `inbox_ask` and rejection
 * rules. Every registered generation
 * predates it, so the older fixtures apply it before reconstructing their
 * earlier prompt bytes.
 */
export const restorePreDefectClassSweepPrompt = (prompt: string): string => restorePreChainWorkspaceScopePrompt(prompt)
  .replace(
    "Sweep changed code and sites governed by changed contracts for each defect class identified in the prior findings or\nrefreshed fix. Record proven pre-existing out-of-scope instances and non-blocking P2 observations separately in the\nactivity log. If an adopted finding remains open, a rejection is unsupported, or a new blocking defect exists, report\nevery blocking instance in one call, one line per finding ID, location (`file:line`, or command and cwd for an\nexecution failure), and consequence:",
    "If an adopted finding remains open, a rejection is unsupported, or a new\ndefect exists, run",
  )
  .replace(
    "The script persists the one allowed v2 outcome; never call `task_output` for this step or write a report file.",
    "The script persists the one allowed v2 outcome; never call `task_output` for\nthis step or write a report file.",
  )
  .replace(
    " Before implementing, trace each input the specification of record requires as pre-existing to a source at HEAD or a specified change, including the same Changes item, that creates it before use. Distinguish an implementation-created detail within scope from an unavailable input premise; ask one blocking `inbox_ask` question with the governing quote and tree evidence only for the latter, and finish independent work meanwhile.",
    "",
  )
  .replace(
    " For every shared contract this change adds, changes, or removes, enumerate all governed sites, verify each, update the inconsistent ones within the specification of record, and list checked sites, changed sites, and verification evidence in the summary.",
    "",
  )
  .replace(
    " Enumerate and inspect every site governed by a contract this change adds, changes, or removes at the pinned head, including sites outside `base...head`; report every inconsistency, grouping instances into one finding only when severity and required fix match, with every location listed in its evidence.",
    "",
  )
  .replace(
    "report. Enumerate and inspect every site governed by a contract this change\nadds, changes, or removes at the pinned head, including sites outside\n`base...head`; report every inconsistency, grouping instances into one finding\nonly when severity and required fix match, with every location listed in its\nevidence. Persist exactly one",
    "report. Persist exactly one",
  )
  .replace(
    " When closing a finding requires changing specified behavior, scope, or an unavailable input premise, ask one blocking `inbox_ask` question quoting the governing text with the tree evidence; finish the independent fixes meanwhile, and resume the dependent work only after the decision is recorded in the specification of record.",
    "",
  )
  .replace(
    " Reject a P0 or P1 finding only with evidence that it is unreachable, covered by another adopted finding, or proven pre-existing and outside the specification of record; for the last case, list every location and the governing scope constraint in `residualRisks`, and leave its code unchanged.",
    " Reject a P0 or P1 finding only with a reason that names why the defect is unreachable or already covered by another adopted finding.",
  )
  .replace(
    " Before persisting, trace every input the specification consumes to an artefact at the frozen base or an explicit specified change that creates it before use; treat an unresolved required input as premise collapse and ask a blocking Inbox question with the governing request and tree evidence.",
    "",
  )
  .replace(
    "Before committing slices, verify that every consumed input exists at the frozen base or is created before use by the same slice or a prerequisite slice; resolve missing creation within the specification of record, and escalate a premise that requires changing it. ",
    "",
  )
  .replace(
    "For each Changes item, check whether its premise still holds. Also trace every\ninput a Changes or Acceptance item consumes — table, column, field, fixture,\nexport — to a source at HEAD or to an explicit Changes item, including the same\none, that creates it before use; an untraceable input is a premise collapse. If\nthe thing a Changes item exists to change is gone or already delivered, or an\ninput is untraceable, collect concrete tree evidence and call",
    "For each Changes item, check whether its premise still holds. If the thing it\nexists to change is gone or already delivered, collect concrete tree evidence\nand call",
  )
  .replace(
    "every consumed input existing at the frozen base or created before use by the same slice or a prerequisite slice, ",
    "",
  );

/**
 * Restore the `hazard` tier Agent name the revalidation prompt carried before
 * the tier's canonical role moved to `senior-dev-sol-high` (2026-09-19). Every
 * registered generation predates that rollover, so the older fixtures apply
 * it before reconstructing their earlier prompt bytes.
 */
export const restorePreSolHighHazardTierPrompt = (prompt: string): string => restorePreDefectClassSweepPrompt(prompt)
  .replace(
    "The current Agent is\n  `senior-dev-sol-high`. An Astra role is used only when the user names it for\n  this dispatch after a Sol high attempt actually fails; it is never a default.",
    "The current Agent is\n  `senior-dev-astra-medium`.",
  );

/**
 * Restore the `hard` tier Agent name the revalidation prompt carried before the
 * tier's canonical role moved to `senior-dev-sol-high` (2026-09-09). Every
 * registered generation predates that rollover, so the older fixtures apply
 * it first.
 */
export const restorePreSolHighHardTierPrompt = (prompt: string): string => restorePreSolHighHazardTierPrompt(prompt)
  .replace("The current Agent is\n  `senior-dev-sol-high`.", "The current Agent is\n  `senior-dev-astra-low`.");

/**
 * Restore the Regression bytes retired by the frozen-baseline rollover before
 * applying older fixture transformations. Every historical generation digest
 * authenticates the whole template, including this mechanical handoff.
 */
export const restorePreFrozenRegressionPrompt = (prompt: string): string => restorePreSolHighHardTierPrompt(prompt)
  .replace(
    "The platform script owns prepare-time refresh/merge, gate dispatch and retries,\nverdict transcription, and the final `regression-verification-v2` task output.\nMerge readiness checks the latest target under the Merge Lease before authorizing\nthe exact merge.",
    "The platform script owns refresh/merge, merge-lease operations, gate dispatch\nand retries, verdict transcription, and the final `regression-verification-v2`\ntask output.",
  )
  .replace(
    "finding id in every present report, and verify that the approved specification\nis preserved without a new defect. Run focused regressions for the findings and\nchanged behavior; the Merge gate owns full workspace and repository suites.",
    "finding id in every present report, rerun focused regressions, and verify that the approved\nspecification is preserved without a new defect.",
  )
  .replace(
    "A finalize exit 0 means the script persisted `pass` or `gate-fail` for the head\nand baseline frozen by prepare; report the bounded `REGRESSION FINALIZE` status\nline it printed. Any nonzero script exit fails the run loudly.\nThe script persists the one allowed v2 outcome; never call `task_output` for\nthis step or write a report file.",
    "A finalize exit 0 means the script persisted exactly one of `pass`, `gate-fail`,\nor `refresh-conflict`; report the bounded `REGRESSION FINALIZE` status line it\nprinted. A finalize exit 77 means the script integrated a newer target head\noutside the lease. Repeat the full semantic verification against that refreshed\ntree, then run either `review-fail` or `finalize` again. Any other nonzero script\nexit fails the run loudly. The script persists the one allowed v2 outcome;\nnever call `task_output` for this step or write a report file.",
  );

export const restorePreOptionalReviewPrompt = (prompt: string): string => restorePreFrozenRegressionPrompt(prompt)
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
export const restorePreTierRevalidationPrompt = (prompt: string): string => restorePreDefectClassSweepPrompt(prompt)
  .replace(/After checking the brief and the tree, judge the implementation tier\.[\s\S]*?(?=After the PATCH succeeds)/u, "")
  .replace('"schemaVersion":2', '"schemaVersion":1')
  .replace(',"route":{"tier":"default|frontend|hard|hazard","reason":"<criterion that applies, or why none does>"}', "");
