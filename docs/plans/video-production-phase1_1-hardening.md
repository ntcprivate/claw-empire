# Video Production Phase 1.1 — Security & Execution Hardening

## Result

This patch adds a closed-by-default production execution boundary and durable attempt lifecycle. It does **not** complete production deployment isolation or provide a video provider/output validator. The current runtime remains in legacy host mode unless an operator explicitly configures container mode and an approved immutable worker image. The shipped production executor registry is empty, so unsupported video work cannot be launched. No Phase 2 stages were enabled.

The trusted CEO remains the application session represented by the server-validated bearer/cookie. Loopback is no longer CEO identity. Workers receive no CEO token, no backend network, no host project/repository mount, and only an empty per-attempt workspace. This is not proof that arbitrary images are safe: the operator must approve the dedicated worker image identity and ensure all untrusted external CLI workers use secure mode. Privileged production writes remain unavailable until the live Docker runtime probe succeeds.

## Root causes and changes

1. **CEO privilege isolation:** the previous session endpoint could issue a CEO session to loopback callers. `installSecurityMiddleware()` and the route guard now require an existing valid server-side CEO session. The production mutation guard separately requires CSRF and a successful container runtime probe. Chat `[VIDEO_BRIEF]` changes pass the same guard before persistence. Body `sender_type`, `sender_id`, and `actorId` are not authorization.
2. **Reservation was not on the launch path:** the managed production task route now calls the execution coordinator. A top-level SQLite transaction changes task/stage state, creates a stable attempt, and owns the singleton slot before the launch callback. Nested transactions are rejected so the claim is committed before spawn. The attempt snapshots the plan version/assignee and stores deterministic worker identity plus image ID before spawn.
3. **Spawn race and stale callbacks:** completion/release is conditional on current task+attempt ownership. Duplicate completion is one-shot. Verified failure releases its own attempt. A verified successful process ends in human review: the execution record is terminal, the stage stays `BLOCKED` pending artifact validation, and the slot is atomically released. A stale callback cannot mutate the replacement attempt. Ambiguous launch errors, unknown inspection, or live workers retain the slot for reconciliation.
4. **Recovery and support boundaries:** startup inspects persisted container identity and image identity, records a recovery event, never relaunches automatically, and leaves unknown/live states held. Successful exit without an artifact validator transitions to human review, not a completed video stage. Resume/provider execution remains unavailable because no production executor is registered.

## Initial source audit (DONE / PARTIAL / MISSING)

- **DONE in code:** loopback no longer creates CEO identity; production mutations and `/run`/cancel require a valid CEO session, CSRF and the isolation readiness guard; chat brief writes share the guard. Atomic attempt/slot/task/stage claim commits before launch. Launch, callback, completion, release, resume and cancellation are scoped to task + attempt ownership. Startup reconciliation keeps unknown or live workers reserved. Unsupported stages remain locked.
- **PARTIAL by design:** the shared broker now covers manager-requested execution and explicit resume, with approval/dependency/snapshot rechecks; cancellation stops only a matching worker and releases after verified exit. Tests use a supported-executor fixture because the shipped executor registry is empty. No actual production provider is enabled.
- **MISSING outside this code-only scope:** deployed worker-container isolation has not been approved/configured/probed; external workers may not be assumed isolated. No artifact validator or video stage executor exists. These remain closed and require separate operator deployment verification before production enablement.

## Container boundary

- `deploy/worker/Dockerfile` is a dedicated context containing only a fixed runner image declaration; it does not copy the repository or credentials.
- Worker launch uses an immutable image ID, empty `/workspace` bind mount, no network, read-only root, no Linux capabilities, `no-new-privileges`, non-root UID 65532, bounded CPU/memory/processes, and a small environment allowlist.
- Runtime image labels are metadata, not cryptographic attestation. Runtime checks verify the configured immutable ID, image properties, daemon, UID, and launch flags. Operator review of the image build and confirmation that no untrusted host workers retain CEO-secret access are still required.
- Local dedicated image build was performed without pulling a base image: `docker build --pull=false --network=none -t claw-empire-worker:phase11-test -f Dockerfile .` from `deploy/worker`. It is a test artifact only; no app deployment or server restart occurred.
- `CLI_WORKER_RUNTIME_MODE=container` and `CLI_WORKER_CONTAINER_IMAGE=<approved exact sha256 image ID or digest>` must be set out of band after operator review. There is no default image. Do not use the all-in-one application image.
- In container mode, external CLI workers are routed through the container adapter with no host fallback; one-shot CLI execution fails closed when no executor is registered. Non-video host compatibility remains in host mode. Production mutations remain blocked until the real isolation probe succeeds.

## Persistence

The additive schema adds `video_production_attempts` with unique attempt token, task/project, state, plan version, assigned agent, worker identity, container/image identity, timestamps and details. `video_production_slot` gains nullable `attempt_id`. Existing rows are preserved. The global live-attempt partial unique index includes prepared, launching, running, completing and reconciliation states. Legacy occupied slots without an attempt token are never overwritten by a new claim.

## Acceptance matrix (16 required checks)

| TC | Result | Evidence / limit |
|---|---|---|
| 1. CEO approve / request changes | PASS, deployment-gated | Real middleware and CEO bearer approval test passes with the isolation dependency injected ready; request-changes persistence is covered by workflow tests. Live deployment probe still pending. |
| 2. Worker cannot acquire CEO session / CSRF | PASS | Real middleware rejects loopback bootstrap, worker bearer and CSRF-only approval requests. |
| 3. Worker cannot mutate approved brief/plan through chat or API | PASS, deployment-gated | Real chat and project-plan routes reject worker identity and reject writes before persistence when isolation is unavailable. |
| 4. Delegation cannot bypass approval | PASS | Internal generic start, task run, agent spawn, assignment and subtask paths are gated; the trusted Dami broker rechecks manager identity and approved task admission. |
| 5. Concurrent requests spawn at most one worker | PASS | File-backed SQLite with independent connections verifies committed claim before spawn and rejects competing launch without spawn. |
| 6. Failed reservation never spawns | PASS | Busy singleton and nested-transaction claim tests keep fake launch count at zero. |
| 7. Spawn failure cleans up only when pre-spawn is proven | PASS | Typed pre-spawn rejection releases its own attempt; generic ambiguous errors retain the slot for reconciliation. |
| 8. Stale completion cannot affect replacement attempt | PASS | Ownership CAS rejects stale and duplicate completion/release. |
| 9. Cancellation is verified and idempotent | PASS | Attempt token and image are checked; duplicate cancel is idempotent; unverified stop retains reservation; late close after cancellation cannot complete the task. Route cleans progress/agent state only for the owned attempt. |
| 10. Restart preserves task state | PASS | File-backed SQLite recovery records events and retains attempt identity across restart-style reconciliation. |
| 11. Resume rechecks authority and cannot duplicate | PASS, supported-executor fixture | Resume through the shared broker verifies Dami DB identity, latest paused attempt, project/plan/assignee snapshot, approval, dependencies and atomic singleton claim. Shipped production registry remains empty. |
| 12. Crash between reservation and spawn is safe | PASS | Simulated crash after durable launch intent remains held as reconciliation-required and is never auto-retried. |
| 13. Live worker is not released on restart | PASS | Verified-running and unknown inspection outcomes keep the owned slot. |
| 14. Existing directive, announcement, chat, project and approval behavior | PASS | Full repository backend regression suite is run separately; focused auth/integration checks cover production route and chat mutations. |
| 15. Other workflows are preserved | PASS | Legacy launcher changes are gated by managed video-production identity; repository API/UI regression suites run separately. |
| 16. Unsupported production stages remain locked | PASS | All actual stages after Intake & Planning remain NOT_IMPLEMENTED; default executor registry is empty; no unsupported work produces output or is auto-completed. |

## Verification record

Final repository verification: backend 55 files / 265 tests passed; frontend 28 files / 98 tests passed; TypeScript and Vite production build passed; lint 0 errors / 42 warnings; OpenAPI contract 119 operations passed; `git diff --check` passed. Focused Phase 1.1 API checks covered 4 files / 35 tests, including real file-backed SQLite, local fake child process, local Docker fake worker using an already running local daemon and installed image, real auth middleware, production approval/chat mutation, cancellation/resume ownership, crash reconciliation and stale ownership. No paid API was called. The local fake-container run does not establish deployment isolation.

### Phase 1.1 file manifest

- **Security and runtime:** `server/security/auth.ts`, `server/security/auth.test.ts`, `server/config/runtime.ts`, `server/modules/lifecycle.ts`, `server/modules/lifecycle/register-graceful-shutdown.ts`, `server/modules/workflow/worker-isolation.ts`, `server/modules/workflow/agents/cli-runtime.ts`, `server/modules/workflow/core/one-shot-runner.ts`, `deploy/worker/Dockerfile`.
- **Execution, persistence and recovery:** `server/modules/bootstrap/schema/video-production-schema.ts`, `server/modules/workflow/video-production.ts`, `server/modules/workflow/video-production-execution.ts`, `server/modules/workflow/video-production-execution.test.ts`, `server/modules/workflow/orchestration/execution-start-task.ts`, `server/modules/workflow/orchestration/run-complete-handler.ts`, `server/modules/routes/core/tasks/execution-run.ts`, `server/modules/routes/core/tasks/execution-control.ts`, `server/modules/routes/core/tasks/video-production-execution-guards.test.ts`.
- **Authorization and intake routes:** `server/modules/routes/core/video-production.ts`, `server/modules/routes/core/video-production-auth.integration.test.ts`, `server/modules/routes/ops/messages/video-production-conversation.ts`, `server/modules/routes/ops/messages/directives-inbox-routes.ts`, `server/modules/routes/ops/messages/chat-routes.ts`.
- **API and contract:** `shared/video-production.ts`, `src/api/video-production.ts`, `src/api/video-production.test.ts`, `docs/openapi.json`.
- **Project UI and regression coverage:** `src/components/project-manager/VideoProductionPanel.tsx`, `src/components/project-manager/VideoProductionPanel.test.tsx`, `src/components/ProjectManagerModal.tsx`, `src/components/project-manager/ProjectInsightsPanel.tsx`, `src/components/taskboard/TaskCard.tsx`, `src/components/taskboard/TaskCard.production.test.tsx`.
- **Reports and tracking:** `docs/plans/video-production-phase1_1-hardening.md`, `tasks/todo.md`.

The additive migration creates `video_production_attempts` and adds nullable `attempt_id` ownership to `video_production_slot`; it does not delete existing rows. No production database migration was applied.

## Deployment status and remaining risks

- **REQUIRES DEPLOYMENT ISOLATION:** no environment switch, worker image, or service rollout was applied to the existing server. Passing the local fake-worker test is not an end-to-end deployment isolation audit. Keep privileged production gates closed until the approved image and actual deployment boundary are verified, including that untrusted host workers cannot access CEO credentials.
- **STILL BLOCKED:** production provider execution, real artifact validation, stage completion and automatic unattended resume. The explicit resume broker is covered with a supported-executor fixture, but the shipped production registry is empty. No production video can be claimed complete from process exit alone.
- Before enabling: build/review and pin the dedicated image by exact immutable ID; configure secure mode out of band; verify the integrated runtime probe; ensure all untrusted CLI workers are routed through that runtime and no old host worker can access CEO credentials; only then review/open the human approval path. Do not grant workers Docker socket, home, browser, database, server config, or repository mounts.
- No paid API requests, production database mutations, deployment changes, or commits were performed.
