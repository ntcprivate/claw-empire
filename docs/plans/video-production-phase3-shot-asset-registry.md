# Phase 3 — Shot & Asset Registry

Trạng thái: DONE — CODE COMPLETE; DEPLOYMENT VERIFICATION PENDING. Root full-repository validation is complete. CEO Registry UI is read-only. Agent operations use the existing Phase 2 identity resolver on exact registry routes only; no agent capability is sent through the browser. See `docs/plans/video-production-phase3-shot-asset-registry-report.md` for source manifest and results.

Agent chính lập kế hoạch, giám sát, review và kiểm tra độc lập. Luna medium chịu trách nhiệm code/tests. User approved Phase 3 additive migrations, registry APIs and UI, with the security correction below.

## Preconditions đã kiểm tra

- Báo cáo Phase 2: CODE COMPLETE — DEPLOYMENT VERIFICATION PENDING; 6 phòng/8 role profiles và RBAC đã có trong source.
- Luna chạy `video-production.test.ts` và `video-production-rbac.test.ts`: 20/20 pass trên SQLite test, có file-backed reopen.
- Agent chính kiểm tra riêng trên SQLite in-memory: nâng slot Phase 1 thiếu `attempt_id` và role-binding draft thiếu `bound_by`, chạy schema hai lần, giữ nguyên dữ liệu; PASS, foreign keys bật.
- Không mở database đang chạy, không đọc secrets, không chạy Docker/provider hoặc worker.
- Tái sử dụng Project/Task, grant/credential resolver, role profiles, plan/decision/event tables và execution coordinator hiện có.
- `video-artifact.ts` là helper naming/discovery của workflow cũ, không phải secure versioned asset store. Không dùng discovery đó để xác thực asset Phase 3 và không sửa `video_preprod`.

## Quyết định bảo mật đã duyệt

Bằng chứng: `server/security/auth.ts` hiện allowlist organization GET, plan PUT, assignments POST; `server/modules/workflow/video-production-rbac.ts` khóa credential issuance/resolution bằng feature flag và isolation. `src/api/core.ts` chỉ có CEO session/CSRF transport. User đã quyết định browser không nhận agent credential.

Không thể dùng actor dropdown, `agent_id`/`role` trong body hoặc session CEO để tạo quyết định giả danh Yuna. Không bật credential flag hoặc bỏ isolation gate để giải quyết vấn đề UI.

1. CEO Registry UI chỉ đọc registry qua CEO session hiện có. Không cho CEO UI create/edit/upload/review/approve/regenerate hay gán hành động cho agent.
2. Agent mutation và Yuna review dùng identity đã xác thực từ Phase 2 resolver/credential scope. Registry writes require a scoped credential bound to a trusted active execution attempt; identity/project/task/plan are loaded from persisted attempt state, never from request body.
3. Chỉ mở rộng exact Video Production registry method/path pairs. Generic API, auth/session, WebSocket, CEO decision/run/cancel và workflow khác giữ nguyên.
4. Tái sử dụng issuer/resolver hiện tại; a nullable `attempt_id`/`task_id` binding is additive on existing credential rows. The registry resolver rechecks running attempt, current task ownership, project and plan version per request. Keep feature flag/isolation gates. No issuance endpoint, real credential or issuance activation.
5. Tests dùng SQLite credential fixtures with an explicitly active fake attempt. Agent operations thật tiếp tục gated tới khi isolation deployment được xác minh và a trusted executor supplies identity scoped to a supported stage task. Current unsupported stages remain closed, so no real registry worker is made runnable by Phase 3.

Không thêm auth system mới hoặc browser capability transport. Nếu UI cần agent login trong tương lai, cần quyết định bảo mật riêng.

## Domain và migration đã triển khai

Migration chỉ additive; không rebuild/drop dữ liệu Phase 1/2. Các bảng Registry được kết nối từ schema Phase 1/2 và có file-backed reopen/idempotence tests:

- Scene và Shot: ID ổn định, project-aware relations, current version/head, order, nội dung và soft-delete. Lưu lịch sử phiên bản append-only. Unique ordering chỉ áp dụng current/active records; không để phiên bản lịch sử gây xung đột order.
- Shot có `required` mặc định true, exact reference/continuity snapshot, status và current approved-take pointer.
- Asset metadata bất biến: project, media type, server storage key, hash/size, authenticated owner và provenance. A new media revision is a new immutable asset ID/blob or deduplicated content hash, not an in-place version increment. Ingest asset trước rồi link take; không tạo asset placeholder để báo thành công.
- Take: exact shot/spec/reference version, attempt tăng đơn điệu, model/prompt metadata, asset version, validation state. Take bị reject vẫn giữ nguyên.
- Reviews append-only: exact take + asset/shot/reference versions, authenticated reviewer, decision, feedback. Chỉ Yuna có quyền take review.
- Reference/continuity versions và dependency links: thay đổi tạo phiên bản mới, đánh dấu dependency stale; không sửa approved bytes hoặc tự regenerate.
- Durable regeneration requests: project + shot/version + rejection + request hash/idempotency key. Dami phải là manager/coordinator thực của project. Không dùng `generation.manage` của Miro; thêm action riêng `regeneration.request`.
- Immutable manifests + ordered entries: scene/shot order, exact approved take/asset version/hash, input fingerprint và canonical digest.

Yêu cầu DB: foreign keys và composite project-aware constraints; unique attempts/idempotency/order; CAS cho version và current approval pointer; mutation và audit cùng transaction. Chỉ một approved take hiện hành mỗi shot; không làm mất lịch sử review.

## API/RBAC đã triển khai

Mọi route nằm dưới `/api/projects/:id/video-production/`; allowlist tường minh từng method/path, không wildcard cả prefix. Dùng action definitions hiện có nếu phù hợp; chỉ thêm action domain cần thiết.

| Thao tác | Identity/action |
|---|---|
| Đọc Registry/manifest | Credential có `studio.read` trong đúng project; CEO UI được xem bằng session hiện có |
| Scene create/update/soft-delete/reorder | Haru, `screenplay.write` |
| Shot create/update/soft-delete/reorder | Haru, `shot_spec.write` |
| Visual-reference media/version và continuity package | Yuna, `visual.manage` |
| Đăng ký footage asset/take | Miro, `footage.submit` |
| Review approve/reject exact take version | Yuna, `take.review`; Miro không được duyệt |
| Regeneration request | Dami, dedicated `regeneration.request` + actual manager/coordinator |
| Tạo immutable manifest snapshot | Trusted service after all required shots pass; Liam can read it with `studio.read`; no substitute for CEO release approval |

Scene/Shot CRUD phải đầy đủ, gồm ordering và soft-delete; không chỉ có create/version endpoint. Tất cả ID nguồn/đích phải thuộc project trong URL. Request body không chứng minh actor, reviewer hoặc owner.

## Media và validation

- Media ngoài DB trong dedicated registry storage root theo project, đường dẫn do server tạo, filename theo content hash/version.
- Ưu tiên upload bytes có size/type limits; không nhận filesystem path tùy ý để đọc file host. Yuna upload reference và Miro upload footage qua các route/action phù hợp riêng.
- Kiểm tra containment/realpath/symlink, tên/extension/media signature, hash bytes thực; không nhận hash client làm bằng chứng.
- Exclusive staging và atomic placement; không overwrite approved asset. DB failure không được xóa nhầm file đã tồn tại/được duyệt; crash recovery giữ dữ liệu, không tự xóa media tùy ý.
- Validation phân biệt rõ file/hash/container metadata checks với codec/creative QC chưa có công cụ. Không gọi FFmpeg/AI/provider, không báo hoàn tất kiểm định chưa thực hiện.

## Workflow và guards

- `Shot Ready → Take Submitted → Validation → Yuna Review → Approved/Rejected → Regeneration`.
- Review dùng CAS trên đúng shot/take/asset/reference version; update reference giữa submit/review phải bị phát hiện.
- Submission mới và regeneration không tự thay approved pointer. Chặn regeneration trên shot đã duyệt; chỉ xử lý shot/version bị reject hợp lệ.
- Regeneration là durable intent, chưa tạo runnable task khi footage stage còn NOT_IMPLEMENTED. Có thể liên kết Task có sẵn làm provenance; không fabricate task/output/completion.
- Manifest chỉ READY khi có ít nhất một required shot và mọi required shot có approval hiện hành, asset hợp lệ, dependency không stale. Manifest cũ bất biến; tính current/stale tách khỏi snapshot lịch sử.
- Không đổi stage implementation/status để hợp thức hóa Registry; không release slot, spawn, resume hay bypass scheduler/approval.

## File/module đã triển khai

1. Shared registry domain schemas/types và role action extensions.
2. Bootstrap schema Registry additive và migration/reopen tests; nối sau schema Phase 1/2.
3. Workflow Registry service: CRUD/version/CAS/review/continuity/manifest và audit; file storage helper riêng chỉ cho Registry.
4. Exact route/action matcher + registry routes; tái sử dụng actor resolver, không đổi generic auth.
5. CEO read-only Registry transport uses existing CEO auth; Scene/Shot Board + read-only Take Review Panel in current Project UI. No agent token enters browser. Agent writes/review use scoped API calls from a trusted executor.
6. DB/service/security/API/UI/regression tests; OpenAPI; báo cáo và tasks checklist.

## Acceptance và verification

- CRUD/order/soft-delete/reopen persistence và migration idempotence, dữ liệu Phase 1/2 không mất.
- Multiple takes, exact-version review, one-current-approved CAS, reject history giữ lại.
- Real middleware + SQLite: role/action/project, hai project thực, spoof body/header, Miro tự duyệt, revoked/expired/rotated capability, CEO/agent ambiguity, generic API/session/WS denial.
- Regeneration retry cùng key không duplicate; key khác payload/shot conflict; approved shot không bị ảnh hưởng; không gọi executor.
- Path traversal/absolute path/encoded separators/symlink/size/type/hash mismatch, cross-project asset reuse; không đọc secrets hoặc host files tùy ý.
- Reference change invalidates dependencies; stale take không approve hoặc vào READY manifest.
- Manifest incomplete/zero-required/stale/tampered asset không READY; immutable historical snapshot/digest/order.
- Crash/restart rollback, durable requests, atomic audit và Phase 1/2 sequential slot/attempt ownership vẫn đúng.
- CEO UI is read-only and displays persisted registry/review actor/status with loading/error states; agent mutations/review are exercised through actual scoped middleware/API fixtures, not browser impersonation.
- Sau source freeze: backend/frontend tests, `pnpm exec tsc -b`, lint, build, OpenAPI và diff check theo scripts thực tế; Docker fixture vẫn skip mặc định.

## Trạng thái hiện tại

Source implementation, focused acceptance coverage, root review and full-repository validation are complete. CEO Registry UI is read-only; scoped agent API routes reuse existing authentication and remain feature/isolation gated. OpenAPI contains 143 operations including 19 Registry operations. Live agent writes remain pending deployed isolation verification and a supported trusted executor. No Phase 4 work.
