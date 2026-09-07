import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const handbook = readFileSync("docs/operator-api.md", "utf8");
const installDocument = readFileSync("docs/install.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const addProjectRunbook = readFileSync("docs/runbooks/add-a-project.md", "utf8");
const quietWindowRunbook = readFileSync("docs/runbooks/quiet-window-auto-deploy.md", "utf8");
const snapshotManifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
const routeSourceDirectory = "packages/api/src/routes";
const routeSourcePaths = [
  "packages/api/src/app.ts",
  ...readdirSync(routeSourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
    .map((entry) => join(routeSourceDirectory, entry.name)),
];
const routeSources = routeSourcePaths.map((path) => readFileSync(path, "utf8"));

// Runner and session endpoints are internal protocols, not operator-facing routes.
const internalRoutePrefixes = ["/runner/", "/session/"];
const isInternalRoute = (path) => internalRoutePrefixes.some((prefix) => path.startsWith(prefix));
const routeKey = (method, path) => `${method.toUpperCase()} ${path}`;
// These session capabilities are intentionally operator-documented despite their internal prefix.
const documentedInternalRoutes = new Set([
  routeKey("PATCH", "/session/runs/:runId/task"),
  routeKey("POST", "/session/runs/:runId/revalidation/cancel"),
]);

const apiRouteRegistrations = [
  ...routeSources.flatMap((source) => [
    ...source.matchAll(/\bapp\.(get|post|put|patch|delete)\s*\(\s*(["'])([^"']+)\2/gu),
  ]),
].map(([, method, , path]) => ({ key: routeKey(method, path), path }));
const apiRoutes = new Set(apiRouteRegistrations.map(({ key }) => key));
const handbookRoutes = new Set(
  [...handbook.matchAll(/^###\s+(GET|POST|PUT|PATCH|DELETE)\s+`([^`]+)`/gmu)]
    .map(([, method, path]) => ({ method, path }))
    .map(({ method, path }) => routeKey(method, path)),
);

test("every operator API route has a handbook entry", () => {
  const missing = apiRouteRegistrations
    .filter(({ key, path }) => !isInternalRoute(path) || documentedInternalRoutes.has(key))
    .map(({ key }) => key)
    .filter((key) => !handbookRoutes.has(key))
    .sort();
  const stale = [...handbookRoutes].filter((route) => !apiRoutes.has(route)).sort();
  const mismatch = [
    "Operator API route coverage mismatch.",
    `Missing handbook entries: ${missing.length === 0 ? "none" : missing.join(", ")}.`,
    `Stale handbook entries: ${stale.length === 0 ? "none" : stale.join(", ")}.`,
  ].join(" ");

  assert.equal(missing.length + stale.length, 0, mismatch);
});

const section = (heading) => {
  const start = handbook.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `operator handbook must have a ${heading} section`);
  const end = handbook.indexOf("\n## ", start + heading.length + 1);
  return handbook.slice(start, end === -1 ? handbook.length : end);
};

const tasks = section("## Tasks");
const templates = section("## Task templates");
const projects = section("## Projects and environments");
const repositories = section("## Repositories");
const inbox = section("## Inbox");
const serviceStatus = section("## Service, status, and onboarding");
const sessions = section("## Sessions and runs");

const routeIn = (source, method, path) => {
  const marker = `### ${method} \`${path}\``;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must be documented in its section`);
  const end = source.indexOf("\n### ", start + marker.length);
  return { start, text: source.slice(start, end === -1 ? source.length : end) };
};

const routeSection = (method, path) => routeIn(tasks, method, path);
const templateRouteSection = (method, path) => routeIn(templates, method, path);
const repositoryRouteSection = (method, path) => routeIn(repositories, method, path);
const inboxRouteSection = (method, path) => routeIn(inbox, method, path);

test("auto-deploy docs describe cadence, scoped draining, and target refresh", () => {
  const runners = routeIn(serviceStatus, "GET", "/runners").text;
  const claims = sessions;

  for (const source of [serviceStatus, quietWindowRunbook]) {
    assert.match(source, /AUTO_DEPLOY_MIN_INTERVAL_MINUTES[\s\S]*240 minutes/u);
    assert.match(source, /shared\/\.env/u);
    assert.match(source, /NOOP coalescing next-eligible=/u);
    assert.match(source, /blockers=0[\s\S]*early/u);
  }
  assert.match(quietWindowRunbook, /wait budget[\s\S]*dispatch drain[\s\S]*only after the interval/u);
  assert.match(quietWindowRunbook, /自动部署等待超时，已开始排空派发/u);
  assert.match(quietWindowRunbook, /lastSuccessfulAutomaticDeployAt/u);
  assert.match(quietWindowRunbook, /runner-only host retains its existing `\/version` follow behavior/u);
  assert.match(serviceStatus, /runner-only deployment retains its existing `\/version`\s+follow behavior/u);
  assert.match(serviceStatus, /control-plane[\s\S]*re-reads\s*`origin\/main`[\s\S]*target-advanced/u);
  assert.match(runners, /only claims that would start an agent session[\s\S]*mechanical merge/u);
  assert.match(claims, /only a[\s\S]*candidate agent Run[\s\S]*agent session/u);
  assert.match(claims, /template[\s\S]*Step kind, not from runner identity/u);
  assert.match(claims, /merge-result[\s\S]*merge-authorization/u);
  assert.match(claims, /dispatch-draining/u);
});

test("POST /projects documents bootstrap rows, canonical roles/template, and slug refusal", () => {
  const { text } = routeIn(projects, "POST", "/projects");
  assert.match(text, /one\s+`local`\s+Environment[\s\S]*`OPEN`[\s\S]*`allowedHosts`/u);
  for (const role of [
    "senior-dev-luna-max",
    "code-reviewer-sol-high",
    "code-reviewer-opus-medium",
    "senior-dev-astra-low",
  ]) {
    assert.match(text, new RegExp("`" + role + "`", "u"));
  }
  assert.match(text, /canonical\s+`pr-engineer-workflow`\s+TaskTemplate/u);
  assert.match(text, /409\s+Conflict[\s\S]*`project-slug-taken`/u);
});

test("POST /projects/:projectId/repos documents onboarding, preflight, grants, and response shapes", () => {
  const { text } = repositoryRouteSection("POST", "/projects/:projectId/repos");
  assert.match(text, /Required JSON fields:[\s\S]*`name`[\s\S]*`remoteUrl`[\s\S]*`dependencyProvisioning`/u);
  assert.match(text, /`dependencyProvisioning` must be exactly `NONE` or `NPM_CI`/u);
  assert.match(text, /\{\s*"error": "Repository dependency provisioning is invalid",\s*"code": "repository-dependency-provisioning-invalid"\s*\}/u);
  assert.match(text, /raw submitted string before any trim or\s*transform/iu);
  for (const accepted of ["HTTPS without userinfo", "scp-like SSH", "local `file:///` remotes"]) {
    assert.match(text, new RegExp(accepted.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  for (const rejected of [
    "whitespace",
    "control characters",
    "query/fragment data",
    "option-like values",
    "unsupported schemes",
    "SSH accounts",
    "missing hosts or paths",
    "values over the maximum length",
  ]) {
    assert.match(text, new RegExp(rejected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s*"), "u"));
  }
  assert.match(text, /onboarding's SSH-account\s*restriction/iu);
  assert.match(text, /`defaultBranch` is defaulted to `main`[\s\S]*`isValidBranchName`/u);
  assert.match(text, /\{\s*"error": "Repository remote is invalid",\s*"code": "repository-remote-invalid",\s*"reason": "<parseRepoRemote rejection reason>"\s*\}/u);
  assert.match(text, /\{\s*"error": "Repository default branch is invalid",\s*"code": "repository-default-branch-invalid"\s*\}/u);
  assert.match(text, /\{\s*"error": "Unique constraint violated"\s*\}/u);
  assert.match(text, /\{\s*"error": "Repository preflight failed",\s*"code": "repository-preflight-failed",\s*"reason": "<existing failure reason>"\s*\}/u);
  assert.match(text, /`NPM_CI`[\s\S]*regular root `package-lock\.json`[\s\S]*exact fetched default\s*branch commit/iu);
  assert.match(text, /\{\s*"error": "Repository preflight failed",\s*"code": "repository-package-lock-missing",\s*"remedy": "Commit package-lock\.json at the repository root on the default branch, or choose dependencyProvisioning NONE\."\s*\}/u);
  assert.match(text, /\{\s*"error": "Repository dependency provisioning contradicts lockfile",\s*"code": "repository-dependency-provisioning-contradicts-lockfile",\s*"remedy": "Choose dependencyProvisioning NPM_CI for repositories with a root package-lock\.json\."\s*\}/u);
  assert.match(text, /both this route and\s*`PATCH \/repos\/:repoId`/iu);
  for (const reason of [
    "git-unavailable",
    "git-identity-missing",
    "remote-unreachable",
    "default-branch-missing",
    "push-not-authorized",
    "command-timeout",
  ]) {
    assert.match(text, new RegExp("`" + reason + "`", "u"));
  }
  assert.match(text, /before the database transaction opens/iu);
  assert.match(text, /API host's ambient Git identity and credentials/iu);
  assert.match(text, /never receives,\s*reads, or decrypts `credentialSecretId`/iu);
  assert.match(text, /`grantAgents`/u);
  assert.match(text, /one `GIT_WRITE` `AgentRepoAccess`[\s\S]*active Project Agent/u);
  assert.match(text, /except `INTEGRATOR_AGENT_NAME`/u);
  assert.match(text, /201 Created[\s\S]*created Repo row itself[\s\S]*creates no grants/u);
  assert.match(text, /201 Created[\s\S]*\{ "repo": <created Repo row>, "grants": <created access rows> \}/u);
  assert.match(text, /rolls back the Repo and all grants/iu);
});

test("PATCH /repos/:repoId documents the optional dependency policy and exact refusal", () => {
  const { text } = repositoryRouteSection("PATCH", "/repos/:repoId");
  assert.match(text, /`dependencyProvisioning` is optional and patchable/iu);
  assert.match(text, /exactly `NONE` or `NPM_CI`/u);
  assert.match(text, /omission preserves the stored value/iu);
  assert.match(text, /\{\s*"error": "Repository dependency provisioning is invalid",\s*"code": "repository-dependency-provisioning-invalid"\s*\}/u);
  assert.match(text, /stored `remoteUrl` and\s*`defaultBranch`[\s\S]*same patch/iu);
  assert.match(text, /\{\s*"error": "Resource not found"\s*\}/u);
  assert.match(text, /\{\s*"error": "Repository remote is invalid",\s*"code": "repository-remote-invalid",\s*"reason": "<parseRepoRemote rejection reason>"\s*\}/u);
  assert.match(text, /\{\s*"error": "Repository default branch is invalid",\s*"code": "repository-default-branch-invalid"\s*\}/u);
  assert.match(text, /\{\s*"error": "Repository preflight failed",\s*"code": "repository-preflight-failed",\s*"reason": "<existing failure reason>"\s*\}/u);
  for (const reason of [
    "git-unavailable",
    "git-identity-missing",
    "remote-unreachable",
    "default-branch-missing",
    "push-not-authorized",
    "command-timeout",
  ]) {
    assert.match(text, new RegExp("`" + reason + "`", "u"));
  }
  assert.match(text, /\{\s*"error": "Repository preflight failed",\s*"code": "repository-package-lock-missing",\s*"remedy": "Commit package-lock\.json at the repository root on the default branch, or choose dependencyProvisioning NONE\."\s*\}/u);
  assert.match(text, /\{\s*"error": "Repository dependency provisioning contradicts lockfile",\s*"code": "repository-dependency-provisioning-contradicts-lockfile",\s*"remedy": "Choose dependencyProvisioning NPM_CI for repositories with a root package-lock\.json\."\s*\}/u);
});

test("Inbox list and summary document shared Project-plus-global scope", () => {
  const list = inboxRouteSection("GET", "/inbox/messages").text;
  const summary = inboxRouteSection("GET", "/inbox/messages/summary").text;
  for (const text of [list, summary]) {
    assert.match(text, /Optional query parameter: `projectId`/u);
    assert.match(text, /Agent, Task, Goal, or\s*Session belongs to that Project/iu);
    assert.match(text, /relation ids are\s*all\s*`null`|all four[\s\S]*relation ids are\s*`null`/iu);
    assert.match(text, /(?:no|with\s*no)\s*`projectId`[\s\S]*unfiltered by\s*Project/iu);
  }
  assert.match(list, /retains top-level-message\s*behavior/iu);
  assert.match(summary, /open, top-level,\s*needs-reply rule/iu);
  assert.match(summary, /\{ "needsReply": number \}/u);
});

test("the add-project runbook and public links cover A1 pull-request onboarding", () => {
  assert.match(addProjectRunbook, /POST "\$BASE_URL\/projects"/u);
  assert.match(addProjectRunbook, /`local` Environment[\s\S]*four[\s\S]*`senior-dev-luna-max`[\s\S]*`code-reviewer-sol-high`[\s\S]*`code-reviewer-opus-medium`[\s\S]*`senior-dev-astra-low`/u);
  assert.match(addProjectRunbook, /`pr-engineer-workflow`/u);
  assert.match(addProjectRunbook, /POST "\$BASE_URL\/projects\/\$PROJECT_ID\/repos"/u);
  assert.match(addProjectRunbook, /"grantAgents":true/u);
  assert.match(addProjectRunbook, /"dependencyProvisioning":"NPM_CI"/u);
  assert.match(addProjectRunbook, /Choose `NPM_CI` only for repositories whose default branch has a root\s*`package-lock\.json`; otherwise choose `NONE`\./u);
  assert.match(addProjectRunbook, /GET "\$BASE_URL\/projects\/\$PROJECT_ID\/repos"/u);
  assert.match(addProjectRunbook, /GET "\$BASE_URL\/projects\/\$PROJECT_ID\/task-templates"/u);
  assert.match(addProjectRunbook, /POST[\s\S]*\/projects\/\$PROJECT_ID\/task-templates\/\$TEMPLATE_ID\/instantiate/u);
  assert.match(addProjectRunbook, /"repoId"[\s\S]*"variables"[\s\S]*"branchName"/u);
  assert.match(addProjectRunbook, /--arg name "\$CHAIN_NAME"/u);
  assert.match(addProjectRunbook, /"name":\$name/u);
  assert.match(addProjectRunbook, /--arg name "\$PROJECT_NAME"/u);
  assert.match(addProjectRunbook, /--arg slug "\$PROJECT_SLUG"/u);
  assert.match(addProjectRunbook, /--arg name "\$REPO_NAME"/u);
  assert.match(addProjectRunbook, /--arg remoteUrl "\$REPO_REMOTE"/u);
  assert.match(addProjectRunbook, /select\(\.name == \$name\)/u);
  assert.match(addProjectRunbook, /gh repo view "\$REPO_REMOTE"/u);
  assert.match(addProjectRunbook, /gh pr list --repo "\$GH_REPO"/u);
  assert.match(addProjectRunbook, /git config --global --get user\.name/u);
  assert.match(addProjectRunbook, /git config --global --get user\.email/u);
  assert.match(addProjectRunbook, /review[\s\S]*merge it by hand/iu);
  for (const prerequisite of [
    "supported GitHub remote",
    "GitHub CLI \(`gh`\) installed and authenticated",
    "Codex, Pi, and Claude Code runtimes installed and authenticated",
  ]) {
    assert.match(addProjectRunbook, new RegExp(prerequisite.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(readme, /\[Add a project\]\(docs\/runbooks\/add-a-project\.md\)/u);
  assert.match(installDocument, /\[Add a project\]\(runbooks\/add-a-project\.md\)/u);
  assert.ok(
    snapshotManifest.include.some((entry) => entry.glob === "docs/runbooks/add-a-project.md"),
    "public-snapshot.json must include the add-project runbook by exact name",
  );
});

test("the template clone route documents its contract, refusals, and example", () => {
  const { text } = templateRouteSection("POST", "/projects/:projectId/task-templates/:templateId/clone");
  assert.match(text, /Required path parameters: `projectId`, `templateId`/u);
  assert.match(text, /Required JSON field: `name`/u);
  assert.match(text, /Optional JSON field: `description`/u);
  assert.match(text, /201 Created/u);
  assert.match(text, /404[\s\S]*`template_not_in_project`/u);
  assert.match(text, /409[\s\S]*`template_name_taken`/u);
  assert.match(text, /409[\s\S]*`template_name_reserved`/u);
  assert.match(text, /curl -X POST "\$BASE_URL\/projects\/\$PROJECT_ID\/task-templates\/\$TEMPLATE_ID\/clone"/u);
});

test("the canonical PR workflow documents its clean-tree and five-section handover", () => {
  const marker = "### Canonical `pr-engineer-workflow` pull-request handover\n";
  const start = handbook.indexOf(marker);
  assert.notEqual(start, -1, "operator handbook must document the canonical PR workflow handover");
  const end = handbook.indexOf("\n### GET ", start + marker.length);
  const text = handbook.slice(start, end === -1 ? handbook.length : end);

  assert.match(text, /exact-name scoped[\s\S]*custom and retired[\s\S]*direct or compound/u);
  assert.match(text, /\.chain\/<branchName>\/spec\.md[\s\S]*pinned specification/u);
  assert.match(text, /complete tracked `\.chain\/` directory[\s\S]*commits[\s\S]*on top of the reviewed history/u);
  assert.match(text, /persists `fixed-implementation`[\s\S]*refuses to publish[\s\S]*tracked[\s\S]*`\.chain\/`/u);
  assert.match(text, /retry[\s\S]*already-clean[\s\S]*without creating another cleanup commit/u);
  assert.match(text, /final\s+Task output, completion head, pushed head, and pull-request\s+head[\s\S]*same cleanup commit/u);

  const sectionHeadings = ["Goal", "Summary", "Verification", "Review outcomes", "Anneal"];
  let previous = -1;
  for (const heading of sectionHeadings) {
    const position = text.indexOf(`\`${heading}\``);
    assert.ok(position > previous, `handover body sections must list ${heading} in order`);
    previous = position;
  }
  assert.match(text, /Goal` is exactly the first line of the Task description/u);
  assert.match(text, /Summary` uses the implementation output's `summary`/u);
  assert.match(text, /closedFindings\.codeEvidence/u);
  assert.match(text, /Verification` renders the implementation and fixed-step `testsRun` entries\s+verbatim/u);
  assert.match(text, /exact command and its observed exit\/result\s+summary/u);
  assert.match(text, /`No commands reported in the task\s+output\.`/u);
  assert.match(text, /`Not available at this step\.`/u);
  assert.match(text, /Review outcomes`\s+initially[\s\S]*code review and blind code review finding[\s\S]*id,\s+severity,\s+and\s+title/u);
  assert.match(text, /fixed output's `residualRisks`/u);
  assert.match(text, /Anneal` contains the current Task id and non-null Chain id/u);
  assert.match(text, /already-open[\s\S]*same initial body[\s\S]*reads the body back exactly/u);
  assert.match(text, /exactly these\s+five sections, in order[\s\S]*no provider-generated or activity-log prose/u);
});

test("the handbook documents the machine-only, run-bound decided output evidence", () => {
  const marker = "The machine-only `/session/runs/:runId/status` projection is run-bound";
  const start = handbook.indexOf(marker);
  assert.notEqual(start, -1, "operator handbook must document the decided output evidence");
  const end = handbook.indexOf("\nThe machine-only `POST /runner/runs/:runId/complete`", start + marker.length);
  const text = handbook.slice(start, end === -1 ? handbook.length : end);

  assert.match(text, /not an operator read route/u);
  assert.match(text, /the runner reads it rather than\s+re-deciding anything/u);
  for (const satisfaction of ["delivered", "not-required", "satisfied-by-prior-run", "absent"]) {
    assert.match(text, new RegExp(`\`${satisfaction}\``, "u"));
  }
  for (const handoff of ["not-a-pr-delivery", "complete", "incomplete"]) {
    assert.match(text, new RegExp(`\`${handoff}\``, "u"));
  }
  for (const field of ["Task id", "chain index", "output kind", "body", "commit SHA", "projectId", "chainId"]) {
    assert.match(text, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(text, /implementation delivery\s+receives only its current `implementation` entry/u);
  assert.match(text, /final delivery receives\s+exactly `implementation`, `review-findings`, `blind-findings`, and\s+`fixed-implementation`, in chain order/u);
  assert.match(text, /does not widen prompt `priorOutputs`, expose sibling evidence to a blind\s+review/u);
  assert.match(text, /derive text from provider output, activity prose, or repository\s+contents/u);
  assert.match(text, /source is persisted task output[\s\S]*claimed session\/run identity/u);
  assert.match(text, /out-of-order\s+or missing evidence makes the handoff `incomplete` rather than being silently\s+omitted or guessed, and delivery fails instead of publishing/u);
});

test("the template step replace route documents its contract, refusals, warnings, and example", () => {
  const { text } = templateRouteSection("PUT", "/projects/:projectId/task-templates/:templateId/steps");
  assert.match(text, /Required path parameters: `projectId`, `templateId`/u);
  assert.match(text, /Required JSON field: `steps`/u);
  assert.match(text, /Each Step.*`name`.*`assigneeType`.*`baseFromStepIndex`/su);
  assert.match(text, /200 OK/u);
  assert.match(text, /404[\s\S]*`template_not_in_project`/u);
  assert.match(text, /409[\s\S]*`template_canonical`/u);
  assert.match(text, /409[\s\S]*`template_in_use`/u);
  assert.match(text, /422[\s\S]*`graph_empty`/u);
  for (const code of [
    "first_step_not_agent",
    "first_layer_not_single",
    "layer_order_invalid",
    "base_step_invalid",
    "prior_kind_unproduced",
    "output_kind_duplicate",
    "prior_kind_duplicate",
    "approval_gate_in_parallel_layer",
    "assignee_invalid",
    "integrator_binding_invalid",
  ]) {
    assert.match(text, new RegExp("422[\\s\\S]*`" + code + "`", "u"));
  }
  assert.match(text, /`no_review_step`/u);
  assert.match(text, /`same_agent_implements_and_reviews`/u);
  assert.match(text, /`pull_request_without_regression`/u);
  assert.match(text, /clone again/iu);
  assert.match(text, /curl -X PUT "\$BASE_URL\/projects\/\$PROJECT_ID\/task-templates\/\$TEMPLATE_ID\/steps"/u);
});

test("the Chain read route documents the control projection and never-held value", () => {
  const { text } = routeSection("GET", "/tasks/:taskId/chain");
  assert.match(text, /control[` ]+object/u);
  assert.match(text, /`state`/u);
  assert.match(text, /`heldLayer`/u);
  assert.match(text, /`heldAt`/u);
  assert.match(text, /`holdReason`/u);
  assert.match(text, /`holdRequestId`/u);
  assert.match(text, /`releasedAt`/u);
  assert.match(text, /`holdRefusal`/u);
  assert.match(text, /null[^.]*never[^.]*held/iu);
});

test("Hold and Resume routes document their request contracts, outcomes, and examples", () => {
  const hold = routeSection("POST", "/tasks/:taskId/chain/hold");
  const resume = routeSection("POST", "/tasks/:taskId/chain/resume");

  assert.match(hold.text, /Required path parameter: `taskId`/u);
  assert.match(hold.text, /Required JSON field: `requestId`/u);
  assert.match(hold.text, /Optional JSON field: `reason`/u);
  assert.match(hold.text, /already held[\s\S]*success[\s\S]*(?:no-op|no transition)/iu);
  assert.match(hold.text, /404[^\n]*task does not exist/iu);
  assert.match(hold.text, /409[\s\S]*(?:no chain|every task|complete)/iu);
  assert.match(hold.text, /curl -X POST "\$BASE_URL\/tasks\/\$TASK_ID\/chain\/hold"/u);

  assert.match(resume.text, /Required path parameter: `taskId`/u);
  assert.match(resume.text, /Required JSON field: `requestId`/u);
  assert.match(resume.text, /not held[\s\S]*success[\s\S]*(?:no-op|no transition)/iu);
  assert.match(resume.text, /404[^\n]*task does not exist/iu);
  assert.match(resume.text, /409[\s\S]*no chain/iu);
  assert.match(resume.text, /curl -X POST "\$BASE_URL\/tasks\/\$TASK_ID\/chain\/resume"/u);
});

test("Chain hold and resume entries follow route-registration order", () => {
  const chain = routeSection("GET", "/tasks/:taskId/chain");
  const hold = routeSection("POST", "/tasks/:taskId/chain/hold");
  const resume = routeSection("POST", "/tasks/:taskId/chain/resume");
  const patch = routeSection("PATCH", "/tasks/:taskId");

  assert.ok(chain.start < hold.start, "Hold follows the Chain read route");
  assert.ok(hold.start < resume.start, "Resume follows Hold");
  assert.ok(resume.start < patch.start, "both Chain controls precede PATCH");
});
