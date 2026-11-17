# VieNeu-TTS cục bộ trên Windows

## Chuẩn bị máy

1. Cài Python 3.13 và bảo đảm `ffmpeg` cùng `ffprobe` gọi được từ tài khoản chạy Claw Empire.
2. Trong thư mục repo, chạy `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-vieneu.ps1`. Script tạo môi trường Python trong `data/vieneu/.venv`, cài SDK đã ghim phiên bản và tải bản model v3 Nano đã ghim revision vào `data/vieneu/model`.
3. Nếu dùng bản giao diện tĩnh, cài dependency từ lockfile bằng `pnpm install --frozen-lockfile` và chạy `pnpm build` trước khi khởi động lại Claw Empire. Hai đường dẫn tuỳ chỉnh `VIE_NEU_PYTHON` và `VIE_NEU_MODEL_DIR` có thể đặt trong `.env`. Lượt tổng hợp chạy bằng tệp model trên máy sau bước tải ban đầu.

Danh sách giọng ban đầu gồm Minh Quân và Mỹ Duyên. Minh Quân và tốc độ `1` là mặc định. API nhận `speed` từ `0.7` đến `1.2`.

## Bàn giao giữa các agent

Pre-production bàn giao `narration.txt` UTF-8. Audio Producer rà cách đọc và có thể ghi lựa chọn `voice` hoặc `speed` vào `voice-settings.json`. Khi agent dùng API văn bản, backend dùng mặc định nếu tệp tuỳ chọn chưa có. Cả Settings và workflow video dùng chung hàng đợi VieNeu-TTS.

Backend xuất `narration.mp3` và `narration.json`. Sidecar mới có `duration_seconds` được đo từ MP3 và `cues` chứa `text`, `startSeconds`, `endSeconds` theo đoạn âm thanh. Scene Engine lấy cue để dựng phụ đề. Metadata cũ có thể tiếp tục dùng `word_times`. API `/api/audio/speech` trả `cues` cho job mới và giữ các điểm truy cập tạo, xem và tải MP3.

## Checklist tự nghiệm thu

- [ ] Mở **Settings → General → VieNeu-TTS**. Tạo MP3 với mỗi giọng, theo dõi trạng thái, nghe và tải cùng một kết quả. Dùng ít nhất một câu có dấu, số và tên riêng.
- [ ] Tạo hai yêu cầu nối tiếp khi yêu cầu đầu đang chạy. Kiểm tra mỗi yêu cầu có kết quả và đường dẫn tách biệt. Thử điều kiện worker thiếu model trên một phiên kiểm thử để xác nhận lỗi rõ ràng và sau đó khôi phục cấu hình.
- [ ] Mở một task video mới trong thư mục dự án được chỉ định. Dùng brief TikTok Quốc ngữ khoảng 90 giây, dọc 1080 × 1920, giọng nam, phụ đề tiếng Việt. Cấu hình Scene Engine dùng CLI có quyền chạy Remotion, ví dụ Codex CLI. Cấu hình Cut QA dùng agent có thể đọc và kiểm tra tệp.
- [ ] Quan sát Pre-production, Voice & Audio, Scene Engine và Cut QA bàn giao trên bảng task. Kiểm tra lượt dùng Audio Producer qua API văn bản có thể tạo MP3 và JSON mà không cần tạo `voice-settings.json` thủ công. Kiểm tra giọng đọc đủ kịch bản, ngắt nghỉ và phát âm tên riêng phù hợp.
- [ ] Mở MP4 bàn giao. Nghe đầu, giữa và cuối clip, đối chiếu phụ đề cùng lời đọc. Kiểm tra 1080 × 1920, 30 fps, H.264/AAC và thời lượng gần 90 giây bằng `ffprobe`. Lượt này đạt khi Claw Empire tự tạo và chuyển giao các tệp từ kịch bản đến bản render cuối.
- [ ] Mở lại một dự án có MP3 hoặc metadata từ phiên bản trước để kiểm tra bàn giao lịch sử.

SDK và model được phát hành theo điều khoản ghi tại [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) và [model card v3 Nano](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Nano).
