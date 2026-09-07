import { z } from "zod";

import { REGRESSION_VERIFICATION_SCHEMA_VERSION } from "./merge-tail.js";
import { stepGeneration, stepRole, type StepRole, type TemplateStepLike } from "./step-role.js";

const commitSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const nonEmptyString = z.string().trim().min(1);
const passGateProof = z.string().regex(/^MERGE GATE: PASS [0-9a-f]{40}$/u);
const failGateProof = z.string().regex(/^MERGE GATE: FAIL \(.+\)$/u);
const stringList = z.array(nonEmptyString);
const canonicalEnvelope = z.object({ schemaVersion: z.literal(1), headSha: commitSha });
const reviewFinding = z.object({
  id: nonEmptyString,
  severity: z.enum(["P0", "P1", "P2"]),
  file: nonEmptyString,
  line: z.number().int().positive(),
  title: nonEmptyString,
  evidence: nonEmptyString,
  requiredFix: nonEmptyString,
});

export const canonicalReviewArtifactSchema = canonicalEnvelope.extend({
  reviewedBase: commitSha,
  reviewedHead: commitSha,
  findings: z.array(reviewFinding),
});

export const canonicalClosedReviewArtifactSchema = canonicalReviewArtifactSchema.extend({
  dispositions: z.array(z.object({
    id: nonEmptyString,
    disposition: z.enum(["ADOPTED", "REJECTED", "MERGED"]),
    reason: nonEmptyString,
  })),
  mustFixIds: stringList,
});

/** The retired adjudication Step contract remains valid for instantiated Chains. */
const canonicalAdjudicationArtifactSchema = canonicalEnvelope.extend({
  reviewedBase: commitSha,
  reviewedHead: commitSha,
  dispositions: z.array(z.object({
    id: nonEmptyString,
    disposition: z.enum(["ADOPTED", "REJECTED", "MERGED"]),
    reason: nonEmptyString,
  })),
  mustFixIds: stringList,
  findings: z.array(reviewFinding).optional(),
});

export const canonicalFixedImplementationArtifactSchema = canonicalEnvelope.extend({
  sourceHead: commitSha,
  dispositions: z.array(z.object({
    id: nonEmptyString,
    disposition: z.enum(["ADOPTED", "REJECTED", "MERGED"]),
    reason: nonEmptyString,
  })),
  closedFindings: z.array(z.object({
    id: nonEmptyString,
    status: z.literal("CLOSED"),
    codeEvidence: nonEmptyString,
    testEvidence: nonEmptyString,
  })),
  testsRun: stringList,
  residualRisks: z.array(z.string()),
});

export type CanonicalReviewArtifact = z.infer<typeof canonicalReviewArtifactSchema>;
export type CanonicalClosedReviewArtifact = z.infer<typeof canonicalClosedReviewArtifactSchema>;
export type CanonicalFixedImplementationArtifact = z.infer<typeof canonicalFixedImplementationArtifactSchema>;

type SchemaByGeneration = Readonly<Record<string, z.ZodType>>;

export const canonicalOutputSchemas: Readonly<Partial<Record<StepRole, SchemaByGeneration>>> = {
  spec: {
    v1: canonicalEnvelope.extend({ spec: nonEmptyString }),
  },
  revalidation: {
    v1: canonicalEnvelope.extend({
      outcome: z.enum(["updated", "unchanged", "proceeded-after-premise-collapse"]),
      summary: nonEmptyString,
      changedReferences: stringList,
    }),
  },
  plan: {
    v1: canonicalEnvelope.extend({ summary: nonEmptyString, sliceIds: stringList }),
  },
  "plan-review": {
    v1: canonicalEnvelope.extend({ findings: z.array(reviewFinding) }),
  },
  "revised-plan": {
    v1: canonicalEnvelope.extend({
      summary: nonEmptyString,
      addressedFindingIds: stringList,
      declinedFindings: z.array(z.object({ id: nonEmptyString, reason: nonEmptyString })),
    }),
  },
  implementation: {
    v1: canonicalEnvelope.extend({
      baseSha: commitSha,
      summary: nonEmptyString,
      testsRun: stringList,
    }),
  },
  "review-findings": {
    v1: canonicalReviewArtifactSchema.extend({ commandsRun: stringList }),
  },
  "blind-findings": {
    v1: canonicalReviewArtifactSchema,
  },
  "must-fix": {
    v1: canonicalAdjudicationArtifactSchema,
  },
  "fixed-implementation": {
    v1: canonicalFixedImplementationArtifactSchema,
  },
  regression: {
    v1: z.discriminatedUnion("outcome", [
      canonicalEnvelope.extend({
        outcome: z.literal("pass"),
        baseHeadSha: commitSha,
        gateVerdict: z.literal("PASS"),
      }),
      canonicalEnvelope.extend({
        outcome: z.literal("review-fail"),
        baseHeadSha: commitSha,
        summary: nonEmptyString,
      }),
      canonicalEnvelope.extend({
        outcome: z.literal("gate-fail"),
        baseHeadSha: commitSha,
        gateVerdict: z.literal("FAIL"),
        summary: nonEmptyString,
      }),
      canonicalEnvelope.extend({
        outcome: z.literal("refresh-conflict"),
        baseHeadSha: commitSha,
        summary: nonEmptyString,
      }),
    ]),
    v2: z.discriminatedUnion("outcome", [
      canonicalEnvelope.extend({
        schemaVersion: z.literal(REGRESSION_VERIFICATION_SCHEMA_VERSION),
        outcome: z.literal("pass"),
        baseHeadSha: commitSha,
        gateVerdict: z.literal("PASS"),
        gateProof: passGateProof,
      }),
      canonicalEnvelope.extend({
        schemaVersion: z.literal(REGRESSION_VERIFICATION_SCHEMA_VERSION),
        outcome: z.literal("review-fail"),
        baseHeadSha: commitSha,
        summary: nonEmptyString,
      }),
      canonicalEnvelope.extend({
        schemaVersion: z.literal(REGRESSION_VERIFICATION_SCHEMA_VERSION),
        outcome: z.literal("gate-fail"),
        baseHeadSha: commitSha,
        gateVerdict: z.literal("FAIL"),
        gateProof: failGateProof,
        summary: nonEmptyString,
        gateFailureExcerpt: z.string().optional(),
      }),
      canonicalEnvelope.extend({
        schemaVersion: z.literal(REGRESSION_VERIFICATION_SCHEMA_VERSION),
        outcome: z.literal("refresh-conflict"),
        baseHeadSha: commitSha,
        summary: nonEmptyString,
      }),
    ]).superRefine((verdict, context) => {
      if (verdict.outcome === "pass" && verdict.gateProof !== `MERGE GATE: PASS ${verdict.headSha}`) {
        context.addIssue({
          code: "custom",
          path: ["gateProof"],
          message: "gate proof oid must match headSha",
        });
      }
    }),
  },
  documentation: {
    v1: canonicalEnvelope.extend({
      summary: nonEmptyString,
      changes: z.array(z.object({ path: nonEmptyString, action: z.enum(["ADDED", "UPDATED", "DELETED"]) })),
    }),
  },
};

/** Resolve one Step output contract through the role and output protocol generation seam. */
export const canonicalOutputSchema = (step: TemplateStepLike): z.ZodType | null => {
  const role = stepRole(step);
  if (role === null) return null;
  // Template rollovers preserve an output protocol unless outputKind itself
  // changes, which is why stepGeneration reads the -vN suffix and nothing else.
  const generation = stepGeneration(step);
  return canonicalOutputSchemas[role]?.[generation] ?? null;
};
