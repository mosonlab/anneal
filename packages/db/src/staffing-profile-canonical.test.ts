import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_STAFFING_PROFILE_NAME,
  MERGE_TAIL_REPAIR_AGENT_ROLE,
  MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES,
  canonicalMergeTailRepairAgentRole,
} from "./staffing-profile-canonical.js";
import { DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME } from "./agent-contract.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";

test("the three active canonical templates use the Luna Max repair role", () => {
  assert.equal(CANONICAL_STAFFING_PROFILE_NAME, "Default");
  assert.equal(MERGE_TAIL_REPAIR_AGENT_ROLE, "senior-dev-luna-max");
  assert.deepEqual(MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES, [
    INTEGRATOR_TEMPLATE_NAME,
    DIRECT_TEMPLATE_NAME,
    PR_TEMPLATE_NAME,
  ]);
  for (const templateName of MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES) {
    assert.equal(canonicalMergeTailRepairAgentRole(templateName), MERGE_TAIL_REPAIR_AGENT_ROLE);
  }
});

test("custom and retired template names have no source-owned repair role", () => {
  assert.equal(canonicalMergeTailRepairAgentRole("operator-workflow"), null);
  assert.equal(canonicalMergeTailRepairAgentRole(`${DIRECT_TEMPLATE_NAME}-legacy-v1`), null);
});
