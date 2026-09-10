# VidWizard POC runner

POC hiện có hai luồng. Luồng cũ kiểm tra replacement 1/2/3 slots theo toàn video. Luồng được khuyến nghị cho case production-like là **one-slot, shot-based**: tự tìm scene, cắt clip, gọi Kie theo shot, review tay từng shot, rồi chỉ nối các shot được chấp nhận.

## One-slot shot-based POC với Kie.ai

### Prerequisites

```bash
sudo apt-get install ffmpeg python3-pip python3-venv
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install "scenedetect[opencv]"
```

CLI tự thêm `.venv/bin` vào `PATH` khi thư mục này tồn tại, nên không cần kích hoạt virtual environment riêng trước khi chạy lệnh POC. `ffmpeg`/`ffprobe` dùng để cắt và nối; PySceneDetect AdaptiveDetector tìm điểm cut. Kie chỉ nhận URL HTTPS công khai, video local được giữ lại để detect/cut, kiểm tra duration và khôi phục audio khi assemble. Tạo `.env` từ `.env.example`; CLI tự nạp file này và không đưa API key vào Git.

### 1. Tạo manifest

```bash
cp poc/config/solo-shot-test.example.json poc/config/solo-shot-test.json
```

Điền `template.localVideoPath` bằng đường dẫn MP4 local và `reference.imageUrl` bằng ảnh full-body có consent ở URL HTTPS public. Để `template.shots` là `[]` để tự detect; chỉ điền shots khi muốn override các điểm cắt. `providerDurationSeconds` để `null` sẽ gửi duration đúng bằng duration shot; chỉ đặt giá trị khác khi đã xác nhận contract duration của provider.

### 2. Detect, cắt shot và sinh prompt riêng

```bash
npm run poc:shot-prepare
```

Lệnh tạo `poc/assets/<template-id>/shots/*.mp4` và `poc/assets/<template-id>/shot-plan.json`. Chỉnh `adaptiveThreshold`/`minShotDurationSeconds` hoặc thêm manual shots trong manifest nếu điểm cắt chưa hợp lý.

Để sinh prompt bằng Kie GPT-5.6 Luna, bật `promptGeneration.enabled` trong manifest và cung cấp `sourceVideoUrl` HTTPS công khai (hoặc `shotVideoUrls` theo từng shot). `prepare` đưa URL MP4 vào Kie File Upload API, sau đó truyền file tạm cho GPT phân tích toàn bộ video; không tạo frame ảnh. Plan lưu `promptSuffix`, `negativePrompt` và metadata vào plan trước dry-run. Upload file không dùng credit, nhưng GPT dùng credit; file của Kie là tạm thời nên chỉ dùng để sinh prompt.

### 3. Upload clips và thêm public URL

Upload từng file local trong `shot-plan.json` lên CDN/storage của bạn. Sau đó thêm `publicVideoUrl` HTTPS tương ứng vào từng shot trong chính file plan. Không đặt API key, signed URL dài hạn, hoặc dữ liệu nhạy cảm vào Git.

### 4. Kie dry-run rồi generate live

```bash
node poc/src/cli.js run-shots --manifest poc/config/solo-shot-test.json --plan poc/assets/horse-riding/shot-plan.json --mode dry-run

export KIE_API_KEY='...'
node poc/src/cli.js run-shots --manifest poc/config/solo-shot-test.json --plan poc/assets/horse-riding/shot-plan.json --mode live
```

Dry-run có thể chạy trước khi upload shot; record sẽ lưu `local_reference_video_path` và đánh dấu `uploadRequiredBeforeLive`. Live mode sẽ fail trước khi tạo task đầu tiên nếu bất kỳ shot nào thiếu `publicVideoUrl`. Mỗi shot được lưu checkpoint trước khi submit, ngay sau khi nhận task ID, và khi polling kết thúc. Nếu mất mạng sau submit hoặc timeout, record chuyển sang `unknown` để reconcile; resume bằng `--resume-dir` sẽ poll lại task đã biết và không tự tạo task trả phí mới. Intent không có task ID phải được xử lý thủ công trước khi chạy lại.

Plan được lưu với `planVersion` và `planHash`. Khi resume, hash và thứ tự shot phải khớp snapshot generation đã lưu; sửa plan giữa chừng sẽ bị từ chối.

### 5. Manual quality review và assemble

```bash
node poc/src/cli.js review-template --runs-dir poc/runs/<run-id>
```

Điền file review sinh ra với `usable`, identity/background/motion/flicker, seam (null ở shot duy nhất), failure reason và notes. Sau đó:

```bash
node poc/src/cli.js assemble \
  --runs-dir poc/runs/<run-id> \
  --reviews poc/runs/<run-id>/review-template.json
```

`assemble` fail-closed: không thể tạo final MP4 nếu một shot fail, thiếu output, chưa review, hoặc `usable: false`. Assembly luôn probe từng clip, normalize về H.264/yuv420p/30fps, kiểm tra output cuối và thứ tự theo immutable generation snapshot. Mặc định mux audio từ video nguồn trong snapshot (nếu có); `--source-audio <path>` thay nguồn audio. Kích thước output theo resolution/aspectRatio của manifest, có letterbox khi cần; không kéo giãn tốc độ để che lỗi timing.
Assembly kiểm tra đủ shot theo plan, đúng thứ tự và không trùng. Final video có cờ `usable: false` cho tới khi được review riêng; toàn bộ shot pass không tự động biến thành final usable.

Review final video sau assembly:

```bash
node poc/src/cli.js final-review \
  --runs-dir poc/runs/<run-id> \
  --review poc/runs/<run-id>/final-review.json
```

Tạo `final-review.json` sau khi xem video cuối, ví dụ `{"usable": true, "notes": "Đã kiểm tra identity, timing và seam của video cuối."}`. Review final có `usable` (boolean) và `notes` bắt buộc. Report generation-level chỉ tính live generations; dry-run bị loại khỏi cost/quality metrics. Chi phí và credits chưa biết giữ là unknown, không quy về zero.

### 6. Report

```bash
node poc/src/cli.js report --runs-dir poc/runs/<run-id>
```

Report đọc riêng shot records, generation snapshots và final records. Bảng generation hiển thị số attempt có/chưa có cost hoặc credits; bảng template tính usable rate và tổng chi phí mọi generation (kể cả thất bại) chia số final usable. Nếu còn cost chưa biết, cost/usable là unknown. Một lần chạy mới là một generation mới; resume chỉ tiếp tục task cũ, không tạo attempt retry tự động.

## Chạy ngay ở dry-run

```bash
npm test
npm run poc:validate
npm run poc:dry-run
npm run poc:report
```

`dry-run` tạo record để kiểm tra manifest và reporting; nó không gọi Seedance hay tạo video.

## Luồng legacy: toàn video

1. Copy `poc/config/test-manifest.example.json` thành `poc/config/test-manifest.json`.
2. Thay toàn bộ URL mẫu bằng URL HTTPS công khai của template video và ảnh full-body đã có consent.
3. Chốt API contract của provider, rồi khai báo:

```bash
export KIE_API_KEY='...'
# Optional; mặc định là https://api.kie.ai/
export KIE_API_BASE_URL='https://api.kie.ai/'
```

4. Chạy:

```bash
node poc/src/cli.js run --manifest poc/config/test-manifest.json --mode live
node poc/src/cli.js report --runs-dir poc/runs
```

Payload dùng model `bytedance/seedance-2-5`, với `reference_video_urls` cho template và `reference_image_urls` cho N nhân vật. Kie chỉ nhận URL HTTPS công khai; upload file nguồn lên storage/CDN trước, không đưa đường dẫn local vào manifest. Record live lưu `creditsConsumed`, `costTime` và output URL do Kie trả về.

## Manual quality review

Sau khi nhận output, thêm `qualityReview` vào mỗi record JSON:

```json
{
  "qualityReview": {
    "usable": true,
    "identityMappingPass": true,
    "backgroundPreserved": true,
    "motionPreserved": true,
    "notes": "..."
  }
}
```

`npm run poc:report` sẽ tổng hợp performance, credits/video và quality pass rate từ các run completed/reviewed.

## Recovery và giới hạn POC

```bash
node poc/src/cli.js run-shots \
  --manifest poc/config/solo-shot-test.json \
  --plan poc/assets/horse-riding/shot-plan.json \
  --mode live --resume-dir poc/runs/<run-id>
```

Resume yêu cầu giữ nguyên manifest và plan, chỉ áp dụng snapshot live; dry-run không được ghi đè run live. Task không rõ kết quả submit và chưa có task ID cần đối chiếu lịch sử provider trước khi chạy tiếp. Không tự retry task đã fail; muốn thử lại phải tạo generation mới, giữ run cũ để report tính đầy đủ chi phí.

Scene ngắn được gộp với scene kề, không bị xóa khỏi timeline. Duyệt lại plan trước upload vì gộp có thể chứa một điểm cut. Sửa boundaries/prompt/reference thì prepare lại; chỉ thêm publicVideoUrl vào plan sau prepare. Hash kiểm tra cấu hình plan, không chứng minh nội dung file/URL không đổi.

Duration request mặc định bằng duration shot (có thể là số lẻ); tính hợp lệ với model cần xác minh trên API trước benchmark. `providerDurationSeconds` hoặc `requestedDurationSeconds` từng shot chỉ dùng khi đã xác nhận contract. Output lệch quá dung sai duration sẽ bị từ chối; pipeline không retime/pad video. 480p là cấu hình kiểm tra kỹ thuật, chưa chứng minh chất lượng model. USD chỉ lấy khi provider trả về; không suy ra từ credits bằng tỷ giá giả định.

Latency submit→assembly hiện bao gồm thời gian chờ human review/download/render. Không dùng số này như latency inference thuần. Pipeline vẫn chạy task tuần tự; không có auto-upload, auto-retry, hoặc benchmark AI trong test.

`npm test` chạy cả synthetic FFmpeg integration và CLI assemble/final-review/report, không dùng Kie credits. Các run cũ không có generation snapshot không dùng được với assembly mới; giữ lại để tham khảo, tạo run mới theo workflow trên.
