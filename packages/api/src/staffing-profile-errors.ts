import type { RefusalStatus } from "./refusal-status.js";

/**
 * Stable refusal codes for the staffing-profile surface, each declared with the
 * HTTP status family it is answered with. The code union is derived from this
 * table, so a code cannot exist without a status family.
 *
 * Separate from the template-authoring and instantiation families on purpose:
 * a staffing profile is an operator-owned plan over an existing graph, so its
 * refusals are about who may run a step, not about whether the graph or the
 * chain is well formed.
 */
export const staffingProfileRefusalStatus = {
  staffing_profile_template_not_found: 404,
  staffing_profile_not_found: 404,
  staffing_profile_name_taken: 409,
  staffing_profile_default_delete_refused: 409,
  agent_referenced_by_staffing_profiles: 409,
  staffing_profile_entry_duplicate: 422,
  staffing_profile_unknown_output_kind: 422,
  staffing_profile_step_not_agent: 422,
  staffing_profile_step_control_plane: 400,
  staffing_profile_include_not_optional: 422,
  staffing_profile_agent_not_found: 422,
  staffing_profile_agent_archived: 422,
  staffing_profile_repo_not_found: 422,
  staffing_profile_repo_required: 422,
  staffing_profile_missing_repo_grant: 422,
  staffing_profile_integrator_binding: 422,
  staffing_profile_compound_implementation: 422,
} as const satisfies Record<string, RefusalStatus>;

export type StaffingProfileRefusalCode = keyof typeof staffingProfileRefusalStatus;

/**
 * The refusal raised when an Agent may not be archived because a staffing
 * profile still names it (R6). Declared here rather than in the agents route so
 * both sides — the archive route and the profile writer that keeps the
 * reference alive — name the same constant.
 */
export const AGENT_REFERENCED_BY_STAFFING_PROFILES = "agent_referenced_by_staffing_profiles" as const;

/** A stable, machine-readable refusal raised while reading or saving a staffing profile. */
export class StaffingProfileRefusal extends Error {
  constructor(
    readonly code: StaffingProfileRefusalCode,
    message: string,
    /** The exact output kind the refusal is about, when it is about one. */
    readonly outputKind?: string,
  ) {
    super(message);
    this.name = "StaffingProfileRefusal";
  }
}

export const isStaffingProfileRefusal = (
  error: unknown,
): error is StaffingProfileRefusal => error instanceof StaffingProfileRefusal;

/** The response body a refusal renders to, without its status. */
export const staffingProfileRefusalBody = (
  error: StaffingProfileRefusal,
): { error: string; code: StaffingProfileRefusalCode; outputKind?: string } => ({
  error: error.message,
  code: error.code,
  ...(error.outputKind === undefined ? {} : { outputKind: error.outputKind }),
});

export const staffingProfileRefusalStatusFor = (
  error: StaffingProfileRefusal,
): RefusalStatus => staffingProfileRefusalStatus[error.code];
