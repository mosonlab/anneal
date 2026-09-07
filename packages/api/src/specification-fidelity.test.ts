import assert from "node:assert/strict";
import test from "node:test";

import { PR_TEMPLATE_NAME } from "@anneal/db";

import {
  normalizeLineEndings,
  prepareSpecificationVerification,
  specificationDigest,
  SPEC_TRANSCRIPTION_UNREADABLE_REASON,
  SPEC_TRANSCRIPTION_REFUSAL_REASON,
  specificationMaterializationForDirectImplementation,
  specificationPathForBranch,
  verifyPreparedSpecification,
} from "./specification-fidelity.js";
import { GitHubReadError } from "./github-read.js";
import { composeTemplateTaskDescription } from "./templates.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test("line-ending normalization folds CR variants and removes at most one final LF", () => {
  assert.deepEqual(
    [...normalizeLineEndings(Uint8Array.from([0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x43, 0x0a]))],
    [0x41, 0x0a, 0x42, 0x0a, 0x43],
  );
  assert.deepEqual(
    [...normalizeLineEndings(Uint8Array.from([0x41, 0x0a, 0x0a]))],
    [0x41, 0x0a],
  );
});

test("faithful pinned materialization accepts normalized line endings and passes the exact head/path", async () => {
  const authoritative = "line one\nline two";
  const verification = {
    key: "key",
    repository: "acme/repo",
    remoteUrl: "https://github.com/acme/repo.git",
    path: specificationPathForBranch("feature/spec-check"),
    implementationHeadSha: "a".repeat(40),
    authoritativeDigest: specificationDigest(authoritative),
    currentBrief: { kind: "authority" as const },
  };
  let call: { repository: string; path: string; commitSha: string } | undefined;
  const verdict = await verifyPreparedSpecification(
    verification,
    { readFileAtCommit: async (repository, path, commitSha) => {
      call = { repository, path, commitSha };
      return bytes("line one\r\nline two");
    } },
    new AbortController().signal,
  );
  assert.equal(verdict, null);
  assert.deepEqual(call, {
    repository: "acme/repo",
    path: ".chain/feature/spec-check/spec.md",
    commitSha: "a".repeat(40),
  });
});

test("faithful pinned materialization accepts one final LF absent from authority", async () => {
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "a".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    { readFileAtCommit: async () => bytes("authoritative\n") },
    new AbortController().signal,
  );
  assert.equal(verdict, null);
});

test("tampered materialization returns one stable operator-visible reason", async () => {
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    { readFileAtCommit: async () => bytes("tampered") },
    new AbortController().signal,
  );
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
  assert.equal(verdict?.classification, "non-transient");
  assert.match(verdict?.message ?? "", /Spec transcription claim refused: spec-transcription-mismatch/u);
});

test("direct implementation materialization uses only the marker-delimited authoritative brief", () => {
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: "the exact brief",
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  assert.deepEqual(specificationMaterializationForDirectImplementation({
    description,
    templateId: "direct-template",
    chainId: "direct-chain",
    templateStep: {
      stepIndex: 1,
      outputKind: "implementation",
      priorOutputKinds: [],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  }, "feature/direct"), {
    kind: "direct-implementation",
    path: ".chain/feature/direct/spec.md",
    body: "the exact brief",
  });
});

test("PR implementation materialization uses the marker-delimited authoritative brief", () => {
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: "the PR workflow brief",
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  assert.deepEqual(specificationMaterializationForDirectImplementation({
    description,
    templateId: "pr-template",
    chainId: "pr-chain",
    templateStep: {
      stepIndex: 1,
      outputKind: "implementation",
      priorOutputKinds: [],
      taskTemplate: { name: PR_TEMPLATE_NAME },
    },
  }, "feature/pr"), {
    kind: "direct-implementation",
    path: ".chain/feature/pr/spec.md",
    body: "the PR workflow brief",
  });
});

test("a transient repository failure retries with backoff and then accepts faithful content", async () => {
  let reads = 0;
  const waits: number[] = [];
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    { readFileAtCommit: async () => {
      reads += 1;
      if (reads === 1) throw new GitHubReadError("proxy flap", "transport");
      return bytes("authoritative");
    } },
    new AbortController().signal,
    { retryDelaysMs: [17, 29], wait: async (delayMs) => { waits.push(delayMs); } },
  );
  assert.equal(verdict, null);
  assert.equal(reads, 2);
  assert.deepEqual(waits, [17]);
});

test("persistent transient repository failure reports retry count and last failure", async () => {
  let reads = 0;
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    { readFileAtCommit: async () => {
      reads += 1;
      throw new GitHubReadError(`proxy flap ${reads}`, "transport");
    } },
    new AbortController().signal,
    { retryDelaysMs: [17, 29], wait: async () => {} },
  );
  assert.equal(reads, 3);
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_UNREADABLE_REASON);
  assert.equal(verdict?.classification, "transient");
  assert.match(verdict?.message ?? "", /after 2 retries \(3 total attempts\)/u);
  assert.match(verdict?.message ?? "", /last failure: proxy flap 3/u);
});

test("a read deadline overrun is transient and exhausts the bounded retry schedule", async () => {
  let reads = 0;
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    { readFileAtCommit: async (_repository, _path, _commitSha, signal) => {
      reads += 1;
      return new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    } },
    new AbortController().signal,
    { retryDelaysMs: [0, 0], attemptTimeoutsMs: [5, 5, 5], wait: async () => {} },
  );
  assert.equal(reads, 3);
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_UNREADABLE_REASON);
  assert.equal(verdict?.classification, "transient");
  assert.match(verdict?.message ?? "", /last failure: repository content read exceeded the 5ms server deadline/u);
});

test("a permanent repository response failure refuses without retrying", async () => {
  let reads = 0;
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    { readFileAtCommit: async () => {
      reads += 1;
      throw new GitHubReadError("repository file is missing", "response");
    } },
    new AbortController().signal,
    { retryDelaysMs: [0, 0], wait: async () => {} },
  );
  assert.equal(reads, 1);
  assert.equal(verdict?.classification, "non-transient");
  assert.match(verdict?.message ?? "", /repository file is missing/u);
});

test("a content mismatch refuses immediately without retrying", async () => {
  let reads = 0;
  const waits: number[] = [];
  const verdict = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo.git",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "b".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    { readFileAtCommit: async () => {
      reads += 1;
      return bytes("tampered");
    } },
    new AbortController().signal,
    { retryDelaysMs: [17, 29], wait: async (delayMs) => { waits.push(delayMs); } },
  );
  assert.equal(reads, 1);
  assert.deepEqual(waits, []);
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
  assert.equal(verdict?.classification, "non-transient");
});

test("direct authority is read from the implementation task and compound authority from the approved spec output", async () => {
  const brief = "the direct brief";
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: brief,
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  const directTx = {
    task: { findMany: async () => [{
      description,
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: null,
    }] },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const direct = await prepareSpecificationVerification(directTx, {
    task: {
      id: "direct-review",
      projectId: "project",
      templateId: "direct-template",
      chainId: "direct-chain",
      chainIndex: 2,
      description: "review task description must not become authority",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1, taskTemplate: { name: "direct-engineer-workflow" } },
    },
    repo: { remoteUrl: "git@github.com:acme/repo.git" },
    branch: "feature/direct",
  }, "c".repeat(40));
  assert.equal(direct.status, "ready");
  if (direct.status === "ready") assert.equal(direct.verification.authoritativeDigest, specificationDigest(brief));

  const compoundTx = {
    task: { findMany: async () => [{
      description: "specification task",
      templateStep: { outputKind: "spec", priorOutputKinds: [] },
      stepOutput: { kind: "spec", body: JSON.stringify({ schemaVersion: 1, spec: "approved compound spec" }) },
    }, {
      description: "implementation task",
      templateStep: { outputKind: "implementation", priorOutputKinds: ["spec"] },
      stepOutput: null,
    }] },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const compound = await prepareSpecificationVerification(compoundTx, {
    task: {
      id: "compound-review",
      projectId: "project",
      templateId: "compound-template",
      chainId: "compound-chain",
      chainIndex: 6,
      description: "review task description must not become authority",
      templateStep: { stepIndex: 6, outputKind: "sol-findings", baseFromStepIndex: 5, taskTemplate: { name: "compound-engineer-workflow-legacy-pre-zero-gate-row" } },
    },
    repo: { remoteUrl: "https://github.com/acme/repo" },
    branch: "feature/compound",
  }, "d".repeat(40));
  assert.equal(compound.status, "ready");
  if (compound.status === "ready") assert.equal(compound.verification.authoritativeDigest, specificationDigest("approved compound spec"));
});

test("PR review claims prepare identical implementation authority for code review and blind code review", async () => {
  const brief = "the PR workflow authoritative brief";
  const implementationDescription = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: brief,
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  const tx = {
    task: { findMany: async () => [{
      description: implementationDescription,
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: null,
    }] },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const candidate = (outputKind: "sol-findings" | "blind-findings") => ({
    task: {
      id: `pr-${outputKind}`,
      projectId: "project",
      templateId: "pr-template",
      chainId: "pr-chain",
      chainIndex: outputKind === "sol-findings" ? 2 : 3,
      description: "review task description must not become authority",
      templateStep: {
        stepIndex: outputKind === "sol-findings" ? 2 : 3,
        outputKind,
        baseFromStepIndex: 1,
        taskTemplate: { name: PR_TEMPLATE_NAME },
      },
    },
    repo: { remoteUrl: "git@github.com:acme/repo.git" },
    branch: "feature/pr",
  });

  const [sol, blind] = await Promise.all([
    prepareSpecificationVerification(tx, candidate("sol-findings"), "e".repeat(40)),
    prepareSpecificationVerification(tx, candidate("blind-findings"), "e".repeat(40)),
  ]);
  assert.equal(sol.status, "ready");
  assert.equal(blind.status, "ready");
  if (sol.status !== "ready" || blind.status !== "ready") return;
  assert.equal(sol.verification.authoritativeDigest, blind.verification.authoritativeDigest);
  assert.equal(sol.verification.authoritativeDigest, specificationDigest(brief));

  const reads: Array<{ repository: string; path: string; commitSha: string }> = [];
  const reader = {
    readFileAtCommit: async (repository: string, path: string, commitSha: string) => {
      reads.push({ repository, path, commitSha });
      return bytes(brief);
    },
  };
  assert.equal(await verifyPreparedSpecification(sol.verification, reader, new AbortController().signal), null);
  assert.equal(await verifyPreparedSpecification(blind.verification, reader, new AbortController().signal), null);
  assert.deepEqual(reads, [
    { repository: "acme/repo", path: ".chain/feature/pr/spec.md", commitSha: "e".repeat(40) },
    { repository: "acme/repo", path: ".chain/feature/pr/spec.md", commitSha: "e".repeat(40) },
  ]);
});

test("an unsupported repository remote is refused before repository I/O with a named cause", async () => {
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature below.",
    featureBrief: "direct brief",
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  const tx = {
    task: { findMany: async () => [{
      description,
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: null,
    }] },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const prepared = await prepareSpecificationVerification(tx, {
    task: {
      id: "direct-review",
      projectId: "project",
      templateId: "direct-template",
      chainId: "direct-chain",
      chainIndex: 2,
      description: "review task",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1 },
    },
    repo: { remoteUrl: "https://example.test/acme/repo.git" },
    branch: "feature/direct",
  }, "e".repeat(40));
  assert.equal(prepared.status, "refused");
  if (prepared.status === "refused") {
    assert.equal(prepared.refusal.reason, SPEC_TRANSCRIPTION_UNREADABLE_REASON);
    assert.equal(prepared.refusal.classification, "non-transient");
    assert.match(prepared.refusal.message, /remote is not a supported GitHub repository/u);
  }
});

test("missing or corrupt authority and an unavailable reader are non-transient refusals", async () => {
  const candidate = {
    task: {
      id: "compound-review",
      projectId: "project",
      templateId: "compound-template",
      chainId: "compound-chain",
      chainIndex: 2,
      description: "review task",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1 },
    },
    repo: { remoteUrl: "https://github.com/acme/repo" },
    branch: "feature/compound",
  };
  const preparedFor = (stepOutput: { kind: string; body: string } | null) => prepareSpecificationVerification(
    {
      task: { findMany: async () => [{
        description: "specification task",
        templateStep: { outputKind: "spec", priorOutputKinds: [] },
        stepOutput,
      }] },
    } as unknown as Parameters<typeof prepareSpecificationVerification>[0],
    candidate,
    "f".repeat(40),
  );

  const missing = await preparedFor(null);
  assert.equal(missing.status, "refused");
  if (missing.status === "refused") {
    assert.equal(missing.refusal.reason, "spec-transcription-authority-missing");
    assert.equal(missing.refusal.classification, "non-transient");
  }

  const corrupt = await preparedFor({ kind: "spec", body: "not-json" });
  assert.equal(corrupt.status, "refused");
  if (corrupt.status === "refused") {
    assert.equal(corrupt.refusal.reason, "spec-transcription-authority-missing");
    assert.equal(corrupt.refusal.classification, "non-transient");
  }

  const unavailableReader = await verifyPreparedSpecification(
    {
      key: "key",
      repository: "acme/repo",
      remoteUrl: "https://github.com/acme/repo",
      path: ".chain/feature/spec-check/spec.md",
      implementationHeadSha: "f".repeat(40),
      authoritativeDigest: specificationDigest("authoritative"),
    currentBrief: { kind: "authority" },
    },
    null,
    new AbortController().signal,
  );
  assert.equal(unavailableReader?.reason, SPEC_TRANSCRIPTION_UNREADABLE_REASON);
  assert.equal(unavailableReader?.classification, "non-transient");
});

const AMENDED_AT = new Date("2026-09-06T18:47:00.000Z");

/**
 * A direct chain whose pinned implementation Run recorded the digest of the
 * brief it was handed, and whose brief may since have been amended in place.
 */
const materializedDirectReview = (materializedBrief: string, currentBrief: string) => {
  const tx = {
    task: { findMany: async () => [{
      id: "direct-implementation",
      description: composeTemplateTaskDescription({
        prompt: "Implement the feature below.",
        featureBrief: currentBrief,
        priorOutputKinds: [],
        outputKind: "implementation",
      }),
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: {
        kind: "implementation",
        body: JSON.stringify({ schemaVersion: 1, headSha: "c".repeat(40) }),
        run: { specificationDigest: specificationDigest(materializedBrief) },
      },
    }] },
    taskActivity: { findFirst: async () => ({ createdAt: AMENDED_AT }) },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  return prepareSpecificationVerification(tx, {
    task: {
      id: "direct-review",
      projectId: "project",
      templateId: "direct-template",
      chainId: "direct-chain",
      chainIndex: 2,
      description: "review task description must not become authority",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1, taskTemplate: { name: "direct-engineer-workflow" } },
    },
    repo: { remoteUrl: "git@github.com:acme/repo.git" },
    branch: "feature/direct",
  }, "c".repeat(40));
};

test("the pinned implementation Run's digest outranks the current brief", async () => {
  const materialized = "the brief the implementer was handed";
  const prepared = await materializedDirectReview(materialized, "the brief after an operator amendment");
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.verification.authoritativeDigest, specificationDigest(materialized));
  assert.deepEqual(prepared.verification.currentBrief, {
    kind: "amended",
    note: `Task direct-implementation had its brief amended at ${AMENDED_AT.toISOString()}, after .chain/feature/direct/spec.md was materialized: that file is the pre-amendment Specification of record, so judge this work against the current brief rather than against the file.`,
  });
  assert.equal(
    await verifyPreparedSpecification(
      prepared.verification,
      { readFileAtCommit: async () => bytes(materialized) },
      new AbortController().signal,
    ),
    null,
  );
});

test("an amended brief does not excuse a materialization that differs from the recorded digest", async () => {
  const amended = "the brief after an operator amendment";
  const prepared = await materializedDirectReview("the brief the implementer was handed", amended);
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  // Transcribing the amendment onto the branch is exactly the rewrite the
  // fidelity check exists to catch, amendment or not.
  const verdict = await verifyPreparedSpecification(
    prepared.verification,
    { readFileAtCommit: async () => bytes(amended) },
    new AbortController().signal,
  );
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
  assert.match(verdict?.message ?? "", /the current task brief also differs from that specification/u);
});

test("a tampered materialization under an unamended brief says the brief still matches", async () => {
  const materialized = "the brief the implementer was handed";
  const prepared = await materializedDirectReview(materialized, materialized);
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.deepEqual(prepared.verification.currentBrief, { kind: "unamended" });
  const verdict = await verifyPreparedSpecification(
    prepared.verification,
    { readFileAtCommit: async () => bytes("tampered") },
    new AbortController().signal,
  );
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
  assert.match(verdict?.message ?? "", /the current task brief still matches that specification/u);
});

test("an amendment with no recorded edit activity still names the task", async () => {
  const tx = {
    task: { findMany: async () => [{
      id: "legacy-implementation",
      description: composeTemplateTaskDescription({
        prompt: "Implement the feature below.",
        featureBrief: "amended before edits were recorded",
        priorOutputKinds: [],
        outputKind: "implementation",
      }),
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: {
        kind: "implementation",
        body: JSON.stringify({ schemaVersion: 1, headSha: "c".repeat(40) }),
        run: { specificationDigest: specificationDigest("what the runner was handed") },
      },
    }] },
    taskActivity: { findFirst: async () => null },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const prepared = await prepareSpecificationVerification(tx, {
    task: {
      id: "legacy-review",
      projectId: "project",
      templateId: "direct-template",
      chainId: "direct-chain",
      chainIndex: 2,
      description: "review task",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1, taskTemplate: { name: "direct-engineer-workflow" } },
    },
    repo: { remoteUrl: "git@github.com:acme/repo.git" },
    branch: "feature/direct",
  }, "c".repeat(40));
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.verification.currentBrief.kind, "amended");
  if (prepared.verification.currentBrief.kind !== "amended") return;
  assert.match(prepared.verification.currentBrief.note, /Task legacy-implementation had its brief amended at an unrecorded time/u);
});

test("a pinned Run without a digest keeps comparing against the current brief", async () => {
  const brief = "the brief as it reads now";
  const tx = {
    task: { findMany: async () => [{
      id: "pre-digest-implementation",
      description: composeTemplateTaskDescription({
        prompt: "Implement the feature below.",
        featureBrief: brief,
        priorOutputKinds: [],
        outputKind: "implementation",
      }),
      templateStep: { outputKind: "implementation", priorOutputKinds: [] },
      stepOutput: {
        kind: "implementation",
        body: JSON.stringify({ schemaVersion: 1, headSha: "c".repeat(40) }),
        run: { specificationDigest: null },
      },
    }] },
  } as unknown as Parameters<typeof prepareSpecificationVerification>[0];
  const prepared = await prepareSpecificationVerification(tx, {
    task: {
      id: "pre-digest-review",
      projectId: "project",
      templateId: "direct-template",
      chainId: "direct-chain",
      chainIndex: 2,
      description: "review task",
      templateStep: { stepIndex: 2, outputKind: "sol-findings", baseFromStepIndex: 1, taskTemplate: { name: "direct-engineer-workflow" } },
    },
    repo: { remoteUrl: "git@github.com:acme/repo.git" },
    branch: "feature/direct",
  }, "c".repeat(40));
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.verification.authoritativeDigest, specificationDigest(brief));
  assert.deepEqual(prepared.verification.currentBrief, { kind: "authority" });
  const verdict = await verifyPreparedSpecification(
    prepared.verification,
    { readFileAtCommit: async () => bytes("something else entirely") },
    new AbortController().signal,
  );
  assert.equal(verdict?.reason, SPEC_TRANSCRIPTION_REFUSAL_REASON);
  assert.match(verdict?.message ?? "", /does not match the authoritative specification$/u);
});
