# AI Video Studio Phase 2 — Implementation report

Status: **PHASE 2 CODE COMPLETE — DEPLOYMENT VERIFICATION PENDING**. Root review and repository validation are complete.

Tóm tắt bàn giao:

- **DONE:** Code, migration bổ sung ba bảng, seed opt-in sáu phòng/tám agent theo workflow pack, RBAC backend, UI và kiểm thử Phase 2. Luna thực hiện code/tests; agent chính giám sát, review và chạy kiểm tra độc lập.
- **PARTIAL:** Creative/take/final-QA approvals của các stage tương lai hiện là permission definitions và ownership metadata; chưa có API nghiệp vụ hoặc executor tương ứng.
- **BLOCKED theo thiết kế:** Production execution và sử dụng credential agent thật còn chờ xác minh isolation/deployment Phase 1.1. Giữ nguyên các guard và trạng thái NOT_IMPLEMENTED.
- Kết quả cuối: backend 282 pass/1 Docker test skip; frontend 103 pass; typecheck/build/OpenAPI/diff check pass; lint 0 errors/40 warnings có sẵn.
- Chưa áp dụng migration/setup vào database đang chạy; không deploy Docker, chạy production worker, gọi API tính phí, commit hoặc chuyển Phase 3.

The user approved the additive RBAC storage and the exact, narrow agent capability boundary. Root review and implementation validation are complete. The implementation adds organization setup, project grants, backend authorization and a server-backed view of roles and stage ownership. Existing Phase 1.1 production isolation, CEO approval and execution guards remain active. Deployment isolation is still pending, so the implementation does not make Phase 2 operationally ready for real workers.

## Database changes

Three new tables are created additively by `ensureVideoProductionRbacSchema`, called from the existing Video Production schema setup. The logical names approved in the design map to physical names as follows:

| Approved logical table | Physical table | Stored authority |
|---|---|---|
| `agent_role_bindings` | `video_production_agent_roles` | One stable domain role per agent, binding provenance (`bound_by`) and timestamps. `agents.role` remains the existing hierarchy/rank field. |
| `project_grants` | `video_production_project_grants` | Project/agent membership or coordinator grant, trusted grantor, active/revoked time. Composite project/agent primary key. |
| `credential_hashes` | `video_production_agent_credentials` | Credential ID, project/agent, unique SHA-256 hash, action scopes, issuer, creation/expiry/revocation. Plaintext credentials are never stored. |

The tables have additive foreign keys, role/grant checks, unique constraints and lookup indexes. The agent role table’s `bound_by` provenance column is upgraded additively for databases that already created the earlier Phase 2 draft shape. Existing plan, event, decision, task and membership tables keep their meanings. No production or user runtime database was opened or migrated by this work.

## Organization setup and existing data

`POST /api/video-production/organization/setup` is explicit and idempotent. It requires a CEO session and CSRF token. The configuration route can work while worker isolation is unavailable; production plan/assignment/approval/run/cancel mutations retain their existing isolation gates. Setup creates six pack-scoped department labels using the existing global anchors (`operations`, `planning`, `design`, `dev`, `qa`, `devsecops`) and the eight stable agent profiles. Dami remains `video_production-seed-5` in Operations. User-owned provider, OAuth, activity and current-task fields are preserved.

Setup fails and rolls back if custom Video Production agents, departments, profile values, stable IDs or anchors conflict. It never deletes custom records to force the expected count. It keeps existing `officePackProfiles` settings intact and adds `video_production` to the persisted hydrated-pack list. Startup profile migration and generic settings hydration skip Video Production, preventing editable legacy profiles from renaming/reassigning studio records after restart. The UI and department API use only actual DB-backed Video Production records; an unconfigured studio displays no fabricated agents or department labels.

New projects created after organization setup receive only the persisted Dami coordinator grant, because Dami is the configured manager. Existing projects receive no automatic authority; the CEO must explicitly grant the manager and other project members. Grant/revoke actions and project-specific setup events are audited. Deleting a configured agent revokes active grants and credentials and records removal events within the existing agent deletion transaction. A manager cannot be removed while referenced by a production record.

## Roles and authorization

Role permissions are typed server constants and are not editable through agent profiles, display names, request bodies or personality text. Agent actions are allowed only when the current request passes all checks:

1. the server resolves the random capability by its SHA-256 hash;
2. its current credential is unexpired, unrevoked, scoped to the exact project and action;
3. the current agent still belongs to the `video_production` pack and has a configured role;
4. the role permits the action and the project grant is active;
5. plan/assignment actions additionally require the persisted manager ID and coordinator grant.

Credential issuance remains an internal server function, disabled by default and checked against current worker-isolation readiness both on issue and every request. There is no public token mint endpoint.

| Role | Defined actions |
|---|---|
| Production Manager (Dami) | Studio read, plan update, task assignment, change request, production monitoring |
| Director (Rian) | Studio read, creative approval, pilot approval, Picture Lock |
| Screenwriter (Haru) | Studio read, screenplay writing, shot specification |
| Art Director (Yuna) | Studio read, visual management, take review |
| Video Producer (Miro) | Studio read, footage submission, generation management |
| Editor (Liam) | Studio read, editing |
| Sound Producer | Studio read, audio management |
| QA Supervisor (Quinn) | Studio read, final QA |

Only the exact agent HTTP pairs below are accepted by the capability middleware:

| Method and path | Required action |
|---|---|
| `GET /api/projects/:id/video-production/organization` | `studio.read` |
| `PUT /api/projects/:id/video-production/plan` | `plan.update` |
| `POST /api/projects/:id/video-production/assignments` | `task.assign` |

The hook uses exact anchored path matching, rejects ambiguous CEO-session plus agent-capability requests, and stores identity in server-owned request context. Agent capabilities are denied on generic agent/task/message APIs, auth/session bootstrap, CEO decisions, webhooks and WebSocket paths. CEO-only setup and project-grant routes do not accept agent capabilities. CEO greenlight, budget override and final release are server-defined CEO actions only.

The assignment route changes only an existing task attached to an implemented stage. It checks project identity, stage ownership and grants atomically, writes an audit event, and preserves the planning root task’s manager invariant: Rian cannot replace Dami on that root task. Unsupported stages return a conflict and do not create tasks, artifacts or completions. There is no take-approval or other future-stage API.

## Stage ownership metadata

Stage ownership is typed metadata, not a worker plan or task generator. Each sequence step names a typed actor role and action, an explicitly labeled Studio Technology service action, or a CEO action. The AI Footage sequence includes Rian’s distinct `pilot.approve` action. The nine-stage sequence is:

1. Intake & Planning: Dami plan update → Rian creative approval → CEO greenlight.
2. Story Development: Haru screenplay → Rian creative approval.
3. Visual Pre-production: Haru shot specification → Yuna visual management → Liam edit → Rian creative approval.
4. Audio Pre-production: Sound Producer audio → Rian creative approval.
5. AI Footage Production: Miro footage submission → Yuna take review → Rian pilot approval.
6. Asset Handoff & Rough Cut: Studio Technology asset-handoff service → Liam edit.
7. Director Review: Rian creative approval → Rian Picture Lock.
8. Finishing & QA: Sound Producer audio → Liam edit → Quinn final QA.
9. Release & Archive: Dami production monitoring → Studio Technology archive service → CEO final release.

The Studio Technology services are metadata only. They are not LLM agents, executors or runnable tasks. Stages not implemented in Phase 1.1 remain closed and unmaterialized.

## Final verification

- Full backend: **59 files; 282 passed, 1 skipped** (283 total). The skipped test is the explicit opt-in Docker fixture; no Docker command ran in the default test suite. An initial run exposed a missing `.delete` method in a route mock; the fixture was corrected without weakening route registration, and the final suite passed.
- Full frontend: **29 files; 103 passed**.
- `pnpm exec tsc -b`: passed. `pnpm run build`: passed.
- Lint: **0 errors, 40 existing warnings**.
- OpenAPI: **124 operations passed**. `git diff --check`: passed.
- Focused collaboration selector regression: **2/2 passed**; execution guard fixture: **8/8 passed**.
- Workspace HEAD remained `63dfc4c`; no commit was created.

## Phase 2 file manifest

Files changed or added for Phase 2, relative to the Phase 1.1 baseline:

- `shared/video-studio-organization.ts`
- `server/modules/bootstrap/schema/video-production-rbac-schema.ts`
- `server/modules/bootstrap/schema/video-production-schema.ts`
- `server/modules/bootstrap/schema/task-schema-migrations.ts`
- `server/config/runtime.ts`
- `server/security/auth.ts`
- `server/security/video-production-agent-auth.integration.test.ts`
- `server/server-main.ts`
- `server/modules/workflow/video-production-rbac.ts`
- `server/modules/workflow/video-production-rbac.test.ts`
- `server/modules/workflow/video-production.ts`
- `server/modules/routes/core/video-production.ts`
- `server/modules/routes/core/video-production-rbac.integration.test.ts`
- `server/modules/routes/core/agents/crud.ts`
- `server/modules/routes/core/agents/crud.seed-filter.test.ts`
- `server/modules/routes/core/departments.ts`
- `server/modules/routes/collab.ts`
- `server/modules/routes/collab.agent-selection.integration.test.ts` (actual registered selectors with SQLite; verifies legacy fallback exclusion, explicit studio candidate resolution and legacy schema compatibility)
- `server/modules/routes/collab/office-pack-agent-hydration.ts`
- `server/modules/routes/ops/settings-stats.ts`
- `server/modules/workflow/video-production-execution.test.ts` (the Docker-backed local adapter fixture now requires explicit opt-in; no Docker command runs in default tests)
- `server/modules/routes/core/tasks/video-production-execution-guards.test.ts` (mock route registrar now includes DELETE for grant/revoke route coverage)
- `src/api/video-production.ts`
- `src/App.tsx`
- `src/app/AppMainLayout.tsx`
- `src/app/office-pack-display.ts`
- `src/app/office-pack-display.test.ts`
- `src/app/useRealtimeSync.ts`
- `src/app/useRealtimeSync.test.ts`
- `src/components/project-manager/VideoProductionPanel.tsx`
- `src/components/project-manager/VideoProductionPanel.test.tsx`
- `docs/openapi.json`
- `tasks/todo.md`
- `docs/plans/video-production-phase2-organization-rbac.md`
- `docs/plans/video-production-phase2-organization-rbac-report.md`

## Operational status and remaining work

Code and isolated SQLite tests do not prove deployment isolation. The capability flag remains off by default; no real credential, worker, production database mutation, Docker operation, paid call or deployment was performed. Production executors remain unconfigured and unsupported stages remain closed. Future creative, take and QA approvals are permission definitions only; there are no fake business APIs or artifacts. Real deployment/image/isolation verification remains a separate required operational step, so Phase 2 does not establish readiness for real agents to execute production work.
