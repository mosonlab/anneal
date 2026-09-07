/**
 * Carrying staffing profiles across a canonical rollover.
 *
 * A rollover renames the old TaskTemplate row and writes the new graph into a
 * *new* row, so nothing follows the template automatically: profiles are rows
 * pointing at the old id. This module decides, purely, what the new row's
 * profiles should contain, and what could not be carried so the caller can say
 * so in its sync report instead of silently reassigning a step.
 *
 * Matching is on the exact `outputKind` first, because that is the key an
 * entry means (`foo` and `foo-v2` are distinct steps of a custom graph). The
 * `-vN` fallback exists only here, for the one case the exact key cannot
 * survive: a canonical step whose output protocol version moved between the
 * retired graph and the new one. The suffix rule is restated rather than taken
 * from `stepRole`, whose answer is a role or null and therefore says nothing
 * about a kind no canonical role owns.
 */

/** The `-vN` output-protocol suffix, matching `step-role.ts`'s rule. */
const VERSION_SUFFIX = /-(v[1-9]\d*)$/u;

export const staffingOutputKindBase = (outputKind: string): string =>
  outputKind.replace(VERSION_SUFFIX, "");

export type StaffingProfileCarryEntry = Readonly<{
  outputKind: string;
  assigneeAgentId: string | null;
  include: boolean | null;
}>;

export type StaffingProfileCarrySource = Readonly<{
  name: string;
  isDefault: boolean;
  entries: readonly StaffingProfileCarryEntry[];
}>;

export type StaffingProfileCarryDrop = Readonly<{
  profileName: string;
  outputKind: string;
  /** `unknown-kind`: the new graph declares no step for it, exactly or by base.
   *  `ambiguous-kind`: several new steps share its base kind, so a fallback
   *  would have to guess which one the operator meant. */
  reason: "unknown-kind" | "ambiguous-kind";
}>;

export type StaffingProfileCarryPlan = Readonly<{
  profiles: readonly StaffingProfileCarrySource[];
  dropped: readonly StaffingProfileCarryDrop[];
  /** One line per dropped entry, for the caller's sync report. */
  reportLines: readonly string[];
}>;

const dropLine = (drop: StaffingProfileCarryDrop): string => (
  drop.reason === "ambiguous-kind"
    ? `Staffing profile ${drop.profileName}: entry ${drop.outputKind} dropped; the new graph has several steps whose output kind reduces to ${staffingOutputKindBase(drop.outputKind)}`
    : `Staffing profile ${drop.profileName}: entry ${drop.outputKind} dropped; the new graph has no step producing it`
);

/** One step of the graph a carry lands on: its kind, and whether the chain may
 *  skip it. Optionality travels with the kind because it decides what an
 *  entry's `include` may be. */
export type StaffingProfileCarryTarget = Readonly<{ outputKind: string; optional: boolean }>;

/**
 * Decide what each profile of a retired template row becomes on the new row.
 *
 * `targetSteps` is the new graph, in step order. Entries that match nothing are
 * dropped and reported; profile names, default membership and the surviving
 * entries' assignees are carried unchanged.
 * `renamedKinds` is supplied only by the canonical installer for registered
 * output-kind renames; exact matches still own their destination first.
 *
 * `include` is carried against the *target's* optionality, not the source's
 * (R3): a step that became optional gains the default opinion `true`, one that
 * stopped being optional loses its flag, and every optional step of the new
 * graph ends with a boolean even if the retired profile never named it.
 */
export const planStaffingProfileCarry = (
  profiles: readonly StaffingProfileCarrySource[],
  targetSteps: readonly StaffingProfileCarryTarget[],
  renamedKinds: Readonly<Record<string, string>> = {},
): StaffingProfileCarryPlan => {
  const targetOutputKinds = targetSteps.map((step) => step.outputKind);
  const optionalTargets = new Set(targetSteps.filter((step) => step.optional).map((step) => step.outputKind));
  const targets = new Set(targetOutputKinds);
  const byBase = new Map<string, string[]>();
  for (const kind of targetOutputKinds) {
    const base = staffingOutputKindBase(kind);
    byBase.set(base, [...byBase.get(base) ?? [], kind]);
  }
  const carryEntry = (entry: StaffingProfileCarryEntry, outputKind: string): StaffingProfileCarryEntry => ({
    outputKind,
    assigneeAgentId: entry.assigneeAgentId,
    include: optionalTargets.has(outputKind) ? entry.include ?? true : null,
  });

  const carried: StaffingProfileCarrySource[] = [];
  const dropped: StaffingProfileCarryDrop[] = [];
  for (const profile of profiles) {
    const entries: StaffingProfileCarryEntry[] = [];
    // Exact matches are settled first for the whole profile: a normalised
    // fallback must never take a target another entry already owns by name.
    const claimed = new Set(
      profile.entries.map((entry) => entry.outputKind).filter((kind) => targets.has(kind)),
    );
    for (const entry of profile.entries) {
      if (targets.has(entry.outputKind)) {
        entries.push(carryEntry(entry, entry.outputKind));
        continue;
      }
      const renamedKind = renamedKinds[entry.outputKind];
      const sameBase = renamedKind !== undefined
        ? targetOutputKinds.filter((kind) => kind === renamedKind)
        : byBase.get(staffingOutputKindBase(entry.outputKind)) ?? [];
      const candidates = sameBase.filter((kind) => !claimed.has(kind));
      if (candidates.length === 1) {
        claimed.add(candidates[0]!);
        entries.push(carryEntry(entry, candidates[0]!));
        continue;
      }
      dropped.push({
        profileName: profile.name,
        outputKind: entry.outputKind,
        reason: sameBase.length === 0 ? "unknown-kind" : "ambiguous-kind",
      });
    }
    const named = new Set(entries.map((entry) => entry.outputKind));
    for (const outputKind of optionalTargets) {
      if (named.has(outputKind)) continue;
      entries.push({ outputKind, assigneeAgentId: null, include: true });
    }
    carried.push({ name: profile.name, isDefault: profile.isDefault, entries });
  }

  return { profiles: carried, dropped, reportLines: dropped.map(dropLine) };
};
