import assert from "node:assert/strict";
import { test } from "node:test";

import type { Prisma } from "@anneal/db";

import { chainStepPresence, templateStepInstantiation } from "./chain-step-omission.js";

const directSteps = [
  { outputKind: "revalidation", optional: false },
  { outputKind: "implementation", optional: false },
  { outputKind: "review-findings", optional: false },
  { outputKind: "blind-findings", optional: true },
  { outputKind: "fixed-implementation", optional: false },
  { outputKind: "regression-verification-v2", optional: false },
];

const kinds = (steps: Array<{ outputKind: string }>): string[] => steps.map((step) => step.outputKind);

/** Staffing that keeps every optional step, the shape of an unstaffed chain. */
const keepsEveryOptionalStep = (): boolean => true;

/** Staffing that excludes the named optional kinds and keeps the rest. */
const excluding = (...outputKinds: string[]) => (step: { outputKind: string }): boolean => (
  !outputKinds.includes(step.outputKind)
);

test("instantiation omits the conditional revalidation step only when the chain is unbound", () => {
  const unbound = templateStepInstantiation(directSteps, {
    routesImplementation: true,
    boundToPredecessor: false,
    includesOptionalStep: keepsEveryOptionalStep,
  });
  assert.equal(unbound.omittedConditionalRevalidation, true);
  assert.deepEqual(kinds(unbound.instantiated), [
    "implementation",
    "review-findings",
    "blind-findings",
    "fixed-implementation",
    "regression-verification-v2",
  ]);

  const bound = templateStepInstantiation(directSteps, {
    routesImplementation: true,
    boundToPredecessor: true,
    includesOptionalStep: keepsEveryOptionalStep,
  });
  assert.equal(bound.omittedConditionalRevalidation, false);
  assert.deepEqual(kinds(bound.instantiated), kinds(directSteps));

  // A template that does not route implementation keeps a revalidation-shaped
  // step: the conditional rule belongs to the routing family, not to the kind.
  const otherFamily = templateStepInstantiation(directSteps, {
    routesImplementation: false,
    boundToPredecessor: false,
    includesOptionalStep: keepsEveryOptionalStep,
  });
  assert.equal(otherFamily.omittedConditionalRevalidation, false);
  assert.deepEqual(kinds(otherFamily.instantiated), kinds(directSteps));
});

test("the conditional rule drops exactly one ordinal", () => {
  // The caller shifts every retained ordinal down by one, so a template that
  // declared a second revalidation-role step must not lose two steps here.
  const twoRevalidations = [
    { outputKind: "revalidation", optional: false },
    { outputKind: "revalidation-v2", optional: false },
    { outputKind: "implementation", optional: false },
  ];
  const instantiation = templateStepInstantiation(twoRevalidations, {
    routesImplementation: true,
    boundToPredecessor: false,
    includesOptionalStep: keepsEveryOptionalStep,
  });
  assert.equal(instantiation.omittedConditionalRevalidation, true);
  assert.deepEqual(kinds(instantiation.instantiated), ["revalidation-v2", "implementation"]);
});

test("instantiation omits optional steps independently of the conditional rule", () => {
  const both = templateStepInstantiation(directSteps, {
    routesImplementation: true,
    boundToPredecessor: false,
    includesOptionalStep: excluding("blind-findings"),
  });
  assert.equal(both.omittedConditionalRevalidation, true);
  assert.deepEqual(kinds(both.instantiated), [
    "implementation",
    "review-findings",
    "fixed-implementation",
    "regression-verification-v2",
  ]);

  const optionalOnly = templateStepInstantiation(directSteps, {
    routesImplementation: true,
    boundToPredecessor: true,
    includesOptionalStep: excluding("blind-findings"),
  });
  assert.equal(optionalOnly.omittedConditionalRevalidation, false);
  assert.deepEqual(kinds(optionalOnly.instantiated), [
    "revalidation",
    "implementation",
    "review-findings",
    "fixed-implementation",
    "regression-verification-v2",
  ]);
});

test("inclusion is asked about optional steps only, and a refusing answer never drops a required one", () => {
  const asked: string[] = [];
  const instantiation = templateStepInstantiation(directSteps, {
    routesImplementation: false,
    boundToPredecessor: true,
    includesOptionalStep: (step) => {
      asked.push(step.outputKind);
      return false;
    },
  });
  // A staffing that excludes everything it is allowed to exclude still leaves
  // every required step: inclusion decides optional steps and nothing else.
  assert.deepEqual(asked, ["blind-findings"]);
  assert.deepEqual(kinds(instantiation.instantiated), [
    "revalidation",
    "implementation",
    "review-findings",
    "fixed-implementation",
    "regression-verification-v2",
  ]);
});

const presenceFor = async (steps: Array<{ outputKind: string; instantiated: boolean }>) => {
  const queries: Array<Record<string, unknown>> = [];
  const tx = {
    taskTemplateStep: {
      findMany: async (query: Record<string, unknown>) => {
        queries.push(query);
        return steps.map(({ outputKind, instantiated }) => ({
          outputKind,
          tasks: instantiated ? [{ id: `task-${outputKind}` }] : [],
        }));
      },
    },
  } as unknown as Prisma.TransactionClient;
  const presence = await chainStepPresence(tx, {
    projectId: "project-1",
    chainId: "chain-1",
    taskTemplateId: "template-1",
  });
  return { presence, queries };
};

test("chain presence separates an omitted producer from an undeclared one", async () => {
  const { presence, queries } = await presenceFor([
    { outputKind: "implementation", instantiated: true },
    { outputKind: "review-findings", instantiated: true },
    { outputKind: "blind-findings", instantiated: false },
  ]);
  assert.equal(presence.ofKind("implementation"), "instantiated");
  assert.equal(presence.ofKind("blind-findings"), "omitted");
  assert.equal(presence.ofKind("documentation"), "undeclared");
  assert.equal(presence.ofRole("blind-findings"), "omitted");
  assert.equal(presence.ofRole("review-findings"), "instantiated");
  assert.equal(presence.ofRole("documentation"), "undeclared");
  // One read answers every kind and every role the callers ask about.
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]!.where, { taskTemplateId: "template-1" });
});

test("chain presence answers a versioned output kind through its role", async () => {
  const { presence } = await presenceFor([
    { outputKind: "blind-findings-v2", instantiated: false },
    { outputKind: "regression-verification-v2", instantiated: true },
  ]);
  assert.equal(presence.ofKind("blind-findings"), "undeclared");
  assert.equal(presence.ofRole("blind-findings"), "omitted");
  assert.equal(presence.ofKind("regression-verification-v2"), "instantiated");
  assert.equal(presence.ofRole("regression"), "instantiated");
});

test("a kind produced by two steps is omitted only when neither has a task", async () => {
  const partial = await presenceFor([
    { outputKind: "review-findings", instantiated: false },
    { outputKind: "review-findings", instantiated: true },
  ]);
  assert.equal(partial.presence.ofKind("review-findings"), "instantiated");

  const neither = await presenceFor([
    { outputKind: "review-findings", instantiated: false },
    { outputKind: "review-findings", instantiated: false },
  ]);
  assert.equal(neither.presence.ofKind("review-findings"), "omitted");
});
