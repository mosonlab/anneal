import assert from "node:assert/strict";
import test from "node:test";

import {
  putRecommendedChoiceFirst,
  recommendMergeApproval,
  recommendMergeStop,
} from "./inbox-recommendation.js";

const currentApproval = () => ({
  checks: [{ name: "ci/build", conclusion: "SUCCESS" }],
  mergeStateStatus: "CLEAN",
  pullRequestBaseRef: "main",
  regressionBaseSha: "b".repeat(40),
  readBaseRef: "main",
  currentDefaultBranch: "main",
  currentDefaultBranchSha: "b".repeat(40),
});

test("merge approval recommends approve only for passing checks, CLEAN state, and the current default base", () => {
  const result = recommendMergeApproval(currentApproval());

  assert.equal(result.kind, "choice");
  assert.equal(result.choiceId, "approve");
  assert.match(result.line, /^推荐：批准/u);
});

test("an UNSTABLE approval rejects on a failed optional check when there are no required checks", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    checks: [],
    additionalChecks: [{ name: "ci/optional", conclusion: "FAILURE" }],
    mergeStateStatus: "UNSTABLE",
  });

  assert.equal(result.choiceId, "reject");
  assert.match(result.line, /ci\/optional（FAILURE）/u);
});

test("a pending optional check prevents approval when there are no required checks", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    checks: [],
    additionalChecks: [{ name: "ci/optional", conclusion: "PENDING:IN_PROGRESS" }],
  });

  assert.equal(result.kind, "wait");
  assert.notEqual(result.choiceId, "approve");
  assert.match(result.line, /以 GitHub 当前状态为准/u);
});

test("an empty required-check set uses accurate approval wording", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    checks: [],
    additionalChecks: [{ name: "ci/optional", conclusion: "SUCCESS" }],
  });

  assert.equal(result.choiceId, "approve");
  assert.match(result.line, /检查全部通过（本仓库无必需检查）/u);
  assert.doesNotMatch(result.line, /必需检查全部通过/u);
});

test("NEUTRAL and SKIPPED conclusions are successful checks", () => {
  for (const conclusion of ["NEUTRAL", "SKIPPED"]) {
    const result = recommendMergeApproval({
      ...currentApproval(),
      checks: [],
      additionalChecks: [{ name: "ci/optional", conclusion }],
    });
    assert.equal(result.choiceId, "approve", conclusion);
  }
});

test("approval is not recommended when the rollup does not match the current head", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    checkRollupMatchesHead: false,
  });

  assert.equal(result.kind, "none");
  assert.equal(result.choiceId, null);
  assert.match(result.line, /不属于当前 PR head/u);
});

test("merge approval recommends reject and names every failed or missing check", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    checks: [
      { name: "ci/build", conclusion: "FAILURE" },
      { name: "lint", conclusion: "TIMED_OUT" },
      { name: "security", conclusion: "ABSENT" },
    ],
  });

  assert.equal(result.choiceId, "reject");
  assert.match(result.line, /ci\/build（FAILURE）/u);
  assert.match(result.line, /lint（TIMED_OUT）/u);
  assert.match(result.line, /security（ABSENT）/u);
});

test("merge approval recommends reject when Regression ran against an old base", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    regressionBaseSha: "c".repeat(40),
  });

  assert.equal(result.choiceId, "reject");
  assert.match(result.line, /Regression base.*落后/u);
  assert.match(result.line, /refresh-conflict/u);
});

test("merge approval recommends reject when the PR targets a non-default branch", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    pullRequestBaseRef: "release",
  });

  assert.equal(result.choiceId, "reject");
  assert.match(result.line, /不再是当前默认分支 main/u);
});

test("merge approval recommends waiting when required checks are still running", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    checks: [
      { name: "ci/build", conclusion: "SUCCESS" },
      { name: "test", conclusion: "PENDING:IN_PROGRESS" },
    ],
  });

  assert.equal(result.kind, "wait");
  assert.equal(result.choiceId, null);
  assert.match(result.line, /^推荐：等待 CI，先不操作/u);
});

test("a DIRTY merge confirmation recommends reject for the refresh-conflict path", () => {
  const result = recommendMergeApproval({
    ...currentApproval(),
    mergeStateStatus: "DIRTY",
  });

  assert.equal(result.choiceId, "reject");
  assert.match(result.line, /DIRTY/u);
  assert.match(result.line, /refresh-conflict/u);
});

test("merge approval makes no recommendation when evidence cannot prove the base is current or CLEAN", () => {
  const baseUnknown = recommendMergeApproval({
    ...currentApproval(),
    regressionBaseSha: null,
  });
  const stateUnknown = recommendMergeApproval({
    ...currentApproval(),
    mergeStateStatus: "BLOCKED",
  });

  assert.equal(baseUnknown.kind, "none");
  assert.match(baseUnknown.line, /^无推荐：/u);
  assert.equal(stateUnknown.kind, "none");
  assert.match(stateUnknown.line, /BLOCKED/u);
});

test("UNSTABLE merge stops recommend re-authorization and list failed checks", () => {
  const result = recommendMergeStop("check-failure-or-absence", JSON.stringify({
    mergeStateStatus: "UNSTABLE",
    failedChecks: ["ci/build", "lint"],
  }));

  assert.equal(result.choiceId, "re-authorize");
  assert.match(result.line, /mergeState 为 UNSTABLE/u);
  assert.match(result.line, /ci\/build、lint/u);
  assert.match(result.line, /确认卡上建议打回/u);
});

test("a DIRTY merge stop recommends new evidence, then rejection through refresh-conflict", () => {
  const result = recommendMergeStop("non-clean-mergeability", JSON.stringify({
    mergeStateStatus: "DIRTY",
    authorized: "a".repeat(40),
    observed: "b".repeat(40),
  }));

  assert.equal(result.choiceId, "re-authorize");
  assert.match(result.line, /DIRTY/u);
  assert.match(result.line, /确认卡上建议打回/u);
  assert.match(result.line, /refresh-conflict/u);
});

test("a CONFLICTING mergeability stop recommends the same refresh-conflict recovery", () => {
  const result = recommendMergeStop("non-clean-mergeability", JSON.stringify({
    mergeable: "CONFLICTING",
    observed: "b".repeat(40),
    authorized: "a".repeat(40),
  }));

  assert.equal(result.choiceId, "re-authorize");
  assert.match(result.line, /CONFLICTING/u);
  assert.match(result.line, /refresh-conflict/u);
});

test("other merge stops recommend investigation", () => {
  const result = recommendMergeStop("api-error", JSON.stringify({ reason: "read failed" }));

  assert.equal(result.choiceId, null);
  assert.match(result.line, /推荐：需调查/u);
});

test("the recommended fixed choice is first and is labeled without changing its id", () => {
  const choices = putRecommendedChoiceFirst([
    { id: "approve", label: "批准并合并" },
    { id: "reject", label: "打回上一步" },
  ], "reject");

  assert.deepEqual(choices, [
    { id: "reject", label: "打回上一步（推荐）" },
    { id: "approve", label: "批准并合并" },
  ]);
});
