# Video Production Workflow Foundation — Phase 1

Phase 1 extends the existing CEO Directive transport with `video_production`. `video_preprod` retains its existing execution behavior. No new package dependency, media generator, TTS, FFmpeg or Remotion integration was added. No production database was opened or migrated during implementation; tests use isolated databases. The additive migration runs when the application next starts.

## Usage

1. Send a CEO Directive beginning with `[video_production]`, selecting a project and its absolute path through the existing project dialog. Alternatively submit `/api/directives` with `workflow_pack_key: "video_production"`, `content`, and `project_path`. `/api/inbox` also supports the explicit pack for `$` directives under its existing webhook authentication.
2. Intake creates one project, one real planning task, nine persisted stage records and an immutable plan version. An empty selected project can be explicitly bound; an unrelated project with existing tasks cannot be converted.
3. The configured Production Manager owns planning. Selection uses the new pack's unique `team_leader` with `acts_as_planning_leader=1`. The default stable agent ID is `video_production-seed-5` (display name Dami). Names do not participate in routing. Ambiguous manager configuration fails closed.
4. Open Projects to view/edit Project Brief, Production Manager, Current Stage, Stage Status, Pending Approval and Production Plan. Brief fields are title, objective, targetAudience, duration, aspectRatio, language, style, deliveryPlatform and constraints. Constraints may be explicitly empty. Missing information remains missing; it is never invented from free-form text.
5. The manager's planning checkpoint is persisted and broadcast using existing messages. It is explicitly labeled an automatic template. CEO can complete the form or send the manager a structured conversation reply with the project context: `[VIDEO_BRIEF] {"expectedVersion":1,"brief":{"duration":"60s","aspectRatio":"9:16"}}`. Partial replies merge into the current brief and must match its version. Free-form conversation still uses the existing agent channel and never constitutes approval.
6. Once required fields are complete, the plan enters `WAITING_FOR_APPROVAL` (the existing Task Board status remains `inbox`, with a separate approval badge). Approve or Request Changes from Projects. Mutations require the application's authenticated CEO session plus CSRF validation. Actor/role fields from request bodies and webhook credentials do not authorize decisions.
7. Approval completes **Intake & Planning only**. All eight later stages remain `NOT_IMPLEMENTED` and have no fabricated task or output. No external worker launches. Editing a brief creates a new immutable plan version and invalidates the previous approval.

The nine stage definitions include owner roles, ordered dependencies, input/output requirements and approval requirements. In Phase 1, the plan is a deterministic, schema-validated foundation template owned by the manager; this change does not implement autonomous LLM brief extraction or creative planning.

## Persistence and execution policy

The idempotent startup migration adds six tables: `video_productions`, `video_production_stages`, `video_production_plan_versions`, `video_production_decisions`, `video_production_events`, and `video_production_slot`. It adds no legacy task status and does not rewrite legacy rows. Unique constraints bind one production to its source message/project and one stage to its task/order. Two partial unique indexes enforce a global maximum of one `RUNNING` production stage and one `in_progress` `video_production` task, without restricting other packs.

Existing message idempotency is reused across the two production directive endpoints. A deterministic request identity is used when no transport key is supplied; an intentional second intake requires a new key and a different project/path. Message storage precedes the synchronous transactional intake. A crash between them leaves a replayable message: retry repairs intake rather than skipping it. No timer is responsible for creating production tasks.

Versioned decisions are idempotent, stale decisions fail with 409, and edited plans require a fresh decision. Database transactions cover plan/stage/task changes. State and slot ownership survive reopening SQLite; restarting does not auto-approve or create another root task. Stage execution admission checks current approval, `READY`, predecessor completion and global slot ownership. Atomic reserve/release helpers exist for a future worker implementation.

All production launch paths are closed in Phase 1: generic `/run`, raw agent spawn, internal start, resume, direct-chat escalation and cross-department/subtask/report delegation. Generic task mutations cannot forge lifecycle metadata, reassign managed tasks, create unregistered production tasks or convert them into another pack. Production project identity and deletion are protected until an archive lifecycle is implemented. Task Board hides unsupported execution controls and directs CEO to Projects.

## Verification

- `pnpm run lint`: pass, 0 errors; 40 warnings in existing areas.
- `pnpm exec tsc -b --pretty false`: pass. There is no separate typecheck script in this repository.
- `pnpm run build`: pass; existing large-chunk/deprecation notices remain.
- `pnpm run test:api -- --run --maxWorkers=2`: 53 files, 247 tests pass.
- `pnpm run test:web -- --run --maxWorkers=2`: 28 files, 98 tests pass.
- `pnpm run openapi:check`: pass, 118 operations.
- `git diff --check`: pass.

The initial unconstrained backend run hit a legacy fixture writing `D:\tmp\project` outside the sandbox and a 5-second worktree-test timeout under resource contention. The final backend run used approved filesystem access and two workers; all tests passed without changing the legacy tests. Tests mock external providers; no paid API call was made. The new UI was tested through DOM integration tests; no live authenticated browser E2E was performed.

Acceptance coverage includes directive ingestion/source linkage, PM ownership, missing-field clarification, immutable brief/plan versions, authenticated/CSRF-protected decisions, stale/repeated decisions, revision invalidation, all execution bypass guards, supported-next-stage eligibility using an explicit future-worker fixture, unsupported stage rejection, global SQL concurrency ceilings, reopen/replay persistence, and legacy workflow/announcement regression tests. No real production stage is enabled merely to make a test pass.

## Limits and compatibility risks

- Eight production stages, media execution, archive/delete, Shot Registry, Budget Manager and automatic LLM plan generation are not implemented.
- Approval uses the repository's existing single trusted CEO-session model. This is not a new multi-user RBAC system; anyone holding that session's credentials remains trusted by the application.
- A project has one production in Phase 1. Another directive is not a revision API; use the brief editor/structured conversation reply to revise its plan.
- The new pack intentionally rejects generic task edit/run/delete controls. Existing packs retain their policies.
- No production worker can run in Phase 1. Before enabling any later stage, its implementation must wire atomic reserve/release into worker lifecycle and define recovery of orphaned workers. The persistent slot fails closed across restart and is never released just because time elapsed.
- Partial unique indexes assume `video_production` is new; a database manually populated with multiple running tasks under that previously unknown key would need reconciliation before migration.
- No commit was created.

## Changed files

Paths below are relative to repository root.

- [docs/openapi.json](../../docs/openapi.json)
- [docs/plans/video-production-phase1-implementation.md](../../docs/plans/video-production-phase1-implementation.md)
- [server/modules/bootstrap/schema/video-production-schema.ts](../../server/modules/bootstrap/schema/video-production-schema.ts)
- [server/modules/routes/collab/coordination/cross-dept-cooperation.ts](../../server/modules/routes/collab/coordination/cross-dept-cooperation.ts)
- [server/modules/routes/collab/direct-chat-task-flow.ts](../../server/modules/routes/collab/direct-chat-task-flow.ts)
- [server/modules/routes/collab/subtask-delegation-batch.ts](../../server/modules/routes/collab/subtask-delegation-batch.ts)
- [server/modules/routes/collab/subtask-delegation.ts](../../server/modules/routes/collab/subtask-delegation.ts)
- [server/modules/routes/collab/task-delegation.ts](../../server/modules/routes/collab/task-delegation.ts)
- [server/modules/routes/core.ts](../../server/modules/routes/core.ts)
- [server/modules/routes/core/agents/spawn.ts](../../server/modules/routes/core/agents/spawn.ts)
- [server/modules/routes/core/projects.ts](../../server/modules/routes/core/projects.ts)
- [server/modules/routes/core/tasks/crud.ts](../../server/modules/routes/core/tasks/crud.ts)
- [server/modules/routes/core/tasks/crud.workflow-pack-filter.test.ts](../../server/modules/routes/core/tasks/crud.workflow-pack-filter.test.ts)
- [server/modules/routes/core/tasks/execution-control.ts](../../server/modules/routes/core/tasks/execution-control.ts)
- [server/modules/routes/core/tasks/execution-run-auto-assign.test.ts](../../server/modules/routes/core/tasks/execution-run-auto-assign.test.ts)
- [server/modules/routes/core/tasks/execution-run-auto-assign.ts](../../server/modules/routes/core/tasks/execution-run-auto-assign.ts)
- [server/modules/routes/core/tasks/execution-run.ts](../../server/modules/routes/core/tasks/execution-run.ts)
- [server/modules/routes/core/tasks/subtasks.ts](../../server/modules/routes/core/tasks/subtasks.ts)
- [server/modules/routes/core/tasks/video-production-execution-guards.test.ts](../../server/modules/routes/core/tasks/video-production-execution-guards.test.ts)
- [server/modules/routes/core/video-production.test.ts](../../server/modules/routes/core/video-production.test.ts)
- [server/modules/routes/core/video-production.ts](../../server/modules/routes/core/video-production.ts)
- [server/modules/routes/ops/messages/chat-routes.ts](../../server/modules/routes/ops/messages/chat-routes.ts)
- [server/modules/routes/ops/messages/directives-inbox-routes.ts](../../server/modules/routes/ops/messages/directives-inbox-routes.ts)
- [server/modules/routes/ops/messages/video-production-conversation.ts](../../server/modules/routes/ops/messages/video-production-conversation.ts)
- [server/modules/routes/ops/messages/video-production-intake.ts](../../server/modules/routes/ops/messages/video-production-intake.ts)
- [server/modules/workflow/orchestration/execution-start-task.ts](../../server/modules/workflow/orchestration/execution-start-task.ts)
- [server/modules/workflow/orchestration/report-workflow-tools.ts](../../server/modules/workflow/orchestration/report-workflow-tools.ts)
- [server/modules/workflow/packs/definitions.ts](../../server/modules/workflow/packs/definitions.ts)
- [server/modules/workflow/video-production.test.ts](../../server/modules/workflow/video-production.test.ts)
- [server/modules/workflow/video-production.ts](../../server/modules/workflow/video-production.ts)
- [server/server-main.ts](../../server/server-main.ts)
- [shared/video-production.ts](../../shared/video-production.ts)
- [src/api.ts](../../src/api.ts)
- [src/api/video-production.test.ts](../../src/api/video-production.test.ts)
- [src/api/video-production.ts](../../src/api/video-production.ts)
- [src/app/office-workflow-pack.ts](../../src/app/office-workflow-pack.ts)
- [src/components/project-manager/ProjectInsightsPanel.tsx](../../src/components/project-manager/ProjectInsightsPanel.tsx)
- [src/components/project-manager/VideoProductionPanel.test.tsx](../../src/components/project-manager/VideoProductionPanel.test.tsx)
- [src/components/project-manager/VideoProductionPanel.tsx](../../src/components/project-manager/VideoProductionPanel.tsx)
- [src/components/ProjectManagerModal.tsx](../../src/components/ProjectManagerModal.tsx)
- [src/components/settings/useApiProvidersState.ts](../../src/components/settings/useApiProvidersState.ts)
- [src/components/taskboard/TaskCard.production.test.tsx](../../src/components/taskboard/TaskCard.production.test.tsx)
- [src/components/taskboard/TaskCard.tsx](../../src/components/taskboard/TaskCard.tsx)
- [src/types/index.ts](../../src/types/index.ts)
- [server/modules/routes/collab/direct-chat-handlers.ts](../../server/modules/routes/collab/direct-chat-handlers.ts)
- [server/modules/routes/collab/direct-chat-types.ts](../../server/modules/routes/collab/direct-chat-types.ts)
