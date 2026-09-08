# VidWizard — Notes triển khai Mobile App với React Native

> Bản ghi chú này diễn giải PRD `VidWizard_PRD_01_AI_Personalized_Video_Experiences_v2_0.docx` theo định hướng **mobile app native iOS/Android**, không phải web app responsive.

## 1. Tóm tắt sản phẩm

VidWizard là ứng dụng tạo video ngắn cá nhân hoá bằng AI. Người dùng chọn một **Experience** (một mẫu video có sẵn), đưa ảnh/video của mình hoặc người khác vào các character slot, chọn những tuỳ biến mà template cho phép, sau đó tạo và chia sẻ video thành phẩm.

Nguyên tắc sản phẩm là **controlled generation**:

- Template định nghĩa story, nhân vật, action, camera, bối cảnh, tỉ lệ khung hình, model routing và production recipe.
- AI chỉ thực hiện phần biến đổi identity/character và phần generation cần thiết.
- Không lấy prompt mở làm luồng chính; mọi tuỳ biến phải được template hỗ trợ rõ ràng.

Mục tiêu: biến người dùng thành nhân vật chính của những video ngắn, đẹp và dễ chia sẻ.

## 2. Quyết định nền tảng

| Hạng mục | Quyết định MVP |
| --- | --- |
| Client | React Native + TypeScript |
| Nền tảng | iOS và Android, mobile-first |
| Điều hướng | Native stack/tabs; flow tạo video là wizard theo từng bước |
| Tỷ lệ đầu ra mặc định | 9:16, tối ưu TikTok/Reels/Stories |
| Chia sẻ | Native share sheet, lưu video vào thư viện thiết bị, deep link attribution |
| Render video | Thực hiện ở backend/cloud; app theo dõi trạng thái job |
| UI web | Không thuộc MVP; không dùng “responsive web” làm chuẩn UX |

Điểm cần sửa trong PRD: §16 đang ghi “Web/mobile-responsive consumer flow”. Diễn đạt đúng là: **“Mobile-first native consumer flow trên iOS và Android.”**

## 3. Phạm vi MVP trên mobile

### Bao gồm

- Catalog 20–50 Experience chất lượng, có preview video.
- Khám phá theo Trending, New, Popular và các category như Action, Sports, Travel, Romance, Comedy, Transformation, Friends & Family, Vietnam Trends.
- 1–3 character slot tuỳ template.
- Chọn ảnh/video từ gallery hoặc camera; kiểm tra định dạng, dung lượng, độ phân giải và khuôn mặt cơ bản trước khi upload.
- Personalization theo schema template: role, outfit/style, location/environment, relationship, age transformation khi được hỗ trợ.
- Consent bắt buộc khi dùng ảnh của người khác.
- Tạo video, theo dõi tiến trình, xem trước, regenerate toàn bộ, lưu/chia sẻ.
- Generation history, credits và analytics nền tảng.

### Chưa thuộc MVP

- Text-to-video hoặc editor prompt mở.
- Timeline editor và chỉnh sửa thủ công.
- Chỉnh riêng từng cảnh / hội thoại AI để sửa video (Edit Operation Set).
- Marketplace cho user tạo template.
- Video dài, câu chuyện nhiều cảnh tự do, foundation video model riêng.

## 4. Luồng người dùng mobile

```text
Home / Discover
  → Mở Experience detail
  → Xem preview và yêu cầu đầu vào
  → Chọn character slot
  → Chụp ảnh / chọn từ gallery
  → Xác nhận consent (nếu có ảnh không phải chính user)
  → Chọn personalization được template hỗ trợ
  → Xem lại credit cost và Generate
  → Upload + tạo generation job
  → Màn hình progress (cho phép background app)
  → Push notification / in-app trạng thái hoàn tất
  → Xem video kết quả
  → Save / Share / Regenerate toàn bộ
```

Các trạng thái cần hiển thị rõ trong flow tạo video:

| Trạng thái | Hành vi app |
| --- | --- |
| `draft` | Lưu cục bộ lựa chọn dở dang để người dùng quay lại tiếp tục. |
| `uploading` | Hiện tiến trình theo file; hỗ trợ retry và upload tiếp sau khi mạng gián đoạn nếu backend hỗ trợ. |
| `validating` | Chờ backend kiểm tra asset, policy và character mapping. |
| `queued` / `generating` / `rendering` | Hiện mô tả tiến trình dễ hiểu; không hứa hẹn phần trăm chính xác nếu backend không cung cấp. |
| `completed` | Mở result preview, lưu vào history và kích hoạt luồng share. |
| `failed` | Nêu lỗi có thể hành động, cho retry hoặc liên hệ hỗ trợ; phân biệt lỗi kỹ thuật với policy. |

## 5. Native mobile requirements

### 5.1 Permissions và media

- Yêu cầu quyền **Camera** chỉ khi người dùng chọn chụp ảnh/video.
- Yêu cầu quyền **Photo Library / Media** chỉ khi người dùng chọn media từ thiết bị hoặc lưu video kết quả.
- Giải thích ngắn trước system prompt; nếu bị từ chối, dẫn người dùng đến Settings bằng CTA rõ ràng.
- Không upload media trước khi người dùng bấm Generate.
- Dùng preview thumbnail cục bộ, nén/chuẩn hoá upload theo giới hạn backend để giảm thời gian và chi phí mạng.

### 5.2 Background, network và notification

- Generation diễn ra server-side; app không được phụ thuộc vào việc vẫn mở trong foreground.
- Lưu `generationId` ngay khi tạo job; khi mở lại app, sync trạng thái từ backend.
- Gửi push notification khi generation hoàn thành hoặc thất bại; deep link đưa thẳng tới result screen.
- Có offline/poor-network states cho download catalog, upload asset và polling job status.
- Không giả định Android và iOS có cùng chính sách background execution; mọi trạng thái cuối cùng phải lấy từ API.

### 5.3 Sharing

- Xuất video MP4 social-ready theo mặc định 9:16.
- Lưu video vào Photos/Gallery khi user chủ động chọn Save.
- Gọi native share sheet để chia sẻ sang TikTok, Instagram, Facebook hoặc app bất kỳ có trên máy.
- Attribution nên dùng deep link/deferred deep link ở link được chia sẻ, không phụ thuộc vào khả năng app đích nhận metadata giống nhau trên cả hai OS.

## 6. Kiến trúc React Native đề xuất

```text
React Native app
├── Presentation
│   ├── Discover / Experience detail
│   ├── Create wizard
│   ├── Generation progress & result
│   ├── History, Credits, Profile
│   └── Permission, error, consent UI
├── Application layer
│   ├── Auth session
│   ├── Catalog & template schema
│   ├── Media selection / upload coordinator
│   ├── Generation job coordinator
│   ├── Credits and purchase state
│   └── Analytics events
├── Device adapters
│   ├── Camera and media library
│   ├── Push notification
│   ├── Native sharing / save-to-gallery
│   ├── Deep links
│   └── Secure credential storage
└── Backend APIs
    ├── Experience Catalog / Template Definition
    ├── Asset Upload & Validation
    ├── Identity Preparation
    ├── Generation Orchestrator / Model Router / Render Pipeline
    ├── Quality & Policy Checker
    ├── Generation History / Credits / Billing
    └── Analytics / Attribution
```

Nguyên tắc phân lớp:

- Screen/component không gọi HTTP trực tiếp; gọi use case/hook ở application layer.
- Mã native được bọc sau adapter để UI và business logic không phụ thuộc thư viện cụ thể.
- Server là nguồn dữ liệu cuối cùng cho credits, policy, generation state và link tải video.
- App chỉ quản lý draft cục bộ, trạng thái UI và cache dữ liệu có thể tái tạo.

## 7. Mô hình dữ liệu tối thiểu

### Experience template

```ts
type ExperienceTemplate = {
  id: string;
  version: string;
  title: string;
  category: string;
  previewVideoUrl: string;
  durationSeconds?: number;
  aspectRatio: '9:16';
  characterSlots: CharacterSlot[];
  personalizationFields: PersonalizationField[];
  estimatedCreditCost: number;
  policyFlags: { childSafety: boolean; consentRequiredForNonSelf: boolean };
};
```

### Generation job

```ts
type GenerationJob = {
  id: string;
  templateId: string;
  status: 'draft' | 'uploading' | 'validating' | 'queued' |
          'generating' | 'rendering' | 'completed' | 'failed';
  progress?: { stage: string; percent?: number };
  resultVideoUrl?: string;
  failure?: { code: string; userMessage: string; retryable: boolean };
  creditCharge: number;
  createdAt: string;
};
```

Không để client tự quyết định cost, permission policy hay trạng thái thành công của generation.

## 8. Consent, safety và privacy

- Với ảnh không phải selfie của user, bắt buộc tick checkbox consent trước Generate: người upload xác nhận đã có sự đồng ý của người xuất hiện trong ảnh.
- Điều khoản sử dụng quy định rõ user chịu trách nhiệm về likeness rights, consent và quyền dùng asset đã upload.
- Cấm upload ảnh người nổi tiếng/chính trị gia theo policy MVP.
- Family Experience/ảnh trẻ em là luồng rủi ro cao hơn: cần age/safety policy, hạn chế template phù hợp và cơ chế review/escalation ở backend.
- Chỉ truyền token qua HTTPS; lưu session credential trong secure storage của thiết bị, không trong AsyncStorage thuần.
- Cung cấp xoá asset/generation history và mô tả retention policy rõ ràng.
- Không tin dữ liệu consent do client tự ghi: backend phải lưu consent record gắn với asset/generation.

## 9. API contract cần có

| Nhu cầu mobile | API/backend cần cung cấp |
| --- | --- |
| Hiển thị catalog | Template list/detail có preview URL, schema input, cost và availability. |
| Upload media tin cậy | Pre-signed/resumable upload, progress metadata, asset validation result. |
| Tạo video | Tạo job idempotent từ template + asset IDs + personalization + consent record. |
| Theo dõi khi app nền | Lấy job theo `generationId`; webhook/push event là tăng cường, API state là chuẩn. |
| Result & share | Signed result URL, thumbnail, thời hạn URL và attribution/deep link metadata. |
| Credits | Balance và transaction history do server xác nhận. |
| History | Phân trang, retry/regenerate policy, asset/result lifecycle. |

## 10. Analytics mobile

Funnel tối thiểu:

```text
template_impression
→ preview_opened
→ create_started
→ asset_selected
→ consent_shown / consent_confirmed
→ upload_completed
→ generation_requested
→ generation_completed hoặc generation_failed
→ result_viewed
→ saved / shared / regenerated
→ purchase_started / purchase_completed
```

Cần gắn tối thiểu `templateId`, template version, category, character-slot count, app version, OS, network class, generation ID (nếu đã có) và error code. Không gửi ảnh, video, khuôn mặt embedding hay nội dung nhạy cảm vào analytics event.

Chỉ số POC cần ra quyết định:

- Preview-to-start conversion, upload completion, consent confirmation rate.
- Generation success rate, identity error rate, thời gian tạo video.
- Regeneration rate, retry do lỗi kỹ thuật và cost/generation thành công.
- Completion/share/save rate theo template và mốc 15s / 20s / 30s.
- Paid conversion, repeat creation và retention/retirement của template.

## 11. Chất lượng và lỗi cần xử lý

- Mục tiêu hiện tại là giả thuyết: output usable ≥85%, lỗi identity nhìn thấy rõ <10%, generation chuẩn dưới 3 phút. Chỉ dùng làm POC gate, không cam kết ra bên ngoài.
- Có error UI riêng cho: media không hợp lệ, mạng/upload thất bại, consent thiếu, policy bị chặn, hết credits, generation technical failure và result download hết hạn.
- Retry miễn phí chỉ áp dụng cho lỗi kỹ thuật đủ điều kiện theo quyết định backend; regenerate theo ý user là generation mới và bị tính credit theo policy.
- Không hiển thị một progress percentage giả nếu pipeline không trả về dữ liệu đáng tin cậy; ưu tiên stage-based progress.

## 12. Checklist trước khi bắt đầu build

- [ ] Chốt Expo hay React Native CLI dựa trên yêu cầu camera/media, push, share, purchase và native SDK của vendor.
- [ ] Chốt auth, API versioning, upload protocol và schema template với backend.
- [ ] Xác định provider analytics, crash reporting, push notification và deep-link attribution.
- [ ] Viết policy chính thức cho consent, celebrity/public figure, child safety, asset retention và xoá dữ liệu.
- [ ] Thiết kế wizard trên màn hình dọc nhỏ trước; kiểm thử một tay và accessibility (font scaling, screen reader, contrast).
- [ ] Định nghĩa retry, credit charge/refund và idempotency cho mọi trạng thái mạng chập chờn.
- [ ] Prototype 3 template đại diện và test 15s/20s/30s trước khi mở rộng catalog 20–50 template.
- [ ] Đo cost thực tế theo Experience trước khi chốt pricing hay free credit cap.

## 13. Kết luận

VidWizard MVP là một **native mobile creation-and-share app**, còn backend là hệ thống điều phối generation dựa trên template. Thành công trên mobile phụ thuộc nhiều vào việc làm cho flow chọn ảnh → consent → generate → nhận kết quả → share thật ngắn, rõ trạng thái và bền vững khi app background hoặc mạng không ổn định; không phải chỉ chuyển một UI web responsive sang màn hình điện thoại.
