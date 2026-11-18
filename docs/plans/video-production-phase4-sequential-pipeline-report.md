# Phase 4 — Báo cáo triển khai và nghiệm thu

Phase 4 đã tích hợp vào mã nguồn Claw-Empire trên mốc Phase 1–3 `71a15f0`. Luna triển khai và viết test. Agent chính lập kế hoạch, review các chốt quyền và chạy bộ kiểm tra độc lập. Kết quả xác nhận ở môi trường kiểm thử cục bộ.

## Nghiệp vụ và cơ chế tái sử dụng

- CEO Directive, Project Brief, duyệt plan, Task Board và Chat dùng đường dẫn hiện có. Dami chọn job hợp lệ kế tiếp từ plan, quyết định và Registry. Panel Video Production gọi cùng API chạy task của ứng dụng. CEO có thể xem trạng thái và chủ động chạy từng job đủ điều kiện.
- Haru dùng provider đã cấu hình để tạo screenplay và shot list có schema. Rian duyệt một artifact cụ thể, hoặc yêu cầu Haru tạo bản sửa. Yuna ghi continuity và review các khung hình trích từ đúng take. Khi Yuna từ chối, Dami tạo yêu cầu regeneration có idempotency cho shot đó.
- Worker Docker dùng entrypoint cố định, UID/GID 65532, mạng `none`, root filesystem chỉ đọc và đúng một workspace của attempt. Broker provider giữ credential phía server. SQLite giữ slot duy nhất qua lúc xác minh, nhập kết quả và khôi phục.
- Miro render composition theo shot từ dữ liệu và asset được xác minh. Liam đọc clip theo manifest, áp dụng chuyển cảnh, phụ đề theo cue và trộn audio từ adapter VieNeu-TTS. Registry ghi các asset và artifact bất biến. Chốt khôi phục đối chiếu workspace, nhận dạng worker và digest đầu vào trước khi nhập lại.
- Rian duyệt bản cắt và Quinn xác minh media độc lập bằng full decode và khung hình lấy mẫu. Quyết định phê duyệt phát hành của CEO gắn với MP4, manifest, timeline, source render, audio, cue và bằng chứng QA. Panel có preview trước khi duyệt và tải MP4 sau khi phát hành.

## Migration

- Thêm `video_production_stage_jobs`, `video_production_stage_artifacts`, `video_production_stage_decisions` và `video_production_final_releases` với chỉ mục và ràng buộc thích hợp.
- Thêm `workspace_path`, `execution_action` và `worker_input_digest` trên attempt. Các job gắn chính xác plan, agent, action và target.
- Migration bổ sung được kiểm tra trên SQLite tạm, gồm đóng và mở lại database. Database production chưa được áp dụng migration.

## Các kiểm tra đã chạy

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm run test:api -- --run --maxWorkers=1` | 312 pass, 64 file, với `CLAW_RUN_DOCKER_TESTS=1` trong lần chạy test |
| `pnpm run test:web -- --run --maxWorkers=1` | 105 pass, 29 file |
| `pnpm exec tsc -b --pretty false` và `pnpm run build` | Pass |
| `pnpm run lint` | 0 lỗi, 40 cảnh báo đã có |
| `pnpm run openapi:check` | Pass, 148 thao tác |
| `git diff --check` và kiểm tra cú pháp worker | Pass |

Fixture xuyên suốt kiểm tra từ screenplay và handoff đến render, khôi phục Liam sau khi mở lại SQLite, Rian review, Quinn QA và CEO release theo đúng hash. Các test riêng kiểm tra yêu cầu sửa screenplay và render lại shot bị từ chối. Provider gọi qua mock có schema. Audio fixture là âm tổng hợp cục bộ.

Image Docker kiểm thử được build lại từ mã worker hiện tại. Ba loại fixture chạy cục bộ gồm shot ngang, shot dọc có PNG tham chiếu và timeline từ hai mục clip với chuyển cảnh chồng 3 khung hình, cue phụ đề và track audio thử. Timeline cuối có H.264 1280×720, 30 fps, 57 khung hình, video 1,900 giây và AAC khoảng 1,963 giây. SHA-256 khớp kết quả worker và FFmpeg giải mã đầy đủ cả hai stream. Khung hình ở 1,4 giây hiển thị đúng cue thứ hai. Giới hạn 256 PID chỉ áp dụng profile Remotion, sau khi fixture đo được Chromium chạm giới hạn 128 PID.

## Giới hạn và bước nghiệm thu live

- **DONE** Mã nguồn MVP, migration bổ sung, giao diện điều phối tuần tự, luồng review và release theo phiên bản, và kiểm thử local.
- **DONE trong mã nguồn** CEO duyệt kế hoạch sẽ lưu ý định tự chạy và khởi động job đầu. Sau mỗi attempt hoàn tất và được xác minh, điều phối dùng bộ chọn bước và executor chung để chạy job tiếp theo, gồm review của agent, sửa screenplay và regeneration theo shot. Chuỗi dừng ở duyệt phát hành của CEO, lỗi hoặc thao tác hủy. Trạng thái tự chạy được lưu trong SQLite và hiển thị trên panel. Chưa nghiệm thu live.
- **PARTIAL** Khi Rian hoặc Quinn yêu cầu sửa bản cắt cuối, ghi nhận kết quả, dừng tự chạy với lỗi cụ thể và chặn phát hành để điều phối chỉnh sửa; vòng tự sửa bản dựng cuối chưa được triển khai.
- **BLOCKED vận hành** Đường dẫn VieNeu mặc định chưa có model và Python environment. Cần cấu hình runtime offline và kiểm tra giọng thật, cue, cùng độ dài lời đọc so với timeline. Job có A/V lệch quá dung sai sẽ báo lỗi.
- Trước khi dùng live, chạy thử với image digest và quyền mount của môi trường đích, provider hỗ trợ ảnh đã cấu hình theo role, model VieNeu cục bộ và một dự án thử. Kiểm tra cả restart, luồng yêu cầu sửa và tải MP4 qua phiên CEO. Image kiểm thử nằm trên máy cục bộ. Production chưa được triển khai và các bài test không gọi provider tính phí.

## Danh sách file Phase 4

### Bổ sung: điều phối video tự chạy

- Dùng chung `video-production-job-executor.ts` cho route CEO và bộ điều phối `video-production-auto-run.ts`; không gọi vòng qua HTTP hoặc dùng đường CLI chung để bỏ qua chốt video.
- Ý định tự chạy gắn phiên bản kế hoạch được lưu trong `video_production_auto_runs`. Kế hoạch vừa được duyệt khởi động tự động. Với dự án đã duyệt từ trước bản cập nhật, một lần chạy job thành công qua CEO sẽ bật chuỗi tiếp tục.
- Callback hoàn tất chỉ đánh thức bộ điều phối; trạng thái, bằng chứng và slot được đọc lại từ SQLite. Hàng đợi nhiều dự án dùng slot toàn hệ thống hiện có. Khởi động lại chỉ tiếp tục từ kết quả đã xác minh; không tự gọi lại provider bị gián đoạn.
- Hủy lưu trạng thái dừng trước callback. QA từ chối và bằng chứng sai được phân biệt với chờ CEO phát hành. Giới hạn 1.000 job mỗi kế hoạch ngăn vòng sửa lặp vô hạn; chạm giới hạn báo lỗi và dừng.
- Kiểm chứng: bộ API toàn hệ thống 354 pass, 1 Docker test tùy chọn skip; thêm 3 test hủy pass riêng. Web 106 pass. Có 14 test tự chạy, gồm một tín hiệu ban đầu tự chạy qua screenplay, review và shot spec rồi dừng khi provider fixture trả dữ liệu sai. TypeScript, build và OpenAPI pass; lint không lỗi, 40 cảnh báo có sẵn. Provider và worker readiness được giả lập trong bài tích hợp điều phối; chưa chạy live hay gọi dịch vụ tính phí.

- **Docker worker** — `deploy/worker/Dockerfile`, `deploy/worker/worker-runner.mjs`.
- **Schema** — `server/modules/bootstrap/schema/video-production-schema.ts`, `server/modules/bootstrap/schema/video-production-registry-schema.ts`.
- **Routes và xác thực** — `server/modules/routes/core.ts`, `server/modules/routes/core/tasks/execution-run.ts`, `server/modules/routes/core/video-production.ts`, `server/modules/routes/core/video-production-registry.ts`, `server/security/auth.ts`.
- **Điều phối, lifecycle và quyền** — `server/modules/workflow/video-production.ts`, `server/modules/workflow/video-production-dispatch.ts`, `server/modules/workflow/video-production-execution.ts`, `server/modules/workflow/video-production-rbac.ts`, `server/modules/workflow/worker-isolation.ts`, `server/modules/workflow/orchestration/run-complete-handler.ts`.
- **Media và đầu ra theo stage** — `server/modules/workflow/packs/vieneu-tts.ts`, `server/modules/workflow/video-production-provider-broker.ts`, `server/modules/workflow/video-production-stage-outputs.ts`, `server/modules/workflow/video-production-stage-artifacts.ts`, `server/modules/workflow/video-production-stage-runner.ts`, `server/modules/workflow/video-production-media.ts`, `server/modules/workflow/video-production-final-render.ts`, `server/modules/workflow/video-production-registry.ts`, `server/modules/workflow/video-production-registry-storage.ts`, `server/modules/workflow/video-production-release.ts`.
- **Kiểu chia sẻ** — `shared/video-production-stage-outputs.ts`, `shared/video-studio-organization.ts`.
- **UI** — `src/api/video-production.ts`, `src/components/project-manager/VideoProductionPanel.tsx`.
- **Tests** — `server/modules/workflow/video-production-execution.test.ts`, `server/modules/workflow/video-production-registry.test.ts`, `server/modules/workflow/video-production-media.test.ts`, `server/modules/workflow/video-production-provider-broker.test.ts`, `src/components/project-manager/VideoProductionPanel.test.tsx`.
- **Tài liệu** — `docs/openapi.json`, `docs/plans/video-production-phase4-sequential-pipeline.md`, `docs/plans/video-production-phase4-sequential-pipeline-report.md`.
