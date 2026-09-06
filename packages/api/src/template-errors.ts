import type { RefusalStatus } from "./refusal-status.js";

/**
 * Every refusal raised while materialising a template chain, each declared with
 * the HTTP status family it is answered with. The code union is derived from
 * this table, so a code cannot exist without a status family.
 */
export const templateInstantiationRefusalStatus = {
  after_task_already_done: 400,
  after_task_archived: 400,
  after_task_not_chained: 400,
  after_task_not_found: 400,
  after_task_not_terminal: 400,
  dispatch_conflicts_with_auto_start: 400,
  gates_merge_step_absent: 400,
  gates_spec_step_absent: 400,
  implementation_route_agent_renamed: 400,
  implementation_route_conflicts_with_step_override: 400,
  implementation_route_malformed: 400,
  implementation_route_template_unsupported: 400,
  instantiate_name_invalid: 400,
  instantiate_name_required: 400,
  repo_not_found: 400,
  staffing_profile_agent_archived: 400,
  staffing_profile_agent_foreign: 400,
  staffing_profile_agent_not_found: 400,
  staffing_profile_compound_implementation: 400,
  staffing_profile_conflicts_with_selection: 400,
  staffing_profile_integrator_binding: 400,
  staffing_profile_line_malformed: 400,
  staffing_profile_missing_repo_grant: 400,
  staffing_profile_not_found: 400,
  staffing_profile_step_not_agent: 400,
  step_override_agent_archived: 400,
  step_override_agent_not_found: 400,
  step_override_compound_implementation: 400,
  step_override_include_not_optional: 400,
  step_override_integrator_binding: 400,
  step_override_invalid_key: 400,
  step_override_missing_repo_grant: 400,
  step_override_step_not_agent: 400,
  step_override_too_many: 400,
  step_override_unknown_step: 400,
  template_agent_repo_grant_missing: 400,
  template_base_reference_missing: 400,
  template_base_reference_not_earlier: 400,
  template_branch_invalid: 400,
  template_compound_implementation_assignee_invalid: 400,
  template_first_step_not_agent: 400,
  template_has_no_instantiable_steps: 400,
  template_has_no_steps: 400,
  template_integrator_binding_invalid: 400,
  template_not_found: 400,
  template_step_agent_archived: 400,
  template_step_agent_missing: 400,
  template_variables_missing: 400,
  template_variables_unknown: 400,
} as const satisfies Record<string, RefusalStatus>;

export type TemplateInstantiationRefusalCode = keyof typeof templateInstantiationRefusalStatus;

/** A stable, machine-readable refusal raised while materialising a template chain. */
export class TemplateInstantiationRefusal extends Error {
  constructor(
    readonly code: TemplateInstantiationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "TemplateInstantiationRefusal";
  }
}

export const isTemplateInstantiationRefusal = (
  error: unknown,
): error is TemplateInstantiationRefusal => error instanceof TemplateInstantiationRefusal;
