const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class DeploymentAttempt {
  #facts = new Map();
  #resources = [];
  #released = false;

  constructor({ deployRoot, targetCommit, transactionId }) {
    if (typeof deployRoot !== "string" || deployRoot === "") throw new TypeError("deployment-attempt-deploy-root-required");
    if (typeof targetCommit !== "string" || targetCommit === "") throw new TypeError("deployment-attempt-target-commit-required");
    if (typeof transactionId !== "string" || transactionId === "") throw new TypeError("deployment-attempt-transaction-id-required");
    this.deployRoot = deployRoot;
    this.targetCommit = targetCommit;
    this.transactionId = transactionId;
    Object.freeze(this);
  }

  fact(name) {
    return this.#facts.get(name);
  }

  requireFact(name) {
    if (!this.#facts.has(name)) throw new TypeError(`deployment-attempt-fact-missing:${name}`);
    return this.#facts.get(name);
  }

  establish(facts) {
    if (facts === undefined || facts === null) return;
    if (typeof facts !== "object" || Array.isArray(facts)) throw new TypeError("deployment-attempt-facts-invalid");
    if (hasOwn(facts, "resources")) {
      if (!Array.isArray(facts.resources)) throw new TypeError("deployment-attempt-resources-invalid");
      for (const resource of facts.resources) {
        if (typeof resource?.release !== "function") throw new TypeError("deployment-attempt-resource-release-missing");
        this.#resources.push(resource);
      }
    }
    for (const [name, value] of Object.entries(facts)) {
      if (name !== "resources") this.#facts.set(name, value);
    }
  }

  ledgerMetadata(metadata = {}) {
    const revisions = this.fact("revisions");
    const preparedRelease = this.fact("verifiedRelease") ?? this.fact("preparedRelease");
    const backup = this.fact("backup");
    const migration = this.fact("migration");
    const publication = this.fact("publication");
    const verification = this.fact("serviceVerification");
    return {
      targetCommit: revisions?.to ?? this.targetCommit,
      ...(preparedRelease?.buildStamp ? { activatedBuildStamp: preparedRelease.buildStamp } : {}),
      ...(preparedRelease?.releaseName ? { releaseDirectoryIdentity: preparedRelease.releaseName } : {}),
      ...(backup?.backupIdentity ? { backupIdentity: backup.backupIdentity } : {}),
      ...(migration ? {
        migrationTailBefore: migration.migrationTailBefore ?? null,
        migrationTailAfter: migration.migrationTailAfter ?? null,
      } : {}),
      ...(publication?.releaseDirectoryIdentity
        ? { releaseDirectoryIdentity: publication.releaseDirectoryIdentity }
        : publication?.releaseIdentity?.name
          ? { releaseDirectoryIdentity: publication.releaseIdentity.name }
          : {}),
      ...(publication?.pointerOldTarget !== undefined ? { pointerOldTarget: publication.pointerOldTarget } : {}),
      ...(publication?.pointerNewTarget !== undefined ? { pointerNewTarget: publication.pointerNewTarget } : {}),
      ...(publication?.releaseIdentity ? { releaseIdentity: publication.releaseIdentity } : {}),
      ...(publication?.pointerTransition ? { pointerTransition: publication.pointerTransition } : {}),
      ...(verification?.activatedBuildStamp ? { activatedBuildStamp: verification.activatedBuildStamp } : {}),
      ...(this.fact("rollbackPointerOutcome") ? { rollbackPointerOutcome: this.fact("rollbackPointerOutcome") } : {}),
      ...(this.fact("supersededEscalation") ? { supersededEscalation: this.fact("supersededEscalation") } : {}),
      ...metadata,
    };
  }

  async release() {
    if (this.#released) return;
    this.#released = true;
    const failures = [];
    for (const resource of this.#resources.reverse()) {
      try {
        await resource.release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "deployment-attempt-resource-release-failed");
  }
}

export const openDeploymentAttempt = (identity) => new DeploymentAttempt(identity);

export const parseReleaseArtifactReceipt = (output) => {
  const receiptLine = output.trim().split("\n").findLast((line) => line.startsWith("RELEASE-ARTIFACT "));
  if (!receiptLine) return null;
  try {
    const receipt = JSON.parse(receiptLine.slice("RELEASE-ARTIFACT ".length));
    return typeof receipt?.releaseName === "string" && receipt.releaseName !== "" ? receipt : null;
  } catch {
    return null;
  }
};
