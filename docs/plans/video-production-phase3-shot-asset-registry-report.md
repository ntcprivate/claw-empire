# Phase 3 — Shot and Asset Registry Report

Status: **DONE — CODE COMPLETE; DEPLOYMENT VERIFICATION PENDING**. Root review and full-repository validation are complete. Phase 3 implementation was limited to local code, isolated SQLite tests and fake media fixtures.

## Security and operating state

- CEO Registry UI is read-only. The UI sends no agent credential, has no actor selector, and cannot review, upload, regenerate or create manifests.
- Agent writes use Phase 2's exact-path capability resolver and server-side actor identity bound to an active persisted task/attempt/current plan. Body-supplied agent IDs do not authorize actions.
- Credential issuance remains disabled unless existing feature and isolation gates pass. No executor or unsupported stage was enabled. There is no credential-issuance route.
- No production/runtime database was opened or migrated; no Docker, worker, provider, paid API, deployment or commit was used.
- Technical validation checks bounded file bytes, allowed media signature, project containment and actual SHA-256. It does not claim codec, playback or creative-quality review.

## Persistence

The additive registry migration is connected through `video-production-schema.ts`; it does not rebuild or drop Phase 1/2 data. New physical tables are:

| Tables | Purpose |
|---|---|
| `video_production_scenes`, `video_production_scene_versions` | Current scene head and append-only screenplay/continuity history |
| `video_production_shots`, `video_production_shot_versions` | Current shot/order head and immutable shot-spec/reference snapshots |
| `video_production_assets` | Project-scoped immutable file metadata and attempt provenance |
| `video_production_visual_references`, `video_production_visual_reference_versions` | Versioned visual reference identity and asset/metadata history |
| `video_production_shot_references` | Version-specific, normalized dependency lineage for stale-reference checks |
| `video_production_takes`, `video_production_take_reviews`, `video_production_approved_takes` | Asset-first takes, exact-version review history and one current approved pointer |
| `video_production_regeneration_requests` | Durable idempotent request records; they do not create runnable tasks |
| `video_production_manifests`, `video_production_manifest_entries` | Immutable ordered release-input snapshot and digest |

Existing credential rows receive nullable attempt/task/plan bindings with all-null-or-all-present consistency. Composite project/task/agent/attempt/plan constraints and triggers protect lineage. Required scene/shot ordering has active-head uniqueness; historical versions and approved manifests are guarded against mutation/deletion. Scene/shot soft deletion preserves history.

Media blobs live outside SQLite below the configured registry root, under server-derived project/hash keys. Upload accepts bytes, not a host path; type/signature, size, symlink/realpath containment and content hash are checked. Content placement is exclusive and immutable. Duplicate bytes safely share a blob while keeping separate metadata rows. A new media revision is represented by a new immutable `asset_id`/blob or deduplicated hash reference; this is not an in-place asset version increment.

## API actions

Registry routes use exact method/path allowlist entries beneath `/api/projects/:id/video-production/`; only the persisted read model is the `/registry` endpoint. There is no wildcard registry prefix and no generic API access.

| Operation | Authenticated action |
|---|---|
| `GET .../registry`, `GET .../manifests/:manifestId` | `studio.read`; CEO session may read only |
| Scene `POST`, `PUT :sceneId`, `PUT scenes/order`, `DELETE :sceneId` | Haru, `screenplay.write` |
| Shot `POST scenes/:sceneId/shots`, `PUT shots/:shotId`, `PUT scenes/:sceneId/shots/order`, `DELETE shots/:shotId` | Haru, `shot_spec.write` |
| Reference bytes and version/link operations | Yuna, `visual.manage` |
| Footage upload and take submission | Miro, `footage.submit` |
| Exact take review | Yuna, `take.review` |
| Regeneration request | Dami, `regeneration.request`, plus actual production-manager/coordinator identity |
| Manifest snapshot creation | Liam, `edit.manage`, bound to a live attempt |

No generic task/chat route was opened. Review checks the exact take/shot/asset versions. Rejecting the currently approved take removes only that current pointer and preserves review history. Regeneration requires a rejected take and cannot target an approved shot; repeated matching idempotency keys return the same request, while changed payloads conflict. Manifest creation and currentness checks bind a full ordered required-shot snapshot across byte verification and final transaction. Required scenes without active required shots prevent READY/current status.

## Phase 3 source manifest

- Schema/migrations: `server/modules/bootstrap/schema/video-production-registry-schema.ts`, `server/modules/bootstrap/schema/video-production-schema.ts`.
- Domain/storage: `server/modules/workflow/video-production-registry.ts`, `server/modules/workflow/video-production-registry-storage.ts`.
- Auth/routes: `server/security/auth.ts`, `server/modules/routes/core/video-production-registry.ts`, `server/modules/routes/core/video-production.ts`.
- Shared policy/domain types: `shared/video-production-registry.ts`, `shared/video-studio-organization.ts`, `server/modules/workflow/video-production-rbac.ts`.
- Asset-root configuration: `server/config/runtime.ts`.
- CEO read-only client/UI: `src/api/video-production.ts`, `src/components/project-manager/VideoProductionPanel.tsx`.
- Focused tests: `server/modules/workflow/video-production-registry.test.ts`, `server/modules/workflow/video-production-registry-storage.test.ts`, `server/security/video-production-registry-auth.integration.test.ts`, `src/api/video-production.test.ts`, `src/components/project-manager/VideoProductionPanel.test.tsx`.
- Phase 2 regression fixtures adjusted without changing production policy: `server/modules/routes/core/video-production-rbac.integration.test.ts` now uses only `studio.read` for its generic self-grant escalation probe; `server/modules/workflow/video-production-rbac.test.ts` applies a scoped 15-second timeout to its file-backed reopen case.
- Existing Phase 1/1.1/2 files remain part of the shared uncommitted baseline. Phase 3 also integrates with `server/modules/bootstrap/schema/video-production-schema.ts`, `server/modules/routes/core/video-production.ts`, `server/modules/workflow/video-production-rbac.ts`, and `server/config/runtime.ts`; these are not new Phase 3-only modules.
- Contract snapshot: `docs/openapi.json` (19 registry method/path operations added; 143 operations total).

## Focused verification

- Root full backend: 62 files; 295 passed and 1 explicit Docker fixture skipped (296 total), exit 0.
- Root full frontend: 29 files / 104 passed, exit 0.
- Direct `pnpm exec tsc -b`: passed; `pnpm run build` (TypeScript + Vite): passed.
- Lint: 0 errors, 40 existing warnings.
- OpenAPI sync/check: 143 operations passed, including 19 Registry operations.
- `git diff --check`: passed. Workspace HEAD unchanged at `63dfc4c`; no commit.
- Focused Phase 3 backend: 3 files / 13 passed; frontend API/UI: 2 files / 14 passed. The broader suite above includes Phase 3 and the final multi-take regression.

Focused cases cover SQLite file reopen/idempotent additive migration; actual Express auth and cross-project denial; spoofed CEO mutation and wrong-role review denial; upload malformed metadata, invalid signature and oversize responses; scene update/reorder/soft-delete; shared dependency links retained through reorder and invalidated by source edits; credential revocation during asset verification leaves no metadata row; multiple takes with a single current approval, identical blob deduplication, and rejection of an older take without clearing the newer approved pointer; exact review/rejection and pointer cleanup; regeneration denial on approved shot, idempotent replay, changed-payload conflict and wrong-shot denial; manifest snapshot change during asset verification, empty required scene invalidation and tampered-byte rejection; read-only CEO display of persisted take/review/continuity/manifest data. The initial full-run failure from an older Phase 2 test's unbound `footage.submit` fixture was fixed by narrowing that escalation probe to `studio.read`; the initial file-backed reopen timeout was addressed with a test-specific 15-second timeout. The final backend suite passes.

## Limitations

**Operational status: PARTIAL / deployment verification pending.** Live agent writes remain gated until the existing isolation deployment is independently verified and a supported trusted executor supplies an active attempt-bound identity. No production database was migrated and no deployment/worker was started. There is no AI/media generation, codec or creative QC, runnable regeneration task (requests are durable intent only), video render, CEO release action, or Phase 4 work. CEO read-only Registry display does not remove Phase 1's separate CEO planning/approval controls. Asset revisions use new immutable asset IDs/blobs, not in-place asset version increments.

## Bàn giao

Phase 3 code và kiểm thử đã hoàn tất; backend 295 test pass + 1 Docker fixture được skip rõ ràng, frontend 104 test pass, build/typecheck/OpenAPI/lint đều đạt. Registry CEO chỉ xem; agent write vẫn khóa tới khi xác minh isolation triển khai và có trusted executor hỗ trợ attempt. Không có dữ liệu production nào được migrate hoặc media nào được tạo.
