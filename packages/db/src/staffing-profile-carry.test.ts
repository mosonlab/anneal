import assert from "node:assert/strict";
import test from "node:test";

import {
  planStaffingProfileCarry,
  staffingOutputKindBase,
  type StaffingProfileCarrySource,
  type StaffingProfileCarryTarget,
} from "./staffing-profile-carry.js";

/** The target graph, written as the kinds a chain must run. */
const required = (...outputKinds: string[]): StaffingProfileCarryTarget[] =>
  outputKinds.map((outputKind) => ({ outputKind, optional: false }));

const optional = (outputKind: string): StaffingProfileCarryTarget => ({ outputKind, optional: true });

const profile = (
  name: string,
  entries: StaffingProfileCarrySource["entries"],
  isDefault = true,
): StaffingProfileCarrySource => ({ name, isDefault, entries });

test("the base kind strips only a -vN output-protocol suffix", () => {
  assert.equal(staffingOutputKindBase("implementation"), "implementation");
  assert.equal(staffingOutputKindBase("implementation-v2"), "implementation");
  assert.equal(staffingOutputKindBase("implementation-v12"), "implementation");
  // Not a protocol version: v0, a bare v, and a non-terminal match stay whole.
  assert.equal(staffingOutputKindBase("implementation-v0"), "implementation-v0");
  assert.equal(staffingOutputKindBase("implementation-v"), "implementation-v");
  assert.equal(staffingOutputKindBase("implementation-v2-notes"), "implementation-v2-notes");
});

test("exact output kinds carry unchanged, with names and default membership", () => {
  const plan = planStaffingProfileCarry(
    [
      profile("Default", [
        { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
        { outputKind: "implementation", assigneeAgentId: "agent-impl", include: null },
        { outputKind: "blind-findings", assigneeAgentId: null, include: false },
      ]),
      profile("Fast", [{ outputKind: "spec", assigneeAgentId: "agent-other", include: null }], false),
    ],
    [...required("spec", "implementation"), optional("blind-findings")],
  );

  assert.deepEqual(plan.profiles, [
    {
      name: "Default",
      isDefault: true,
      entries: [
        { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
        { outputKind: "implementation", assigneeAgentId: "agent-impl", include: null },
        { outputKind: "blind-findings", assigneeAgentId: null, include: false },
      ],
    },
    {
      name: "Fast",
      isDefault: false,
      entries: [
        { outputKind: "spec", assigneeAgentId: "agent-other", include: null },
        // Named nothing about the optional step, so it carries the default.
        { outputKind: "blind-findings", assigneeAgentId: null, include: true },
      ],
    },
  ]);
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(plan.reportLines, []);
});

test("a kind whose protocol version moved is carried by its base kind", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [
      { outputKind: "regression-verification", assigneeAgentId: "agent-regression", include: null },
    ])],
    required("regression-verification-v2"),
  );

  assert.deepEqual(plan.profiles[0]!.entries, [
    { outputKind: "regression-verification-v2", assigneeAgentId: "agent-regression", include: null },
  ]);
  assert.deepEqual(plan.dropped, []);
});

test("an exact match keeps its target away from another entry's fallback", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [
      { outputKind: "findings-v2", assigneeAgentId: "agent-exact", include: null },
      { outputKind: "findings", assigneeAgentId: "agent-fallback", include: null },
    ])],
    required("findings-v2"),
  );

  assert.deepEqual(plan.profiles[0]!.entries, [
    { outputKind: "findings-v2", assigneeAgentId: "agent-exact", include: null },
  ]);
  assert.deepEqual(plan.dropped, [
    { profileName: "Default", outputKind: "findings", reason: "ambiguous-kind" },
  ]);
});

test("several new steps sharing one base kind refuse to guess", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [{ outputKind: "notes", assigneeAgentId: "agent-notes", include: null }])],
    required("notes-v2", "notes-v3"),
  );

  assert.deepEqual(plan.profiles[0]!.entries, []);
  assert.deepEqual(plan.dropped, [
    { profileName: "Default", outputKind: "notes", reason: "ambiguous-kind" },
  ]);
  assert.match(plan.reportLines[0]!, /several steps whose output kind reduces to notes/u);
});

test("an entry the new graph does not produce is dropped and reported", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [
      { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
      { outputKind: "retired-kind", assigneeAgentId: "agent-gone", include: true },
    ])],
    required("spec"),
  );

  assert.deepEqual(plan.profiles[0]!.entries, [
    { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
  ]);
  assert.deepEqual(plan.dropped, [
    { profileName: "Default", outputKind: "retired-kind", reason: "unknown-kind" },
  ]);
  assert.deepEqual(plan.reportLines, [
    "Staffing profile Default: entry retired-kind dropped; the new graph has no step producing it",
  ]);
});

test("a template with no profiles carries nothing and reports nothing", () => {
  assert.deepEqual(planStaffingProfileCarry([], required("spec")), {
    profiles: [],
    dropped: [],
    reportLines: [],
  });
});

test("include is carried against the target's optionality, both directions", () => {
  // The retired graph made this step optional and the profile skipped it; the
  // new graph requires it, so the flag has nothing left to decide.
  const nowRequired = planStaffingProfileCarry(
    [profile("Default", [{ outputKind: "blind-findings", assigneeAgentId: "agent-blind", include: false }])],
    required("blind-findings"),
  );
  assert.deepEqual(nowRequired.profiles[0]!.entries, [
    { outputKind: "blind-findings", assigneeAgentId: "agent-blind", include: null },
  ]);

  // The other direction: a step that became optional gains the default opinion
  // rather than being stored with none.
  const nowOptional = planStaffingProfileCarry(
    [profile("Default", [{ outputKind: "blind-findings", assigneeAgentId: "agent-blind", include: null }])],
    [optional("blind-findings")],
  );
  assert.deepEqual(nowOptional.profiles[0]!.entries, [
    { outputKind: "blind-findings", assigneeAgentId: "agent-blind", include: true },
  ]);
});

test("every optional step of the new graph ends with a boolean the profile never named", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [{ outputKind: "spec", assigneeAgentId: "agent-spec", include: null }])],
    [...required("spec"), optional("blind-findings")],
  );

  assert.deepEqual(plan.profiles[0]!.entries, [
    { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
    { outputKind: "blind-findings", assigneeAgentId: null, include: true },
  ]);
  assert.deepEqual(plan.dropped, []);
});


test("canonical review rename carries staffing without mutating the retired profile", () => {
  const source = profile("Review", [{ outputKind: "sol-findings", assigneeAgentId: "operator-agent", include: null }]);
  const before = JSON.stringify(source);
  const plan = planStaffingProfileCarry([source], required("review-findings"), { "sol-findings": "review-findings" });
  assert.deepEqual(plan.profiles[0]!.entries, [{ outputKind: "review-findings", assigneeAgentId: "operator-agent", include: null }]);
  assert.deepEqual(plan.dropped, []);
  assert.equal(JSON.stringify(source), before);
  const collision = planStaffingProfileCarry([
    profile("Both", [...source.entries, { outputKind: "review-findings", assigneeAgentId: "exact-agent", include: null }]),
  ], required("review-findings"), { "sol-findings": "review-findings" });
  assert.equal(collision.profiles[0]!.entries[0]!.assigneeAgentId, "exact-agent");
  assert.equal(collision.dropped[0]!.reason, "ambiguous-kind");
});
