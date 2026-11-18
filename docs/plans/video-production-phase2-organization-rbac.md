# Phase 2 — Organization & RBAC: kế hoạch và kết quả

Trạng thái thiết kế: đã được duyệt và triển khai. Trạng thái hiện tại: **CODE COMPLETE — DEPLOYMENT VERIFICATION PENDING**. Kết quả triển khai và manifest được ghi tại [implementation report](video-production-phase2-organization-rbac-report.md).

Người dùng giao agent chính lập kế hoạch, giám sát và review; agent Luna hiện có (`/root/phase11_complete_luna_medium`) thực hiện code và tests. Người dùng đã duyệt có điều kiện ba bảng logic `agent_role_bindings`, `project_grants`, `credential_hashes` cùng ranh giới xác thực hẹp trong kế hoạch. Có thể dùng tên bảng có prefix Video Production theo convention để tránh đụng domain khác; phải ghi rõ mapping trong báo cáo cuối.

## Điều kiện và lý do dừng

Tài liệu Phase 2 mới cho phép triển khai khi Phase 1.1 là `CODE COMPLETE — DEPLOYMENT VERIFICATION PENDING`. Vì vậy deployment chưa hoàn tất không chặn công việc cấu hình/API/UI. Mục 8 yêu cầu duyệt migration/security boundary đã được đáp ứng bằng phê duyệt có điều kiện của người dùng. Chỉ dừng để hỏi lại nếu cần trust boundary ngoài phương án đã duyệt, thay đổi deployment hoặc mở rộng phạm vi bảo mật đáng kể; không hỏi lại cho công việc đã được cho phép.

Không mở guard approval/execution, không thêm production executor, không deploy/build Docker, không đọc secrets, không gọi provider hoặc sửa database đang chạy. Không commit.

## Bằng chứng khảo sát

| Hiện trạng | Vị trí kiểm chứng | Hệ quả |
|---|---|---|
| `agents.role` chỉ nhận team_leader/senior/junior/intern | `server/modules/bootstrap/schema/base-schema.ts:45` | Giữ cấp bậc; bổ sung binding domain role riêng. |
| Đã có office departments theo workflow pack | `server/modules/bootstrap/schema/base-schema.ts:21`; `server/modules/routes/core/departments.ts:81` | Tái sử dụng tên/phạm vi phòng ban theo pack. |
| Đã có `project_agents` phục vụ membership/assignment | `server/modules/bootstrap/schema/task-schema-migrations.ts:108`; `server/modules/routes/core/projects.ts:405` | Không đổi ý nghĩa hoặc tự ghi đè danh sách này. |
| Auth hiện chỉ xác thực CEO session; middleware chặn các private API còn lại | `server/security/auth.ts:108`; `server/security/auth.ts:212` | Resolver ở route đơn thuần không đủ; không được mở agent credential vào toàn bộ API. |
| Production mutation cần CEO, CSRF và isolation ready | `server/modules/routes/core/video-production.ts:28` | Giữ isolation gate và quyền CEO đối với quyết định. |
| Manager đã lưu bằng agent ID; Dami mặc định thuộc operations | `server/modules/workflow/video-production.ts:158` | Tái sử dụng manager linkage và stable ID `video_production-seed-5`. |
| UI có thể sinh starter agents và đọc profile trong settings | `src/app/AppMainLayout.tsx:230` | Profile UI/personality không phải nguồn phân quyền. |
| Đã có plan versions, decisions, events, attempts và singleton slot | `server/modules/bootstrap/schema/video-production-schema.ts:3` | Tái sử dụng audit/execution; không tạo scheduler khác. |

## Thay đổi database đề nghị duyệt

Ba bảng bổ sung, không rebuild/drop bảng cũ và không đổi CHECK của `agents.role`:

1. `video_production_agent_roles`: `agent_id` PK/FK agents, `role_key` CHECK tám role dưới đây, `created_at`, `updated_at`.
2. `video_production_project_grants`: `project_id` FK projects, `agent_id` FK agents, `grant_key` CHECK member/coordinator, `granted_by`, `created_at`, `revoked_at`; PK `(project_id, agent_id)`.
3. `video_production_agent_credentials`: `credential_id` PK, `project_id` FK projects, `agent_id` FK agents, `token_hash` UNIQUE, `scopes_json`, `issued_by`, `created_at`, `expires_at`, `revoked_at`. Chỉ lưu hash credential ngẫu nhiên; thêm indexes cho project/agent và expiry.

Role profiles, permissions và stage ownership là typed constants do server kiểm soát. Không thêm bảng permission có thể sửa qua Agent Management. Tái sử dụng `video_production_events` cho grant/revoke, assignment và approval thuộc project; dùng audit convention hiện có cho setup tổ chức. Việc ghi privileged action và audit phải atomic.

Migration được kiểm thử trên database tạm, bao gồm chạy lại và mở lại database. Không áp dụng vào database production trong tác vụ này.

## Tổ chức đề nghị

Ưu tiên sáu department anchors hiện có với tên riêng trong `office_pack_departments` của `video_production`, tránh thêm department toàn cục hoặc chuyển Dami khỏi operations:

| Department của pack | Anchor ID hiện có | Agent / domain role |
|---|---|---|
| Production Management | operations | Dami / production_manager |
| Creative Development | planning | Rian / director; Haru / screenwriter |
| AI Visual Production | design | Yuna / art_director; Miro / video_producer |
| Post-production & Sound | dev | Liam / editor; Audio Producer / sound_producer |
| Quality Assurance | qa | Quinn / qa_supervisor |
| Studio Technology | devsecops | Backend, Asset Registry, Render Worker là services; không có LLM agent |

Setup là thao tác CEO xác thực + CSRF, opt-in và idempotent; không tự đổi active office/workflow khác. Tạo đủ tám agents cho cấu hình studio mới; Dami dùng ID hiện có, bảy agents còn lại dùng stable IDs do server định nghĩa. Không dựa tên hiển thị để cấp quyền. Giữ provider/OAuth/status/current task và mọi dữ liệu người dùng hiện có.

Không ghi đè cấu hình cùng ID khi xung đột. Nếu pack đã có tổ chức tùy biến hoặc thiếu anchor cần thiết, trả conflict cần cấu hình rõ ràng; không xóa agent để ép số lượng tám và không tự nhận seed thành công. Cấu hình legacy/UI profiles phải được kiểm tra để không ghi đè seed mới khi restart/hydration.

## Ranh giới xác thực đề nghị duyệt

- CEO tiếp tục dùng session hiện có. Agent credential không được đổi thành CEO session/cookie/CSRF và không có quyền greenlight, budget override hay release.
- Identity agent đến từ capability ngẫu nhiên do server cấp, hash đối chiếu database, có expiry/revocation, project và action scopes. Role lấy từ binding server, không lấy `role`, `agent_id`, `sender_type` trong body.
- Quyền hiệu lực là giao của role permissions, project grant còn hiệu lực, credential scopes và task assignment hợp lệ. Kiểm tra lại trên từng request/broker action, không chỉ khi cấp credential.
- HTTP agent access đề nghị chỉ có ba cặp method/path: `GET /api/projects/:id/video-production/organization` (project read), `PUT /api/projects/:id/video-production/plan` (PM plan), `POST /api/projects/:id/video-production/assignments` (PM assignment). Hook trước global rejection chỉ nhận ba route này, gắn actor vào server-owned context. Mỗi route vẫn kiểm tra action và project. Không whitelist cả prefix bằng wildcard; path/method khác tiếp tục CEO-only.
- Không nhận credential agent trên `/api/messages`, `/api/tasks/*`, `/api/subtasks/*`, Agent/Department/Settings API, auth/session, webhook hoặc WebSocket cũ. Generic API tiếp tục chỉ nhận CEO theo cơ chế cũ.
- Assignment wrapper chỉ dùng task đã tồn tại thuộc đúng project/stage được triển khai; giữ manager/root-task invariant, assignment audit và concurrency checks. Không sinh task cho stage NOT_IMPLEMENTED. Không thêm API take/screenplay/artifact giả để biểu diễn permission.
- Giữ nguyên isolation requirement trước mọi mutation production đã được Phase 1.1 bảo vệ; approval/run/cancel tiếp tục dùng CEO gate. Configuration `POST /api/video-production/organization/setup` và project grant/revoke tại `/api/projects/:id/video-production/agents/:agentId/grant` có guard CEO + CSRF riêng, không được dùng làm đường vòng sửa plan/task/approval.
- Issuance là internal server method, không có public token-mint endpoint. Không cấp credential thật hoặc nối worker trong Phase 2; default off/empty. Tests dùng database và credential fixture riêng, không phải bằng chứng deployment.
- Giữ trạng thái an toàn khi revoke grant/role change, credential hết hạn hoặc restart. Revoke/rotate không để credential cũ tiếp tục hoạt động.

## Permission matrix

| Actor | Quyền theo project | Không được tự cấp |
|---|---|---|
| CEO | greenlight, budget override, final release; quản lý grants | Không lấy actor từ body |
| Dami | plan, assignment, change request, production monitoring | CEO approval, creative/take/final QA approval |
| Rian | creative approval, pilot approval, Picture Lock | CEO greenlight/release |
| Haru | screenplay/dialogue/scene/shot specification được giao | Screenplay approval |
| Yuna | visual references, continuity, take review | CEO approval |
| Miro | footage/take submission, generation attempts | Take approval |
| Liam | animatic/timeline/editing/render coordination | CEO/final QA approval |
| Audio Producer | dialogue/audio artifacts/mix | CEO/final QA approval |
| Quinn | final QA approve/reject và defects | CEO release |

Quyền nghiệp vụ Phase 3 trở đi chỉ là policy definitions và policy tests ở Phase 2; không có endpoint hay artifact/completion giả.

## Stage ownership

1. Intake & Planning: Dami, Rian; CEO approval.
2. Story Development: Haru; Rian approval.
3. Visual Pre-production: Haru, Yuna, Liam; Rian approval.
4. Audio Pre-production: Audio Producer; Rian approval.
5. AI Footage Production: Miro; Yuna review, Rian pilot approval.
6. Asset Handoff & Rough Cut: Backend service, Liam.
7. Director Review: Rian; Picture Lock.
8. Finishing & QA: Audio Producer, Liam, Quinn; Quinn QA.
9. Release & Archive: Dami, Backend service; CEO approval.

Owner sequence là metadata/template cho task tuần tự. Không tạo runnable tasks cho tám stages `NOT_IMPLEMENTED`; không đổi stage status hoặc plan version đã được duyệt chỉ để cập nhật nhãn ownership. Khi tương lai có executor, materialization phải đi qua version/approval/dependency và singleton scheduler hiện có. Services không được coi là agent hoặc executor đã triển khai.

## Thứ tự triển khai đã dùng và file dự kiến

Danh sách dưới đây là phạm vi thiết kế ban đầu, được giữ lại làm lịch sử. File manifest thực tế, kết quả review và trạng thái hoàn thành được ghi trong [implementation report](video-production-phase2-organization-rbac-report.md).

1. `shared/video-studio-organization.ts` (mới): role profiles, stable IDs, department labels, stage ownership; mở rộng types của `shared/video-production.ts` và `src/types/index.ts` nếu cần.
2. `server/modules/bootstrap/schema/video-production-rbac-schema.ts` (mới), `server/server-main.ts`: migration bổ sung; organization seed service riêng, setup opt-in; tái sử dụng pack department schema.
3. `server/modules/workflow/video-production-rbac.ts` (mới): policy, trusted actor/grant/credential helpers, audit; narrow auth hook tại `server/security/auth.ts` sau khi duyệt method/path.
4. `server/modules/routes/core/video-production.ts`, `server/modules/workflow/video-production.ts`: organization/grant/setup API và PM binding; scoped plan/assignment integration nếu cần. Kiểm tra các generic task/chat/delegation boundaries, không mở quyền trên route cũ.
5. `src/api/video-production.ts`, `src/app/office-workflow-pack.ts`, `src/app/AppMainLayout.tsx`, `src/components/AgentManager.tsx`, `src/components/agent-manager/DepartmentsTab.tsx`, `src/components/project-manager/VideoProductionPanel.tsx`, Task Board khi cần: dùng dữ liệu backend, hiển thị role, PM, owner, assignment và pending approval; không redesign Office.
6. Tests schema/policy/API thật + regression/UI, `docs/openapi.json`, báo cáo và `tasks/todo.md`.

Không thêm dependency nếu thư viện hiện tại đáp ứng. Phải review patch từng phần trước khi mở rộng file scope.

## Verification criteria và kết quả hiện tại

- Seed hai lần và reopen file-backed database: đúng sáu pack departments/tám agents trong studio mới; giữ user fields, org/workflow khác, stable roles và Dami ID; conflict không ghi nửa chừng.
- Policy matrix: role + project + action + assignment; Miro/Haru/Dami bị chặn approval tương ứng; Rian/Yuna/Quinn có đúng quyền định nghĩa.
- Actual auth middleware + routes: không spoof bằng body/header ID/role; credential sai/hết hạn/revoked/sai project bị chặn; agent token không được vào generic API/auth/session/CEO decision; không cấp CEO cookie.
- Grant/revoke/assignment/approval có actor audit; failed transaction không để thay đổi thiếu audit.
- Scoped plan/assignment giữ version, dependency và isolation gates; production registry vẫn rỗng; stages chưa có executor vẫn không chạy; concurrent/restart/retry không phá attempt ownership/singleton.
- UI dùng database organization, hiển thị role/owner/PM/pending state; không dùng fake starter agents thay dữ liệu server; workflow cũ không regression.
- Chạy scripts thực tế: `pnpm run test:api -- --run --maxWorkers=2`, `pnpm run test:web -- --run --maxWorkers=2`, `pnpm exec tsc -b`, `pnpm run lint`, `pnpm run build`, `pnpm run openapi:check`, `git diff --check`. Chỉ ghi PASS/FAIL sau khi thực sự chạy.

## Rủi ro phải review

Hook xác thực đặt sai thứ tự hoặc allowlist rộng có thể mở API CEO cho agent; role/profile từ client có thể gây privilege escalation; membership mới có thể lệch với project assignment cũ; seed/hydration có thể ghi đè org tùy biến hoặc tạo dư agents; update ownership có thể làm thay đổi ý nghĩa plan đã duyệt. Thiết kế trên giữ các ranh giới này tường minh, nhưng cần tests và review source sau implementation.

Thiết kế này đã được triển khai và root đã hoàn tất review/validation. Full backend: 59 files, 282 passed và 1 Docker fixture skipped (283 total); frontend: 29 files / 103 passed; TypeScript/build pass; lint 0 errors và 40 warnings hiện có; OpenAPI 124 operations pass; `git diff --check` pass. Test Docker cần opt-in và đã được skip có chủ đích trong lần chạy mặc định. Xem [implementation report](video-production-phase2-organization-rbac-report.md) để biết manifest và giới hạn vận hành. Việc xác minh isolation trên deployment vẫn pending; các stage không được hỗ trợ tiếp tục bị đóng.
