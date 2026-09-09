# Deployment designs

## deployment-governance-regime

### Decision

Deployment does not gain artifact signing or provenance attestation, separation
of powers, a database migrator role, a restore-rehearsal harness, an N/N-1
mechanical gate, containerization, an orchestrator, or zero-downtime
switching.

### Why

The real requirement is atomic rollback for a single-operator deployment; a
many-state release-governance machine was judged over-designed.

### What exists instead

Artifact-based deployment with a small state ledger and migration as policy
(expand automatically, destructive manually).

### Revisit when

The deployment serves more than one operator.

## delete-source-build-fallback

### Decision

The `npm ci` plus source-build fallback is not deleted until the pointer path
has deployed successfully in production at least once.

### Why

Deleting the only path with production evidence before the new one has run
means burning the boat if the new path fails on first use.

### What exists instead

The fallback, with the deploy test suite plus dry run plus one observed real
auto-deploy as the proof required for deletion.

### Revisit when

That proof exists.
