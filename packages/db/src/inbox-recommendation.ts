/** Pure recommendations for platform-authored Inbox cards. */

export const RECOMMENDED_LABEL_SUFFIX = "（推荐）";

export type InboxChoice = { id: string; label: string };

export const putRecommendedChoiceFirst = <T extends InboxChoice>(
  choices: readonly T[],
  recommendedId: string | null,
): T[] => {
  if (!recommendedId) return [...choices];
  const recommended = choices.find((choice) => choice.id === recommendedId);
  if (!recommended) return [...choices];
  const label = recommended.label.endsWith(RECOMMENDED_LABEL_SUFFIX)
    ? recommended.label
    : `${recommended.label}${RECOMMENDED_LABEL_SUFFIX}`;
  return [
    { ...recommended, label },
    ...choices.filter((choice) => choice.id !== recommendedId),
  ];
};

export type MergeApprovalRecommendationInput = {
  checks: Array<{ name: string; conclusion: string }>;
  additionalChecks?: Array<{ name: string; conclusion: string }>;
  checkRollupMatchesHead?: boolean;
  mergeStateStatus: string | null;
  pullRequestBaseRef: string | null;
  regressionBaseSha: string | null;
  readBaseRef: string;
  currentDefaultBranch: string | null;
  currentDefaultBranchSha: string | null;
};

export type MergeApprovalRecommendation = {
  kind: "choice" | "wait" | "none";
  choiceId: "approve" | "reject" | null;
  line: string;
};

const isPendingConclusion = (conclusion: string): boolean => {
  const normalized = conclusion.toUpperCase();
  return normalized.startsWith("PENDING:")
    || ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "STARTING"].includes(normalized);
};

const isSuccessfulConclusion = (conclusion: string): boolean => (
  ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion.toUpperCase())
);

const displayChecks = (checks: Array<{ name: string; conclusion: string }>): string => checks
  .map(({ name, conclusion }) => `${name}（${conclusion}）`)
  .join("、");

/**
 * Recommend from the evidence the card already shows. A branch name alone is
 * not enough to approve: the passing Regression's base must still equal the
 * live head of the configured default branch.
 */
export const recommendMergeApproval = (
  input: MergeApprovalRecommendationInput,
): MergeApprovalRecommendation => {
  if (input.checkRollupMatchesHead === false) {
    return {
      kind: "none",
      choiceId: null,
      line: "无推荐：检查状态不属于当前 PR head，需重新读取证据。",
    };
  }

  const allChecks = [...input.checks, ...(input.additionalChecks ?? [])];
  const failedChecks = allChecks.filter(({ conclusion }) => (
    !isSuccessfulConclusion(conclusion) && conclusion.toUpperCase() !== "ABSENT" && !isPendingConclusion(conclusion)
  ));
  const absentChecks = input.checks.filter(({ conclusion }) => conclusion.toUpperCase() === "ABSENT");
  if (failedChecks.length > 0 || absentChecks.length > 0) {
    const checks = [...failedChecks, ...absentChecks];
    return {
      kind: "choice",
      choiceId: "reject",
      line: `推荐：打回 —— 未通过或缺失的检查：${displayChecks(checks)}。`,
    };
  }

  const branchMismatch = input.currentDefaultBranch !== null
    && (input.readBaseRef !== input.currentDefaultBranch
      || input.pullRequestBaseRef !== input.currentDefaultBranch);
  const baseShaMismatch = input.currentDefaultBranch !== null
    && input.readBaseRef === input.currentDefaultBranch
    && input.regressionBaseSha !== null
    && input.currentDefaultBranchSha !== null
    && input.regressionBaseSha !== input.currentDefaultBranchSha;
  if (branchMismatch || baseShaMismatch) {
    const reason = branchMismatch
      ? input.readBaseRef !== input.currentDefaultBranch
        ? `链的目标分支 ${input.readBaseRef} 不是当前默认分支 ${input.currentDefaultBranch ?? "UNKNOWN"}`
        : `PR base ${input.pullRequestBaseRef ?? "UNKNOWN"} 不再是当前默认分支 ${input.currentDefaultBranch ?? "UNKNOWN"}`
      : `Regression base ${input.regressionBaseSha} 已落后于当前默认分支 ${input.currentDefaultBranchSha}`;
    return {
      kind: "choice",
      choiceId: "reject",
      line: `推荐：打回 —— ${reason}；按 runbook 重新运行 Regression 并处理 refresh-conflict。`,
    };
  }

  const pendingChecks = allChecks.filter(({ conclusion }) => isPendingConclusion(conclusion));
  if (pendingChecks.length > 0) {
    return {
      kind: "wait",
      choiceId: null,
      line: `推荐：等待 CI，先不操作 —— 尚有检查在运行：${pendingChecks.map(({ name }) => name).join("、")}；以 GitHub 当前状态为准。`,
    };
  }

  if (input.mergeStateStatus === "DIRTY") {
    return {
      kind: "choice",
      choiceId: "reject",
      line: "推荐：打回 —— mergeState 为 DIRTY，base 存在冲突；让 Regression 的 refresh-conflict 路径处理。",
    };
  }

  const baseIsCurrent = input.currentDefaultBranch !== null
    && input.readBaseRef === input.currentDefaultBranch
    && input.pullRequestBaseRef === input.currentDefaultBranch
    && input.regressionBaseSha !== null
    && input.currentDefaultBranchSha !== null
    && input.regressionBaseSha === input.currentDefaultBranchSha;
  if (input.mergeStateStatus === "CLEAN" && baseIsCurrent) {
    const passingChecks = input.checks.length === 0
      ? "检查全部通过（本仓库无必需检查）"
      : "必需检查全部通过";
    return {
      kind: "choice",
      choiceId: "approve",
      line: `推荐：批准并合并 —— ${passingChecks}、合并状态为 CLEAN，base 与当前默认分支一致。`,
    };
  }

  const missingEvidence = input.currentDefaultBranch === null
    ? "缺少当前默认分支信息"
    : input.regressionBaseSha === null || input.currentDefaultBranchSha === null
      ? "缺少 Regression base 或当前默认分支的 commit SHA"
      : `合并状态为 ${input.mergeStateStatus ?? "UNKNOWN"}`;
  return {
    kind: "none",
    choiceId: null,
    line: `无推荐：${missingEvidence}，需要先调查后再决定。`,
  };
};

type EvidenceRecord = Record<string, unknown>;

const parseRecord = (evidence: string): EvidenceRecord | null => {
  try {
    const value: unknown = JSON.parse(evidence);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as EvidenceRecord
      : null;
  } catch {
    return null;
  }
};

const stopFailedChecks = (record: EvidenceRecord | null): string[] => {
  const explicit = record?.failedChecks;
  if (Array.isArray(explicit)) {
    return explicit.filter((name): name is string => typeof name === "string" && name.length > 0);
  }
  const reason = record?.reason;
  if (typeof reason !== "string") return [];
  const match = reason.match(/required (?:check|status) (.+?) (?:concluded|is) (?!SUCCESS\b|PENDING\b|EXPECTED\b)([A-Z_]+)/u);
  return match?.[1] ? [match[1]] : [];
};

export type MergeStopRecommendation = {
  choiceId: "re-authorize" | null;
  line: string;
};

/** Recommend only the two evidence-backed mechanical recovery paths in ADR-0011. */
export const recommendMergeStop = (
  condition: string,
  evidence: string,
): MergeStopRecommendation => {
  const record = parseRecord(evidence);
  const mergeStateStatus = record?.mergeStateStatus;
  const failedChecks = stopFailedChecks(record);
  if ((condition === "check-failure-or-absence" || condition === "non-clean-mergeability")
    && mergeStateStatus === "UNSTABLE"
    && failedChecks.length > 0) {
    return {
      choiceId: "re-authorize",
      line: `推荐：重新授权 —— mergeState 为 UNSTABLE，失败检查：${failedChecks.join("、")}；新证据确认卡上建议打回。`,
    };
  }
  const mergeable = record?.mergeable;
  const hasConflict = mergeStateStatus === "DIRTY" || mergeable === "CONFLICTING";
  if (condition === "non-clean-mergeability" && hasConflict) {
    return {
      choiceId: "re-authorize",
      line: mergeStateStatus === "DIRTY"
        ? "推荐：重新授权 —— DIRTY 表示存在冲突；新证据确认卡上建议打回，让 Regression 的 refresh-conflict 路径处理。"
        : "推荐：重新授权 —— mergeable 为 CONFLICTING，表示存在冲突；新证据确认卡上建议打回，让 Regression 的 refresh-conflict 路径处理。",
    };
  }
  return {
    choiceId: null,
    line: "推荐：需调查 —— 当前停止证据不满足已知恢复条件，先核对 mergeState、检查和 base。",
  };
};

/** Text-only tail notices contain no answer choice; ask the operator to inspect the recorded stop. */
export const mergeTailNoticeRecommendation = (reason: string): string => (
  `推荐：需调查 —— 自动合并尾部因“${reason.replace(/[\r\n]+/gu, " ").trim()}”停止；先核对记录证据与对应 runbook。`
);
