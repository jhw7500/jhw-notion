# Task Scope Guard 1: Work Contracts and Task Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every newly claimed Task an immutable, machine-readable Work Contract and support independent parent/child Tasks in one repository without changing the Issue-to-parent identity.

**Architecture:** Add a closed contract vocabulary beside the existing Registry schemas, keep legacy records readable but ineligible for new Claims, and make Claim acquisition the atomic point that freezes the contract, enforces one Task per session, and rejects active exclusive-resource conflicts. Child records derive their parent relationship without receiving a GitHub source index or inherited grants.

**Tech Stack:** TypeScript 5.5 strict ESM, Zod, Node.js crypto, existing Registry Git transaction layer, Vitest

**Spec:** `docs/superpowers/specs/2026-08-25-task-scope-guard-design.md`

## Global Constraints

- This is plan 1 of 6. Complete it before the Guard, hook adapters, or execution wrappers.
- Preserve all canonical Task, Claim, Project, Repository, and Issue source identities.
- Keep legacy Task and Claim records parseable for read-only status; never infer a contract from `expected_scope`.
- Every new Task record stores `task_role` and `work_contract`; every new Claim stores a normalized contract snapshot and digest.
- A formal Issue source index points only to the formal parent/standalone Task. Child Tasks never receive a source index.
- Parent/child depth is exactly one. A child cannot parent another child.
- Dependencies are visibility metadata only. No code path may turn a dependency into a grant.
- Repository grants normally use `coordination: shared`; either side declaring an exact resource `exclusive` blocks simultaneous Claims.
- `shell.unclassified` is part of the operation vocabulary but is rejected by the persisted Work Contract schema.
- Resource aliases, wildcards, prefix matching, free-text paths, IP addresses, and device addresses are not contract identities.
- Initial authority supports repository, parent Issue, configured Notion database, and registered board resources. Standalone `remote_host`, `firmware_target`, and `deployment_target` contracts fail with `RESOURCE_AUTHORITY_UNSUPPORTED`; later board-scoped execution binds those capabilities to the board resource.
- Keep ESM imports suffixed with `.js`, use named exports, and write tests before production changes.
- Run `npm run build`, `npm run typecheck`, and `npm test`; none is substitutable for another.
- Do not stage or commit the approved design document or unrelated user changes with implementation commits.

---

### Task 1: Define the closed Work Contract vocabulary and deterministic digest

**Files:**
- Create: `mcp-server/src/control/work-contract.ts`
- Create: `mcp-server/src/control/__tests__/work-contract.test.ts`
- Modify: `mcp-server/src/control/schemas.ts`

**Interfaces:**
- Produces: `CapabilitySchema`, `PersistedCapabilitySchema`, `ResourceRefSchema`, `WorkGrantSchema`, `TaskDependencySchema`, and `WorkContractSchema`.
- Produces: `normalizeWorkContract(contract): WorkContract`.
- Produces: `workContractDigest(contract): string`, a lowercase SHA-256 digest of normalized JSON.
- Produces: `conflictingExclusiveGrant(left, right): WorkGrant | undefined`.
- Preserves: `shell.unclassified` can be used by Guard operations but not parsed as a persistent grant.

- [ ] **Step 1: Write failing vocabulary and normalization tests**

Create tests that pin the exact vocabulary and reject unknown fields, aliases, wildcards, duplicate grants, self-dependencies, and persistent `shell.unclassified`:

```ts
import { describe, expect, it } from "vitest";
import {
  WorkContractSchema,
  normalizeWorkContract,
  workContractDigest,
} from "../work-contract.js";

const taskId = "tsk-018f21e0-7b2c-7a00-8000-000000000001";

it("normalizes exact grants and dependencies before hashing", () => {
  const input = {
    version: 1 as const,
    task_id: taskId,
    grants: [
      {
        capability: "git.commit",
        resource: { kind: "repository", id: "repo-wlan-package" },
        coordination: "shared",
      },
      {
        capability: "repo.modify",
        resource: { kind: "repository", id: "repo-wlan-package" },
        coordination: "shared",
      },
    ],
    dependencies: [],
  };
  const reversed = { ...input, grants: [...input.grants].reverse() };
  expect(normalizeWorkContract(input)).toEqual(normalizeWorkContract(reversed));
  expect(workContractDigest(input)).toBe(workContractDigest(reversed));
});

it("does not persist the unknown-shell sentinel", () => {
  expect(WorkContractSchema.safeParse({
    version: 1,
    task_id: taskId,
    grants: [{
      capability: "shell.unclassified",
      resource: { kind: "repository", id: "repo-wlan-package" },
      coordination: "shared",
    }],
    dependencies: [],
  }).success).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd mcp-server
npx vitest run src/control/__tests__/work-contract.test.ts
```

Expected: FAIL because `work-contract.ts` does not exist.

- [ ] **Step 3: Implement exact schemas and capability/resource compatibility**

Define these immutable tuples and derive Zod enums from them:

```ts
export const CAPABILITIES = [
  "repo.inspect", "repo.modify", "git.commit", "git.publish",
  "tracker.mutate", "notion.mutate", "test.host",
  "board.observe", "board.execute", "remote.execute",
  "firmware.change", "deploy.execute", "integration.perform",
  "shell.unclassified",
] as const;

export const PERSISTED_CAPABILITIES = [
  "repo.inspect", "repo.modify", "git.commit", "git.publish",
  "tracker.mutate", "notion.mutate", "test.host",
  "board.observe", "board.execute", "remote.execute",
  "firmware.change", "deploy.execute", "integration.perform",
] as const;

export const RESOURCE_KINDS = [
  "repository", "issue", "notion_database", "board",
  "remote_host", "firmware_target", "deployment_target",
] as const;
```

Use a strict discriminated union for resource IDs:

- `repository`: `repo-[a-z0-9][a-z0-9-]{1,62}`
- `issue`: bounded GitHub node ID, maximum 128 UTF-8 bytes
- `notion_database`: `decisionLog | preferences | projects | references | knowledgeBase`
- `board`: `[a-z0-9][a-z0-9-]{1,62}`
- `remote_host`: `rhost-[a-z0-9][a-z0-9-]{1,62}`
- `firmware_target`: `fwt-[a-z0-9][a-z0-9-]{1,62}`
- `deployment_target`: `dpl-[a-z0-9][a-z0-9-]{1,62}`

Pin capability/resource compatibility in one exported table. In the initial release:

- repository: repository and Git capabilities, `test.host`, `integration.perform`
- issue: `tracker.mutate`
- notion database: `notion.mutate`
- board: `board.observe`, `board.execute`, `remote.execute`, `firmware.change`
- remote host: `remote.execute`
- firmware target: `firmware.change`
- deployment target: `deploy.execute`

Reject duplicate `(capability, resource.kind, resource.id)` tuples even when their coordination differs. Sort grants by capability, kind, ID, and coordination; sort dependencies by relation and Task ID.

- [ ] **Step 4: Implement deterministic digest and exclusive-conflict comparison**

```ts
export function workContractDigest(value: unknown): string {
  const normalized = normalizeWorkContract(value);
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

export function conflictingExclusiveGrant(
  left: WorkContract,
  right: WorkContract,
): WorkGrant | undefined {
  return left.grants.find((grant) => right.grants.some((candidate) =>
    grant.resource.kind === candidate.resource.kind &&
    grant.resource.id === candidate.resource.id &&
    (grant.coordination === "exclusive" || candidate.coordination === "exclusive")));
}
```

The comparison is by exact canonical resource, not capability. This intentionally blocks a shared observer when another active Task has assigned that resource exclusively.

- [ ] **Step 5: Verify GREEN and the full type gate**

Run:

```bash
cd mcp-server
npx vitest run src/control/__tests__/work-contract.test.ts
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the contract primitives**

```bash
git add mcp-server/src/control/work-contract.ts \
        mcp-server/src/control/schemas.ts \
        mcp-server/src/control/__tests__/work-contract.test.ts
git commit -m "feat(control): define task work contracts"
```

---

### Task 2: Add standalone/parent/child records and authority-checked contract registration

**Files:**
- Create: `mcp-server/src/control/contract-authority.ts`
- Create: `mcp-server/src/control/registry-paths.ts`
- Create: `mcp-server/src/control/__tests__/contract-authority.test.ts`
- Modify: `mcp-server/src/control/schemas.ts`
- Modify: `mcp-server/src/control/catalog.ts`
- Modify: `mcp-server/src/control/github-source.ts`
- Modify: `mcp-server/src/control/__tests__/catalog.test.ts`
- Modify: `mcp-server/src/control/__tests__/helpers.ts`

**Interfaces:**
- Produces: `TaskRoleSchema = z.enum(["standalone", "parent"])`.
- Produces: `ChildTaskSchema` with `parent_task_id`, `required_for_parent`, goal, done conditions, lifecycle, and mandatory contract.
- Produces: `Catalog.registerChildTask(input)`, `Catalog.listChildren(parentTaskId)`, and `Catalog.configureInactiveTask(input)`.
- Produces: `ControlContractAuthority.assertKnownContract(taskContext, contract)`.
- Produces shared path helpers `activeClaimRelativePath(taskId)` and `taskRelativePath(taskId)`.

- [ ] **Step 1: Write failing parent/child and migration tests**

Cover these cases before changing schemas:

1. New formal and temporary Tasks require an explicit contract and store `task_role: "standalone"`.
2. A formal Task can be created or configured as `parent`.
3. A child derives project/repository from a formal parent and has no source index.
4. A child of a child fails with `TASK_CHILD_DEPTH_EXCEEDED`.
5. Child contract grants are exactly those supplied; parent grants are not copied.
6. Dependencies remain present only under `work_contract.dependencies`.
7. A legacy formal/temporary Task without role/contract still parses, but `configureInactiveTask` writes both fields.
8. Configuration while `claims/active/<task>.yaml` exists fails with `TASK_CONTRACT_ACTIVE`.
9. Source-index audit accepts child records with no source index and still requires one exact index for every formal record.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/catalog.test.ts \
  src/control/__tests__/contract-authority.test.ts
```

Expected: FAIL on missing child/configuration interfaces.

- [ ] **Step 3: Extend Task schemas with explicit compatibility boundaries**

Keep legacy parsing deliberate:

```ts
const legacyCompatibleTaskConfiguration = {
  task_role: TaskRoleSchema.optional(),
  work_contract: WorkContractSchema.optional(),
};

export const ChildTaskSchema = z.object({
  ...taskBase,
  kind: z.literal("child"),
  parent_task_id: canonicalId("tsk"),
  required_for_parent: z.boolean(),
  goal: boundedUtf8(32 * 1024),
  done_conditions: z.array(boundedUtf8(256)).min(1).max(32),
  lifecycle: TemporaryLifecycleSchema,
  work_contract: WorkContractSchema,
}).strict();
```

Add a refinement requiring `work_contract.task_id === task.id`. Formal and temporary records accept optional role/contract only to read legacy bytes; catalog creation paths must call a helper that rejects omission with `TASK_CONTRACT_REQUIRED`.

Do not add `issue_node_id`, `issue_url`, or a formal-source alias to `ChildTaskSchema`.

- [ ] **Step 4: Centralize Registry paths and implement inactive configuration**

Move the active-Claim and Task record path constructors to `registry-paths.ts` so Catalog and ClaimService use one spelling. Implement:

```ts
export interface ConfigureTaskInput {
  task_id: string;
  task_role: "standalone" | "parent";
  work_contract: WorkContract;
}

async configureInactiveTask(input: ConfigureTaskInput): Promise<TaskRecord>
```

Inside one Registry transaction:

1. Read and strictly validate the Task.
2. Refuse child role changes.
3. Refuse `parent` for a non-formal Task.
4. Check the active-Claim path before writing.
5. Require contract Task ID equality.
6. Preserve source identity, aliases, and legacy `expected_scope`.
7. Write only the canonical Task record path.

- [ ] **Step 5: Implement child registration and source-index audit rules**

`registerChildTask` must:

- require a formal `parent` Task;
- derive `project_id` and `repo_id` from the parent;
- default missing CLI `required_for_parent` to true before calling Catalog, while Catalog itself requires a boolean;
- require a unique bounded alias;
- reject self-dependencies and dependencies on unknown Tasks;
- write only `tasks/<child-id>.yaml`;
- never create or modify `tasks/by-source/*`.

`listChildren` must enumerate bounded Task records, filter exact `parent_task_id`, sort by Task ID, and fail closed on malformed entries.

- [ ] **Step 6: Validate contract resources against existing authority**

Implement `ControlContractAuthority` with injected ports:

```ts
export interface ContractAuthorityPorts {
  getRepository(repoId: string): Promise<RepositoryRecord>;
  getTask(taskId: string): Promise<TaskRecord>;
  boardStatus(boardId: string): Promise<unknown>;
}
```

Rules:

- repository resource must equal the Task's `repo_id` and resolve through Catalog;
- issue resource must equal the formal Task's Issue node ID, or the formal parent Issue node ID for a child;
- Notion database IDs are already the closed configured logical IDs;
- board resource must resolve through `BoardService.status(boardId)`;
- standalone remote/firmware/deployment resource kinds return `RESOURCE_AUTHORITY_UNSUPPORTED`;
- every dependency Task must exist, cannot be self, and does not alter grants.

Call this authority before every new registration/configuration. Recheck it later in Guard evaluation because Registry and host-local board state are not one transaction.

- [ ] **Step 7: Verify tests and commit topology support**

Run:

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/work-contract.test.ts \
  src/control/__tests__/contract-authority.test.ts \
  src/control/__tests__/catalog.test.ts
npm run build
npm run typecheck
```

Then commit:

```bash
git add mcp-server/src/control \
        mcp-server/src/control/__tests__
git commit -m "feat(control): support parent and child tasks"
```

---

### Task 3: Freeze contracts in Claims and reject session/resource collisions atomically

**Files:**
- Modify: `mcp-server/src/control/claim-service.ts`
- Modify: `mcp-server/src/control/task-service.ts`
- Modify: `mcp-server/src/control/worktree.ts`
- Modify: `mcp-server/src/control/schemas.ts`
- Modify: `mcp-server/src/control/__tests__/claim-service.test.ts`
- Modify: `mcp-server/src/control/__tests__/task-service.test.ts`
- Modify: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`

**Interfaces:**
- Produces: `ContractActiveClaimSchema` and legacy-compatible `ActiveClaimSchema`.
- Changes: `ClaimService.claimTask(input)` returns a Claim with `work_contract` and `work_contract_digest`.
- Produces: `ClaimService.resolveSessionClaim(sessionId, host)`.
- Enforces: one active Task Claim per exact session and no active exclusive-resource conflict.

- [ ] **Step 1: Write failing Claim invariant tests**

Add tests for:

- Claiming a legacy Task without a contract returns `TASK_CONTRACT_REQUIRED`.
- The Claim snapshot equals the normalized Task contract and its digest.
- Changing the Task record after Claim creation does not change the active Claim snapshot.
- The same session cannot claim a second Task and receives `TASK_SESSION_BUSY`.
- Two Tasks can claim the same repository when every matching grant is shared and worktrees differ.
- A board resource marked exclusive by either contract rejects the later Claim with `TASK_RESOURCE_CONFLICT`.
- A legacy active Claim makes new Claim acquisition fail closed with `ACTIVE_CLAIM_CONTRACT_REQUIRED`.
- `resolveSessionClaim` returns one exact Claim, undefined for none, and `REGISTRY_CORRUPT` for duplicate session ownership.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/claim-service.test.ts \
  src/control/__tests__/task-service.test.ts
```

Expected: FAIL on missing contract fields and collision checks.

- [ ] **Step 3: Add legacy-compatible and contract-bound Claim schemas**

Define one shared Claim base, then a union:

```ts
export const LegacyActiveClaimSchema = ActiveClaimBaseSchema.strict();
export const ContractActiveClaimSchema = ActiveClaimBaseSchema.extend({
  work_contract: WorkContractSchema,
  work_contract_digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const ActiveClaimSchema = z.union([
  ContractActiveClaimSchema,
  LegacyActiveClaimSchema,
]);
```

New Claim writes must use `ContractActiveClaimSchema`. Add optional legacy-compatible `work_contract_digest` to history parsing, but every newly released history copies the active Claim digest.

- [ ] **Step 4: Move revision and contract capture inside the Claim transaction**

In `claimTask`, perform this order while the Registry transaction is held:

1. Read the Task.
2. Require `task_role` and `work_contract`.
3. Verify contract Task ID.
4. Read the exact source revision.
5. Check the Task's own active Claim.
6. Enumerate all bounded active Claims.
7. Reject a different Task in the same session.
8. Reject any exact resource where either contract says exclusive.
9. Generate the Claim and persist the normalized snapshot/digest.

Do not accept contract data from `ClaimTaskInput`; the Registry Task record is the only source.

- [ ] **Step 5: Preserve worktree isolation without repository exclusivity**

Keep existing branch/worktree generation keyed by Task and Claim. Add an E2E fixture with two child Tasks under one formal parent, both granting:

```json
{
  "capability": "repo.modify",
  "resource": { "kind": "repository", "id": "repo-wlan-package" },
  "coordination": "shared"
}
```

Assert both Claims start, their branch and worktree coordinates differ, and each owner check succeeds only for its own Claim.

- [ ] **Step 6: Verify full Claim gates and commit**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/claim-service.test.ts \
  src/control/__tests__/task-service.test.ts \
  src/control/__tests__/phase1a.e2e.test.ts
npm run build
npm run typecheck
npm test
```

Then:

```bash
git add mcp-server/src/control
git commit -m "feat(control): bind claims to work contracts"
```

---

### Task 4: Enforce child lifecycle and record pre-close completion evidence

**Files:**
- Create: `mcp-server/src/control/task-completion.ts`
- Create: `mcp-server/src/control/__tests__/task-completion.test.ts`
- Modify: `mcp-server/src/control/schemas.ts`
- Modify: `mcp-server/src/control/catalog.ts`
- Modify: `mcp-server/src/control/claim-service.ts`
- Modify: `mcp-server/src/control/task-service.ts`
- Modify: `mcp-server/src/control/__tests__/claim-service.test.ts`
- Modify: `mcp-server/src/control/__tests__/task-service.test.ts`

**Interfaces:**
- Produces: `ChildDispositionSchema = z.enum(["superseded", "not-required", "accepted-risk"])`.
- Produces: `TaskCompletionEvidenceSchema` and `TaskCompletionEvidenceRecordSchema`.
- Produces: `assertParentCompletionReady(parent, children, evidence): void`.
- Produces: `TaskService.markCompletionReady(input)` for an active formal standalone/parent Claim.
- Produces: `TaskService.getCompletionEvidence(taskId, claimId)`.
- Changes: child `handoff` remains non-terminal; only `completed | abandoned` satisfies a required-child terminal gate.
- Persists: completion evidence before Issue close, bound to the still-active Claim; it is evidence, not GitHub Issue lifecycle.

- [ ] **Step 1: Write failing completion-evidence tests**

Pin these cases:

- Marking a parent ready with a required active or handoff child fails `PARENT_CHILDREN_INCOMPLETE`.
- A required abandoned child without one exact disposition fails `PARENT_DISPOSITION_REQUIRED`.
- A disposition for a completed or unknown child fails `INVALID_PARENT_COMPLETION`.
- Empty integration validation fails `PARENT_INTEGRATION_VALIDATION_REQUIRED`.
- Optional children may remain non-terminal.
- A formal standalone Task records validation with an empty disposition list.
- Evidence stores exact Task/Claim/contract digest and is immutable for that Claim.
- Evidence creation requires the active owner and does not close or mutate the GitHub Issue.
- Finishing/handoff before Issue close makes that evidence unusable by a later Claim.
- Completing a formal Claim requires its own completion-evidence record, but Claim release itself still does not close the Issue.
- Child `handoff` transitions lifecycle to `handoff`, and a later Claim can resume it.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/task-completion.test.ts \
  src/control/__tests__/claim-service.test.ts \
  src/control/__tests__/task-service.test.ts
```

- [ ] **Step 3: Define bounded evidence and its Claim binding**

```ts
export const TaskCompletionEvidenceSchema = z.object({
  integration_validation: z.array(boundedUtf8(512)).min(1).max(64),
  child_dispositions: z.array(z.object({
    task_id: canonicalId("tsk"),
    disposition: ChildDispositionSchema,
  }).strict()).max(64),
}).strict();

export const TaskCompletionEvidenceRecordSchema = z.object({
  version: z.literal(1),
  task_id: canonicalId("tsk"),
  claim_id: canonicalId("clm"),
  work_contract_digest: z.string().regex(/^[0-9a-f]{64}$/),
  recorded_at: OffsetDateTimeSchema,
  evidence: TaskCompletionEvidenceSchema,
}).strict();
```

Store records at `task-completion/<task-id>/<claim-id>.yaml`. Extend completed formal Claim history with a bounded pointer/digest to the matching evidence record; reject a pointer for non-completed history. The formal Task stays open until the later tracker execution boundary closes its Issue.

- [ ] **Step 4: Generalize lifecycle transitions for child Tasks**

Replace `transitionTemporaryLifecycle` with `transitionTaskLifecycle`:

- formal standalone/parent records do not carry the temporary lifecycle and return no Task-record mutation;
- temporary and child records transition through `active | handoff | completed | abandoned`;
- completed or abandoned child Tasks cannot be reclaimed;
- handoff remains reclaimable;
- every caller and test uses the renamed method.

- [ ] **Step 5: Record readiness while the formal Claim is still active**

For `markCompletionReady`:

1. Assert exact active Task/Claim ownership.
2. Require a formal standalone/parent Task.
3. Load bounded children through `Catalog.listChildren`.
4. For a parent, call `assertParentCompletionReady`; for standalone, require no child dispositions.
5. Persist an immutable evidence record bound to the active contract digest.
6. On exact retry, return the existing byte-identical record; reject changed evidence.

Before releasing a formal Claim as completed, require the matching evidence record and copy its pointer/digest into history. Temporary and child Tasks keep the existing outcome/validation rules and cannot supply formal completion evidence. Tracker close in plan 5 will require the same active Claim and record, so Issue closure and Claim release remain separate ordered events.

- [ ] **Step 6: Verify and commit parent gates**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/task-completion.test.ts \
  src/control/__tests__/claim-service.test.ts \
  src/control/__tests__/task-service.test.ts
npm run build
npm run typecheck
npm test
```

```bash
git add mcp-server/src/control
git commit -m "feat(control): gate parent task completion"
```

---

### Task 5: Expose contracts and child workflows in the CLI and operator skill

**Files:**
- Create: `mcp-server/src/control/work-contract-cli.ts`
- Create: `mcp-server/src/control/__tests__/work-contract-cli.test.ts`
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`
- Modify: `skills/claude/task.md`
- Regenerate: `skills/codex/jhw-task/SKILL.md`

**Interfaces:**
- Adds repeatable CLI syntax: `--grant capability:resource-kind:resource-id:shared|exclusive`.
- Adds repeatable CLI syntax: `--depends blocked_by|observes|integrates:tsk-...`.
- Adds: `task child-start`.
- Adds: `task contract` for inactive legacy migration or contract replacement.
- Adds: `task completion-ready --task --claim --integration-validation ... --child-disposition ...`.

- [ ] **Step 1: Write failing parser and CLI tests**

Test exact accepted commands and malformed variants:

```bash
jhw-control task child-start \
  --parent tsk-018f21e0-7b2c-7a00-8000-000000000001 \
  --alias local-hardening \
  --repo-path /srv/src/wlan-package \
  --goal "Harden local package changes" \
  --done "host tests pass" \
  --required-for-parent true \
  --grant repo.modify:repository:repo-wlan-package:shared \
  --grant git.commit:repository:repo-wlan-package:shared \
  --session codex-local-hardening
```

Also assert:

- missing grants fail before Registry mutation;
- `shell.unclassified` grant fails;
- duplicate grant flags normalize to a unique contract or fail on conflicting coordination;
- `--required-for-parent` accepts only exact `true | false`;
- existing `task start --task` rejects registration/contract flags;
- `task contract` fails while a Claim is active;
- completion-ready fields are rejected on ordinary finish and on child/temporary Tasks;
- completed formal finish requires the evidence record produced for the same Claim.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/work-contract-cli.test.ts \
  src/control/__tests__/cli.test.ts
```

- [ ] **Step 3: Implement strict repeated-flag parsers**

`work-contract-cli.ts` must split each grant into exactly four non-empty fields and each dependency into exactly two fields. It then validates through `WorkContractSchema`; it does not maintain a second vocabulary.

For a new formal/temporary `task start`:

- normalize omitted role to `standalone` and persist it;
- require at least one grant;
- keep `--scope` for temporary display/migration only;
- pass the contract through GitHubSourceService authority validation.

`task child-start` registers the child and immediately starts its Claim. If worktree creation fails, preserve the existing Claim recovery semantics.

- [ ] **Step 4: Add contract migration and parent completion-ready surfaces**

`task contract` requires:

```text
--task <tsk-id>
--role standalone|parent
--grant <repeatable>
--depends <repeatable, optional>
```

It never updates an active Claim. The operator must finish/handoff and start a new Claim to use changed grants.

Parse completion dispositions through the closed enum and pass them as structured evidence. Never parse evidence from free-text `--outcome`. `task completion-ready` records evidence but does not close the Issue or release the Claim.

- [ ] **Step 5: Update operator guidance and generated Codex skill**

Document:

- repository is a resource, not the Task unit;
- one session owns one active Task;
- same-repository child Tasks use separate Claims/worktrees;
- dependencies grant no capability;
- exact grant syntax and coordination meaning;
- contract changes require finish/configure/start;
- parent completion and disposition requirements;
- legacy `expected_scope` is not runtime authority.

Run:

```bash
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
```

- [ ] **Step 6: Run all repository gates**

```bash
cd mcp-server
npm run build
npm run typecheck
npm test
cd ..
node scripts/sync-codex-skills.mjs --check
git diff --check
```

Expected: all commands exit 0 and `git diff --check` emits no output.

- [ ] **Step 7: Commit the CLI and operator workflow**

```bash
git add mcp-server/src/control/cli.ts \
        mcp-server/src/control/work-contract-cli.ts \
        mcp-server/src/control/__tests__/cli.test.ts \
        mcp-server/src/control/__tests__/work-contract-cli.test.ts \
        skills/claude/task.md \
        skills/codex/jhw-task
git commit -m "feat(control): expose scoped child task workflows"
```

---

## Plan 1 completion gate

Before starting plan 2, demonstrate all of the following in tests and CLI output:

1. Two child Tasks in `repo-wlan-package` hold independent Claims/worktrees with shared repository grants.
2. A board-exclusive child prevents a second active Claim from assigning the same board.
3. A session cannot silently switch Tasks.
4. A Claim snapshot remains unchanged after its Task record is edited.
5. A legacy contractless Task/Claim is visible but cannot mutate or be newly claimed.
6. Parent completion fails without required-child terminal state, abandoned-child disposition, and integration validation.
7. The Issue source index still resolves to the original formal parent ID.
