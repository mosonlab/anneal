import { GoalDispatchState, type PrismaClient } from "@anneal/db";

/**
 * Delete one Project and all rows owned by it.
 *
 * The schema deliberately keeps several relations `Restrict` for ordinary
 * single-row deletes. A project delete is different: every row in that graph
 * is being removed, so the references have to be cleared or deleted in a
 * dependency-safe order before the Project itself is deleted.
 */
export const deleteProject = async (db: PrismaClient, projectId: string): Promise<boolean> => db.$transaction(async (tx) => {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return false;

  // Remove history first. Goal-linked Tasks and Runs have composite identity
  // foreign keys with ON UPDATE CASCADE, so deleting these rows before clearing
  // a Goal tuple avoids cascading an invalid partial identity into them.
  await tx.goalExecutionEvent.deleteMany({
    where: {
      OR: [
        { goal: { projectId } },
        { task: { projectId } },
        { run: { projectId } },
      ],
    },
  });
  await tx.inboxDecision.deleteMany({ where: { run: { projectId } } });
  await tx.sessionEvent.deleteMany({ where: { session: { projectId } } });
  await tx.taskStepOutput.deleteMany({ where: { task: { projectId } } });
  await tx.mergeGateAttestation.deleteMany({ where: { task: { projectId } } });
  await tx.mergeRecoveryAttempt.deleteMany({ where: { integratorTask: { projectId } } });
  await tx.taskActivity.deleteMany({ where: { task: { projectId } } });

  // Inbox rows can be attached through any of the project-owned roots. Delete
  // them before those roots so nullable links do not turn an owned card into a
  // global one during the transaction.
  await tx.inboxMessage.deleteMany({
    where: {
      OR: [
        { agent: { projectId } },
        { session: { projectId } },
        { task: { projectId } },
        { goal: { projectId } },
        { gateTask: { projectId } },
        {
          thread: {
            OR: [
              { session: { projectId } },
              { task: { projectId } },
              { goal: { projectId } },
            ],
          },
        },
      ],
    },
  });
  await tx.inboxThread.deleteMany({
    where: {
      OR: [
        { session: { projectId } },
        { task: { projectId } },
        { goal: { projectId } },
      ],
    },
  });
  await tx.goalProgressEntry.deleteMany({ where: { goal: { projectId } } });

  // Sessions have Restrict links to Agents, Tasks, and Goals, so remove them
  // before any of those rows (their events were removed above).
  await tx.session.deleteMany({ where: { projectId } });

  // Break nullable Restrict/self references before deleting their targets.
  // Non-Goal Tasks have no tuple invariant, so their predecessor and decision
  // references can be cleared directly.
  await tx.task.updateMany({
    where: { projectId, goalId: null },
    data: {
      dispatchAfterTaskId: null,
      goalPredecessorTaskId: null,
      goalDecisionRunId: null,
    },
  });
  // Goal-linked Tasks must keep their lineage tuple all non-null while Runs
  // still point at it. MIGRATED_CLOSED is the valid no-decision state; the
  // complete tuple is cleared after Runs have been removed below.
  await tx.task.updateMany({
    where: { projectId, goalId: { not: null } },
    data: {
      dispatchAfterTaskId: null,
      goalDispatchState: GoalDispatchState.MIGRATED_CLOSED,
      goalDecisionKey: null,
      goalDecisionRequestHash: null,
      goalDecisionRunId: null,
      goalDecisionAt: null,
    },
  });
  await tx.run.updateMany({ where: { projectId }, data: { retryOfRunId: null } });
  await tx.taskTemplate.updateMany({ where: { projectId }, data: { webhookRepoId: null } });
  await tx.staffingProfile.updateMany({ where: { projectId }, data: { mergeTailRepairAgentId: null } });

  // The row itself is the project-owned handoff record. Removing it before
  // Runs avoids writing an invalid handedOffRunId/handedOffAt pair while also
  // satisfying the Restrict edge to Run.
  await tx.mergeLeaseEvent.deleteMany({ where: { projectId } });

  // Runs reference project Tasks, Goals, Agents, and Repos through Restrict
  // edges. The run-level dependents and nullable retry links are gone now.
  await tx.run.deleteMany({ where: { projectId } });

  // Tasks reference one another, Runs, Goals, Agents, and Repos through
  // Restrict edges. Now that Runs and their composite identity FKs are gone,
  // clear the remaining Goal tuple and predecessor links in one valid update.
  await tx.task.updateMany({
    where: { projectId, goalId: { not: null } },
    data: {
      goalId: null,
      goalGeneration: null,
      goalIteration: null,
      goalDispatchKey: null,
      goalDispatchRequestHash: null,
      goalDispatchState: null,
      goalDecisionKey: null,
      goalDecisionRequestHash: null,
      goalDecisionRunId: null,
      goalDecisionAt: null,
      goalPredecessorTaskId: null,
    },
  });
  await tx.task.deleteMany({ where: { projectId } });

  // Goal children and the Goal rows themselves are now unreferenced.
  await tx.goalDefinitionItem.deleteMany({ where: { goal: { projectId } } });
  await tx.goal.deleteMany({ where: { projectId } });

  // Template/profile history and chain-control audit are project-owned even
  // where the child table has no projectId of its own.
  await tx.staffingProfileEntry.deleteMany({ where: { profile: { projectId } } });
  await tx.staffingProfileTier.deleteMany({ where: { profile: { projectId } } });
  await tx.chainControlEvent.deleteMany({ where: { chainControl: { projectId } } });
  await tx.taskTemplateStep.deleteMany({ where: { taskTemplate: { projectId } } });
  await tx.triggerFire.deleteMany({ where: { template: { projectId } } });
  await tx.staffingProfile.deleteMany({ where: { projectId } });
  await tx.taskTemplate.deleteMany({ where: { projectId } });
  await tx.chainControl.deleteMany({ where: { projectId } });

  // Remove project-scoped join rows before their Agent/Repo/Skill targets.
  await tx.agentSkill.deleteMany({ where: { projectId } });
  await tx.agentMCPConnection.deleteMany({ where: { projectId } });
  await tx.agentRepoAccess.deleteMany({ where: { projectId } });
  await tx.agentCollaboration.deleteMany({ where: { projectId } });
  await tx.agentSecretGrant.deleteMany({ where: { agent: { projectId } } });
  await tx.filesystemGrant.deleteMany({ where: { agent: { projectId } } });
  await tx.environmentSecret.deleteMany({ where: { environment: { projectId } } });

  await tx.mCPConnection.deleteMany({ where: { projectId } });
  await tx.skill.deleteMany({ where: { projectId } });
  await tx.repo.deleteMany({ where: { projectId } });
  await tx.agent.deleteMany({ where: { projectId } });
  await tx.environment.deleteMany({ where: { projectId } });
  await tx.project.delete({ where: { id: projectId } });
  return true;
});
